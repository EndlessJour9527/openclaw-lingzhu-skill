# OpenClaw Lingzhu

面向 Rokid/乐奇眼镜场景的 `Lingzhu <-> OpenClaw` 桥接插件。

## 安装

```bash
# 从本地目录安装
openclaw plugins install ./extension

# 或以开发模式链接安装
openclaw plugins install --link ./extension
```

## OpenClaw 2026.05.18 兼容性

此版本已在 `openclaw.plugin.json` 中补齐新版插件发现所需的静态声明：

- `activation.onStartup: true`，确保 Gateway 启动时加载桥接插件并注册 HTTP 路由。
- `contracts.tools`，声明插件运行时通过 `api.registerTool(...)` 注册的设备工具所有权。
- `activation.onConfigPaths`，当配置中出现 `plugins.entries.lingzhu` 时纳入启动加载计划。

安装或升级后建议执行：

```bash
openclaw plugins install --link ./extension
openclaw plugins doctor
openclaw lingzhu doctor
curl http://127.0.0.1:18789/metis/agent/api/health
```

## 配置

在 `openclaw.json` 或 `moltbot.json` 中加入：

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "lingzhu": {
        "enabled": true,
        "config": {
          "authAk": "",
          "agentId": "main",
          "includeMetadata": true,
          "requestTimeoutMs": 60000,
          "sessionMode": "per_user",
          "sessionNamespace": "lingzhu",
          "defaultNavigationMode": "0",
          "enableFollowUp": true,
          "followUpMaxCount": 3,
          "maxImageBytes": 5242880,
          "systemPrompt": "你是部署在 Rokid 眼镜上的智能助手。",
          "debugLogging": true,
          "debugLogPayloads": false,
          "debugLogDir": "",
          "enableExperimentalNativeActions": true
        }
      }
    }
  }
}
```

## CLI

```bash
openclaw lingzhu info
openclaw lingzhu status
openclaw lingzhu curl
openclaw lingzhu capabilities
openclaw lingzhu logpath
openclaw lingzhu doctor
openclaw lingzhu cache-cleanup
```

## 健康检查

```bash
curl http://127.0.0.1:18789/metis/agent/api/health
```

## 调试日志

启用 `debugLogging` 后，桥接日志默认写入插件目录下的 `logs/`：

- `logs/lingzhu-YYYY-MM-DD.log`

联调时建议先这样配置：

- `debugLogging: true`
- `debugLogPayloads: false`

只有在需要精确排查协议载荷时，再临时改为：

- `debugLogPayloads: true`

## 实验性原生动作

启用 `enableExperimentalNativeActions` 后，会额外向模型暴露这些实验动作：

- `send_notification`
- `send_toast`
- `speak_tts`
- `start_video_record`
- `stop_video_record`
- `open_custom_view`

这些动作是否被灵珠平台或眼镜端真实识别，仍需真机联调验证。

## 额外工具

- `openclaw lingzhu doctor`: 输出当前桥接自检结果，适合部署后快速核对配置。
- `openclaw lingzhu cache-cleanup`: 清理 24 小时前的图片缓存，避免联调过程中缓存目录持续膨胀。
