# MCP Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web版 Betaflight Configurator を MCP 経由で外部 LLM エージェントから操作できるようにする(PID/レート/フィルタの項目単位読み書き+タブ切替)。

**Architecture:** Node製の中継プロセス(`tools/mcp-bridge/`: stdio MCPサーバー + WebSocketサーバー)と、Configurator側のdev限定モジュール(`src/js/agent_bridge/`)の2コンポーネント。中継はツール呼び出しを `{id, method, params}` JSONでブラウザへ転送し、Configurator側が既存の `MSP.promise()` / `mspHelper.crunch()` / `switchTab()` を呼んで応答する。

**Tech Stack:** Node 24 / ES Modules / `@modelcontextprotocol/sdk` / `ws` / `zod` / vitest

**Spec:** `docs/superpowers/specs/2026-07-05-mcp-agent-bridge-design.md`

## Global Constraints

- WebSocket は `127.0.0.1:8765` バインドのみ。認証なし(dev限定のため)
- `src/js/agent_bridge/` は `import.meta.env.DEV` が真のときだけ動的 import(プロダクションバンドル非混入)
- モーター試運転系(`MSP_SET_MOTOR` 等)の専用ツールは作らない
- CLI コマンド注入は行わない。設定操作は MSP 構造化経路のみ
- 依存追加はルート `package.json` の devDependencies に `@modelcontextprotocol/sdk`, `ws`, `zod` のみ
- `src/` 配下の新規コードは `npm run lint`(eslint)を通すこと
- ブリッジ ⇔ Configurator 間のリクエストタイムアウトは 10 秒
- 複数タブ接続時は最後に接続したタブが有効(前のソケットは close)
- テストは vitest、`test/**/*.test.js` に配置(既存規約)

## 事前確認済みのコードベース事実(実装者向け)

- `MSP.promise(code, data)` は `src/js/msp.js:552` にあり、`data` が不要なら `false` を渡す。応答コールバックは `mspHelper.process_data`(MSPリスナー、`serial_backend.js:549` で登録)が **FC オブジェクトへの解析格納を終えた後** に発火する(`MSPHelper.js:1807-1818`)。つまり `await MSP.promise(MSPCodes.MSP_PID)` が解決した時点で `FC.PIDS` は最新。
- `mspHelper` は `src/js/msp/MSPHelper.js:3011` で `export { mspHelper }`(let のライブバインディング。FC接続前は `undefined`)。
- `mspHelper.crunch(code)` は FC オブジェクトの現在値から SET 系ペイロードを構築する。`MSP_SET_PID`(202) / `MSP_SET_RC_TUNING`(204) / `MSP_SET_FILTER_CONFIG`(93) / `MSP_SET_PID_ADVANCED`(95) すべて crunch 対応済み。
- `FC.PIDS` は 10×3 配列。軸順は ROLL=0, PITCH=1, YAW=2、項順は P=0, I=1, D=2。FF は `FC.ADVANCED_TUNING.feedforwardRoll/Pitch/Yaw`(`fc.js:573-575`)。
- `FC.RC_TUNING` / `FC.FILTER_CONFIG` はフラットな数値オブジェクト(`fc.js:290` / `fc.js:511`)。
- 接続状態は `CONFIGURATOR.connectionValid`(`src/js/data_storage.js:16`)。FC情報は `FC.CONFIG.flightControllerIdentifier` / `flightControllerVersion` / `apiVersion` / `craftName`。
- タブ切替は `src/js/tab_switch.js` の `export function switchTab(tabKey, options)`。ガードに引っかかると `false` を返す(成功時は `undefined`)。`options.mode` は接続中なら `"connected"`。現在タブは `GUI.active_tab`(`src/js/gui.js`)。
- タブ一覧は `src/components/sidebar/sidebar_items.js` の `sidebarItems`(各要素の `item.tab ?? item.key` がタブキー)。
- Web版エントリは `src/index.html` → `src/js/browserMain.js`。
- vitest 設定は `vite.config.js:136-144`(include: `test/**/*.test.{js,mjs,cjs}`、environment: jsdom、root: `.`)。Node環境が必要なテストはファイル先頭に `// @vitest-environment node` を書く。

## File Structure

```
tools/mcp-bridge/
  relay.js      # 純ロジック: pending管理・タイムアウト・socket着脱(依存ゼロ)
  ws-host.js    # WebSocketサーバー起動、relayへの配線(dep: ws)
  tools.js      # MCPツール定義とrelay転送(dep: zod)
  server.js     # エントリ: McpServer + stdio + 上記の組み立て
  README.md     # 起動方法と claude mcp add 手順
src/js/agent_bridge/
  handlers.js   # method名 → 既存API呼び出しのハンドラ表
  index.js      # WebSocket接続・再接続・dispatch
src/js/browserMain.js   # 末尾にdev限定の動的importを追加(Modify)
package.json            # devDeps追加 + "mcp-bridge" script(Modify)
test/js/tools/mcp_bridge_relay.test.js
test/js/tools/mcp_bridge_ws_host.test.js
test/js/agent_bridge/handlers.test.js
test/js/agent_bridge/transport.test.js
```

---

### Task 1: Relay(中継の純ロジック)

**Files:**
- Create: `tools/mcp-bridge/relay.js`
- Test: `test/js/tools/mcp_bridge_relay.test.js`

**Interfaces:**
- Produces: `class ConfiguratorRelay { constructor({timeoutMs=10000}={}); attach(socket); detach(socket); get connected; call(method, params) → Promise<any>; handleMessage(rawString) }`
  - `socket` は `{ send(string), close() }` を持つ任意オブジェクト(WebSocket互換)
  - `call` はソケット未接続時に即 reject、応答 `{id, error}` で reject、`{id, result}` で resolve、10秒で timeout reject

- [ ] **Step 1: 失敗するテストを書く**

`test/js/tools/mcp_bridge_relay.test.js`:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/js/tools/mcp_bridge_relay.test.js`
Expected: FAIL(`Cannot find module '../../../tools/mcp-bridge/relay.js'`)

- [ ] **Step 3: 実装**

`tools/mcp-bridge/relay.js`:

```js
/**
 * Pending-request bookkeeping between the MCP server and the Configurator
 * browser tab. Transport-agnostic: sockets only need send() and close().
 */
export class ConfiguratorRelay {
    constructor({ timeoutMs = 10000 } = {}) {
        this.socket = null;
        this.pending = new Map();
        this.nextId = 1;
        this.timeoutMs = timeoutMs;
    }

    attach(socket) {
        if (this.socket && this.socket !== socket) {
            try {
                this.socket.close();
            } catch {
                // previous socket may already be dead
            }
        }
        this.socket = socket;
    }

    detach(socket) {
        if (this.socket === socket) {
            this.socket = null;
        }
    }

    get connected() {
        return this.socket !== null;
    }

    call(method, params = {}) {
        if (!this.socket) {
            return Promise.reject(
                new Error(
                    "Configurator is not connected to the bridge. Start the app with `npm run dev` and open it in a browser.",
                ),
            );
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for Configurator response to '${method}'`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error !== undefined) {
            entry.reject(new Error(message.error));
        } else {
            entry.resolve(message.result);
        }
    }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run test/js/tools/mcp_bridge_relay.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/mcp-bridge/relay.js test/js/tools/mcp_bridge_relay.test.js
git commit -m "Add ConfiguratorRelay for MCP bridge request routing"
```

---

### Task 2: WebSocketホスト + MCPサーバー本体

**Files:**
- Create: `tools/mcp-bridge/ws-host.js`
- Create: `tools/mcp-bridge/tools.js`
- Create: `tools/mcp-bridge/server.js`
- Modify: `package.json`(devDependencies と scripts)
- Test: `test/js/tools/mcp_bridge_ws_host.test.js`

**Interfaces:**
- Consumes: Task 1 の `ConfiguratorRelay`
- Produces:
  - `startWsHost(relay, {host="127.0.0.1", port=8765}={}) → Promise<WebSocketServer>`(`listening` 後に resolve)
  - `registerTools(server, relay)` — `McpServer` に全ツールを登録
  - `node tools/mcp-bridge/server.js` で起動する stdio MCP サーバー

- [ ] **Step 1: 依存を追加**

```bash
npm install --save-dev @modelcontextprotocol/sdk ws zod
```

Expected: package.json の devDependencies に 3 つ追加され、install が成功する。

- [ ] **Step 2: 失敗するテストを書く**

`test/js/tools/mcp_bridge_ws_host.test.js`:

```js
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
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run test/js/tools/mcp_bridge_ws_host.test.js`
Expected: FAIL(`Cannot find module '../../../tools/mcp-bridge/ws-host.js'`)

- [ ] **Step 4: ws-host を実装**

`tools/mcp-bridge/ws-host.js`:

```js
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
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run test/js/tools/mcp_bridge_ws_host.test.js`
Expected: PASS (1 test)

- [ ] **Step 6: MCPツール定義を実装**

`tools/mcp-bridge/tools.js`(ロジックは relay/handlers 側でテスト済み。本ファイルは宣言的な登録のみ):

```js
import { z } from "zod";

const axisShape = z
    .object({
        P: z.number().int().min(0).max(255).optional(),
        I: z.number().int().min(0).max(255).optional(),
        D: z.number().int().min(0).max(255).optional(),
        FF: z.number().int().min(0).max(2000).optional(),
    })
    .strict();

export function registerTools(server, relay) {
    const forward = (method) => async (params) => {
        try {
            const result = await relay.call(method, params ?? {});
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error?.message ?? String(error) }] };
        }
    };

    server.registerTool(
        "get_status",
        {
            description:
                "Get Configurator/FC connection state, firmware version, craft name and the currently active tab.",
        },
        forward("get_status"),
    );

    server.registerTool(
        "list_tabs",
        { description: "List the tab keys that can be passed to switch_tab." },
        forward("list_tabs"),
    );

    server.registerTool(
        "switch_tab",
        {
            description: "Switch the Configurator UI to the given tab (e.g. 'setup', 'pid_tuning', 'receiver').",
            inputSchema: { tab: z.string() },
        },
        forward("switch_tab"),
    );

    server.registerTool(
        "get_pid_tuning",
        { description: "Read current PID values (P/I/D/FF per roll/pitch/yaw axis) from the flight controller." },
        forward("get_pid_tuning"),
    );

    server.registerTool(
        "set_pid_tuning",
        {
            description:
                "Set PID values on the flight controller (RAM only until save_to_flash). " +
                "Pass only the axes/terms you want to change, e.g. { roll: { P: 47 } }.",
            inputSchema: {
                roll: axisShape.optional(),
                pitch: axisShape.optional(),
                yaw: axisShape.optional(),
            },
        },
        forward("set_pid_tuning"),
    );

    server.registerTool(
        "get_rates",
        { description: "Read current rate settings (RC rate, expo, super rate, throttle curve...)." },
        forward("get_rates"),
    );

    server.registerTool(
        "set_rates",
        {
            description:
                "Set rate parameters (RAM only until save_to_flash). Pass only the keys to change, " +
                "e.g. { values: { roll_rate: 0.8 } }. Call get_rates first to see valid keys.",
            inputSchema: { values: z.record(z.string(), z.number()) },
        },
        forward("set_rates"),
    );

    server.registerTool(
        "get_filters",
        { description: "Read current gyro / D-term filter settings." },
        forward("get_filters"),
    );

    server.registerTool(
        "set_filters",
        {
            description:
                "Set filter parameters (RAM only until save_to_flash). Pass only the keys to change, " +
                "e.g. { values: { gyro_lowpass_hz: 100 } }. Call get_filters first to see valid keys.",
            inputSchema: { values: z.record(z.string(), z.number()) },
        },
        forward("set_filters"),
    );

    server.registerTool(
        "save_to_flash",
        {
            description:
                "DESTRUCTIVE: write current settings to the flight controller's flash (MSP_EEPROM_WRITE). " +
                "Until this is called, set_* changes live in RAM and are lost on power cycle. " +
                "Confirm with the user before calling.",
        },
        forward("save_to_flash"),
    );

    server.registerTool(
        "msp_command",
        {
            description:
                "ADVANCED / low-level escape hatch: send a raw MSP command. `code` is the MSP command id, " +
                "`data` is an optional byte array payload. Can change or break FC state - use only when no " +
                "dedicated tool exists, and confirm with the user first.",
            inputSchema: {
                code: z.number().int().min(0).max(65535),
                data: z.array(z.number().int().min(0).max(255)).optional(),
            },
        },
        forward("msp_command"),
    );
}
```

- [ ] **Step 7: エントリポイントを実装**

`tools/mcp-bridge/server.js`:

```js
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
```

- [ ] **Step 8: npm script を追加**

`package.json` の scripts に追加(`"prepare": "husky"` の後):

```json
"mcp-bridge": "node tools/mcp-bridge/server.js"
```

- [ ] **Step 9: 起動スモークチェック**

Run: `timeout 5 npm run mcp-bridge < /dev/null; echo "exit=$?"`
Expected: stderr に `[mcp-bridge] ready: ws://127.0.0.1:8765` が出る(stdin EOF で終了、またはtimeoutの124)。ポート競合エラーが出ないこと。

- [ ] **Step 10: Commit**

```bash
git add tools/mcp-bridge/ws-host.js tools/mcp-bridge/tools.js tools/mcp-bridge/server.js test/js/tools/mcp_bridge_ws_host.test.js package.json package-lock.json
git commit -m "Add MCP bridge server with websocket host and tool definitions"
```

---

### Task 3: Configurator側ハンドラ

**Files:**
- Create: `src/js/agent_bridge/handlers.js`
- Test: `test/js/agent_bridge/handlers.test.js`

**Interfaces:**
- Consumes: 既存の `FC` / `MSP.promise` / `MSPCodes` / `mspHelper.crunch` / `CONFIGURATOR.connectionValid` / `GUI.active_tab` / `switchTab` / `sidebarItems`
- Produces: `createHandlers() → { [method: string]: async (params) => result }`(method名は Task 2 の forward 名と一致: `get_status`, `list_tabs`, `switch_tab`, `get_pid_tuning`, `set_pid_tuning`, `get_rates`, `set_rates`, `get_filters`, `set_filters`, `save_to_flash`, `msp_command`)

- [ ] **Step 1: 失敗するテストを書く**

`test/js/agent_bridge/handlers.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFC = {
    PIDS: [],
    ADVANCED_TUNING: {},
    RC_TUNING: {},
    FILTER_CONFIG: {},
    CONFIG: {},
};
const mockMSP = { promise: vi.fn() };
const mockCONFIGURATOR = { connectionValid: true };
const mockGUI = { active_tab: "setup" };
const mockSwitchTab = vi.fn();
const mockCrunch = vi.fn(() => new Uint8Array([1, 2]));

vi.mock("../../../src/js/fc.js", () => ({ default: mockFC }));
vi.mock("../../../src/js/msp.js", () => ({ default: mockMSP }));
vi.mock("../../../src/js/data_storage.js", () => ({ default: mockCONFIGURATOR }));
vi.mock("../../../src/js/gui.js", () => ({ default: mockGUI }));
vi.mock("../../../src/js/tab_switch.js", () => ({ switchTab: mockSwitchTab }));
vi.mock("../../../src/js/msp/MSPHelper.js", () => ({ mspHelper: { crunch: mockCrunch } }));
vi.mock("../../../src/components/sidebar/sidebar_items.js", () => ({
    sidebarItems: [{ tab: "setup", i18n: "tabSetup" }, { key: "pid_tuning", i18n: "tabPidTuning" }],
}));

const { createHandlers } = await import("../../../src/js/agent_bridge/handlers.js");
const MSPCodes = (await import("../../../src/js/msp/MSPCodes.js")).default;

describe("agent bridge handlers", () => {
    let handlers;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCONFIGURATOR.connectionValid = true;
        mockGUI.active_tab = "setup";
        mockMSP.promise.mockResolvedValue({});
        mockFC.PIDS = [
            [40, 30, 20],
            [41, 31, 21],
            [42, 32, 0],
        ];
        mockFC.ADVANCED_TUNING = { feedforwardRoll: 100, feedforwardPitch: 101, feedforwardYaw: 102 };
        mockFC.RC_TUNING = { roll_rate: 0.7, rcYawRate: 1.0 };
        mockFC.FILTER_CONFIG = { gyro_lowpass_hz: 250, dterm_lowpass_hz: 150 };
        mockFC.CONFIG = {
            flightControllerIdentifier: "BTFL",
            flightControllerVersion: "4.5.1",
            apiVersion: "1.46.0",
            craftName: "testquad",
            name: "",
        };
        handlers = createHandlers();
    });

    it("get_status reports connection, firmware and active tab", async () => {
        const status = await handlers.get_status();
        expect(status).toEqual({
            fcConnected: true,
            firmware: "BTFL 4.5.1",
            apiVersion: "1.46.0",
            craftName: "testquad",
            activeTab: "setup",
        });
    });

    it("get_status works while disconnected", async () => {
        mockCONFIGURATOR.connectionValid = false;
        mockFC.CONFIG.flightControllerIdentifier = "";
        const status = await handlers.get_status();
        expect(status.fcConnected).toBe(false);
        expect(status.firmware).toBeNull();
    });

    it("list_tabs returns tab keys from sidebar items", async () => {
        await expect(handlers.list_tabs()).resolves.toEqual({ tabs: ["setup", "pid_tuning"] });
    });

    it("switch_tab calls switchTab with connected mode and throws on refusal", async () => {
        mockSwitchTab.mockReturnValueOnce(undefined);
        await expect(handlers.switch_tab({ tab: "pid_tuning" })).resolves.toEqual({ activeTab: "pid_tuning" });
        expect(mockSwitchTab).toHaveBeenCalledWith("pid_tuning", { mode: "connected" });

        mockSwitchTab.mockReturnValueOnce(false);
        await expect(handlers.switch_tab({ tab: "osd" })).rejects.toThrow(/could not switch/i);
    });

    it("get_pid_tuning refreshes from MSP and returns per-axis values", async () => {
        const result = await handlers.get_pid_tuning();
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_PID, false);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_PID_ADVANCED, false);
        expect(result.roll).toEqual({ P: 40, I: 30, D: 20, FF: 100 });
        expect(result.yaw).toEqual({ P: 42, I: 32, D: 0, FF: 102 });
    });

    it("set_pid_tuning updates only the requested terms and writes both MSP messages", async () => {
        const result = await handlers.set_pid_tuning({ roll: { P: 47 }, pitch: { D: 38, FF: 120 } });
        expect(mockFC.PIDS[0][0]).toBe(47);
        expect(mockFC.PIDS[0][1]).toBe(30); // untouched
        expect(mockFC.PIDS[1][2]).toBe(38);
        expect(mockFC.ADVANCED_TUNING.feedforwardPitch).toBe(120);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID_ADVANCED);
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_SET_PID, expect.any(Uint8Array));
        expect(result.roll.P).toBe(47);
    });

    it("set_rates updates known keys and rejects unknown keys", async () => {
        const result = await handlers.set_rates({ values: { roll_rate: 0.9 } });
        expect(mockFC.RC_TUNING.roll_rate).toBe(0.9);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_RC_TUNING);
        expect(result.roll_rate).toBe(0.9);

        await expect(handlers.set_rates({ values: { nope: 1 } })).rejects.toThrow(/unknown parameter.*nope/i);
    });

    it("set_filters updates known keys via MSP_SET_FILTER_CONFIG", async () => {
        const result = await handlers.set_filters({ values: { gyro_lowpass_hz: 100 } });
        expect(mockFC.FILTER_CONFIG.gyro_lowpass_hz).toBe(100);
        expect(mockCrunch).toHaveBeenCalledWith(MSPCodes.MSP_SET_FILTER_CONFIG);
        expect(result.gyro_lowpass_hz).toBe(100);
    });

    it("save_to_flash sends MSP_EEPROM_WRITE", async () => {
        await expect(handlers.save_to_flash()).resolves.toEqual({ saved: true });
        expect(mockMSP.promise).toHaveBeenCalledWith(MSPCodes.MSP_EEPROM_WRITE, false);
    });

    it("msp_command forwards raw payload and returns response bytes", async () => {
        const buffer = Uint8Array.from([9, 8, 7]).buffer;
        mockMSP.promise.mockResolvedValueOnce({ dataView: new DataView(buffer) });
        const result = await handlers.msp_command({ code: 112, data: [1, 2] });
        expect(mockMSP.promise).toHaveBeenCalledWith(112, expect.any(Uint8Array));
        expect(result).toEqual({ code: 112, response: [9, 8, 7] });
    });

    it("write handlers reject when FC is not connected", async () => {
        mockCONFIGURATOR.connectionValid = false;
        await expect(handlers.get_pid_tuning()).rejects.toThrow(/not connected/i);
        await expect(handlers.set_rates({ values: { roll_rate: 1 } })).rejects.toThrow(/not connected/i);
        await expect(handlers.save_to_flash()).rejects.toThrow(/not connected/i);
    });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/js/agent_bridge/handlers.test.js`
Expected: FAIL(`Cannot find module '../../../src/js/agent_bridge/handlers.js'`)

- [ ] **Step 3: 実装**

`src/js/agent_bridge/handlers.js`:

```js
import FC from "../fc.js";
import MSP from "../msp.js";
import MSPCodes from "../msp/MSPCodes.js";
import { mspHelper } from "../msp/MSPHelper.js";
import CONFIGURATOR from "../data_storage.js";
import GUI from "../gui.js";
import { switchTab } from "../tab_switch.js";
import { sidebarItems } from "../../components/sidebar/sidebar_items.js";

const AXES = [
    ["roll", 0, "feedforwardRoll"],
    ["pitch", 1, "feedforwardPitch"],
    ["yaw", 2, "feedforwardYaw"],
];
const PID_TERMS = [
    ["P", 0],
    ["I", 1],
    ["D", 2],
];

function requireFc() {
    if (!CONFIGURATOR.connectionValid) {
        throw new Error("FC not connected. Ask the user to connect the flight controller in the Configurator first.");
    }
}

function pidSnapshot() {
    const result = {};
    for (const [axis, index, ffKey] of AXES) {
        result[axis] = {
            P: FC.PIDS[index][0],
            I: FC.PIDS[index][1],
            D: FC.PIDS[index][2],
            FF: FC.ADVANCED_TUNING[ffKey],
        };
    }
    return result;
}

async function refreshPids() {
    await MSP.promise(MSPCodes.MSP_PID, false);
    await MSP.promise(MSPCodes.MSP_PID_ADVANCED, false);
}

// Shared read-modify-write cycle for flat numeric sections (rates, filters).
async function updateSection({ readCode, writeCode, getTarget, values }) {
    requireFc();
    await MSP.promise(readCode, false);
    const target = getTarget();
    const unknown = Object.keys(values ?? {}).filter((key) => !(key in target));
    if (unknown.length > 0) {
        throw new Error(
            `Unknown parameter(s): ${unknown.join(", ")}. Valid parameters: ${Object.keys(target).join(", ")}`,
        );
    }
    Object.assign(target, values);
    await MSP.promise(writeCode, mspHelper.crunch(writeCode));
    await MSP.promise(readCode, false);
    return { ...getTarget() };
}

export function createHandlers() {
    return {
        async get_status() {
            const { flightControllerIdentifier, flightControllerVersion, apiVersion, craftName, name } = FC.CONFIG;
            return {
                fcConnected: CONFIGURATOR.connectionValid,
                firmware: flightControllerIdentifier
                    ? `${flightControllerIdentifier} ${flightControllerVersion}`
                    : null,
                apiVersion: apiVersion ?? null,
                craftName: craftName || name || null,
                activeTab: GUI.active_tab || null,
            };
        },

        async list_tabs() {
            return { tabs: sidebarItems.map((item) => item.tab ?? item.key).filter(Boolean) };
        },

        async switch_tab({ tab }) {
            const mode = CONFIGURATOR.connectionValid ? "connected" : "disconnected";
            const refused = switchTab(tab, { mode }) === false;
            if (refused) {
                throw new Error(
                    `Could not switch to tab '${tab}' (tab is locked, already active, or not allowed right now).`,
                );
            }
            return { activeTab: tab };
        },

        async get_pid_tuning() {
            requireFc();
            await refreshPids();
            return pidSnapshot();
        },

        async set_pid_tuning(params) {
            requireFc();
            await refreshPids();
            for (const [axis, index, ffKey] of AXES) {
                const changes = params?.[axis];
                if (!changes) {
                    continue;
                }
                for (const [term, termIndex] of PID_TERMS) {
                    if (changes[term] !== undefined) {
                        FC.PIDS[index][termIndex] = changes[term];
                    }
                }
                if (changes.FF !== undefined) {
                    FC.ADVANCED_TUNING[ffKey] = changes.FF;
                }
            }
            await MSP.promise(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID));
            await MSP.promise(MSPCodes.MSP_SET_PID_ADVANCED, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED));
            await refreshPids();
            return pidSnapshot();
        },

        async get_rates() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_RC_TUNING, false);
            return { ...FC.RC_TUNING };
        },

        async set_rates({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_RC_TUNING,
                writeCode: MSPCodes.MSP_SET_RC_TUNING,
                getTarget: () => FC.RC_TUNING,
                values,
            });
        },

        async get_filters() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_FILTER_CONFIG, false);
            return { ...FC.FILTER_CONFIG };
        },

        async set_filters({ values } = {}) {
            return updateSection({
                readCode: MSPCodes.MSP_FILTER_CONFIG,
                writeCode: MSPCodes.MSP_SET_FILTER_CONFIG,
                getTarget: () => FC.FILTER_CONFIG,
                values,
            });
        },

        async save_to_flash() {
            requireFc();
            await MSP.promise(MSPCodes.MSP_EEPROM_WRITE, false);
            return { saved: true };
        },

        async msp_command({ code, data } = {}) {
            requireFc();
            const payload = Array.isArray(data) && data.length > 0 ? Uint8Array.from(data) : false;
            const response = await MSP.promise(code, payload);
            const view = response?.dataView;
            const bytes = view ? Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) : [];
            return { code, response: bytes };
        },
    };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run test/js/agent_bridge/handlers.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: lint 確認**

Run: `npx eslint src/js/agent_bridge/handlers.js`
Expected: エラー 0

- [ ] **Step 6: Commit**

```bash
git add src/js/agent_bridge/handlers.js test/js/agent_bridge/handlers.test.js
git commit -m "Add agent bridge handlers for MSP and tab operations"
```

---

### Task 4: Configurator側トランスポート + dev限定フック

**Files:**
- Create: `src/js/agent_bridge/index.js`
- Modify: `src/js/browserMain.js`(末尾に追記)
- Test: `test/js/agent_bridge/transport.test.js`

**Interfaces:**
- Consumes: Task 3 の `createHandlers()`
- Produces: `startAgentBridge({url?}) → stop関数`。ブリッジからの `{id, method, params}` を受けてハンドラを実行し `{id, result}` / `{id, error}` を返信。切断時 3 秒間隔で再接続。

- [ ] **Step 1: 失敗するテストを書く**

`test/js/agent_bridge/transport.test.js`:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run test/js/agent_bridge/transport.test.js`
Expected: FAIL(`Cannot find module '../../../src/js/agent_bridge/index.js'`)

- [ ] **Step 3: 実装**

`src/js/agent_bridge/index.js`:

```js
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run test/js/agent_bridge/transport.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: browserMain.js にdev限定フックを追加**

`src/js/browserMain.js` の末尾に追記:

```js
// Dev-only: allow an external MCP agent to drive the Configurator.
// The module is loaded dynamically so it is never part of production builds.
if (import.meta.env.DEV) {
    import("./agent_bridge/index.js")
        .then(({ startAgentBridge }) => startAgentBridge())
        .catch((error) => console.warn("[agent-bridge] failed to start", error));
}
```

- [ ] **Step 6: lint + 全テスト確認**

Run: `npx eslint src/js/agent_bridge/ src/js/browserMain.js && npx vitest run test/js/agent_bridge/ test/js/tools/`
Expected: lint エラー 0、テスト全 PASS

- [ ] **Step 7: プロダクションバンドル非混入の確認**

Run: `npm run build 2>&1 | tail -5 && ! grep -rl "agent-bridge" dist/assets/ && echo "OK: not in production bundle"`
Expected: build 成功、`OK: not in production bundle` が出力される

- [ ] **Step 8: Commit**

```bash
git add src/js/agent_bridge/index.js src/js/browserMain.js test/js/agent_bridge/transport.test.js
git commit -m "Connect Configurator to MCP bridge in dev mode"
```

---

### Task 5: ドキュメント + E2E検証

**Files:**
- Create: `tools/mcp-bridge/README.md`

**Interfaces:**
- Consumes: Task 1-4 の全成果物

- [ ] **Step 1: README を書く**

`tools/mcp-bridge/README.md`(内容は以下をそのまま使用):

- タイトル: Betaflight Configurator MCP Bridge
- 概要: dev限定でMCPクライアント(Claude Code等)からConfiguratorを操作するブリッジ。PID/レート/フィルタの項目単位読み書きとタブ切替。
- アーキテクチャ図: `MCP client --stdio--> tools/mcp-bridge/server.js --ws://127.0.0.1:8765--> Configurator dev tab`
- セットアップ手順:
  1. `npm install`(リポジトリルート)
  2. `npm run dev` でConfigurator起動、ブラウザで開く
  3. ConfiguratorでFCを接続
  4. `claude mcp add betaflight -- node /ABSOLUTE/PATH/TO/betaflight-configurator/tools/mcp-bridge/server.js`
- ツール一覧表(get_status / list_tabs / switch_tab / get_pid_tuning / set_pid_tuning / get_rates / set_rates / get_filters / set_filters / save_to_flash / msp_command と各説明)
- 安全性: RAM変更は `save_to_flash` まで揮発、127.0.0.1のみバインド、モーター制御ツールなし、`BF_BRIDGE_PORT` でポート変更可

- [ ] **Step 2: 全テスト + lint の最終確認**

Run: `npm run lint && npx vitest run`
Expected: どちらも成功(既存テストへの回帰なし)

- [ ] **Step 3: E2E チェックリスト(手動、FC実機またはVirtualFC)**

1. ターミナルA: `npm run dev` → ブラウザで開く
2. ブラウザのdevtoolsコンソールに `[agent-bridge] connected to MCP bridge` が出る(ブリッジ未起動なら3秒毎に再接続試行)
3. `claude mcp add betaflight -- node <abs path>/tools/mcp-bridge/server.js` で登録し、Claude Code から:
   - `get_status` → 接続状態が返る
   - `switch_tab { tab: "pid_tuning" }` → 画面のタブが切り替わる
   - `get_pid_tuning` → PIDタブの表示値と一致する
   - `set_pid_tuning { roll: { P: +1 } }` → PIDタブをリロードすると変わっている
   - `save_to_flash` → FC再接続後も値が保持されている

- [ ] **Step 4: Commit**

```bash
git add tools/mcp-bridge/README.md
git commit -m "Add MCP bridge documentation"
```
