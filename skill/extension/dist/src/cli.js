import { getDebugLogFilePath } from "./debug-log.js";
import { cleanupImageCache, summarizeImageCache } from "./image-cache.js";
function maskSecret(secret) {
    if (!secret) {
        return "(empty)";
    }
    if (secret.length <= 8) {
        return "*".repeat(secret.length);
    }
    return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
}
export function registerLingzhuCli(ctx, getState) {
    const { program } = ctx;
    const lingzhuCmd = program
        .command("lingzhu")
        .description("灵珠平台接入管理");
    lingzhuCmd
        .command("info")
        .description("显示灵珠接入信息")
        .action(() => {
        const state = getState();
        const url = `http://127.0.0.1:${state.gatewayPort}/metis/agent/api/sse`;
        const debugLogState = `${state.config.debugLogging ? "ON" : "OFF"} ${getDebugLogFilePath(state.config)}`;
        console.log("");
        console.log("Lingzhu Bridge");
        console.log(`  SSE 接口: ${url}`);
        console.log(`  鉴权 AK: ${maskSecret(state.authAk)}`);
        console.log(`  智能体 ID: ${state.config.agentId || "main"}`);
        console.log(`  会话策略: ${state.config.sessionMode || "per_user"}`);
        console.log(`  调试日志: ${debugLogState}`);
        console.log(`  状态: ${state.config.enabled !== false ? "已启用" : "已禁用"}`);
        console.log("");
        console.log("如需复制完整 Bearer Token 调试示例，请运行:");
        console.log("  openclaw lingzhu curl");
        console.log("");
    });
    lingzhuCmd
        .command("status")
        .description("检查灵珠接入状态")
        .action(() => {
        const state = getState();
        console.log(state.config.enabled !== false ? "已启用" : "已禁用");
    });
    lingzhuCmd
        .command("curl")
        .description("输出可直接复制的本地联调 curl 命令")
        .action(() => {
        const state = getState();
        const url = `http://127.0.0.1:${state.gatewayPort}/metis/agent/api/sse`;
        const agentId = state.config.agentId || "main";
        console.log(`curl -X POST '${url}' \\`);
        console.log(`--header 'Authorization: Bearer ${state.authAk}' \\`);
        console.log("--header 'Content-Type: application/json' \\");
        console.log("--data '{");
        console.log('  "message_id": "test_local_01",');
        console.log(`  "agent_id": "${agentId}",`);
        console.log('  "message": [');
        console.log('    {"role": "user", "type": "text", "text": "你好"}');
        console.log("  ]");
        console.log("}'");
    });
    lingzhuCmd
        .command("capabilities")
        .description("显示当前桥接支持的眼镜能力")
        .action(() => {
        const state = getState();
        const experimentalEnabled = state.config.enableExperimentalNativeActions === true;
        console.log("支持的眼镜能力:");
        console.log("  - take_photo: 拍照");
        console.log("  - take_navigation: 导航");
        console.log("  - control_calendar: 日程提醒");
        console.log("  - notify_agent_off: 退出智能体");
        if (experimentalEnabled) {
            console.log("  - send_notification: 实验性通知");
            console.log("  - send_toast: 实验性提示");
            console.log("  - speak_tts: 实验性播报");
            console.log("  - start_video_record / stop_video_record: 实验性录像");
            console.log("  - open_custom_view: 实验性自定义页面");
        }
        else {
            console.log("  - 实验性原生动作: 未启用");
            console.log("    需设置 enableExperimentalNativeActions=true 后可用");
        }
        console.log("");
        console.log("桥接增强能力:");
        console.log("  - 多模态图片预处理（受信 file URL / data URL / 远程图片）");
        console.log("  - Follow-up 建议生成");
        console.log("  - 可配置会话策略");
        console.log("  - 健康检查与联调 curl");
        console.log("  - 文件调试日志与载荷脱敏");
    });
    lingzhuCmd
        .command("logpath")
        .description("显示桥接文件日志路径")
        .action(() => {
        const state = getState();
        console.log(getDebugLogFilePath(state.config));
    });
    lingzhuCmd
        .command("doctor")
        .description("输出桥接自检结果")
        .action(async () => {
        const state = getState();
        const cache = await summarizeImageCache();
        const issues = [];
        if (state.config.enabled === false) {
            issues.push("插件当前处于禁用状态");
        }
        if (!state.authAk) {
            issues.push("当前没有可用 AK");
        }
        if (!state.config.agentId) {
            issues.push("未显式配置 agentId，将回退到 main");
        }
        if (state.chatCompletionsEnabled !== true) {
            issues.push("gateway.http.endpoints.chatCompletions.enabled 未开启");
        }
        console.log("Lingzhu Doctor");
        console.log(`  插件状态: ${state.config.enabled !== false ? "已启用" : "已禁用"}`);
        console.log(`  智能体 ID: ${state.config.agentId || "main"}`);
        console.log(`  请求超时: ${state.config.requestTimeoutMs || 60000} ms`);
        console.log(`  会话策略: ${state.config.sessionMode || "per_user"}`);
        console.log(`  Follow-up: ${state.config.enableFollowUp !== false ? "ON" : "OFF"}`);
        console.log(`  实验动作: ${state.config.enableExperimentalNativeActions === true ? "ON" : "OFF"}`);
        console.log(`  调试日志: ${state.config.debugLogging === true ? "ON" : "OFF"}`);
        console.log(`  Chat Completions: ${state.chatCompletionsEnabled === true ? "ON" : "OFF"}`);
        console.log(`  图片缓存: ${cache.dir} (${cache.files} files)`);
        if (issues.length > 0) {
            console.log("");
            console.log("Warnings:");
            for (const issue of issues) {
                console.log(`  - ${issue}`);
            }
        }
    });
    lingzhuCmd
        .command("cache-cleanup")
        .description("清理 24 小时前的图片缓存")
        .action(async () => {
        const summary = await cleanupImageCache();
        console.log(`removed=${summary.removed} kept=${summary.kept}`);
    });
    return lingzhuCmd;
}
//# sourceMappingURL=cli.js.map