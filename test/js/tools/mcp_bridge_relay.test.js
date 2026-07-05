// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfiguratorRelay } from "../../../tools/mcp-bridge/relay.js";

function fakeSocket() {
    return {
        sent: [],
        send(msg) {
            this.sent.push(JSON.parse(msg));
        },
        close: vi.fn(),
    };
}

describe("ConfiguratorRelay", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("rejects call() when no configurator is attached", async () => {
        const relay = new ConfiguratorRelay();
        await expect(relay.call("get_status")).rejects.toThrow(/not connected/i);
    });

    it("resolves call() when a matching response arrives", async () => {
        const relay = new ConfiguratorRelay();
        const socket = fakeSocket();
        relay.attach(socket);

        const promise = relay.call("get_status", { verbose: true });
        expect(socket.sent).toHaveLength(1);
        const { id, method, params } = socket.sent[0];
        expect(method).toBe("get_status");
        expect(params).toEqual({ verbose: true });

        relay.handleMessage(JSON.stringify({ id, result: { fcConnected: false } }));
        await expect(promise).resolves.toEqual({ fcConnected: false });
    });

    it("rejects call() when the configurator returns an error", async () => {
        const relay = new ConfiguratorRelay();
        const socket = fakeSocket();
        relay.attach(socket);

        const promise = relay.call("get_pid_tuning");
        relay.handleMessage(JSON.stringify({ id: socket.sent[0].id, error: "FC not connected" }));
        await expect(promise).rejects.toThrow("FC not connected");
    });

    it("rejects call() after the timeout elapses", async () => {
        const relay = new ConfiguratorRelay({ timeoutMs: 10000 });
        relay.attach(fakeSocket());

        const promise = relay.call("get_status");
        const assertion = expect(promise).rejects.toThrow(/timed out/i);
        vi.advanceTimersByTime(10001);
        await assertion;
    });

    it("closes the previous socket when a new one attaches (last tab wins)", () => {
        const relay = new ConfiguratorRelay();
        const first = fakeSocket();
        const second = fakeSocket();
        relay.attach(first);
        relay.attach(second);
        expect(first.close).toHaveBeenCalled();
        expect(relay.connected).toBe(true);
    });

    it("detach() only clears the currently attached socket", () => {
        const relay = new ConfiguratorRelay();
        const first = fakeSocket();
        const second = fakeSocket();
        relay.attach(first);
        relay.attach(second);
        relay.detach(first); // stale close event from the replaced socket
        expect(relay.connected).toBe(true);
        relay.detach(second);
        expect(relay.connected).toBe(false);
    });

    it("ignores invalid JSON and unknown ids", () => {
        const relay = new ConfiguratorRelay();
        relay.attach(fakeSocket());
        expect(() => relay.handleMessage("not json")).not.toThrow();
        expect(() => relay.handleMessage(JSON.stringify({ id: 999, result: 1 }))).not.toThrow();
    });
});
