# Changelog

## 1.0.5 (2026-10-23)

### Added

- **`recent` 里补上「到底有没有正文」**：新增 `textBytes`（已下发的正文长度）、`reasoningBytes`（已下发的推理长度）、`finish`（`stop` / `max-tokens` / `tool-calls` / `aborted` / `error`）。
  - **为什么**：`outcome: "ok"` 只说明流是按协议收尾的，不说明客户端真的收到了回复。一个「推理写完了、正文一个字没发、`finish_reason: stop`」的响应在旧记录里和一次正常回答长得一模一样 —— 而客户端看到的正是「思考结束 → 没有回复 → 像断了」。现在 `textBytes: 0` 与 `finish: "stop"` 并列出现，就能一眼把「上游只给了推理」和「客户端自己断的」区分开。
- 回归检查补三条断言：成功请求必须记录非零 `textBytes`、`reasoningBytes` 为数字、`finish` 为 `stop`。**6/6**。

## 1.0.4 (2026-10-23)

### Added

- **状态文档里的「最近请求」诊断**（`GET /plugins/dsh-openai-gateway/status` 的 `recent`，最新在前，保留 20 条）。每条记录 `at` / `model` / `stream` / `ms` / `firstByteMs` / `attempts` / `outcome`（`ok`｜`error`｜`aborted`）/ `code` / `message`。
  - **为什么需要它**：`requests` 与 `failures` 两个计数器只能回答「有没有失败」，不能回答「刚才那一次到底怎么了」——客户端挂断和上游限流都会让同一个数字 +1。没有这条记录时，排查「外部调用又断了」只能靠猜：池子文件只能说明上游有没有拒绝，计数器只能说明有一次失败，两者对不上就无从下手。
  - 每条请求结束时还会写一行日志（成功走 info，失败走 warn，带 adapter 自己的 code 与原文）。
- 新增回归检查：`tests/resilience.spec.mjs` 第 6 条断言状态文档确实记录了最近请求的模型、是否流式、耗时、首字节时间与结束原因。**6/6**（`1.0.3` 上没有 `recent` 字段，这条会失败）。

## 1.0.3 (2026-10-23)

### Fixes

- **网关比宿主脆：同一个 provider，DSH 里跑得下来，网关里第一次失败就断。** 根因是网关少了宿主已有的那一层 —— `@deepseek-ai/dsh-llm` 的 agent loop 对 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` 默认重试 **5 次**、500 ms → 10 s 指数退避（抖动 0.1），并尊重上游自己给出的重置点；而网关的 `consume()` 直接把第一次失败交给调用方。于是上游一次 `14003`（模型繁忙）或 `6004`（用量超频）就是一次失败的 HTTP 请求，而宿主会等一会儿再答。
  - **补上重试层**：`blockingCompletion` 与 `streamCompletion` 都按同一套策略重试（策略可用 `retryMaxRetries` / `retryInitialDelayMs` / `retryMaxDelayMs` 覆盖）。流式只在**尚未写出任何字节**时重试 —— 一旦有 delta 上过线，重放会让调用方看到两遍答案，此时改为如实报告。
  - **上游给的重置点照办，但只在预算内**：`providerRetryAfterMs` ≤ `retryMaxDelayMs` 就等它，超过就当作「请稍后再来」直接失败。这和宿主 `llm-retry` 对超长 `providerRetryAfterMs` 的处置一致。
- **限流被答成 502**：`statusForCode()` 没有 `RATE_LIMIT` 分支，落到 `default: 502`。502 读起来是「网关坏了」，OpenAI 兼容客户端要么放弃、要么立刻重试，两种都不对。现在 `RATE_LIMIT` / `QUOTA` → **429**，`TIMEOUT` → **504**，错误类型为 `rate_limit_error`，并在上游给出重置点时回 `Retry-After`（同时保留 `retry_after_seconds` 字段）。
- **流中途失败被伪装成正常结束**：已写出字节后收到 `finish.kind === 'error'|'aborted'` 时，旧代码走到 `flush(); write({}, openAiFinish(finish))`，把一个被截断的答案标成 `finish_reason: "stop"`。现在改为在流内写一条 `data: {"error": …}` 再补 `data: [DONE]`，调用方读到的是「上游失败」而不是「连接断了」。
- **长思考期间连接上一个字节都没有**：`flush()`（写 200 + SSE 头）只在第一个 delta 到来时才调用，首字之前**连响应头都没有**，之后也从不发注释行。一个思考几分钟的模型，在调用方的读超时看来就是死连接 —— 这也是「外部调用过一会儿就断」的直接原因。现在超过 `silentFlushMs`（默认 10 s）仍无数据就先提交响应头，然后每 `keepAliveMs`（默认 15 s）写一条 `: keep-alive` SSE 注释直到流结束。代价是：一旦提交了响应头，首字之前的失败只能以流内 error 事件表达（不再是 JSON 状态码），所以只在「沉默已经比丢状态码更危险」的时候才提交。
- 新增回归检查 `tests/resilience.spec.mjs`（并入 `npm test`）：用可编排的假 adapter 驱动真实的 HTTP 监听器，断言「瞬时失败会重试并最终答复」「重试耗尽回 429 + Retry-After」「不可重试的失败立即回 400」「首字之后失败仍以 `[DONE]` 收尾」「安静期会发 keep-alive」。**判据是同一份测试在新旧构建上的差异**：对 `1.0.2` 跑是 **1/5**（只有「不可重试立即失败」那条本来就对），对 `1.0.3` 跑是 **5/5**；`tests/catalog-refresh.spec.mjs` 仍是 4/4。

### Compatibility

- 流式调用在「超过 10 秒没有首字」之后，失败会以流内 `data: {"error": …}` 的形式到达（而不是 HTTP 4xx/5xx）。这是为了让长任务不被读超时掐断；10 秒内失败的请求仍按原样回 JSON 状态码。
- 新增可选配置：`retryMaxRetries`、`retryInitialDelayMs`、`retryMaxDelayMs`、`silentFlushMs`、`keepAliveMs`。

## 1.0.2 (2026-10-23)

### Fixes

- **页面上的模型清单会永久缺掉「后注册」的 provider（实测：WorkBuddy、Qoder 消失）**：侧边栏页面读的是状态文档里的目录快照，而这份快照有两个致命之处。其一，`warmCatalog()` 的重试条件是「这一遍拿到非空目录就停」，于是 DeepSeek 这类秒答的内置 provider 先返回 4 个模型就把预热结束了；而凭据要 `resolve()`、目录要访问上游的 adapter（WorkBuddy 的 `registerModelDiscovery`）几秒后才绑上，profile 里排在网关**后面**的插件（如 `@eghrhegpe/dsh-connect-qoder`）更是在预热早已停下之后才 `registerAdapter`。其二，`statusPayload()` 直接读 `state.catalog.entries`，**从不重建** —— 所以页面上的「刷新」按钮只是把同一份冻结快照再渲染一遍，用户点多少次都恢复不了，只有外部 OpenAI 客户端调用过 `/v1/models` 才会顺带更新。
  - **预热改为「等 provider 集合稳定」**：不再是「一次非空即停」，而是每次 1 秒重读、连续两遍「已注册 provider 集合 + 已上报模型 provider 集合」完全一致、且已过 6 秒观察窗才停；30 次封顶，保证没有任何 provider 的 profile 也能正常启动。观察窗是必需的：插件绑定 provider 的时刻由它自己的异步初始化决定，网关无权假设「第 N 毫秒之后不会再有人来」。
  - **状态路由按需重建**：`statusPayload()` 现在先 `await catalog(ctx, state, ttl, refresh)`，快照超过 TTL 就重建；重建失败退回旧快照并记一条 warn，绝不让一次发现失败把页面打成空白。
  - **「刷新」按钮真的会刷新**：页面改为请求 `STATUS_PATH?refresh=1`，宿主侧用新增的 `refreshRequested(req.url)` 解析，命中就强制重建。改动前按钮发的是同一个无参 URL，语义上只等于「重画一遍」。
- 新增回归检查 `tests/catalog-refresh.spec.mjs`（`npm test`）：用一个可在任意时刻绑定、且模型列表会滞后的假 host 驱动真实的 `apply()`，断言四件事 —— 预热会等到迟到的 provider、TTL 内的普通读仍然走缓存、`?refresh=1` 会强制重建、TTL 到期后的读会自动重建。**判据是「同一份测试在旧构建上失败、在新构建上通过」**：对 `1.0.1` 的 `index.js` 跑是 1/4 通过（失败的正是迟到 provider、强制刷新、TTL 重建三条），对 `1.0.2` 跑是 4/4。

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
