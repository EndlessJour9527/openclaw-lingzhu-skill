import type { IncomingMessage, ServerResponse } from "node:http";
import type { LingzhuConfig, LingzhuContext, LingzhuRequest, LingzhuSSEData, LingzhuToolCall } from "./types.js";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  createFollowUpResponse,
  detectIntentFromText,
  extractFollowUpFromText,
  formatLingzhuSSE,
  lingzhuToOpenAI,
  parseToolCallFromAccumulated,
  ToolCallAccumulator,
} from "./transform.js";
import { buildRequestLogName, summarizeForDebug, writeDebugLog } from "./debug-log.js";
import { cleanupImageCacheIfNeeded, ensureImageCacheDir } from "./image-cache.js";
import { lingzhuEventBus } from "./events.js";

interface LingzhuRuntimeState {
  config: LingzhuConfig;
  authAk: string;
  gatewayPort: number;
  chatCompletionsEnabled?: boolean;
}

interface ValidatedRemoteImageUrl {
  url: URL;
  address: string;
  family: number;
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIContent = string | OpenAIContentPart[];

const REMOTE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_IMAGE_TIMEOUT_MS = 15000;
const PENDING_PHOTO_PROMPT_TTL_MS = 5 * 60 * 1000;
const PHOTO_TRANSACTION_DEDUPE_MS = 8 * 1000;

const pendingPhotoPrompts = new Map<string, { text: string; createdAt: number }>();
const photoTransactionsByMessageId = new Map<string, { ownerKey: string; createdAt: number }>();
const recentPhotoTransactionsByOwner = new Map<string, { messageId: string; text: string; createdAt: number }>();

function resolveMaxImageBytes(config: LingzhuConfig): number {
  if (typeof config.maxImageBytes === "number" && Number.isFinite(config.maxImageBytes)) {
    return Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Math.trunc(config.maxImageBytes)));
  }

  return 5 * 1024 * 1024;
}

function normalizeContext(metadata: LingzhuRequest["metadata"]): LingzhuContext | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  if ("context" in metadata && metadata.context && typeof metadata.context === "object") {
    return metadata.context as LingzhuContext;
  }

  return metadata as LingzhuContext;
}

function extractFallbackUserText(messages: LingzhuRequest["message"]): string {
  return messages
    .map((message) => message.text || message.content || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractUserText(messages: LingzhuRequest["message"]): string {
  return messages
    .filter((message) => message.role === "user" && message.type === "text")
    .map((message) => message.text || message.content || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function hasIncomingImage(messages: LingzhuRequest["message"]): boolean {
  return messages.some((message) => message.role === "user" && message.type === "image" && Boolean(message.image_url));
}

function isLocalDeviceActionCommand(command: LingzhuToolCall["command"]): boolean {
  return command === "take_photo"
    || command === "take_navigation"
    || command === "notify_agent_off"
    || command === "control_calendar";
}

function detectLocalPhotoIntent(text: string): LingzhuToolCall | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const photoKeywords = [
    "take_photo",
    "拍照",
    "照相",
    "拍一张",
    "当前画面",
    "当前场景",
    "开始巡检",
    "现场巡检",
    "工业巡检",
    "安全隐患",
    "隐患",
    "现场风险",
    "识别风险",
    "故障诊断",
    "设备异常",
    "帮我看看",
    "换个角度",
    "重新拍",
    "再检查",
  ];

  if (!photoKeywords.some((keyword) => normalized.includes(keyword))) {
    return null;
  }

  return {
    handling_required: true,
    command: "take_photo",
    is_recall: true,
  };
}

function buildSessionKey(config: LingzhuConfig, body: LingzhuRequest): string {
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

function sanitizeSessionSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 96) || "anonymous";
}

function buildVisionSessionKey(config: LingzhuConfig, body: LingzhuRequest): string {
  const namespace = config.sessionNamespace || "lingzhu";
  const targetAgentId = config.agentId || body.agent_id || "main";
  const userId = sanitizeSessionSegment(body.user_id || body.agent_id || "anonymous");
  const messageId = sanitizeSessionSegment(body.message_id || `${Date.now()}`);
  return `agent:${targetAgentId}:${namespace}_vision_${userId}_${messageId}`;
}

function detectVisionPromptPreset(
  text: string,
  config: LingzhuConfig
): NonNullable<LingzhuConfig["visionPromptPreset"]> {
  const configured = config.visionPromptPreset || "auto";
  if (configured !== "auto") {
    return configured;
  }

  const normalized = text.toLowerCase();
  const diagnosisKeywords = [
    "故障",
    "异常",
    "报警",
    "报错",
    "停机",
    "泄漏",
    "振动",
    "异响",
    "仪表",
    "读数",
    "电机",
    "阀门",
    "管路",
    "设备",
    "diagnosis",
    "fault",
    "alarm",
  ];
  const inspectionKeywords = [
    "安全隐患",
    "巡检",
    "风险",
    "消防",
    "电气安全",
    "通道",
    "警示",
    "防护",
    "整改",
    "inspection",
    "hazard",
    "safety",
  ];

  const diagnosisHit = diagnosisKeywords.some((keyword) => normalized.includes(keyword));
  const inspectionHit = inspectionKeywords.some((keyword) => normalized.includes(keyword));
  const strongDiagnosisHit = ["故障", "异常", "报警", "报错", "停机", "泄漏", "振动", "异响", "diagnosis", "fault", "alarm"]
    .some((keyword) => normalized.includes(keyword));

  if (diagnosisHit && (!inspectionHit || strongDiagnosisHit)) {
    return "fault_diagnosis";
  }
  if (inspectionHit) {
    return "industrial_inspection";
  }

  return "general_visual_qa";
}

function buildVisionSystemPrompt(
  preset: NonNullable<LingzhuConfig["visionPromptPreset"]>,
  originalText: string
): string {
  const base = [
    "当前请求已经包含灵珠/乐奇眼镜拍摄并回传的图片。",
    "必须直接基于已随消息内联传入的图片回答用户问题。",
    "严禁再次调用 take_photo、camera、photo、photos_latest、image、file_fetch、nodes 或任何读取本地路径的工具。",
    "不要要求用户重新上传图片；不要输出本地文件路径。",
    originalText ? `用户原始问题：${originalText}` : "",
  ].filter(Boolean);

  if (preset === "industrial_inspection") {
    base.push(
      "请按工业巡检报告风格输出：1. 现场概况；2. 安全隐患清单；3. 风险等级（高/中/低）；4. 整改建议；5. 需要复核的点。",
      "如果图片中证据不足，要明确说明“不确定”，但仍给出可执行的现场复核建议。"
    );
  } else if (preset === "fault_diagnosis") {
    base.push(
      "请按设备故障诊断风格输出：1. 可见异常；2. 可能原因；3. 影响范围；4. 排查步骤；5. 是否建议停机/隔离/报修。",
      "不要把普通安全巡检建议替代为故障结论；缺少证据时给出排查优先级。"
    );
  } else {
    base.push(
      "请用简洁、可执行的方式回答图片相关问题；如果用户在现场操作，优先给出下一步动作。"
    );
  }

  return base.join("\n");
}

function rememberPendingPhotoPrompt(body: LingzhuRequest, text: string): void {
  if (!body.message_id || !text.trim()) {
    return;
  }

  const now = Date.now();
  for (const [key, value] of pendingPhotoPrompts) {
    if (now - value.createdAt > PENDING_PHOTO_PROMPT_TTL_MS) {
      pendingPhotoPrompts.delete(key);
    }
  }

  pendingPhotoPrompts.set(body.message_id, {
    text: text.trim(),
    createdAt: now,
  });
}

function consumePendingPhotoPrompt(body: LingzhuRequest): string {
  const pending = pendingPhotoPrompts.get(body.message_id);
  if (!pending) {
    return "";
  }

  pendingPhotoPrompts.delete(body.message_id);
  return Date.now() - pending.createdAt <= PENDING_PHOTO_PROMPT_TTL_MS ? pending.text : "";
}

function buildPhotoOwnerKey(body: LingzhuRequest): string {
  return `${body.agent_id || "main"}:${body.user_id || body.agent_id || "anonymous"}`;
}

function cleanupPhotoTransactions(now = Date.now()): void {
  for (const [messageId, transaction] of photoTransactionsByMessageId) {
    if (now - transaction.createdAt > PHOTO_TRANSACTION_DEDUPE_MS) {
      photoTransactionsByMessageId.delete(messageId);
    }
  }

  for (const [ownerKey, transaction] of recentPhotoTransactionsByOwner) {
    if (now - transaction.createdAt > PHOTO_TRANSACTION_DEDUPE_MS) {
      recentPhotoTransactionsByOwner.delete(ownerKey);
    }
  }
}

function isBarePhotoEcho(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^(take_photo|photo|camera|拍照|照相|现在开始拍照|开始拍照|调用拍照|调用摄像头)[。.!！\s]*$/i.test(normalized);
}

function shouldSuppressDuplicatePhoto(body: LingzhuRequest, text: string): boolean {
  const now = Date.now();
  cleanupPhotoTransactions(now);

  if (photoTransactionsByMessageId.has(body.message_id)) {
    return true;
  }

  const ownerKey = buildPhotoOwnerKey(body);
  const recent = recentPhotoTransactionsByOwner.get(ownerKey);
  return Boolean(recent && recent.messageId !== body.message_id && isBarePhotoEcho(text));
}

function markPhotoRequested(body: LingzhuRequest, text: string): void {
  const now = Date.now();
  cleanupPhotoTransactions(now);
  const ownerKey = buildPhotoOwnerKey(body);

  photoTransactionsByMessageId.set(body.message_id, { ownerKey, createdAt: now });
  recentPhotoTransactionsByOwner.set(ownerKey, {
    messageId: body.message_id,
    text: text.trim(),
    createdAt: now,
  });
}

function releasePhotoTransaction(body: LingzhuRequest): void {
  const transaction = photoTransactionsByMessageId.get(body.message_id);
  if (transaction) {
    const recent = recentPhotoTransactionsByOwner.get(transaction.ownerKey);
    if (recent?.messageId === body.message_id) {
      recentPhotoTransactionsByOwner.delete(transaction.ownerKey);
    }
  }

  photoTransactionsByMessageId.delete(body.message_id);
  cleanupPhotoTransactions();
}

function readEnv(name: string): string {
  try {
    return globalThis.process?.env?.[name]?.trim() || "";
  } catch {
    return "";
  }
}

function resolveGatewayToken(config: LingzhuConfig, api: any): string {
  if (config.gatewayToken) {
    return config.gatewayToken;
  }

  return readEnv("OPENCLAW_GATEWAY_TOKEN")
    || readEnv("GATEWAY_TOKEN")
    || api.config?.gateway?.auth?.token
    || "";
}

function verifyAuth(
  authHeader: string | string[] | undefined,
  expectedAk: string
): boolean {
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

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
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
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

async function downloadImageToFile(imageUrl: string, maxBytes: number): Promise<string | null> {
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
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const fail = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          response.destroy();
          fileStream.destroy();
          reject(error);
        };

        response.on("data", (chunk: Buffer) => {
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
    } finally {
      if (!completed) {
        fileStream.destroy();
        await fs.unlink(filePath).catch(() => undefined);
      }
    }

    return `file://${filePath}`;
  } catch {
    return null;
  }
}

async function saveDataUrlToFile(dataUrl: string, maxBytes: number): Promise<string | null> {
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

function estimateBase64DecodedBytes(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function isPrivateIpv4(address: string): boolean {
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

function isPrivateIpv6(address: string): boolean {
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

function isPrivateAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return isPrivateIpv4(address);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

async function validateRemoteImageUrl(imageUrl: string): Promise<ValidatedRemoteImageUrl | null> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(imageUrl);
  } catch {
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
  } catch {
    return null;
  }
}

async function requestValidatedRemoteImage(target: ValidatedRemoteImageUrl): Promise<IncomingMessage> {
  const client = target.url.protocol === "https:" ? https : http;
  const defaultPort = target.url.protocol === "https:" ? 443 : 80;
  const port = target.url.port ? Number(target.url.port) : defaultPort;
  const hostHeader = target.url.port ? `${target.url.hostname}:${target.url.port}` : target.url.hostname;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = client.request(
      {
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
        checkServerIdentity:
          target.url.protocol === "https:"
            ? (_hostname, cert) => tls.checkServerIdentity(target.url.hostname, cert)
            : undefined,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          reject(new Error("redirect not allowed"));
          return;
        }
        resolve(response);
      }
    );

    request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => {
      request.destroy(new Error("remote image timeout"));
    });
    request.on("error", reject);
    request.end();
  });
}

function isPathWithinDirectory(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveTrustedFileUrl(fileUrl: string): Promise<string | null> {
  try {
    const cacheDir = await ensureImageCacheDir();
    const localPath = fileURLToPath(fileUrl);
    return isPathWithinDirectory(localPath, cacheDir) ? localPath : null;
  } catch {
    return null;
  }
}

function guessImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function filePathToDataUrl(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }

    const buffer = await fs.readFile(filePath);
    if (buffer.length > maxBytes) {
      return null;
    }

    return `data:${guessImageMimeType(filePath)};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function normalizeImageUrlToDataUrl(
  imageUrl: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  maxImageBytes: number
): Promise<string | null> {
  if (imageUrl.startsWith("file://")) {
    const localPath = await resolveTrustedFileUrl(imageUrl);
    if (!localPath) {
      logger.warn("[Lingzhu] Refused non-cache file URL image");
      return null;
    }
    return filePathToDataUrl(localPath, maxImageBytes);
  }

  if (imageUrl.startsWith("data:")) {
    const savedFileUrl = await saveDataUrlToFile(imageUrl, maxImageBytes);
    if (!savedFileUrl) {
      logger.warn("[Lingzhu] Failed to persist data URL image or image exceeds size limit");
      return null;
    }

    const localPath = await resolveTrustedFileUrl(savedFileUrl);
    logger.info(`[Lingzhu] Data URL image persisted to: ${savedFileUrl}`);
    return localPath ? filePathToDataUrl(localPath, maxImageBytes) : imageUrl.replace(/\s+/g, "");
  }

  logger.info(`[Lingzhu] Downloading image for inline vision payload: ${imageUrl.substring(0, 80)}...`);
  const fileUrl = await downloadImageToFile(imageUrl, maxImageBytes);
  if (!fileUrl) {
    logger.warn(`[Lingzhu] Image download failed or URL was rejected: ${imageUrl}`);
    return null;
  }

  logger.info(`[Lingzhu] Image saved to: ${fileUrl}`);
  const localPath = await resolveTrustedFileUrl(fileUrl);
  return localPath ? filePathToDataUrl(localPath, maxImageBytes) : null;
}

async function preprocessOpenAIMessages(
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: OpenAIContent;
  }>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  maxImageBytes: number
): Promise<Array<{ role: "system" | "user" | "assistant"; content: OpenAIContent }>> {
  const result: Array<{ role: "system" | "user" | "assistant"; content: OpenAIContent }> = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content) });
      continue;
    }

    const contentParts: OpenAIContentPart[] = [];

    for (const part of msg.content) {
      if (part.type === "text" && part.text) {
        contentParts.push({ type: "text", text: part.text });
      } else if (part.type === "image_url" && part.image_url?.url) {
        const dataUrl = await normalizeImageUrlToDataUrl(part.image_url.url, logger, maxImageBytes);
        if (dataUrl) {
          contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
    }

    if (contentParts.some((part) => part.type === "image_url")) {
      if (!contentParts.some((part) => part.type === "text")) {
        contentParts.unshift({
          type: "text",
          text: "请直接分析这张图片，并根据当前对话上下文回答用户问题。",
        });
        logger.info("[Lingzhu] Added placeholder text for image-only message");
      }
      result.push({ role: msg.role, content: contentParts });
      continue;
    }

    const textOnly = contentParts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (textOnly) {
      result.push({ role: msg.role, content: textOnly });
    }
  }

  return result;
}

export function createHttpHandler(api: any, getRuntimeState: () => LingzhuRuntimeState) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/metis/agent/api/health" && req.method === "GET") {
      const state = getRuntimeState();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          endpoint: "/metis/agent/api/sse",
          enabled: state.config.enabled !== false,
          agentId: state.config.agentId || "main",
          supportedCommands:
            state.config.enableExperimentalNativeActions === true
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
          visionPromptPreset: state.config.visionPromptPreset || "auto",
          debugLogging: state.config.debugLogging === true,
          experimentalNativeActions: state.config.enableExperimentalNativeActions === true,
          chatCompletionsEnabled: state.chatCompletionsEnabled === true,
        })
      );
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
    let keepaliveInterval: NodeJS.Timeout | undefined;

    const stopKeepalive = () => {
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = undefined;
      }
    };

    const safeWrite = (payload: string): boolean => {
      if (res.writableEnded || res.destroyed) {
        return false;
      }

      try {
        res.write(payload);
        return true;
      } catch {
        return false;
      }
    };

    const abortUpstream = (reason: string) => {
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
    let nativeToolListener: ((eventData: any) => void) | undefined;
    let nativeToolInvoked = false;

    try {
      const maxRequestBytes = Math.min(
        50 * 1024 * 1024,
        Math.max(1024 * 1024, resolveMaxImageBytes(config) * 2 + 1024 * 1024)
      );
      const body = (await readJsonBody(req, maxRequestBytes)) as LingzhuRequest | undefined;
      if (!body || !body.message_id || !body.agent_id || !Array.isArray(body.message)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Missing required fields: message_id, agent_id, message" }));
        return true;
      }

      requestMessageId = body.message_id;
      requestAgentId = body.agent_id;
      const includePayload = config.debugLogPayloads === true;

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "request.in"),
        {
          headers: req.headers,
          body: summarizeForDebug(body, includePayload),
        }
      );

      logger.info(
        `[Lingzhu] Request: message_id=${body.message_id}, agent_id=${body.agent_id}, messages=${body.message.length}`
      );

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

      const requestHasImage = hasIncomingImage(body.message);
      const localIntentText = extractUserText(body.message);
      const localToolCall = localIntentText
        ? detectIntentFromText(localIntentText, {
          defaultNavigationMode: config.defaultNavigationMode,
          enableExperimentalNativeActions: config.enableExperimentalNativeActions,
        }) || detectLocalPhotoIntent(localIntentText)
        : null;

      if (!requestHasImage && localToolCall && isLocalDeviceActionCommand(localToolCall.command)) {
        logger.info(`[Lingzhu] 本地短路设备动作: ${localToolCall.command}, message_id=${body.message_id}`);
        if (localToolCall.command === "take_photo") {
          if (shouldSuppressDuplicatePhoto(body, localIntentText)) {
            logger.warn(`[Lingzhu] 已忽略重复拍照触发: message_id=${body.message_id}`);
            const finalFinishData: LingzhuSSEData = {
              role: "agent",
              type: "answer",
              answer_stream: "",
              message_id: body.message_id,
              agent_id: body.agent_id,
              is_finish: true,
            };
            writeDebugLog(
              config,
              buildRequestLogName(body.message_id, "response.duplicate_photo_done"),
              summarizeForDebug(finalFinishData, includePayload)
            );
            safeWrite(formatLingzhuSSE("message", finalFinishData));
            stopKeepalive();
            res.end();
            return true;
          }

          rememberPendingPhotoPrompt(body, localIntentText);
          markPhotoRequested(body, localIntentText);
        }

        const toolData: LingzhuSSEData = {
          role: "agent",
          type: "tool_call",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: false,
          tool_call: localToolCall,
        };
        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.local_tool_call"),
          summarizeForDebug(toolData, includePayload)
        );
        safeWrite(formatLingzhuSSE("message", toolData));

        const finalFinishData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: "",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: true,
        };
        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.local_tool_done"),
          summarizeForDebug(finalFinishData, includePayload)
        );
        safeWrite(formatLingzhuSSE("message", finalFinishData));
        stopKeepalive();
        res.end();
        logger.info(`[Lingzhu] 本地设备动作已完成: message_id=${body.message_id}`);
        return true;
      }

      const includeMetadata = config.includeMetadata !== false;
      const maxImageBytes = resolveMaxImageBytes(config);
      void cleanupImageCacheIfNeeded().catch((error) => {
        logger.warn(`[Lingzhu] 图片缓存清理失败: ${error instanceof Error ? error.message : String(error)}`);
      });

      const context = includeMetadata ? normalizeContext(body.metadata) : undefined;
      let openaiMessages: Array<{ role: "system" | "user" | "assistant"; content: OpenAIContent }> = lingzhuToOpenAI(body.message, context, {
        systemPrompt: config.systemPrompt,
        defaultNavigationMode: config.defaultNavigationMode,
        enableExperimentalNativeActions: config.enableExperimentalNativeActions,
      }) as any;

      openaiMessages = await preprocessOpenAIMessages(openaiMessages, logger, maxImageBytes);
      if (requestHasImage) {
        const visionOriginalText = extractFallbackUserText(body.message) || consumePendingPhotoPrompt(body);
        releasePhotoTransaction(body);
        const visionPreset = detectVisionPromptPreset(visionOriginalText, config);
        openaiMessages.unshift({
          role: "system",
          content: buildVisionSystemPrompt(visionPreset, visionOriginalText),
        });
        logger.info(`[Lingzhu] Fast vision channel enabled: preset=${visionPreset}`);
      }
      const hasUserMsg = openaiMessages.some((message) => message.role === "user");
      if (!hasUserMsg) {
        const fallbackText = extractFallbackUserText(body.message) || "你好";
        openaiMessages.push({ role: "user", content: fallbackText });
        logger.warn(`[Lingzhu] No user message after transform, fallback=${fallbackText}`);
      }

      logger.info(
        `[Lingzhu] includeMetadata=${includeMetadata}, openaiMessages=${openaiMessages.length}, maxImageBytes=${maxImageBytes}`
      );

      const sessionKey = requestHasImage ? buildVisionSessionKey(config, body) : buildSessionKey(config, body);
      const targetAgentId = config.agentId || body.agent_id || "main";
      const gatewayPort = api.config?.gateway?.port ?? state.gatewayPort ?? 18789;
      const gatewayToken = resolveGatewayToken(config, api);

      nativeToolListener = (eventData: any) => {
        logger.info(`[Lingzhu:NativeEvent] Received native_invoke event: ${JSON.stringify(eventData)}`);
        logger.info(`[Lingzhu:NativeEvent] Current sessionKey=${sessionKey}, targetAgentId=${targetAgentId}`);

        if (requestHasImage) {
          logger.warn("[Lingzhu:NativeEvent] 当前请求已包含图片，快速视觉通道已忽略原生工具调用");
          return;
        }

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

        const toolData: LingzhuSSEData = {
          role: "agent",
          type: "tool_call",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: false,  // 重要：不要过早发送 is_finish: true，避免 Lingzhu 代理粗暴断流
          tool_call: eventData.tool_call,
        };

        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.native_tool_call"),
          summarizeForDebug(toolData, includePayload)
        );

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

      const headers: Record<string, string> = {
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

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "openclaw.request"),
        {
          url: openclawUrl,
          headers: summarizeForDebug(headers, includePayload),
          body: summarizeForDebug(openclawBody, includePayload),
        }
      );

      const timeoutMs =
        typeof config.requestTimeoutMs === "number"
          ? Math.max(5000, Math.min(300000, Math.trunc(config.requestTimeoutMs)))
          : 60000;

      logger.info(
        `[Lingzhu] Calling OpenClaw: ${openclawUrl}, agentId=${targetAgentId}, sessionKey=${sessionKey}, timeout=${timeoutMs}ms`
      );

      const timeoutHandle = setTimeout(() => {
        abortUpstream(`OpenClaw request timeout after ${timeoutMs}ms`);
      }, timeoutMs);

      let openclawResponse: Response;
      try {
        openclawResponse = await fetch(openclawUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(openclawBody),
          signal: upstreamController.signal,
        });
      } catch (error) {
        if (upstreamController.signal.aborted) {
          throw new Error(String(upstreamController.signal.reason || `OpenClaw request timeout after ${timeoutMs}ms`));
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!openclawResponse.ok) {
        const errorText = await openclawResponse.text();
        throw new Error(`OpenClaw API error: ${openclawResponse.status} - ${errorText}`);
      }

      let fullResponse = "";
      const toolAccumulator = new ToolCallAccumulator();
      const streamedToolCalls: LingzhuSSEData[] = [];
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

              writeDebugLog(
                config,
                buildRequestLogName(body.message_id, "openclaw.chunk"),
                summarizeForDebug(chunk, includePayload)
              );

              if (delta?.content) {
                fullResponse += delta.content;

                if (nativeToolInvoked) {
                  logger.info("[Lingzhu] 已触发原生设备工具，跳过后续普通文本流");
                  continue;
                }

                streamedAnswer = true;
                const answerChunkData: LingzhuSSEData = {
                  role: "agent",
                  type: "answer",
                  answer_stream: delta.content,
                  message_id: body.message_id,
                  agent_id: body.agent_id,
                  is_finish: false,
                };
                writeDebugLog(
                  config,
                  buildRequestLogName(body.message_id, "response.answer_chunk"),
                  summarizeForDebug(answerChunkData, includePayload)
                );
                safeWrite(formatLingzhuSSE("message", answerChunkData));
              }

              if (finishReason === "tool_calls" || (finishReason && toolAccumulator.hasTools())) {
                for (const tool of toolAccumulator.getCompleted()) {
                  const lingzhuToolCall = parseToolCallFromAccumulated(tool.name, tool.arguments, {
                    defaultNavigationMode: config.defaultNavigationMode,
                    enableExperimentalNativeActions: config.enableExperimentalNativeActions,
                  });

                  if (lingzhuToolCall) {
                    const toolData: LingzhuSSEData = {
                      role: "agent",
                      type: "tool_call",
                      message_id: body.message_id,
                      agent_id: body.agent_id,
                      is_finish: false, // 改为 false，配合结尾的 is_finish
                      tool_call: lingzhuToolCall,
                    };
                    writeDebugLog(
                      config,
                      buildRequestLogName(body.message_id, "response.tool_call"),
                      summarizeForDebug(toolData, includePayload)
                    );
                    streamedToolCalls.push(toolData);
                  }
                }
              }
            } catch {
              // Ignore chunk parse failures.
            }
          }
        }
      } finally {
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

      if (!requestHasImage && !hasToolCall && fullResponse) {
        const detectedIntent = detectIntentFromText(fullResponse, {
          defaultNavigationMode: config.defaultNavigationMode,
          enableExperimentalNativeActions: config.enableExperimentalNativeActions,
        });
        if (detectedIntent) {
          logger.info(`[Lingzhu] 从文本检测到意图: ${JSON.stringify(detectedIntent)}`);
          const toolData: LingzhuSSEData = {
            role: "agent",
            type: "tool_call",
            message_id: body.message_id,
            agent_id: body.agent_id,
            is_finish: false,
            tool_call: detectedIntent,
          };
          const sseOutput = formatLingzhuSSE("message", toolData);
          logger.info(`[Lingzhu:DEBUG] Sending Legacy Intent SSE >> ${sseOutput.replace(/\n/g, "\\n")}`);
          writeDebugLog(
            config,
            buildRequestLogName(body.message_id, "response.intent_fallback"),
            summarizeForDebug(toolData, includePayload)
          );
          safeWrite(sseOutput);
        }
      } else if (!hasToolCall && streamedAnswer) {
        const finalAnswerData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: "",
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: true,
        };
        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.answer_done"),
          summarizeForDebug(finalAnswerData, includePayload)
        );
        safeWrite(formatLingzhuSSE("message", finalAnswerData));

        if (config.enableFollowUp !== false) {
          const followUps = extractFollowUpFromText(
            fullResponse,
            typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3
          );

          if (followUps && followUps.length > 0) {
            const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
            writeDebugLog(
              config,
              buildRequestLogName(body.message_id, "response.follow_up"),
              summarizeForDebug(followUpData, includePayload)
            );
            safeWrite(formatLingzhuSSE("message", followUpData));
          }
        }
      } else if (!hasToolCall && fullResponse) {
        const finalAnswerData: LingzhuSSEData = {
          role: "agent",
          type: "answer",
          answer_stream: fullResponse,
          message_id: body.message_id,
          agent_id: body.agent_id,
          is_finish: true,
        };
        writeDebugLog(
          config,
          buildRequestLogName(body.message_id, "response.final_answer"),
          summarizeForDebug(finalAnswerData, includePayload)
        );
        safeWrite(formatLingzhuSSE("message", finalAnswerData));

        if (config.enableFollowUp !== false) {
          const followUps = extractFollowUpFromText(
            fullResponse,
            typeof config.followUpMaxCount === "number" ? config.followUpMaxCount : 3
          );

          if (followUps && followUps.length > 0) {
            const followUpData = createFollowUpResponse(followUps, body.message_id, body.agent_id);
            writeDebugLog(
              config,
              buildRequestLogName(body.message_id, "response.follow_up"),
              summarizeForDebug(followUpData, includePayload)
            );
            safeWrite(formatLingzhuSSE("message", followUpData));
          }
        }
      }

      writeDebugLog(
        config,
        buildRequestLogName(body.message_id, "response.done"),
        {
          hasToolCall,
          fullResponse: summarizeForDebug(fullResponse, includePayload),
        }
      );

      // 如果整个请求链路中触发了任意 tool_call (原生 or 文本识别)，
      // 补发一个空的 is_finish: true 作为最终流束结标记，适配灵珠的接收器逻辑
      if (hasToolCall || nativeToolInvoked) {
        const finalFinishData: LingzhuSSEData = {
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
    } catch (error) {
      stopKeepalive();
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes("Client disconnected") || errorMsg.includes("Native tool fulfilled")) {
        logger.info(`[Lingzhu] Request fulfilled or client disconnected normally: ${errorMsg}`);
      } else {
        logger.error(`[Lingzhu] Error: ${errorMsg}`);
      }

      writeDebugLog(
        config,
        buildRequestLogName(requestMessageId, "error"),
        {
          message_id: requestMessageId,
          agent_id: requestAgentId,
          error: errorMsg,
        },
        true
      );

      if (!upstreamController.signal.aborted && !res.writableEnded) {
        const errorData: LingzhuSSEData = {
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
    } finally {
      if (nativeToolListener) {
        lingzhuEventBus.off("native_invoke", nativeToolListener);
      }
    }

    return true;
  };
}
