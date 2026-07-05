import { createHandlers } from "./handlers.js";

const DEFAULT_URL = "ws://127.0.0.1:8765";
const RECONNECT_DELAY_MS = 3000;

/**
 * Dev-only bridge that lets an external MCP server drive the Configurator.
 * Loaded dynamically from browserMain.js when import.meta.env.DEV is set;
 * never part of production builds.
 */
export function startAgentBridge({ url = DEFAULT_URL } = {}) {
    const handlers = createHandlers();
    let stopped = false;

    function connect() {
        if (stopped) {
            return;
        }
        const socket = new WebSocket(url);

        socket.onopen = () => {
            console.log(`[agent-bridge] connected to MCP bridge at ${url}`);
        };

        socket.onmessage = async (event) => {
            let request;
            try {
                request = JSON.parse(event.data);
            } catch {
                return;
            }
            const handler = handlers[request.method];
            let reply;
            if (!handler) {
                reply = { id: request.id, error: `Unknown method '${request.method}'` };
            } else {
                try {
                    reply = { id: request.id, result: (await handler(request.params ?? {})) ?? null };
                } catch (error) {
                    reply = { id: request.id, error: error?.message ?? String(error) };
                }
            }
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(reply));
            }
        };

        socket.onclose = () => {
            if (!stopped) {
                setTimeout(connect, RECONNECT_DELAY_MS);
            }
        };
    }

    connect();
    return function stop() {
        stopped = true;
    };
}
