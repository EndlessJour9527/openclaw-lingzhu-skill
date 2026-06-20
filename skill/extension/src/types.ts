/**
 * 灵珠插件配置类型
 */
export interface LingzhuConfig {
  enabled?: boolean;
  authAk?: string;
  /** 调用 OpenClaw Gateway /v1/chat/completions 时使用的 Bearer Token */
  gatewayToken?: string;
  agentId?: string;
  /** 是否将设备信息（metadata）传递给 OpenClaw，默认 true */
  includeMetadata?: boolean;
  /** OpenClaw /v1/chat/completions 请求超时（毫秒），默认 60000 */
  requestTimeoutMs?: number;
  /** 自定义 system prompt，用于增强模型对设备工具的调用约束 */
  systemPrompt?: string;
  /** 图片回传后的视觉分析预设：auto=按问题自动判断，industrial_inspection=工业巡检，fault_diagnosis=故障诊断，general_visual_qa=通用视觉问答 */
  visionPromptPreset?: "auto" | "industrial_inspection" | "fault_diagnosis" | "general_visual_qa";
  /** 默认导航方式：0=驾车，1=步行，2=骑行 */
  defaultNavigationMode?: "0" | "1" | "2";
  /** 是否启用 follow_up 建议，默认 true */
  enableFollowUp?: boolean;
  /** follow_up 最多返回多少条建议，默认 3 */
  followUpMaxCount?: number;
  /** 下载或解码图片时允许的最大字节数，默认 5MB */
  maxImageBytes?: number;
  /** 会话策略：per_user=按 user_id 保持上下文，shared_agent=同 agent 共用，per_message=每次独立 */
  sessionMode?: "per_user" | "shared_agent" | "per_message";
  /** 会话 key 前缀，默认 lingzhu */
  sessionNamespace?: string;
  /** 是否写入桥接调试日志到文件 */
  debugLogging?: boolean;
  /** 是否在调试日志里写入完整请求/响应载荷 */
  debugLogPayloads?: boolean;
  /** 调试日志目录，留空则写到插件目录下 logs/ */
  debugLogDir?: string;
  /** 是否启用实验性原生动作映射 */
  enableExperimentalNativeActions?: boolean;
}

/**
 * 灵珠请求消息格式
 */
export interface LingzhuMessage {
  role: "user" | "agent";
  type: "text" | "image";
  text?: string;
  content?: string;
  image_url?: string;
}

/**
 * 灵珠请求上下文
 */
export interface LingzhuContext {
  location?: string;
  latitude?: string;
  longitude?: string;
  weather?: string;
  battery?: string;
  currentTime?: string;
  lang?: string;
  company_id?: number;
  runningApp?: string;
}

export interface LingzhuMetadataEnvelope {
  context?: LingzhuContext;
  [key: string]: unknown;
}

/**
 * 灵珠请求体
 */
export interface LingzhuRequest {
  message_id: string;
  agent_id: string;
  message: LingzhuMessage[];
  user_id?: string;
  /** metadata 直接包含设备上下文信息（非嵌套在 context 下） */
  metadata?: LingzhuContext | LingzhuMetadataEnvelope;
}

/**
 * 灵珠工具调用
 */
export interface LingzhuToolCall {
  handling_required: boolean;
  command:
  | "take_photo"
  | "take_navigation"
  | "notify_agent_off"
  | "control_calendar"
  | "send_notification"
  | "send_toast"
  | "speak_tts"
  | "start_video_record"
  | "stop_video_record"
  | "open_custom_view";
  is_recall?: boolean;
  action?: string;
  poi_name?: string;
  navi_type?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  content?: string;
  play_tts?: boolean;
  icon_type?: string;
  duration_sec?: number;
  width?: number;
  height?: number;
  quality?: number;
  view_name?: string;
  view_payload?: string;
}

/**
 * 灵珠 SSE 响应数据
 */
export interface LingzhuSSEData {
  role: "agent";
  type: "answer" | "tool_call" | "follow_up";
  answer_stream?: string;
  message_id: string;
  agent_id: string;
  is_finish: boolean;
  follow_up?: string[];
  tool_call?: LingzhuToolCall;
}
