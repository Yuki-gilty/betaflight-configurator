import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/js/agent_bridge/handlers.js", () => ({
    createHandlers: () => ({
        ping: async (params) => ({ pong: params.value }),
        boom: async () => {
            throw new Error("kaboom");
        },
    }),
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

const { startAgentBridge } = await import("../../../src/js/agent_bridge/index.js");

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
