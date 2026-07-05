// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadBlackbox } from "../../../tools/mcp-bridge/downloader.js";

function fakeRelay(flash, { supported = true } = {}) {
    return {
        call: async (method, params) => {
            if (method === "get_blackbox_info") {
                return { ready: true, supported, sectors: 1, totalSize: 8192, usedSize: flash.length };
            }
            if (method === "read_dataflash_chunk") {
                const chunk = flash.subarray(params.address, params.address + params.size);
                return { address: params.address, bytes: chunk.length, base64: Buffer.from(chunk).toString("base64") };
            }
            throw new Error(`unexpected method ${method}`);
        },
    };
}

describe("downloadBlackbox", () => {
    it("downloads the used flash to a file in chunks", async () => {
        const flash = Uint8Array.from({ length: 10000 }, (_, i) => i % 251);
        const filePath = path.join(mkdtempSync(path.join(tmpdir(), "bbl-")), "log.bbl");
        const progress = [];

        const result = await downloadBlackbox(fakeRelay(flash), {
            filePath,
            chunkSize: 4096,
            onProgress: (read, total) => progress.push([read, total]),
        });

        expect(result).toEqual({ filePath, bytesRead: 10000, totalBytes: 10000 });
        expect(Buffer.compare(readFileSync(filePath), Buffer.from(flash))).toBe(0);
        expect(progress.at(-1)).toEqual([10000, 10000]);
    });

    it("rejects when dataflash is unsupported or empty", async () => {
        const filePath = path.join(mkdtempSync(path.join(tmpdir(), "bbl-")), "log.bbl");
        await expect(
            downloadBlackbox(fakeRelay(new Uint8Array(0), { supported: false }), { filePath }),
        ).rejects.toThrow(/not supported/i);
        await expect(downloadBlackbox(fakeRelay(new Uint8Array(0)), { filePath })).rejects.toThrow(/empty/i);
    });
});
