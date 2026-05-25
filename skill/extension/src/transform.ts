import type {
  LingzhuMessage,
  LingzhuContext,
  LingzhuSSEData,
  LingzhuToolCall,
} from "./types.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | { type: string; image_url?: { url: string } }[];
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
}

interface LingzhuTransformOptions {
  systemPrompt?: string;
  defaultNavigationMode?: "0" | "1" | "2";
  enableExperimentalNativeActions?: boolean;
}

const EXPERIMENTAL_COMMANDS = new Set<LingzhuToolCall["command"]>([
  "send_notification",
  "send_toast",
  "speak_tts",
  "start_video_record",
  "stop_video_record",
  "open_custom_view",
]);

const ALLOWED_MARKER_COMMANDS = new Set<LingzhuToolCall["command"]>([
  "take_photo",
  "take_navigation",
  "notify_agent_off",
  "control_calendar",
  "send_notification",
  "send_toast",
  "speak_tts",
  "start_video_record",
  "stop_video_record",
  "open_custom_view",
]);

function resolveNavigationMode(
  value: unknown,
  fallback: "0" | "1" | "2" = "0"
): "0" | "1" | "2" {
  return value === "1" || value === "2" ? value : fallback;
}

function createDefaultSystemPrompt(enableExperimentalNativeActions = false): string {
  const lines = [
    "你是灵珠设备桥接助手，需要优先把用户意图转换成设备工具调用。",
    "当用户要求拍照、拍摄、照相或记录当前画面时，必须调用 take_photo。",
    "当用户提出工业巡检、设备检查、故障诊断、表计识别、异常判断等视觉任务时，必须先调用 take_photo 获取当前画面，再基于图片回答。",
    "当用户要求导航、带路、去某地时，必须调用 navigate，并尽量补充 destination。",
    "当用户要求添加日程、设置提醒、安排事项时，必须调用 calendar。",
    "当用户要求退出、结束当前智能体会话时，必须调用 exit_agent。",
    "不要把工具调用伪装成普通文本说明；能调用工具时优先调用工具。",
  ];

  if (enableExperimentalNativeActions) {
    lines.push("当用户要求发送眼镜通知时，调用 send_notification。");
    lines.push("当用户要求发送轻提示或 Toast 时，调用 send_toast。");
    lines.push("当用户要求眼镜直接播报文本时，调用 speak_tts。");
    lines.push("当用户要求开始录像时，调用 start_video_record；要求停止录像时，调用 stop_video_record。");
    lines.push("当用户要求打开自定义页面或实验界面时，调用 open_custom_view。");
  }

  return lines.join("\n");
}

const TOOL_COMMAND_MAP: Record<string, LingzhuToolCall["command"]> = {
  take_photo: "take_photo",
  camera: "take_photo",
  photo: "take_photo",
  takepicture: "take_photo",
  snapshot: "take_photo",

  navigate: "take_navigation",
  navigation: "take_navigation",
  take_navigation: "take_navigation",
  maps: "take_navigation",
  route: "take_navigation",
  directions: "take_navigation",

  calendar: "control_calendar",
  add_calendar: "control_calendar",
  control_calendar: "control_calendar",
  schedule: "control_calendar",
  reminder: "control_calendar",
  add_reminder: "control_calendar",
  create_event: "control_calendar",
  set_schedule: "control_calendar",

  exit_agent: "notify_agent_off",
  exit: "notify_agent_off",
  quit: "notify_agent_off",
  notify_agent_off: "notify_agent_off",
  close_agent: "notify_agent_off",
  leave_agent: "notify_agent_off",

  send_notification: "send_notification",
  notification: "send_notification",
  notify: "send_notification",
  send_toast: "send_toast",
  toast: "send_toast",
  speak_tts: "speak_tts",
  tts: "speak_tts",
  speak: "speak_tts",
  start_video_record: "start_video_record",
  start_recording: "start_video_record",
  record_video: "start_video_record",
  stop_video_record: "stop_video_record",
  stop_recording: "stop_video_record",
  open_custom_view: "open_custom_view",
  custom_view: "open_custom_view",
  show_view: "open_custom_view",
};

function resolveToolCommand(
  toolName: string,
  options: LingzhuTransformOptions = {}
): LingzhuToolCall["command"] | null {
  const command = TOOL_COMMAND_MAP[toolName.toLowerCase()] ?? null;
  if (!command) {
    return null;
  }

  if (EXPERIMENTAL_COMMANDS.has(command) && options.enableExperimentalNativeActions !== true) {
    return null;
  }

  return command;
}

export class ToolCallAccumulator {
  private tools: Map<number, { id: string; name: string; arguments: string }> = new Map();

  accumulate(toolCalls: OpenAIToolCall[]): void {
    for (const tc of toolCalls) {
      const index = tc.index ?? 0;

      if (!this.tools.has(index)) {
        this.tools.set(index, {
          id: tc.id || "",
          name: tc.function?.name || "",
          arguments: "",
        });
      }

      const existing = this.tools.get(index)!;
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    }
  }

  getCompleted(): Array<{ id: string; name: string; arguments: string }> {
    return Array.from(this.tools.values()).filter((tool) => tool.name);
  }

  hasTools(): boolean {
    return this.tools.size > 0;
  }

  clear(): void {
    this.tools.clear();
  }
}

function decodeMarkerParams(rawValue: string): Record<string, unknown> {
  const value = rawValue.trim();
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function extractLingzhuToolMarker(
  text: string
): { command: LingzhuToolCall["command"]; params: Record<string, unknown> } | null {
  const markerPrefix = "<LINGZHU_TOOL_CALL:";
  const markerStart = text.indexOf(markerPrefix);
  if (markerStart < 0) {
    return null;
  }

  const commandSeparator = text.indexOf(":", markerStart + markerPrefix.length);
  const markerEnd = text.lastIndexOf(">");
  if (commandSeparator < 0 || markerEnd < 0) {
    return null;
  }

  const command = text.slice(markerStart + markerPrefix.length, commandSeparator).trim();
  if (!ALLOWED_MARKER_COMMANDS.has(command as LingzhuToolCall["command"])) {
    return null;
  }

  return {
    command: command as LingzhuToolCall["command"],
    params: decodeMarkerParams(text.slice(commandSeparator + 1, markerEnd)),
  };
}

export function detectIntentFromText(
  text: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const experimentalEnabled = options.enableExperimentalNativeActions === true;

  const markerMatch = extractLingzhuToolMarker(text);
  if (markerMatch) {
    const command = markerMatch.command;
    if (EXPERIMENTAL_COMMANDS.has(command) && !experimentalEnabled) {
      return null;
    }

    const rawParams = markerMatch.params;
    const toolCall: LingzhuToolCall = {
      handling_required: true,
      command,
      is_recall: true,
    };

    if (command === "take_navigation") {
      toolCall.action = "open";
      if (rawParams.destination) toolCall.poi_name = String(rawParams.destination);
      toolCall.navi_type = resolveNavigationMode(rawParams.navi_type, defaultNavigationMode);
    } else if (command === "control_calendar") {
      toolCall.action = "create";
      if (rawParams.title) toolCall.title = String(rawParams.title);
      if (rawParams.start_time) toolCall.start_time = String(rawParams.start_time);
      if (rawParams.end_time) toolCall.end_time = String(rawParams.end_time);
    } else if (command === "send_notification" || command === "send_toast" || command === "speak_tts") {
      if (rawParams.content) toolCall.content = String(rawParams.content);
      if (typeof rawParams.play_tts === "boolean") toolCall.play_tts = rawParams.play_tts;
      if (rawParams.icon_type) toolCall.icon_type = String(rawParams.icon_type);
    } else if (command === "start_video_record") {
      if (typeof rawParams.duration_sec === "number") toolCall.duration_sec = rawParams.duration_sec;
      if (typeof rawParams.width === "number") toolCall.width = rawParams.width;
      if (typeof rawParams.height === "number") toolCall.height = rawParams.height;
      if (typeof rawParams.quality === "number") toolCall.quality = rawParams.quality;
    } else if (command === "open_custom_view") {
      if (rawParams.view_name) toolCall.view_name = String(rawParams.view_name);
      if (rawParams.view_payload) {
        toolCall.view_payload = typeof rawParams.view_payload === "string"
          ? rawParams.view_payload
          : JSON.stringify(rawParams.view_payload);
      }
    }

    return toolCall;
  }

  const patterns: Array<{ regex: RegExp; command: LingzhuToolCall["command"] }> = [
    { regex: /拍照|拍张照|照相|拍一张|帮我拍/, command: "take_photo" },
    { regex: /退出智能体|退出当前会话|结束对话|关闭智能体/, command: "notify_agent_off" },
  ];

  if (experimentalEnabled) {
    patterns.push({ regex: /发(一条|个)?通知|发送通知/, command: "send_notification" });
    patterns.push({ regex: /toast|轻提示|弹出提示/i, command: "send_toast" });
    patterns.push({ regex: /播报|朗读|语音提示|念一段/, command: "speak_tts" });
    patterns.push({ regex: /开始录像|录一段视频|开始录制/, command: "start_video_record" });
    patterns.push({ regex: /停止录像|结束录像|停止录制/, command: "stop_video_record" });
    patterns.push({ regex: /打开.*页面|显示.*页面|展示.*页面/, command: "open_custom_view" });
  }

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      return {
        handling_required: true,
        command: pattern.command,
        is_recall: true,
      };
    }
  }

  const navigationMatch = text.match(/(?:导航(?:到|去)?|前往|带我去|带路去)\s*[:：]?\s*([^\n，。！？]+)/);
  if (navigationMatch?.[1]) {
    return {
      handling_required: true,
      command: "take_navigation",
      is_recall: true,
      action: "open",
      poi_name: navigationMatch[1].trim(),
      navi_type: defaultNavigationMode,
    };
  }

  return null;
}

export function lingzhuToOpenAI(
  messages: LingzhuMessage[],
  context?: LingzhuContext,
  options: LingzhuTransformOptions = {}
): OpenAIMessage[] {
  const openaiMessages: OpenAIMessage[] = [];
  const systemParts: string[] = [createDefaultSystemPrompt(options.enableExperimentalNativeActions === true)];

  if (options.systemPrompt) {
    systemParts.push(options.systemPrompt);
  }

  if (systemParts.length > 0) {
    openaiMessages.push({
      role: "system",
      content: systemParts.join("\n\n"),
    });
  }

  if (context) {
    const parts: string[] = [];
    if (context.currentTime) parts.push(`当前时间: ${context.currentTime}`);
    if (context.location) parts.push(`位置: ${context.location}`);
    if (context.weather) parts.push(`天气: ${context.weather}`);
    if (context.battery) parts.push(`电量: ${context.battery}%`);
    if (context.latitude && context.longitude) {
      parts.push(`坐标: ${context.latitude}, ${context.longitude}`);
    }
    if (context.lang) parts.push(`语言: ${context.lang}`);
    if (context.runningApp) parts.push(`当前运行应用: ${context.runningApp}`);

    if (parts.length > 0) {
      openaiMessages.push({
        role: "system",
        content: `[rokid glasses 信息]\n${parts.join("\n")}`,
      });
    }
  }

  for (const msg of messages) {
    const role = msg.role === "agent" ? "assistant" : "user";

    if (msg.type === "text" && msg.text) {
      openaiMessages.push({ role, content: msg.text });
    } else if (msg.type === "text" && msg.content) {
      openaiMessages.push({ role, content: msg.content });
    } else if (msg.type === "image" && msg.image_url) {
      openaiMessages.push({
        role,
        content: [{ type: "image_url", image_url: { url: msg.image_url } }],
      });
    }
  }

  return openaiMessages;
}

export function parseToolCallFromAccumulated(
  toolName: string,
  argsStr: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData["tool_call"] | null {
  const defaultNavigationMode = resolveNavigationMode(options.defaultNavigationMode);
  const command = resolveToolCommand(toolName, options);
  if (!command) {
    return null;
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr || "{}");
  } catch {
    args = {};
  }

  const toolCall: LingzhuToolCall = {
    handling_required: true,
    command,
    is_recall: true,
  };

  switch (command) {
    case "take_navigation":
      toolCall.action = (args.action as string) || "open";
      if (args.destination || args.poi_name || args.address) {
        toolCall.poi_name = String(args.destination || args.poi_name || args.address);
      }
      toolCall.navi_type = resolveNavigationMode(args.navi_type ?? args.type, defaultNavigationMode);
      break;

    case "control_calendar":
      toolCall.action = (args.action as string) || "create";
      if (args.title) toolCall.title = String(args.title);
      if (args.start_time || args.startTime) {
        toolCall.start_time = String(args.start_time || args.startTime);
      }
      if (args.end_time || args.endTime) {
        toolCall.end_time = String(args.end_time || args.endTime);
      }
      break;

    case "send_notification":
    case "send_toast":
    case "speak_tts":
      if (args.content) toolCall.content = String(args.content);
      if (typeof args.play_tts === "boolean") toolCall.play_tts = args.play_tts;
      if (args.icon_type) toolCall.icon_type = String(args.icon_type);
      break;

    case "start_video_record":
      if (typeof args.duration_sec === "number") toolCall.duration_sec = args.duration_sec;
      if (typeof args.width === "number") toolCall.width = args.width;
      if (typeof args.height === "number") toolCall.height = args.height;
      if (typeof args.quality === "number") toolCall.quality = args.quality;
      break;

    case "open_custom_view":
      if (args.view_name) toolCall.view_name = String(args.view_name);
      if (args.view_payload) {
        toolCall.view_payload = typeof args.view_payload === "string"
          ? args.view_payload
          : JSON.stringify(args.view_payload);
      }
      break;
  }

  return toolCall;
}

export function openaiChunkToLingzhu(
  chunk: OpenAIChunk,
  messageId: string,
  agentId: string,
  options: LingzhuTransformOptions = {}
): LingzhuSSEData {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const content = delta?.content || "";
  const isFinish = choice?.finish_reason != null;
  const toolCalls = delta?.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    const tc = toolCalls[0];
    if (tc.function?.name) {
      const parsedToolCall = parseToolCallFromAccumulated(
        tc.function.name,
        tc.function.arguments || "{}",
        options
      );

      if (parsedToolCall) {
        return {
          role: "agent",
          type: "tool_call",
          message_id: messageId,
          agent_id: agentId,
          is_finish: isFinish,
          tool_call: parsedToolCall,
        };
      }
    }
  }

  return {
    role: "agent",
    type: "answer",
    answer_stream: content,
    message_id: messageId,
    agent_id: agentId,
    is_finish: isFinish,
  };
}

export function createFollowUpResponse(
  suggestions: string[],
  messageId: string,
  agentId: string
): LingzhuSSEData {
  return {
    role: "agent",
    type: "follow_up",
    message_id: messageId,
    agent_id: agentId,
    is_finish: true,
    follow_up: suggestions,
  };
}

export function extractFollowUpFromText(text: string, limit = 3): string[] | null {
  const patterns = [
    /你还可以(?:问我|继续问|试试)[:：\s]*(.+)/,
    /(?:推荐|建议)(?:问题|提问)?[:：\s]*(.+)/,
    /(?:相关|更多)问题[:：\s]*(.+)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const suggestions = match[1]
      .split(/[,，;\n]/)
      .map((item) => item.replace(/^\d+[.、\s]*/, "").trim())
      .filter((item) => item.length > 0 && item.length < 100);

    if (suggestions.length > 0) {
      return suggestions.slice(0, Math.max(0, limit));
    }
  }

  return null;
}

export function formatLingzhuSSE(
  event: "message" | "done",
  data: LingzhuSSEData | string
): string {
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  return `event:${event}\ndata:${dataStr}\n\n`;
}
