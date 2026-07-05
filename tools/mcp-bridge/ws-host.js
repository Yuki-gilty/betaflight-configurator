import { WebSocketServer } from "ws";

/**
 * Hosts the websocket endpoint the Configurator dev module connects to,
 * and wires connected sockets into the relay. Resolves once listening.
 */
export function startWsHost(relay, { host = "127.0.0.1", port = 8765 } = {}) {
    return new Promise((resolve, reject) => {
        const wss = new WebSocketServer({ host, port });
        wss.on("connection", (socket) => {
            relay.attach(socket);
            socket.on("message", (raw) => relay.handleMessage(raw.toString()));
            socket.on("close", () => relay.detach(socket));
        });
        wss.on("listening", () => resolve(wss));
        wss.on("error", reject);
    });
}
