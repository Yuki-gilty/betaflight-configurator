# Betaflight Configurator MCP Bridge

A standard stdio MCP server, so it works with any MCP client (Claude Code,
Claude Desktop, Codex CLI, ...). It drives the web version of Betaflight
Configurator: read/write PID, rate and filter parameters item-by-item over
MSP, and switch UI tabs.

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
4. Register the bridge with your MCP client:

   **Claude Code**

   ```bash
   claude mcp add betaflight -- node /ABSOLUTE/PATH/TO/betaflight-configurator/tools/mcp-bridge/server.js
   ```

   **Claude Desktop** — add the same command to `mcpServers` in its config,
   or install the packaged extension (`npm run mcp-bridge:mcpb`).

   **Codex CLI** — add to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.betaflight]
   command = "node"
   args = ["/ABSOLUTE/PATH/TO/betaflight-configurator/tools/mcp-bridge/server.js"]
   ```

   Any other MCP client works too: the server speaks stdio MCP, so point the
   client at `node .../tools/mcp-bridge/server.js`.

The bridge can also be started manually with `npm run mcp-bridge` to check
that it boots, but MCP clients normally spawn it themselves via the command
registered above.

Note: the WebSocket port (8765) is shared, so only one MCP client can be
connected to the Configurator at a time. A second client's bridge process
stays alive and takes over automatically once the first one exits.

## Tools

| Tool | Description |
| --- | --- |
| `get_status` | Connection state, firmware, craft name, active tab |
| `list_tabs` / `switch_tab` | Inspect and drive UI tab navigation |
| `get_pid_tuning` / `set_pid_tuning` | `profile` (active PID/rate profile + names), `pids` (P/I/D/D_MAX/FF per axis), `level` (Angle/Horizon), `sliders` (simplified-tuning sliders) + `advanced` (full advanced-tuning profile: TPA, anti-gravity, I-term relax, feedforward details...). Partial updates (`{ roll: { P: 47 } }`) |
| `set_advanced_tuning` | Advanced PID-profile parameters (tpaRate, antiGravityGain, itermRelax, throttleBoost...), partial updates by key |
| `get_rates` / `set_rates` | Rate parameters, partial updates by key |
| `get_filters` / `set_filters` | Gyro/D-term filter parameters incl. dynamic notch & RPM filter (+ filter multiplier slider state in `_sliders`), partial updates by key |
| `save_to_flash` | Persist RAM changes to flash (destructive - confirm first) |
| `get_blackbox_info` | Onboard dataflash state (supported/used bytes) |
| `download_blackbox` / `blackbox_download_status` | Background download of the blackbox log to a local .bbl |
| `erase_blackbox` | Erase onboard dataflash (destructive - confirm first) |
| `msp_command` | Raw MSP escape hatch (advanced) |

Read tools decode enum fields (filter types PT1/BIQUAD/PT2/PT3, rates type,
TPA mode, I-term relax type, ...) into a `_labels` companion object returned
alongside the raw numeric values.

## Blackbox auto-tuning

`analyze_bbl.py` decodes a .bbl (via `blackbox_decode`) and outputs per-axis
step-response metrics, gyro noise summaries and motor saturation as JSON for
an LLM to interpret. The `/bb-tune` project skill (`.claude/skills/bb-tune/`)
orchestrates the whole download → analyze → propose → apply loop. See
MANUAL.ja.md §8 for the user-facing workflow.

`set_*` changes live in FC RAM until `save_to_flash` is called - a power
cycle reverts them, which is intentional for safe experimentation.

## Safety

- WebSocket binds to 127.0.0.1 only; nothing is exposed to the network
- No motor-control tools are provided
- `BF_BRIDGE_PORT` overrides the bridge's port (default 8765). The
  Configurator side always connects to 8765, so if you change it you must
  also update `DEFAULT_URL` in `src/js/agent_bridge/index.js`
