// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { ConfiguratorRelay } from "../../../tools/mcp-bridge/relay.js";
import { startWsHost } from "../../../tools/mcp-bridge/ws-host.js";

describe("startWsHost", () => {
    let wss;
    let client;

    afterEach(async () => {
        client?.close();
        await new Promise((resolve) => (wss ? wss.close(resolve) : resolve()));
    });

    it("round-trips a relay call through a websocket client", async () => {
        const relay = new ConfiguratorRelay();
        wss = await startWsHost(relay, { port: 0 }); // port 0 = OS assigns a free port
        const port = wss.address().port;

        client = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve) => client.on("open", resolve));

        // fake configurator: echo every request back as a result
        client.on("message", (raw) => {
            const { id, method, params } = JSON.parse(raw.toString());
            client.send(JSON.stringify({ id, result: { method, params } }));
        });

        // wait until the server side attached the socket
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(relay.connected).toBe(true);

        const result = await relay.call("get_status", { a: 1 });
        expect(result).toEqual({ method: "get_status", params: { a: 1 } });
    });
});
