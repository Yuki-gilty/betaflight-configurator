#!/usr/bin/env node
/**
 * Packages the MCP bridge as a Claude Desktop extension (.mcpb).
 * Users install it by double-clicking - no Node.js required on their machine
 * (Claude Desktop ships its own Node runtime for extensions).
 *
 * Usage: node tools/mcp-bridge/build-mcpb.mjs
 * Output: tools/mcp-bridge/dist-mcpb/betaflight-mcp.mcpb
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist-mcpb");
const staging = path.join(outDir, "staging");
const output = path.join(outDir, "betaflight-mcp.mcpb");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(staging, "server"), { recursive: true });

for (const file of ["server.js", "relay.js", "ws-host.js", "tools.js", "downloader.js"]) {
    cpSync(path.join(here, file), path.join(staging, "server", file));
}

const manifest = {
    manifest_version: "0.2",
    name: "betaflight-configurator",
    display_name: "Betaflight Configurator",
    version: "0.2.0",
    description:
        "Control Betaflight Configurator from Claude: read/write PID, rates and filters, switch tabs, download blackbox logs.",
    author: { name: "Betaflight MCP bridge (personal build)" },
    server: {
        type: "node",
        entry_point: "server/server.js",
        mcp_config: {
            command: "node",
            args: ["${__dirname}/server/server.js"],
        },
    },
};
writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

writeFileSync(
    path.join(staging, "package.json"),
    JSON.stringify(
        {
            name: "betaflight-mcp-bridge",
            version: manifest.version,
            type: "module",
            dependencies: {
                "@modelcontextprotocol/sdk": "^1.0.0",
                ws: "^8.0.0",
                zod: "^3.0.0",
            },
        },
        null,
        2,
    ),
);

console.log("Installing production dependencies into staging...");
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: staging, stdio: "inherit" });

console.log("Packing .mcpb...");
try {
    execSync(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${output}"`, { stdio: "inherit" });
} catch {
    // Fallback: an .mcpb is a zip archive with manifest.json at the root
    console.log("mcpb CLI unavailable - falling back to plain zip");
    execSync(`cd "${staging}" && zip -qr "${output}" .`, { stdio: "inherit" });
}

if (!existsSync(output)) {
    process.exit(1);
}
console.log(`\nDone: ${output}`);
console.log("Install: double-click the file (or drag it onto Claude Desktop > Settings > Extensions).");
