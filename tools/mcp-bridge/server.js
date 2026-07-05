#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfiguratorRelay } from "./relay.js";
import { startWsHost } from "./ws-host.js";
import { registerTools } from "./tools.js";

const PORT = Number(process.env.BF_BRIDGE_PORT ?? 8765);

const relay = new ConfiguratorRelay();
await startWsHost(relay, { port: PORT });

const server = new McpServer({ name: "betaflight-configurator", version: "0.1.0" });
registerTools(server, relay);
await server.connect(new StdioServerTransport());

// stdout is reserved for the MCP protocol - log to stderr only
console.error(`[mcp-bridge] ready: ws://127.0.0.1:${PORT} (waiting for Configurator dev tab)`);
