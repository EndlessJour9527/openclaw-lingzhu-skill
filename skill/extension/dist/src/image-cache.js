import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_CACHE_DIR = path.resolve(__dirname, "../../.cache/img");
const DEFAULT_MAX_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastCleanupAt = 0;
export function getImageCacheDir() {
    return IMAGE_CACHE_DIR;
}
export async function ensureImageCacheDir() {
    await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
    return IMAGE_CACHE_DIR;
}
export async function cleanupImageCache(maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
    const cacheDir = await ensureImageCacheDir();
    const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    const maxAgeMs = Math.max(1, maxAgeHours) * 60 * 60 * 1000;
    let removed = 0;
    let kept = 0;
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const filePath = path.join(cacheDir, entry.name);
        try {
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
                await fs.unlink(filePath);
                removed += 1;
            }
            else {
                kept += 1;
            }
        }
        catch {
            // Ignore per-file cleanup failures.
        }
    }
    lastCleanupAt = now;
    return { removed, kept };
}
export async function cleanupImageCacheIfNeeded(maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
        return;
    }
    await cleanupImageCache(maxAgeHours).catch(() => undefined);
}
export async function summarizeImageCache() {
    const cacheDir = await ensureImageCacheDir();
    const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.isFile()).length;
    return {
        dir: cacheDir,
        files,
    };
}
//# sourceMappingURL=image-cache.js.map