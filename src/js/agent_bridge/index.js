import { createHandlers } from "./handlers.js";
import { get as getConfig, set as setConfig } from "../ConfigStorage.js";
import { gui_log } from "../gui_log.js";
import { i18n } from "../localization.js";

const DEFAULT_URL = "ws://127.0.0.1:8765";
const RECONNECT_DELAY_MS = 3000;

/**
 * Bridge that lets an external MCP server (Claude Desktop / Claude Code)
 * drive the Configurator. Loaded in dev mode and Tauri desktop builds;
 * connects only while the user has enabled it in Options.
 */
export function startAgentBridge({ url = DEFAULT_URL, onStatus } = {}) {
    const handlers = createHandlers();
    let stopped = false;

    function connect() {
        if (stopped) {
            return;
        }
        const socket = new WebSocket(url);

        socket.onopen = () => {
            console.log(`[agent-bridge] connected to MCP bridge at ${url}`);
            onStatus?.(true);
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
            onStatus?.(false);
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

// --- user-facing on/off switch and connection state ---

const state = { enabled: false, connected: false };
const listeners = new Set();
let stopBridge = null;

function notifyListeners() {
    for (const listener of listeners) {
        listener({ ...state });
    }
}

function handleStatus(connected) {
    if (state.connected === connected) {
        return;
    }
    state.connected = connected;
    gui_log(i18n.getMessage(connected ? "agentBridgeConnected" : "agentBridgeDisconnected"));
    notifyListeners();
}

function start() {
    if (stopBridge) {
        return;
    }
    state.enabled = true;
    stopBridge = startAgentBridge({ onStatus: handleStatus });
    notifyListeners();
}

function stop() {
    stopBridge?.();
    stopBridge = null;
    state.enabled = false;
    if (state.connected) {
        state.connected = false;
        gui_log(i18n.getMessage("agentBridgeDisconnected"));
    }
    notifyListeners();
}

/** Subscribe to {enabled, connected} changes. Returns an unsubscribe function. */
export function subscribeAgentBridge(listener) {
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
}

/** Toggle from the Options dialog; persists the choice. */
export function setAgentBridgeEnabled(value) {
    setConfig({ agentBridgeEnabled: !!value });
    if (value) {
        start();
    } else {
        stop();
    }
}

/** Called once at startup; connects if the user enabled it (default: on in dev). */
export function initAgentBridge() {
    const { agentBridgeEnabled } = getConfig("agentBridgeEnabled", import.meta.env.DEV);
    if (agentBridgeEnabled) {
        start();
    }
}
