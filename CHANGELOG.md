# Changelog

## 1.0.1 (2026-10-23)

### Fixes

- **流式工具调用的名字被重复拼接**（`BashBashBash…`，导致外部客户端报「工具不存在」、请求一直卡住）：宿主 adapter 在**每一个** `tool-call-delta` 上都带着完整的 `id` 与 `name`（`llm-pi-ai` 的 `toolcall_delta` 就是如此），而 OpenAI 客户端会**累积拼接**每个字符串字段，于是 `Bash` 被拼成几十份。现在按「后缀增量」下发：字段没变就发空、只变长就发增量、整段变化才发全量 —— 客户端拼一次正好等于一个正确的名字与一个调用 ID。非流式路径同样按该规则合并。
- 新增回归检查：以真实 adapter 的重复行为驱动流式工具调用，断言按 OpenAI 语义拼接后 `name` / `id` / `arguments` 各只有一份；并验证 `tool` 结果消息带回 `tool_call_id` 后仍被正确翻译。

## 1.0.0 (2026-10-23)

首个公开版本。把已经配置在 DeepSeek Harness 里的**全部 provider、全部模型**暴露成一个固定的 OpenAI 兼容接口，并提供侧边栏页面管理端口、密钥与模型清单。

### Added

- **OpenAI 兼容接口**：`GET /v1/models`、`GET /v1/models/<provider>/<model>`、`POST /v1/chat/completions`、`POST /v1/completions`、`OPTIONS /v1/*`（CORS 预检，无需鉴权）。
- **按 `provider/model` 命名** —— 一个裸模型 ID 在只有一个 provider 提供时同样可用；多个 provider 撞名时返回候选列表而不是猜一个。
- **翻译层**：`system` / `developer` 折进 system 提示；`user` / `assistant` / `tool` 转成 LLM 消息块；`tools` 转函数声明；`tool_calls` 分片拼装完整并回到 `tool_call_id`；`reasoning_content` 单独返回；`usage` 映射为 `prompt_tokens` / `completion_tokens` / `total_tokens`（含 reasoning / cache 细分）。
- **`reasoning_effort` 按目标模型声明的档位映射**，不支持的档位降级或丢弃，不拒请求。
- **`stop` 降级**：上游返回 `UNSUPPORTED_OPTION` 时去掉 `stop` 重试一次。
- **固定端口**（默认 `8787`，只绑 `127.0.0.1`）：与界面端口解耦，重启不变；启动时端口被占用自动落到随机端口继续服务并在页面标明；页面可即时改端口，被占用时返回 `409` 且继续在原端口服务。
- **固定密钥**：`sk-dsh-…` 落在 `$DSH_HOME/openai-gateway/settings.json`（0600），跨重启不变；页面 **生成** 可轮换（两步确认）。自动迁移旧版 `api-key` 文件。
- **侧边栏「模型网关」页**（`sidebar.panellist` + `main` 面板）：接口地址、密钥（打码 / 显示 / 复制）、端口编辑、按 provider 折叠的完整模型清单，支持单个 / 整组 / 全部复制。
- **控制接口**：`GET /plugins/dsh-openai-gateway/status`、`POST …/settings`、`POST …/key`，要求同源 + `POST` + JSON Content-Type，且状态文档自带完整模型清单（页面只发一个同源请求）。

### Compatibility

1.0.0 在以下 provider 插件上实测通过（真实凭据、真实上游）：

- **`@opencode2dsh/dsh-plugin`**（provider `opencode2dsh`）—— 免费额度模型，如 `opencode2dsh/deepseek-v4.1-flash-free`（阻塞与流式均验证）。
- **`dsh-connect-workbuddy`**（provider `workbuddy`、`workbuddy-global`）—— 如 `workbuddy/deepseek-v4.1-flash`；账号池换号时上游注入的提示原样透传。
- **`dsh-workbuddy-xdpool`**（provider `workbuddy-xdpool`）—— 同样经 `ctx.llm` 路由，无需适配。
- **`@deepseek-ai/dsh-llm-pi-ai` 的本地路由**（provider `local`，例如指向 Ollama 的 `qwen3.5:4b`）。
- **DSH 内置 DeepSeek provider**（`deepseek-official`、`deepseek-account`）。

网关不按厂商写转发逻辑：它只读 `ctx.llm` 已注册的 provider，因此任何把 provider 注册进 `ctx.llm` 的插件都自动可用。上游需要的请求头由各 provider 自己的 adapter 负责，网关不额外拼装。

### Known limits

- 外部客户端不能传图片与文件（会话外拿不到可持久化的附件引用），只转发文本。
- 只绑 `127.0.0.1`，不是网络服务。
- 没有 web server 的 profile 无页面与控制接口，但 `/v1/*` 仍按固定端口提供服务。
