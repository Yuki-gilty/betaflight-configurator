import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Streams the FC's used dataflash to a .bbl file by asking the Configurator
 * for chunks over the relay. Flash reads over MSP are slow (roughly a minute
 * per few MB), so callers should run this as a background job and poll.
 */
export async function downloadBlackbox(relay, { filePath, chunkSize = 4096, onProgress } = {}) {
    const info = await relay.call("get_blackbox_info", {});
    if (!info.supported) {
        throw new Error(
            "Onboard dataflash is not supported on this FC (SD-card logging boards must be read directly).",
        );
    }
    const totalBytes = info.usedSize;
    if (!totalBytes) {
        throw new Error("Dataflash is empty - no blackbox log to download.");
    }

    mkdirSync(path.dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath);
    let address = 0;
    try {
        while (address < totalBytes) {
            const size = Math.min(chunkSize, totalBytes - address);
            const chunk = await relay.call("read_dataflash_chunk", { address, size });
            if (!chunk.bytes) {
                break; // device reported end of data early
            }
            const buffer = Buffer.from(chunk.base64, "base64");
            await new Promise((resolve, reject) => stream.write(buffer, (err) => (err ? reject(err) : resolve())));
            address += buffer.length;
            onProgress?.(address, totalBytes);
        }
    } finally {
        await new Promise((resolve) => stream.end(resolve));
    }
    return { filePath, bytesRead: address, totalBytes };
}
