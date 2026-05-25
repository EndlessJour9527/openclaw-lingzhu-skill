import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_AGE_HOURS = 24;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastCleanupAt = 0;

function readEnv(name: string): string {
  try {
    return globalThis.process?.env?.[name]?.trim() || "";
  } catch {
    return "";
  }
}

function resolveImageCacheDir(): string {
  const configuredDir = readEnv("OPENCLAW_LINGZHU_IMAGE_CACHE_DIR");
  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  const openclawHome = readEnv("OPENCLAW_HOME") || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "lingzhu", "media", "img");
}

export function getImageCacheDir(): string {
  return resolveImageCacheDir();
}

export async function ensureImageCacheDir(): Promise<string> {
  const cacheDir = getImageCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

export async function cleanupImageCache(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<{
  removed: number;
  kept: number;
}> {
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
      } else {
        kept += 1;
      }
    } catch {
      // Ignore per-file cleanup failures.
    }
  }

  lastCleanupAt = now;
  return { removed, kept };
}

export async function cleanupImageCacheIfNeeded(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  await cleanupImageCache(maxAgeHours).catch(() => undefined);
}

export async function summarizeImageCache(): Promise<{
  dir: string;
  files: number;
}> {
  const cacheDir = await ensureImageCacheDir();
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).length;
  return {
    dir: cacheDir,
    files,
  };
}
