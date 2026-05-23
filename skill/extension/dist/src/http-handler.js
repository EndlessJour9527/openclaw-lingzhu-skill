import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createFollowUpResponse, detectIntentFromText, extractFollowUpFromText, formatLingzhuSSE, lingzhuToOpenAI, parseToolCallFromAccumulated, ToolCallAccumulator, } from "./transform.js";
import { buildRequestLogName, summarizeForDebug, writeDebugLog } from "./debug-log.js";
import { cleanupImageCacheIfNeeded, ensureImageCacheDir } from "./image-cache.js";
import { lingzhuEventBus } from "./events.js";
const REMOTE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_IMAGE_TIMEOUT_MS = 15000;
function resolveMaxImageBytes(config) {
    if (typeof config.maxImageBytes === "number" && Number.isFinite(config.maxImageBytes)) {
        return Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Math.trunc(config.maxImageBytes)));
    }
    return 5 * 1024 * 1024;
}
function normalizeContext(metadata) {
    if (!metadata || typeof metadata !== "object") {
        return undefined;
    }
    if ("context" in metadata && metadata.context && typeof metadata.context === "object") {
        return metadata.context;
    }
    return metadata;
}
function extractFallbackUserText(messages) {
    return messages
        .map((message) => message.text || message.content || "")
        .filter(Boolean)
        .join(" ")
        .trim();
}
function buildSessionKey(config, body) {
    const namespace = config.sessionNamespace || "lingzhu";
    const targetAgentId = config.agentId || body.agent_id || "main";
    const userId = body.user_id || body.agent_id || "anonymous";
    switch (config.sessionMode) {
        case "shared_agent":
            return `agent:${targetAgentId}:${namespace}_shared`;
        case "per_message":
            return `agent:${targetAgentId}:${namespace}_${body.message_id}`;
        case "per_user":
        default:
            return `agent:${targetAgentId}:${namespace}_${userId}`;
    }
}
function verifyAuth(authHeader, expectedAk) {
    if (!expectedAk) {
        return true;
    }
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!header) {
        return false;
    }
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        return false;
    }
    return match[1].trim() === expectedAk;
}
async function readJsonBody(req, maxBytes = 1024 * 1024) {
    const chunks = [];
    let totalBytes = 0;
    return new Promise((resolve, reject) => {
        req.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                reject(new Error(`Request body too large (>${maxBytes} bytes)`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf-8");
                resolve(body ? JSON.parse(body) : {});
            }
            catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}
function readHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value ?? "";
}
async function downloadImageToFile(imageUrl, maxBytes) {
    try {
        const validatedUrl = await validateRemoteImageUrl(imageUrl);
        if (!validatedUrl) {
            return null;
        }
        const response = await requestValidatedRemoteImage(validatedUrl);
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            return null;
        }
        const contentLength = Number(readHeaderValue(response.headers["content-length"]) || "0");
        if (contentLength > maxBytes) {
            response.resume();
            return null;
        }
        const contentType = readHeaderValue(response.headers["content-type"]).toLowerCase();
        if (contentType && !contentType.startsWith("image/")) {
            response.resume();
            return null;
        }
        const ext = contentType.includes("png")
            ? ".png"
            : contentType.includes("jpeg") || contentType.includes("jpg")
                ? ".jpg"
                : contentType.includes("gif")
                    ? ".gif"
                    : contentType.includes("webp")
                        ? ".webp"
                        : ".img";
        const cacheDir = await ensureImageCacheDir();
        const hash = crypto.createHash("md5").update(imageUrl).digest("hex").slice(0, 12);
        const fileName = `img_${Date.now()}_${hash}${ext}`;
        const filePath = path.join(cacheDir, fileName);
        const fileStream = createWriteStream(filePath, { flags: "wx" });
        let totalBytes = 0;
        let completed = false;
        try {
            await new Promise((resolve, reject) => {
                let settled = false;
                const fail = (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    response.destroy();
                    fileStream.destroy();
                    reject(error);
                };
                response.on("data", (chunk) => {
                    totalBytes += chunk.length;
                    if (totalBytes > maxBytes) {
                        fail(new Error("image exceeds size limit"));
                        return;
                    }
                    if (!fileStream.write(chunk)) {
                        response.pause();
                        fileStream.once("drain", () => response.resume());
                    }
                });
                response.on("end", () => {
                    if (settled) {
                        return;
                    }
                    fileStream.end(() => {
                        settled = true;
                        resolve();
                    });
                });
                response.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
                fileStream.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
            });
            completed = true;
        }
        finally {
            if (!completed) {
                fileStream.destroy();
                await fs.unlink(filePath).catch(() => undefined);
            }
        }
        return `file://${filePath}`;
    }
    catch {
        return null;
    }
}
async function saveDataUrlToFile(dataUrl, maxBytes) {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
        return null;
    }
    const mimeType = match[1].toLowerCase();
    const payload = match[2].replace(/\s+/g, "");
    if (estimateBase64DecodedBytes(payload) > maxBytes) {
        return null;
    }
    const buffer = Buffer.from(payload, "base64");
    if (buffer.length > maxBytes) {
        return null;
    }
    const ext = mimeType.includes("png")
        ? ".png"
        : mimeType.includes("jpeg") || mimeType.includes("jpg")
            ? ".jpg"
            : mimeType.includes("gif")
                ? ".gif"
                : mimeType.includes("webp")
                    ? ".webp"
                    : ".img";
    const cacheDir = await ensureImageCacheDir();
    const hash = crypto.createHash("md5").update(payload).digest("hex").slice(0, 12);
    const fileName = `img_${Date.now()}_${hash}${ext}`;
    const filePath = path.join(cacheDir, fileName);
    await fs.writeFile(filePath, buffer);
    return `file://${filePath}`;
}
function estimateBase64DecodedBytes(payload) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
}
function isPrivateIpv4(address) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }
    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}
function isPrivateIpv6(address) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
        || normalized === "::"
        || normalized.startsWith("fc")
        || normalized.startsWith("fd")
        || normalized.startsWith("fe8")
        || normalized.startsWith("fe9")
        || normalized.startsWith("fea")
        || normalized.startsWith("feb");
}
function isPrivateAddress(address) {
    const ipVersion = net.isIP(address);
    if (ipVersion === 4) {
        return isPrivateIpv4(address);
    }
    if (ipVersion === 6) {
        return isPrivateIpv6(address);
    }
    return false;
}
async function validateRemoteImageUrl(imageUrl) {
    let parsedUrl;
    try {
        parsedUrl = new URL(imageUrl);
    }
    catch {
        return null;
    }
    if (!REMOTE_IMAGE_PROTOCOLS.has(parsedUrl.protocol)) {
        return null;
    }
    if (parsedUrl.username || parsedUrl.password) {
        return null;
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname)) {
        return null;
    }
    try {
        const resolved = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
        const safeEntry = resolved.find((entry) => !isPrivateAddress(entry.address));
        if (!safeEntry || resolved.some((entry) => isPrivateAddress(entry.address))) {
            return null;
        }
        return {
            url: parsedUrl,
            address: safeEntry.address,
            family: safeEntry.family,
        };
    }
    catch {
        return null;
    }
}
async function requestValidatedRemoteImage(target) {
    const client = target.url.protocol === "https:" ? https : http;
    const defaultPort = target.url.protocol === "https:" ? 443 : 80;
    const port = target.url.port ? Number(target.url.port) : defaultPort;
    const hostHeader = target.url.port ? `${target.url.hostname}:${target.url.port}` : target.url.hostname;
    return new Promise((resolve, reject) => {
        const request = client.request({
            protocol: target.url.protocol,
            host: target.address,
            port,
            method: "GET",
            path: `${target.url.pathname}${target.url.search}`,
            headers: {
                Host: hostHeader,
                "User-Agent": "openclaw-lingzhu/1.0",
            },
            family: target.family,
            servername: target.url.protocol === "https:" ? target.url.hostname : undefined,
            lookup: (_hostname, _options, callback) => {
                callback(null, target.address, target.family);
            },
            checkServerIdentity: target.url.protocol === "https:"
                ? (_hostname, cert) => tls.checkServerIdentity(target.url.hostname, cert)
                : undefined,
        }, (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode >= 300 && statusCode < 400) {
                response.resume();
                reject(new Error("redirect not allowed"));
                return;
            }
            resolve(response);
        });
        request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => {
            request.destroy(new Error("remote image timeout"));
        });
        request.on("error", reject);
        request.end();
    });
}
function isPathWithinDirectory(filePath, parentDir) {
    const relative = path.relative(parentDir, path.resolve(filePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function resolveTrustedFileUrl(fileUrl) {
    try {
        const cacheDir = await ensureImageCacheDir();
        const localPath = fileURLToPath(fileUrl);
        return isPathWithinDirectory(localPath, cacheDir) ? localPath : null;
    }
    catch {
        return null;
    }
}
async function preprocessOpenAIMessages(messages, logger, maxImageBytes) {
    const result = [];
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            result.push({ role: msg.role, content: msg.content });
            continue;
        }
        if (!Array.isArray(msg.content)) {
            result.push({ role: msg.role, content: String(msg.content) });
            continue;
        }
        const textParts = [];
        const imagePaths = [];
        for (const part of msg.content) {
            if (part.type === "text" && part.text) {
                textParts.push(part.text);
            }
            else if (part.type === "image_url" && part.image_url?.url) {
                const imagePartUrl = part.image_url.url;
                if (imagePartUrl.startsWith("file://")) {
                    const localPath = await resolveTrustedFileUrl(imagePartUrl);
                    if (localPath) {
                        imagePaths.push(localPath);
                    }
                    else {
                        logger.warn("[Lingzhu] 已拒绝非缓存目录 file URL");
                    }
                }
                else if (imagePartUrl.startsWith("data:")) {
                    const fileUrl = await saveDataUrlToFile(imagePartUrl, maxImageBytes);
                    if (fileUrl) {
                        imagePaths.push(fileUrl.replace("file://", ""));
                        logger.info("[Lingzhu] data URL 图片已保存到本地缓存");
                    }
                    else {
                        logger.warn("[Lingzhu] data URL 图片处理失败或超出大小限制");
                    }
                }
                else {
                    logger.info(`[Lingzhu] 正在下载图片到本地: ${imagePartUrl.substring(0, 80)}...`);
                    const fileUrl = await downloadImageToFile(imagePartUrl, maxImageBytes);
                    if (fileUrl) {
                        imagePaths.push(fileUrl.replace("file://", ""));
                        logger.info(`[Lingzhu] 图片已保存到: ${fileUrl}`);
                    }
                    else {
                        logger.warn(`[Lingzhu] 图片下载失败或地址被拒绝: ${imagePartUrl}`);
                    }
                }
            }
        }
        let finalContent = textParts.join("\n");
        if (imagePaths.length > 0) {
            const imageRefs = imagePaths.map((imagePath) => `[图片: ${imagePath}]`).join("\n");
            if (finalContent) {
                finalContent = `${finalContent}\n\n${imageRefs}`;
            }
            else {
                finalContent = `读取这个图片\n\n${imageRefs},请根据执行的对话内容进行回答`;
                logger.info("[Lingzhu] 为纯图片消息添加了占位文本");
            }
        }
        if (finalContent) {
            result.push({ role: msg.role, content: finalContent });
        }
    }
    return result;
}
export function createHttpHandler(api, getRuntimeState) {
    return async function handler(req, res) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/metis/agent/api/health" && req.method === "GET") {
            const state = getRuntimeState();
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({
                ok: true,
                endpoint: "/metis/agent/api/sse",
                enabled: state.config.enabled !== false,
                agentId: state.config.agentId || "main",
                supportedCommands: state.config.enableExperimentalNativeActions === true
                    ? [
                        "take_photo",
                        "take_navigation",
                        "control_calendar",
                        "notify_agent_off",
                        "send_notification",
                        "send_toast",
                        "speak_tts",
                        "start_video_record",
                        "stop_video_record",
                        "open_custom_view",
                    ]
                    : ["take_photo", "take_navigation", "control_calendar", "notify_agent_off"],
                followUpEnabled: state.config.enableFollowUp !== false,
                sessionMode: state.config.sessionMode || "per_user",
                debugLogging: state.config.debugLogging === true,
                experimentalNativeActions: state.config.enableExperimentalNativeActions === true,
                chatCompletionsEnabled: state.chatCompletionsEnabled === true,
            }));
            return true;
        }
        if (url.pathname !== "/metis/agent/api/sse") {
            return false;
        }
        if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method Not Allowed");
            return true;
        }
        const logger = api.logger;
        const state = getRuntimeState();
        const config = state.config;
        const upstreamController = new AbortController();
        let keepaliveInterval;
        const stopKeepalive = () => {
            if (keepaliveInterval) {
                clearInterval(keepaliveInterval);
                keepaliveInterval = undefined;
            }
        };
        const safeWrite = (payload) => {
            if (res.writableEnded || res.destroyed) {
                return false;
            }
            try {
                res.write(payload);
                return true;
            }
            catch {
                return false;
            }
        };
        const abortUpstream = (reason) => {
            stopKeepalive();
            if (!upstreamController.signal.aborted) {
                upstreamController.abort(reason);
            }
        };
        req.on("aborted", () => abortUpstream("Client disconnected"));
        res.on("close", () => {
            if (!res.writableEnded) {
                abortUpstream("Client disconnected");
            }
        });
        if (config.enabled === false) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "Lingzhu plugin is disabled" }));
            return true;
        }
        const authHeader = req.headers.authorization;
        if (!verifyAuth(authHeader, state.authAk || "")) {
            logger.warn("[Lingzhu] Unauthorized request");
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return true;
        }
        let requestMessageId = "unknown";
        let requestAgentId = "unknown";
        let nativeToolListener;
        let nativeToolInvoked = false;
        try {
            const body = (await readJsonBody(req));
            if (!body || !body.message_id || !body.agent_id || !Array.isArray(body.message)) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Missing required fields: message_id, agent_id, message" }));
                return true;
            }
            requestMessageId = body.message_id;
            requestAgentId = body.agent_id;
            const includePayload = config.debugLogPayloads === true;
            writeDebugLog(config, buildRequestLogName(body.message_id, "request.in"), {
                headers: req.headers,
                body: summarizeForDebug(body, includePayload),
            });
            logger.info(`[Lingzhu] Request: message_id=${body.message_id}, agent_id=${body.agent_id}, messages=${body.message.length}`);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            if (typeof res.flushHeaders === "function") {
                res.flushHeaders();
            }
            safeWrite(": keepalive\n\n");
            keepaliveInterval = setInterval(() => {
                if (!safeWrite(": keepalive\n\n")) {
                    stopKeepalive();
                }
            }, 7000);
            const includeMetadata = config.includeMetadata !== false;
            const maxImageBytes = resolveMaxImageBytes(config);
            void cleanupImageCacheIfNeeded().catch((error) => {
                logger.warn(`[Lingzhu] 图片缓存清理失败: ${error instanceof Error ? error.message : String(error)}`);
            });
            const context = includeMetadata ? normalizeContext(body.metadata) : undefined;
            let openaiMessages = lingzhuToOpenAI(body.message, context, {
                systemPrompt: config.systemPrompt,
                defaultNavigationMode: config.defaultNavigationMode,
                enableExperimentalNativeActions: config.enableExperimentalNativeActions,
            });
            openaiMessages = await preprocessOpenAIMessages(openaiMessages, logger, maxImageBytes);
            const hasUserMsg = openaiMessages.some((message) => message.role === "user");
            if (!hasUserMsg) {
                const fallbackText = extractFallbackUserText(body.message) || "你好";
                openaiMessages.push({ role: "user", content: fallbackText });
                logger.warn(`[Lingzhu] No user message after transform, fallback=${fallbackText}`);
            }
            logger.info(`[Lingzhu] includeMetadata=${includeMetadata}, openaiMessages=${openaiMessages.length}, maxImageBytes=${maxImageBytes}`);
            const sessionKey = buildSessionKey(config, body);
            const targetAgentId = config.agentId || body.agent_id || "main";
            const gatewayPort = api.config?.gateway?.port ?? state.gatewayPort ?? 18789;
            const gatewayToken = api.config?.gateway?.auth?.token;
            nativeToolListener = (eventData) => {
                logger.info(`[Lingzhu:NativeEvent] Received native_invoke event: ${JSON.stringify(eventData)}`);
                logger.info(`[Lingzhu:NativeEvent] Current sessionKey=${sessionKey}, targetAgentId=${targetAgentId}`);
                if (eventData.sessionKey && eventData.sessionKey !== sessionKey) {
                    logger.warn(`[Lingzhu:NativeEvent] Filtered out! Event sessionKey (${eventData.sessionKey}) != current (${sessionKey})`);
                    return;
                }
                if (!eventData.sessionKey && eventData.agentId && eventData.agentId !== targetAgentId) {
                    logger.warn(`[Lingzhu:NativeEvent] Filtered out by agentId! Event agentId (${eventData.agentId}) != target (${targetAgentId})`);
                    return;
                }
                logger.info(`[Lingzhu:NativeEvent] Match successful! Firing SSE tool data...`);
                nativeToolInvoked = true;
                const toolData = {
                    role: "agent",
                    type: "tool_call",
                    message_id: body.message_id,
                    agent_id: body.agent_id,
                    is_finish: false, // 重要：不要过早发送 is_finish: true，避免 Lingzhu 代理粗暴断流
                    tool_call: eventData.tool_call,
                };
                writeDebugLog(config, buildRequestLogName(body.message_id, "response.native_tool_call"), summarizeForDebug(toolData, includePayload));
                const sseFormatted = formatLingzhuSSE("message", toolData);
                logger.info(`[Lingzhu:DEBUG] Sending Native SSE >> ${sseFormatted.replace(/\n/g, '\\n')}`);
                safeWrite(sseFormatted);
            };
            lingzhuEventBus.on("native_invoke", nativeToolListener);
            const openclawUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
            const openclawBody = {
                model: `openclaw:${targetAgentId}`,
                stream: true,
                messages: openaiMessages,
                user: sessionKey,
                client: "lingzhu",
                platform: "lingzhu",
                // tools: lingzhuTools,
            };
            const headers = {
                "Content-Type": "application/json",
                "x-openclaw-agent-id": targetAgentId,
                "x-openclaw-session-key": sessionKey,
                "x-openclaw-message-channel": "lingzhu",
                // "x-openclaw-client": "lingzhu",
                // "x-openclaw-platform": "lingzhu",
            };
            if (gatewayToken) {
                headers.Authorization = `Bearer ${gatewayToken}`;
            }
            writeDebugLog(config, buildRequestLogName(body.message_id, "openclaw.request"), {
                url: openclawUrl,
                headers: summarizeForDebug(headers, includePayload),
                body: summarizeForDebug(openclawBody, includePayload),
            });
            const timeoutMs = typeof config.requestTimeoutMs === "number"
                ? Math.max(5000, Math.min(300000, Math.trunc(config.requestTimeoutMs)))
                : 60000;
            logger.info(`[Lingzhu] Calling OpenClaw: ${openclawUrl}, agentId=${targetAgentId}, sessionKey=${sessionKey}, timeout=${timeoutMs}ms`);
            const timeoutHandle = setTimeout(() => {
                abortUpstream(`OpenClaw request timeout after ${timeoutMs}ms`);
            }, timeoutMs);
            let openclawResponse;
            try {
                openclawResponse = await fetch(openclawUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(openclawBody),
                    signal: upstreamController.signal,
                });
            }
            catch (error) {
                if (upstreamController.signal.aborted) {
                    throw new Error(String(upstreamController.signal.reason || `OpenClaw request timeout after ${timeoutMs}ms`));
                }
                throw error;
            }
            finally {
                clearTimeout(timeoutHandle);
            }
            if (!openclawResponse.ok) {
                const errorText = await openclawResponse.text();
                throw new Error(`OpenClaw API error: ${openclawResponse.status} - ${errorText}`);
            }
            let fullResponse = "";
            const toolAccumulator = new ToolCallAccumulator();
            const streamedToolCalls = [];
            let streamedAnswer = false;
            const reader = openclawResponse.body?.getReader();
            if (!reader) {
                throw new Error("No response body");
            }
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith("data: ")) {
                            continue;
                        }
                        const data = trimmed.slice(6);
                        if (data === "[DONE]") {
                            continue;
                        }
                        try {
                            const chunk = JSON.parse(data);
                            const delta = chunk.choices?.[0]?.delta;
                            const finishReason = chunk.choices?.[0]?.finish_reason;
                            if (delta?.tool_calls) {
                                toolAccumulator.accumulate(delta.tool_calls);
                            }
                            writeDebugLog(config, buildRequestLogName(body.message_id, "openclaw.chunk"), summarizeForDebug(chunk, includePayload));
                            if (delta?.content) {
                                fullResponse += delta.content;
                                streamedAnswer = true;
                                const answerChunkData = {
                                    role: "agent",
                                    type: "answer",
                                    answer_stream: delta.content,
                                    message_id: body.message_id,
                                    agent_id: body.agent_id,
                                    is_finish: false,
                                };
                                writeDebugLog(config, buildRequestLogName(body.message_id, "response.answer_chunk"), summarizeForDebug(answerChunkData, includePayload));
                                safeWrite(formatLingzhuSSE("message", answerChunkData));
                            }
                            if (finishReason === "tool_calls" || (finishReason && toolAccumulator.hasTools())) {
                                for (const tool of toolAccumulator.getCompleted()) {
                                    const lingzhuToolCall = parseToolCallFromAccumulated(tool.name, tool.arguments, {
                                        defaultNavigationMode: config.defaultNavigationMode,
                                        enableExperimentalNativeActions: config.enableExperimentalNativeActions,
                                    });
                                    if (lingzhuToolCall) {
                                        const toolData = {
                                            role: "agent",
                                            type: "tool_call",
                                            message_id: body.message_id,
                                            agent_id: body.agent_id,
                                            is_finish: false, // 改为 false，配合结尾的 is_finish
                                            tool_call: lingzhuToolCall,
                                        };
                                        writeDebugLog(config, buildRequestLogName(body.message_id, "response.tool_call"), summarizeForDebug(toolData, includePayload));
                                        streamedToolCalls.push(toolData);
                                    }
                                }
                            }
                        }
                        catch {
                            // Ignore chunk parse failures.
                        }
                    }
                }
            }
            finally {
                stopKeepalive();
            }
            const hasToolCall = streamedToolCalls.length > 0 || nativeToolInvoked;
            if (!nativeToolInvoked && streamedToolCalls.length > 0) {
                for (const toolData of streamedToolCalls) {
                    const sseFormatted = formatLingzhuSSE("message", toolData);
                    logger.info(`[Lingzhu:DEBUG] Sending Streamed Tool SSE >> ${sseFormatted.replace(/\n/g, '\\n')}`);
                    safeWrite(sseFormatted);
                }
            }
            if (!hasToolCall && fullResponse) {
                const detectedIntent = detectIntentFromText(fullResponse, {
                    defaultNavigationMode: config.defaultNavigationMode,
                    enableExperimentalNativeActions: config.enableExperimentalNativeActions,
                });
                if (detectedIntent) {
                    logger.info(`[Lingzhu] 从文本检测到意图: ${JSON.stringify(detectedIntent)}`);
                    const toolData = {
                        role: "agent",
                        type: "tool_call",
                        message_id: body.message_id,
                        agent_id: body.agent_id,
                        is_finish: false,
                        tool_call: detectedIntent,
                    };
                    const sseOutput = formatLingzhuSSE("message", toolData);
                    logger.info(`[Lingzhu:DEBUG] Sending Legacy Intent SSE >> ${sseOutput.replace(/\n/g, "\\n")}`);
                    writeDebugLog(config, buildRequestLogName(body.message_id, "response.intent_fallback"), summarizeForDebug(toolData, includePayload));
                    safeWrite(sseOutput);
                }
            }
            else if (!hasToolCall && streamedAnswer) {
                const finalAnswerData = {
                    role: "agent",
                    type: "answer",
                    answer_stream: "",
                    message_id: body.message_id,
                    agent_id: body.agent_id,
                    is_finish: true,
                };
                writeDebugLog(config, buildRequestLogName(body.message_id, "response.answer_done"), summarizeForDebug(finalAnswerData, includePayload));
                safeWrite(formatLingzhuSSE("message", finalAnswerData));
                if (config.enableFollowUp !== false) {
                    const followUps = extractFollowUpFromText(fullResponse, typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3);
                    if (followUps && followUps.length > 0) {
                        const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
                        writeDebugLog(config, buildRequestLogName(body.message_id, "response.follow_up"), summarizeForDebug(followUpData, includePayload));
                        safeWrite(formatLingzhuSSE("message", followUpData));
                    }
                }
            }
            else if (!hasToolCall && fullResponse) {
                const finalAnswerData = {
                    role: "agent",
                    type: "answer",
                    answer_stream: fullResponse,
                    message_id: body.message_id,
                    agent_id: body.agent_id,
                    is_finish: true,
                };
                writeDebugLog(config, buildRequestLogName(body.message_id, "response.final_answer"), summarizeForDebug(finalAnswerData, includePayload));
                safeWrite(formatLingzhuSSE("message", finalAnswerData));
                if (config.enableFollowUp !== false) {
                    const followUps = extractFollowUpFromText(fullResponse, typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3);
                    if (followUps && followUps.length > 0) {
                        const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
                        writeDebugLog(config, buildRequestLogName(body.message_id, "response.follow_up"), summarizeForDebug(followUpData, includePayload));
                        safeWrite(formatLingzhuSSE("message", followUpData));
                    }
                }
            }
            writeDebugLog(config, buildRequestLogName(body.message_id, "response.done"), {
                hasToolCall,
                fullResponse: summarizeForDebug(fullResponse, includePayload),
            });
            // 如果整个请求链路中触发了任意 tool_call (原生 or 文本识别)，
            // 补发一个空的 is_finish: true 作为最终流束结标记，适配灵珠的接收器逻辑
            if (hasToolCall || nativeToolInvoked) {
                const finalFinishData = {
                    role: "agent",
                    type: "answer",
                    answer_stream: "",
                    message_id: body.message_id,
                    agent_id: body.agent_id,
                    is_finish: true,
                };
                safeWrite(formatLingzhuSSE("message", finalFinishData));
            }
            if (!res.writableEnded) {
                res.end();
            }
            logger.info(`[Lingzhu] Completed: message_id=${body.message_id}`);
        }
        catch (error) {
            stopKeepalive();
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes("Client disconnected") || errorMsg.includes("Native tool fulfilled")) {
                logger.info(`[Lingzhu] Request fulfilled or client disconnected normally: ${errorMsg}`);
            }
            else {
                logger.error(`[Lingzhu] Error: ${errorMsg}`);
            }
            writeDebugLog(config, buildRequestLogName(requestMessageId, "error"), {
                message_id: requestMessageId,
                agent_id: requestAgentId,
                error: errorMsg,
            }, true);
            if (!upstreamController.signal.aborted && !res.writableEnded) {
                const errorData = {
                    role: "agent",
                    type: "answer",
                    answer_stream: `[错误] ${errorMsg}`,
                    message_id: requestMessageId,
                    agent_id: requestAgentId,
                    is_finish: true,
                };
                safeWrite(formatLingzhuSSE("message", errorData));
                res.end();
            }
        }
        finally {
            if (nativeToolListener) {
                lingzhuEventBus.off("native_invoke", nativeToolListener);
            }
        }
        return true;
    };
}
//# sourceMappingURL=http-handler.js.map