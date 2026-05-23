import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lingzhuConfigSchema, resolveLingzhuConfig, generateAuthAk } from "./src/config.js";
import { createHttpHandler } from "./src/http-handler.js";
import { registerLingzhuCli } from "./src/cli.js";
import { createLingzhuTools } from "./src/lingzhu-tools.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AK_FILE = path.join(__dirname, "../.lingzhu.ak"); // 存储在插件根目录
// 插件状态
let pluginConfig = {};
let activeAuthAk = "";
let gatewayPort = 18789;
function maskSecret(secret) {
    if (!secret) {
        return "(empty)";
    }
    if (secret.length <= 8) {
        return "*".repeat(secret.length);
    }
    return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
}
/**
 * 灵珠平台接入插件
 */
const lingzhuPlugin = {
    id: "lingzhu",
    name: "Lingzhu Bridge",
    description: "灵珠平台 <-> OpenClaw 协议转换桥梁",
    configSchema: lingzhuConfigSchema,
    register(api) {
        const logger = api.logger;
        // 获取并解析配置
        const rawConfig = api.config?.plugins?.entries?.lingzhu?.config;
        pluginConfig = resolveLingzhuConfig(rawConfig);
        // 生成或使用已有 AK
        if (pluginConfig.authAk) {
            activeAuthAk = pluginConfig.authAk;
        }
        else {
            // 尝试从本地文件读取
            if (fs.existsSync(AK_FILE)) {
                try {
                    activeAuthAk = fs.readFileSync(AK_FILE, "utf-8").trim();
                    logger.info("[Lingzhu] 已从本地记录加载 AK");
                }
                catch (e) {
                    logger.warn(`[Lingzhu] 读取本地 AK 文件失败: ${e}`);
                }
            }
            // 如果还是没有，则生成并保存
            if (!activeAuthAk) {
                activeAuthAk = generateAuthAk();
                try {
                    fs.writeFileSync(AK_FILE, activeAuthAk, "utf-8");
                    logger.info("[Lingzhu] 已自动生成并持久化 AK");
                }
                catch (e) {
                    logger.warn(`[Lingzhu] 持久化 AK 文件失败: ${e}`);
                }
            }
        }
        // 获取 Gateway 端口
        gatewayPort = api.config?.gateway?.port ?? 18789;
        // 配置/状态获取函数
        const getConfig = () => pluginConfig;
        const getRuntimeState = () => ({
            config: pluginConfig,
            authAk: activeAuthAk,
            gatewayPort,
            chatCompletionsEnabled: api.config?.gateway?.http?.endpoints?.chatCompletions?.enabled === true,
        });
        // 1. 注册 HTTP 路由
        if (typeof api.registerHttpRoute === "function") {
            const httpHandler = createHttpHandler(api, getRuntimeState);
            api.registerHttpRoute({
                path: "/metis/agent/api/sse",
                handler: httpHandler,
                auth: "plugin",
                match: "exact",
            });
            api.registerHttpRoute({
                path: "/metis/agent/api/health",
                handler: httpHandler,
                auth: "plugin",
                match: "exact",
            });
            logger.info("[Lingzhu] 已注册 HTTP 路由: /metis/agent/api/sse, /metis/agent/api/health");
        }
        else if (typeof api.registerHttpHandler === "function") {
            api.registerHttpHandler(createHttpHandler(api, getRuntimeState));
            logger.info("[Lingzhu] 已注册 HTTP 端点: POST /metis/agent/api/sse");
        }
        // 2. 注册灵珠设备工具
        logger.info(`[Lingzhu] 检查 registerTool API: ${typeof api.registerTool}`);
        if (pluginConfig.enabled === false) {
            logger.info("[Lingzhu] 插件已禁用，跳过设备工具注册");
        }
        else if (typeof api.registerTool === "function") {
            const tools = createLingzhuTools(pluginConfig.enableExperimentalNativeActions === true);
            logger.info(`[Lingzhu] 准备注册 ${tools.length} 个工具`);
            for (const tool of tools) {
                try {
                    api.registerTool(tool, { optional: false });
                    logger.info(`[Lingzhu] 已注册工具: ${tool.name}`);
                }
                catch (e) {
                    logger.error(`[Lingzhu] 注册工具失败: ${tool.name}, 错误: ${e}`);
                }
            }
        }
        else {
            logger.warn("[Lingzhu] registerTool API 不可用，无法注册设备工具");
        }
        // 3. 注册 CLI 命令
        if (typeof api.registerCli === "function") {
            api.registerCli((ctx) => registerLingzhuCli(ctx, getRuntimeState), { commands: ["lingzhu"] });
        }
        // 4. 注册后台服务
        if (typeof api.registerService === "function") {
            api.registerService({
                id: "lingzhu-bridge",
                start: () => {
                    if (pluginConfig.enabled === false) {
                        logger.info("[Lingzhu] 插件已禁用");
                        return;
                    }
                    const url = `http://127.0.0.1:${gatewayPort}/metis/agent/api/sse`;
                    console.log("");
                    console.log("╔═══════════════════════════════════════════════════════════════════════╗");
                    console.log("║                    Lingzhu Bridge 已启动                              ║");
                    console.log("╠═══════════════════════════════════════════════════════════════════════╣");
                    console.log(`║  SSE 接口:  ${url.padEnd(56)}║`);
                    console.log(`║  鉴权 AK:   ${maskSecret(activeAuthAk).padEnd(56)}║`);
                    console.log("╚═══════════════════════════════════════════════════════════════════════╝");
                    console.log("");
                    logger.info(`[Lingzhu] Bridge 已启动，端点: ${url}`);
                },
                stop: () => {
                    logger.info("[Lingzhu] Bridge 已停止");
                },
            });
        }
    },
};
export default lingzhuPlugin;
//# sourceMappingURL=index.js.map