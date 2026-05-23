import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = path.resolve(__dirname, "../logs");
function sanitizeSegment(value) {
    return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}
function redactValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, innerValue] of Object.entries(value)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes("authorization") ||
                lowerKey.includes("authak") ||
                lowerKey.includes("token") ||
                lowerKey.includes("secret") ||
                lowerKey === "ak") {
                result[key] = "***redacted***";
            }
            else {
                result[key] = redactValue(innerValue);
            }
        }
        return result;
    }
    return value;
}
export function resolveDebugLogDir(config) {
    if (config.debugLogDir && config.debugLogDir.trim()) {
        return config.debugLogDir.trim();
    }
    return DEFAULT_LOG_DIR;
}
export function getDebugLogFilePath(config) {
    const now = new Date();
    const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
    ].join("-");
    return path.join(resolveDebugLogDir(config), `lingzhu-${date}.log`);
}
export function writeDebugLog(config, event, payload, always = false) {
    if (!always && config.debugLogging !== true) {
        return;
    }
    const filePath = getDebugLogFilePath(config);
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        payload: redactValue(payload),
    });
    void (async () => {
        try {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.appendFile(filePath, `${line}\n`, "utf8");
        }
        catch {
            // Ignore logging failures so debug logging cannot break request handling.
        }
    })();
}
export function summarizeForDebug(value, includePayload) {
    if (includePayload) {
        return value;
    }
    if (value && typeof value === "object") {
        const summary = {};
        for (const [key, innerValue] of Object.entries(value)) {
            if (Array.isArray(innerValue)) {
                summary[key] = `[array:${innerValue.length}]`;
            }
            else if (innerValue && typeof innerValue === "object") {
                summary[key] = "{object}";
            }
            else if (typeof innerValue === "string" && innerValue.length > 160) {
                summary[key] = `${innerValue.slice(0, 160)}...`;
            }
            else {
                summary[key] = innerValue;
            }
        }
        return summary;
    }
    return value;
}
export function buildRequestLogName(messageId, event) {
    return `${sanitizeSegment(messageId || "unknown")}.${event}`;
}
//# sourceMappingURL=debug-log.js.map