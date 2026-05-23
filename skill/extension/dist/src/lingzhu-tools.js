import { lingzhuEventBus } from "./events.js";
import { parseToolCallFromAccumulated } from "./transform.js";
const EMPTY_PARAMS = {
    type: "object",
    properties: {},
    required: [],
};
const TOOL_DEFINITIONS = [
    {
        name: "take_photo",
        command: "take_photo",
        description: "使用灵珠设备的摄像头拍照。当用户要求拍照、拍摄、照相时，必须调用此工具，或者有使用关于视觉能力(看一下这个东西，看一下我前面有什么)。",
        parameters: EMPTY_PARAMS,
        statusText: () => "正在通过灵珠设备拍照...",
    },
    {
        name: "navigate",
        command: "take_navigation",
        description: "使用灵珠设备的导航功能，导航到指定地址或 POI。当用户要求导航、带路、去某地时，必须调用此工具。(注意不要回复，直接调用工具)",
        parameters: {
            type: "object",
            properties: {
                destination: { type: "string", description: "目标地址或 POI 名称" },
                navi_type: {
                    type: "string",
                    enum: ["0", "1", "2"],
                    description: "导航类型：0=驾车，1=步行，2=骑行",
                },
            },
            required: ["destination"],
        },
        statusText: (params) => {
            const destination = typeof params.destination === "string" ? params.destination : "目标地点";
            return `正在导航到 ${destination}...`;
        },
    },
    {
        name: "calendar",
        command: "control_calendar",
        description: "在灵珠设备上创建日程提醒。当用户要求添加日程、设置提醒、安排事项时，必须调用此工具。",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "日程标题" },
                start_time: { type: "string", description: "开始时间，格式：YYYY-MM-DD HH:mm" },
                end_time: { type: "string", description: "结束时间，格式：YYYY-MM-DD HH:mm" },
            },
            required: ["title", "start_time"],
        },
        statusText: (params) => {
            const title = typeof params.title === "string" ? params.title : "日程";
            return `已创建日程：${title}`;
        },
    },
    {
        name: "exit_agent",
        command: "notify_agent_off",
        description: "退出当前智能体会话，返回灵珠主界面。当用户要求退出、结束对话时，必须调用此工具。",
        parameters: EMPTY_PARAMS,
        statusText: () => "正在退出智能体...",
    },
    {
        name: "send_notification",
        command: "send_notification",
        description: "向眼镜发送通知，可选同步 TTS 播报。实验性原生动作。",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "通知内容" },
                play_tts: { type: "boolean", description: "是否同步播报 TTS" },
                icon_type: { type: "string", description: "图标类型，默认 1" },
            },
            required: ["content"],
        },
        experimental: true,
        statusText: () => "已向眼镜发送通知",
    },
    {
        name: "send_toast",
        command: "send_toast",
        description: "向眼镜发送轻提示 Toast。实验性原生动作。",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "Toast 内容" },
                play_tts: { type: "boolean", description: "是否同步播报 TTS" },
                icon_type: { type: "string", description: "图标类型，默认 1" },
            },
            required: ["content"],
        },
        experimental: true,
        statusText: () => "已向眼镜发送提示",
    },
    {
        name: "speak_tts",
        command: "speak_tts",
        description: "在眼镜端直接播报一段文本。实验性原生动作。",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "播报内容" },
            },
            required: ["content"],
        },
        experimental: true,
        statusText: () => "正在播报文本",
    },
    {
        name: "start_video_record",
        command: "start_video_record",
        description: "开始眼镜录像。实验性原生动作。",
        parameters: {
            type: "object",
            properties: {
                duration_sec: { type: "number", description: "录像时长，单位秒" },
                width: { type: "number", description: "录像宽度" },
                height: { type: "number", description: "录像高度" },
                quality: { type: "number", description: "画质或质量" },
            },
            required: [],
        },
        experimental: true,
        statusText: () => "正在开始录像",
    },
    {
        name: "stop_video_record",
        command: "stop_video_record",
        description: "停止眼镜录像。实验性原生动作。",
        parameters: EMPTY_PARAMS,
        experimental: true,
        statusText: () => "正在停止录像",
    },
    {
        name: "open_custom_view",
        command: "open_custom_view",
        description: "打开眼镜上的实验性自定义页面。实验性原生动作。",
        parameters: {
            type: "object",
            properties: {
                view_name: { type: "string", description: "页面名称" },
                view_payload: { type: "string", description: "页面 JSON 或配置字符串" },
            },
            required: ["view_name"],
        },
        experimental: true,
        statusText: () => "正在打开自定义页面",
    },
];
function getLingzhuToolDefinitions(enableExperimentalNativeActions) {
    return TOOL_DEFINITIONS.filter((tool) => enableExperimentalNativeActions || tool.experimental !== true);
}
function encodeMarkerParams(params) {
    return Buffer.from(JSON.stringify(params ?? {}), "utf8").toString("base64url");
}
function formatToolMarker(command, params) {
    return `<LINGZHU_TOOL_CALL:${command}:${encodeMarkerParams(params)}>`;
}
export function createLingzhuToolSchemas(enableExperimentalNativeActions = false) {
    return getLingzhuToolDefinitions(enableExperimentalNativeActions).map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}
export function createLingzhuTools(enableExperimentalNativeActions = false) {
    return getLingzhuToolDefinitions(enableExperimentalNativeActions).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        async execute(_id, params, ctx) {
            console.log(`[Lingzhu:Native] Tool execute called for ${tool.name} with params:`, params);
            console.log(`[Lingzhu:Native] Context (ctx) provided:`, ctx);
            const marker = formatToolMarker(tool.command, params);
            const statusText = tool.statusText?.(params) ?? "";
            try {
                const parsedToolCall = parseToolCallFromAccumulated(tool.name, JSON.stringify(params), {
                    enableExperimentalNativeActions
                });
                console.log(`[Lingzhu:Native] Parsed Tool Call:`, parsedToolCall);
                if (parsedToolCall) {
                    const sessionKey = ctx?.user || ctx?.session?.user || ctx?.sessionKey || ctx?.sessionId;
                    const agentId = ctx?.agentId || ctx?.agent_id;
                    const emitPayload = {
                        sessionKey,
                        agentId,
                        tool_call: parsedToolCall
                    };
                    console.log(`[Lingzhu:Native] Emitting native_invoke with payload:`, emitPayload);
                    lingzhuEventBus.emit("native_invoke", emitPayload);
                }
                else {
                    console.log(`[Lingzhu:Native] Failed to parse tool call from command ${tool.name}`);
                }
            }
            catch (err) {
                console.error(`[Lingzhu:Native] Error during execute parsing:`, err);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: statusText ? `${marker} ${statusText}` : marker,
                    },
                ],
            };
        },
    }));
}
//# sourceMappingURL=lingzhu-tools.js.map