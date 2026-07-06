import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/js/agent_bridge/handlers.js", () => ({
    createHandlers: () => ({
        ping: async (params) => ({ pong: params.value }),
        boom: async () => {
            throw new Error("kaboom");
        },
    }),
}));

const mockConfig = {};
const mockGuiLog = vi.fn();
vi.mock("../../../src/js/ConfigStorage.js", () => ({
    get: (key, defaultValue) => ({ [key]: mockConfig[key] ?? defaultValue }),
    set: (obj) => Object.assign(mockConfig, obj),
}));
vi.mock("../../../src/js/gui_log.js", () => ({ gui_log: (msg) => mockGuiLog(msg) }));
vi.mock("../../../src/js/localization.js", () => ({ i18n: { getMessage: (key) => key } }));
const mockShowOverlay = vi.fn();
const mockHideOverlay = vi.fn();
vi.mock("../../../src/js/agent_bridge/overlay.js", () => ({
    showAgentOverlay: (...a) => mockShowOverlay(...a),
    hideAgentOverlay: (...a) => mockHideOverlay(...a),
}));

class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }
    send(msg) {
        this.sent.push(JSON.parse(msg));
    }
    close() {
        this.onclose?.();
    }
    async receive(message) {
        await this.onmessage?.({ data: JSON.stringify(message) });
        // let the async handler finish and send the reply
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const { startAgentBridge, setAgentBridgeEnabled, subscribeAgentBridge } =
    await import("../../../src/js/agent_bridge/index.js");

describe("startAgentBridge", () => {
    let stop;

    beforeEach(() => {
        FakeWebSocket.instances = [];
        vi.stubGlobal("WebSocket", FakeWebSocket);
    });

    afterEach(() => {
        stop?.();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("answers a request with the handler result", async () => {
        stop = startAgentBridge({ url: "ws://test" });
        const socket = FakeWebSocket.instances[0];
        await socket.receive({ id: 1, method: "ping", params: { value: 42 } });
        expect(socket.sent).toEqual([{ id: 1, result: { pong: 42 } }]);
    });

    it("answers with an error when the handler throws", async () => {
        stop = startAgentBridge({ url: "ws://test" });
        const socket = FakeWebSocket.instances[0];
        await socket.receive({ id: 2, method: "boom", params: {} });
        expect(socket.sent).toEqual([{ id: 2, error: "kaboom" }]);
    });

    it("answers with an error for unknown methods", async () => {
        stop = startAgentBridge({ url: "ws://test" });
        const socket = FakeWebSocket.instances[0];
        await socket.receive({ id: 3, method: "nope", params: {} });
        expect(socket.sent[0].error).toMatch(/unknown method/i);
    });

    it("reports connection status changes and logs to the GUI", async () => {
        setAgentBridgeEnabled(true);
        expect(mockConfig.agentBridgeEnabled).toBe(true);

        const seen = [];
        const unsubscribe = subscribeAgentBridge((s) => seen.push(s));
        expect(seen[0].enabled).toBe(true);

        const socket = FakeWebSocket.instances.at(-1);
        socket.onopen?.();
        expect(seen.at(-1).connected).toBe(true);
        expect(mockGuiLog).toHaveBeenCalledWith("agentBridgeConnected");

        setAgentBridgeEnabled(false);
        expect(mockConfig.agentBridgeEnabled).toBe(false);
        expect(seen.at(-1)).toEqual({ enabled: false, connected: false, active: false });
        expect(mockGuiLog).toHaveBeenCalledWith("agentBridgeDisconnected");
        unsubscribe();
    });

    it("shows the blue overlay while a command runs and hides it after a linger", async () => {
        vi.useFakeTimers();
        mockShowOverlay.mockClear();
        mockHideOverlay.mockClear();
        setAgentBridgeEnabled(true);
        const socket = FakeWebSocket.instances.at(-1);

        // onActivity(method) fires synchronously before the handler awaits,
        // so the overlay shows immediately when the command starts
        const done = socket.onmessage({ data: JSON.stringify({ id: 1, method: "ping", params: { value: 1 } }) });
        expect(mockShowOverlay).toHaveBeenCalled();
        expect(mockHideOverlay).not.toHaveBeenCalled();

        // flush the handler microtask and the linger timer
        await vi.runAllTimersAsync();
        await done;
        expect(mockHideOverlay).toHaveBeenCalled();

        setAgentBridgeEnabled(false);
    });

    it("reconnects after the socket closes, and stop() prevents it", async () => {
        vi.useFakeTimers();
        stop = startAgentBridge({ url: "ws://test" });
        expect(FakeWebSocket.instances).toHaveLength(1);

        FakeWebSocket.instances[0].close();
        vi.advanceTimersByTime(3000);
        expect(FakeWebSocket.instances).toHaveLength(2);

        stop();
        FakeWebSocket.instances[1].close();
        vi.advanceTimersByTime(3000);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });
});
