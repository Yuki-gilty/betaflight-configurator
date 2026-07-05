# Betaflight Configurator MCP Bridge

Dev-only bridge that lets an MCP client (Claude Code, Claude Desktop, ...)
drive the web version of Betaflight Configurator: read/write PID, rate and
filter parameters item-by-item over MSP, and switch UI tabs.

日本語の使い方ガイドは [MANUAL.ja.md](./MANUAL.ja.md) を参照してください。

## Architecture

```
MCP client (Claude Code) --stdio--> tools/mcp-bridge/server.js --ws://127.0.0.1:8765--> Configurator dev tab
```

The Configurator side (`src/js/agent_bridge/`) is only loaded when the app
runs in Vite dev mode (`npm run dev`); it is never part of production builds.

## Setup

1. Install dependencies (repo root): `npm install`
2. Start the Configurator: `npm run dev` and open the app in a browser
3. Connect your flight controller in the Configurator
4. Register the bridge with Claude Code:

   ```bash
   claude mcp add betaflight -- node /ABSOLUTE/PATH/TO/betaflight-configurator/tools/mcp-bridge/server.js
   ```

   (Claude Desktop: add the same command to `mcpServers` in its config.)

The bridge can also be started manually with `npm run mcp-bridge` to check
that it boots, but MCP clients normally spawn it themselves via the command
registered above.

## Tools

| Tool | Description |
| --- | --- |
| `get_status` | Connection state, firmware, craft name, active tab |
| `list_tabs` / `switch_tab` | Inspect and drive UI tab navigation |
| `get_pid_tuning` / `set_pid_tuning` | P/I/D/FF per axis, partial updates (`{ roll: { P: 47 } }`) |
| `get_rates` / `set_rates` | Rate parameters, partial updates by key |
| `get_filters` / `set_filters` | Gyro/D-term filter parameters, partial updates by key |
| `save_to_flash` | Persist RAM changes to flash (destructive - confirm first) |
| `msp_command` | Raw MSP escape hatch (advanced) |

`set_*` changes live in FC RAM until `save_to_flash` is called - a power
cycle reverts them, which is intentional for safe experimentation.

## Safety

- WebSocket binds to 127.0.0.1 only; nothing is exposed to the network
- No motor-control tools are provided
- `BF_BRIDGE_PORT` overrides the bridge's port (default 8765). The
  Configurator side always connects to 8765, so if you change it you must
  also update `DEFAULT_URL` in `src/js/agent_bridge/index.js`
