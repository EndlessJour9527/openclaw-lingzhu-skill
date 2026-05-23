import crypto from "node:crypto";
const DEFAULT_CONFIG = {
    enabled: true,
    authAk: "",
    agentId: "main",
    includeMetadata: true,
    requestTimeoutMs: 60000,
    systemPrompt: "",
    defaultNavigationMode: "0",
    enableFollowUp: true,
    followUpMaxCount: 3,
    maxImageBytes: 5 * 1024 * 1024,
    sessionMode: "per_user",
    sessionNamespace: "lingzhu",
    debugLogging: false,
    debugLogPayloads: false,
    debugLogDir: "",
    enableExperimentalNativeActions: false,
};
export function resolveLingzhuConfig(raw) {
    const cfg = (raw ?? {});
    const timeout = typeof cfg.requestTimeoutMs === "number" && Number.isFinite(cfg.requestTimeoutMs)
        ? Math.max(5000, Math.min(300000, Math.trunc(cfg.requestTimeoutMs)))
        : DEFAULT_CONFIG.requestTimeoutMs;
    const followUpMaxCount = typeof cfg.followUpMaxCount === "number" && Number.isFinite(cfg.followUpMaxCount)
        ? Math.max(0, Math.min(8, Math.trunc(cfg.followUpMaxCount)))
        : DEFAULT_CONFIG.followUpMaxCount;
    const maxImageBytes = typeof cfg.maxImageBytes === "number" && Number.isFinite(cfg.maxImageBytes)
        ? Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Math.trunc(cfg.maxImageBytes)))
        : DEFAULT_CONFIG.maxImageBytes;
    const defaultNavigationMode = cfg.defaultNavigationMode === "1" || cfg.defaultNavigationMode === "2"
        ? cfg.defaultNavigationMode
        : DEFAULT_CONFIG.defaultNavigationMode;
    const sessionMode = cfg.sessionMode === "shared_agent" || cfg.sessionMode === "per_message"
        ? cfg.sessionMode
        : DEFAULT_CONFIG.sessionMode;
    return {
        enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
        authAk: cfg.authAk ?? DEFAULT_CONFIG.authAk,
        agentId: cfg.agentId ?? DEFAULT_CONFIG.agentId,
        includeMetadata: cfg.includeMetadata ?? DEFAULT_CONFIG.includeMetadata,
        requestTimeoutMs: timeout,
        systemPrompt: typeof cfg.systemPrompt === "string" ? cfg.systemPrompt.trim() : DEFAULT_CONFIG.systemPrompt,
        defaultNavigationMode,
        enableFollowUp: cfg.enableFollowUp ?? DEFAULT_CONFIG.enableFollowUp,
        followUpMaxCount,
        maxImageBytes,
        sessionMode,
        sessionNamespace: typeof cfg.sessionNamespace === "string" && cfg.sessionNamespace.trim()
            ? cfg.sessionNamespace.trim()
            : DEFAULT_CONFIG.sessionNamespace,
        debugLogging: cfg.debugLogging ?? DEFAULT_CONFIG.debugLogging,
        debugLogPayloads: cfg.debugLogPayloads ?? DEFAULT_CONFIG.debugLogPayloads,
        debugLogDir: typeof cfg.debugLogDir === "string" ? cfg.debugLogDir.trim() : DEFAULT_CONFIG.debugLogDir,
        enableExperimentalNativeActions: cfg.enableExperimentalNativeActions ?? DEFAULT_CONFIG.enableExperimentalNativeActions,
    };
}
export function generateAuthAk() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const segments = [8, 4, 4, 4, 12];
    return segments
        .map((len) => {
        const bytes = crypto.randomBytes(len);
        let value = "";
        for (let i = 0; i < len; i += 1) {
            value += chars[bytes[i] % chars.length];
        }
        return value;
    })
        .join("-");
}
export const lingzhuConfigSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        enabled: { type: "boolean" },
        authAk: { type: "string" },
        agentId: { type: "string" },
        includeMetadata: { type: "boolean" },
        requestTimeoutMs: { type: "number", minimum: 5000, maximum: 300000 },
        systemPrompt: { type: "string" },
        defaultNavigationMode: { type: "string", enum: ["0", "1", "2"] },
        enableFollowUp: { type: "boolean" },
        followUpMaxCount: { type: "number", minimum: 0, maximum: 8 },
        maxImageBytes: { type: "number", minimum: 262144, maximum: 20971520 },
        sessionMode: { type: "string", enum: ["per_user", "shared_agent", "per_message"] },
        sessionNamespace: { type: "string" },
        debugLogging: { type: "boolean" },
        debugLogPayloads: { type: "boolean" },
        debugLogDir: { type: "string" },
        enableExperimentalNativeActions: { type: "boolean" },
    },
    parse(value) {
        return resolveLingzhuConfig(value);
    },
    uiHints: {
        enabled: { label: "启用灵珠接入" },
        authAk: {
            label: "鉴权密钥 (AK)",
            sensitive: true,
            help: "灵珠平台调用时携带的 Bearer Token，留空则自动生成",
        },
        agentId: {
            label: "智能体 ID",
            help: "使用的 OpenClaw 智能体 ID，默认 main",
        },
        includeMetadata: {
            label: "透传设备元信息",
            help: "是否将 metadata 中的时间、位置、电量等信息传给 OpenClaw，默认开启",
        },
        requestTimeoutMs: {
            label: "上游请求超时 (ms)",
            help: "调用 OpenClaw /v1/chat/completions 的超时时间，范围 5000~300000",
        },
        systemPrompt: {
            label: "自定义系统提示词",
            help: "可补充业务约束，帮助模型更稳定地选择拍照、导航、日程或退出工具",
        },
        defaultNavigationMode: {
            label: "默认导航方式",
            help: "当模型未明确指定时使用的导航模式：0=驾车，1=步行，2=骑行",
        },
        enableFollowUp: {
            label: "启用 follow_up 建议",
            help: "是否在普通文本回答后生成 follow_up 建议",
        },
        followUpMaxCount: {
            label: "follow_up 上限",
            help: "最多返回多少条 follow_up 建议，范围 0~8",
        },
        maxImageBytes: {
            label: "图片大小上限 (bytes)",
            help: "下载远程图片或解码 data URL 时允许的最大体积，范围 256KB~20MB",
        },
        sessionMode: {
            label: "会话策略",
            help: "per_user 按用户保持上下文，shared_agent 全员共享，per_message 每次独立",
        },
        sessionNamespace: {
            label: "会话命名空间",
            help: "构造 OpenClaw session key 时使用的前缀，便于多套桥接并存",
        },
        debugLogging: {
            label: "文件调试日志",
            help: "启用后将桥接链路写入插件目录 logs/ 或自定义目录",
        },
        debugLogPayloads: {
            label: "记录完整载荷",
            help: "启用后日志中包含完整请求和响应 JSON，仅建议联调时开启",
        },
        debugLogDir: {
            label: "调试日志目录",
            help: "调试日志写入目录，留空则使用插件目录下的 logs/",
        },
        enableExperimentalNativeActions: {
            label: "实验性原生动作",
            help: "启用通知、Toast、TTS、录像和自定义页面等实验性桥接动作",
        },
    },
};
//# sourceMappingURL=config.js.map