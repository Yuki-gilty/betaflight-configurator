#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfiguratorRelay } from "./relay.js";
import { startWsHost } from "./ws-host.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.BF_BRIDGE_PORT ?? 8765);
const BIND_RETRY_MS = 15000;

// stdout is reserved for the MCP protocol - log to stderr only
process.on("uncaughtException", (error) => console.error("[mcp-bridge] uncaught exception:", error));
process.on("unhandledRejection", (error) => console.error("[mcp-bridge] unhandled rejection:", error));

const relay = new ConfiguratorRelay();
const server = new McpServer({ name: "betaflight-configurator", version: "0.2.0" });
registerTools(server, relay);

// Connect MCP first so the client sees us as healthy even while the
// websocket port is held by another bridge instance (e.g. Claude Code and
// Claude Desktop both installed - whichever starts second waits its turn).
await server.connect(new StdioServerTransport());
console.error(`[mcp-bridge] MCP connected; binding ws://127.0.0.1:${PORT}...`);

async function bindWsHost() {
    try {
        await startWsHost(relay, { port: PORT });
        console.error(`[mcp-bridge] ready: ws://127.0.0.1:${PORT} (waiting for Configurator)`);
    } catch (error) {
        if (error?.code === "EADDRINUSE") {
            console.error(
                `[mcp-bridge] port ${PORT} is in use (another Claude app is running the bridge?) - ` +
                    `retrying in ${BIND_RETRY_MS / 1000}s`,
            );
            setTimeout(bindWsHost, BIND_RETRY_MS);
        } else {
            console.error("[mcp-bridge] failed to start websocket host:", error);
        }
    }
}
bindWsHost();
