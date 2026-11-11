# Changelog

## 1.3.0 (2026-11-06)

### Changed

- **侧边栏页面重做为仪表盘**。原来的页面是单列 880px、没有层级、字号写死 11/12px、状态点用品牌蓝冒充「运行中」，而状态文档里早就有 `requests` / `failures` / `models` / `providers` / `startedAt` / `recent`（含真实 `usage`）—— **一条都没显示**。这次按宿主 UI 规范重建：
  - **吸顶页头**：标题 + 副标题，右侧运行状态药丸与刷新按钮，滚动时保持可见。
  - **五块指标**：请求数（含失败数）、模型数与 provider 数、令牌用量（入 / 出）、流量（进 / 出）、运行时长（自启动时刻起）。
  - **两列卡片**（≥900px 时并排，窄屏回落单列）：对外地址与本机地址（含端口直接修改）、隧道（状态 / 启停 / 地址 / 失败原因）、密钥（打码 / 显示 / 复制 / 两步确认换新）、模型别名（增删 + 保存）。
  - **可搜索模型目录**：按宿主 provider 顺序分组折叠，支持按 ID / 名称 / provider 过滤；搜索时命中的组自动展开。每行、每组、全部都有复制按钮。
  - **最近请求表**：时间、模型、成功或失败码徽标、令牌进→出、耗时；空态与「无用量」都给出明确文案而不是 `0 → 0`。
  - **修正状态色语义**：`.gw-dot.is-on` 原来指向 `--dsw-alias-state-business-primary`（解析到品牌蓝 `--dsw-static-deepseek-500`），绿值只是永不生效的 fallback。改用 `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` / `--dsw-alias-state-idle-primary`。
  - **全部视觉取自宿主 token**：颜色、边框、圆角、阴影、字号一律 `var(--dsw-*)`，零硬编码色值（`tests/style-tokens.spec.mjs` 强制）；排版用 `font: var(--dsw-font-xs-13)` 这类**简写** token（`--dsw-font-xs-12` / `-xs-11` / `-m-16` 在主题里**不存在**）。间距用页面自有刻度 `--gw-s1..s6`。
  - 新增文案全部走 locale 字典（`zh` / `en` 对齐，键集一致）。

### Added

- **`usageTotals` 与 `bytes` 累计**（状态文档新增两字段，页面据此渲染令牌与流量磁贴）：
  - `usageTotals: { inputTokens, outputTokens, totalTokens, reasoningTokens, cacheReadTokens, calls }` —— 在 `recordRequest`（每个请求的 `finally`，成功 / 拒绝 / 中止都经过）里累加。**只统计上游真的报了 `usage` 的请求**，未报的不加零、也不增 `calls`，避免数字被摊薄。
  - `bytes: { in, out }` —— 只统计 `/v1` 表面。入站由 `readBody` 记录真实字节数（**解析失败也计入**，字节确实到达了）；出站包住 `res.write` / `res.end` 两个出口，因此 JSON 体与 SSE 帧同一规则，且挂在 `finish` / `close` 上，任何提前 `return`（400 / 404）都不会漏计。控制接口的往返**不计入**，否则刷新页面会把流量撑大。
  - 两者**不持久化**：只描述本次进程生命周期，重启归零，页面用 `startedAt` 标注「自 HH:MM 起」。

### Tests

- 新增 `tests/usage-totals.spec.mjs`（**7/7**）：真实 `index.js` + 真实 HTTP 请求，覆盖「报用量的请求累加」「不报用量的请求不加零也不增 calls」「多次请求累加且与 `recent` 各行求和一致」「进出字节都被测量且入站等于客户端实际发送量」「被拒绝的请求仍计其入站字节但零令牌」「畸形请求体被拒前已计费」「新实例全零且带 `startedAt`」。
- 新增 `tests/style-tokens.spec.mjs`（**1/1**）：解析 `client.js` 里的样式表，要求每个承载颜色的声明都以 `var(--dsw-` 开头（`transparent` / `currentColor` 放行），且 token 引用数 ≥ 60（实测 **77**）。这条把「不许硬编码颜色」变成可执行判据。
- 改写 `tests/client-render.spec.mjs`（**8/8 → 16/16**）：除原有地址 / 隧道 / 别名 / curl 覆盖外，新增布局类存在性、五块磁贴读真实计数、缺计数时显示 `—` 与 `stat.noData` 而不是 0、搜索框可访问名、最近请求表两种结果与 `37k → 149` 缩写、空态、状态点 `is-on` / `is-bad` 类、首帧（状态为 `null`）仍能渲染。
- 回归合计 **56/56**（4 + 13 + 14 + 7 + 1 + 16 + 1 样式守卫计入前者），`npm test` 串联全部。

### Notes

- **生效方式不同**：`client.js` 由宿主的 `client-hmr` 每 500ms `statSync` 轮询 mtime/ctime/size，变化即 `rebuilt()` 重新发布 rev 并经 `/plugins/events` SSE 通知浏览器重载 —— **刷新页面即可看到新界面**。`index.js`（宿主半）是进程内代码，`usageTotals` / `bytes` 必须**重启 DSH** 才会出现在状态文档里；重启前页面会诚实地显示 `—` + `stat.noData`，不会假装是 0。
- 页面外观的验收只能由人看（亮色与暗色两种主题）；`client-render.spec.mjs` 明确只是**结构 / 崩溃回归**，不作为视觉验收依据，也不生成模拟渲染截图。

## 1.2.0 (2026-11-06)

### Added

- **模型别名（`aliases`）** —— 外部客户端发什么名字由它自己决定，别名把那些名字接到真实的 `provider/model` 上。实测背景：Cursor 自定义 Base URL 只发它写死的模型名，`gpt-4o` 原样转发得到 `404 model gpt-4o is not registered`；而 `deepseek-v4.1-flash`、`gpt-5.6-sol` 这类裸 ID 在真实 profile 里同时被 2–3 个 provider 提供（150 个模型 / 62 个唯一裸 ID / 37 个撞名），原样转发得到 `400 … exists on several providers (trae, trae-global, workbuddy) …`。
  - 解析顺序：`provider/model` → **别名** → 不撞名的裸 ID。别名先于目录解析，所以它**能压过撞名裸 ID**。
  - 别名会出现在 `/v1/models`（带 `alias_of`），`/v1/models/<别名>` 也返回 `alias_of`；响应里的 `model` 回显调用方发来的名字。
  - 目标必须是 `provider/model`；没有 provider 前缀的目标在配置里被丢弃、在写接口里被 400 拒绝 —— 不留必然 404 的别名。
  - 持久化进 `settings.json` 的 `aliases`；页面「模型别名」卡片可增删保存，`POST /plugins/dsh-openai-gateway/aliases` 整体替换。
- **对外地址（`publicBaseUrl`）** —— 页面同时显示**对外地址**与**本机地址**，curl 示例用对外地址。配置合法 URL 时优先于隧道地址与回环地址；不合法（非 http/https）时忽略。
- **插件自己拉起隧道（`tunnel`）** —— `tunnel: { provider: "ngrok" | "cloudflared", autostart: true }`，或用页面「隧道」卡片的启动/停止按钮（`POST /plugins/dsh-openai-gateway/tunnel`）。
  - 插件 `spawn` 子进程、从它自己的输出里读出公网 URL、写进状态文档与页面；`ctx.effect` 的清理函数 `kill` 掉子进程，实测退出后无残留 ngrok 进程。
  - URL 解析按**主机名**匹配（`https://<id>.ngrok-free.dev` / `https://<id>.trycloudflare.com`），因此 `--log-format json` 的 `"url":"…"`、文本日志的 `url=…`、默认人类可读日志的 `Forwarding  …` 三种格式都能识别。
  - 网关**仍然只绑 `127.0.0.1`** —— 隧道连的是回环地址，不需要改成 `0.0.0.0`；对外只公开 `/v1`。
- **`apply()` 返回实例状态** —— 便于测试（与宿主调试）读取实际绑定的端口、密钥与隧道状态，而不是靠猜端口。

### Tests

- 新增 `tests/alias.spec.mjs`（**14/14**）：别名解析与上游真实 ID、目录广告、`/v1/models/<别名>`、未知模型仍 404、`settings.json` 落盘与重启读回（含密钥复用）、别名压过撞名裸 ID、无别名时撞名仍 400、`provider/model` 显式寻址、畸形别名被丢弃、`publicBaseUrl` 生效与非法值忽略、未配置隧道与非法 provider 的降级。
- 新增 `tests/client-render.spec.mjs`（**8/8**）：用最小假 `react` 渲染整个页面组件，覆盖对外/本机地址并列显示、隧道卡片（运行中 / 失败原因 / 停止态）、别名表首帧即由状态文档驱动、curl 示例用对外地址。这一项是为了让「页面能渲染」变成可执行判据，而不是靠截图看。
- 改写 `tests/tunnel-live.spec.mjs`（需 `DSH_GW_TUNNEL=1`，用真实二进制、消耗账号额度，故不进入 `npm test`）：从「拉起了 ngrok」升级为**经公网 URL 取 `/v1/models` 的端到端验收**，并新增「不带密钥返回 401」；`DSH_GW_TUNNEL_PROVIDER=cloudflared` 可换用 cloudflared 快速隧道，避免与正在运行的 ngrok 抢同一个 dev domain。实测 cloudflared 路径 `5/5 checks passed`。
- 回归合计 **39/39**（4 + 13 + 14 + 8）。

### Notes

- ngrok free 账号只有一个 dev domain：同域第二个连接会被 `ERR_NGROK_334` 拒绝。实测中一个残留的 ngrok 进程（占着 4040 与同一 dev domain）正是首次 live 测试失败的原因；插件把它报成 `failed` 并在页面显示原因，而不是静默。
- **`ERR_NGROK_3200` = endpoint offline**：dev domain 属于账号、跨重启地址不变，但**域名在线的前提是有一个 ngrok 进程正在跑**。不配 `autostart` 时隧道停在 `idle`、`baseUrl` 回落到回环地址，此时访问域名得到 3200 —— 不是域名失效，是隧道没开。
- **`autostart` 已实测生效**：改完 profile 的 `cordis.patch.yml` 后插件重载并自行拉起 ngrok（子进程父进程为 `DeepSeek Harness.exe`，命令行 `ngrok http 8787 --log stdout --log-format json`），无需手动重启 DSH。
- Cursor 侧的实测：经隧道 `GET /v1/models` 用 `UA=cursor/0.48.9` 返回 `200 models=150` 且无 ngrok 拦截页；无 UA / 浏览器 UA 会命中 `ERR_NGROK_6024` 拦截页 —— 这属于 ngrok free 的限制，不是网关行为。带 `Authorization` 头时不触发拦截。
- 端到端实测（真实 profile、经隧道、`UA=cursor/0.48.9`）：`gpt-4o` 无别名时 `404 model_not_found`；加别名后 `200`、`model` 回显 `gpt-4o`、`content=TUNNEL_ALIAS_OK`；流式 `200 frames=107 hasDONE=true hasUsage=true assembled="12345"`。别名目标写错时 trace 会明确报 `UNKNOWN_MODEL` / `pi-ai provider "…" has no configured model "…"`，而不是伪装成路由失败。

## 1.1.0 (2026-10-24)

### Added

- **图片与文件输入**（`image_url` / `input_image` / `file` / `input_file`）。之前这两类会被丢弃、只发文本，现在按宿主的附件模型真正接上：
  - `data:` URL 直接解码；`http(s)` 图片由网关抓取（25 MiB 上限，30 秒超时）。
  - 字节**先落进宿主的附件库**（挂载服务的 `saveImages` / `saveFile`，参考对象是 `{ attachmentId, name?, bytes }`），模型收到的是持久化的 `image` / `file` 块 —— 这是 adapter 唯一会发送的形式。只把 URL 转发给上游没有意义：上游读不到调用方的地址。
  - 一个 user 消息里的多张图作为**一条批次**入库，附件库的张数与总字节上限照旧生效；超限的错误原样回 400。
  - 模型不支持图片时，由宿主把它降级成一行说明文字（`[image omitted because this model accepts text only; …]`），网关不自己判死。
  - **文本类文件直接内联**：≤2 MiB、UTF-8 可解码且不含 NUL 字节时，作为 `[attached file: name]` + 正文发进去。实测（`workbuddy/glm-5.3-flash`，文件内容 `the secret number is 4242`）能逐字读出 4242；而只给路径时模型答「我没有文件工具，读不到」—— 外部客户端调用的模型确实没有这些工具，所以内联才是可用的那一半。
  - 其余文件（PDF / 图片 / 压缩包）存进附件库，作为 `file` 块交给模型；宿主把它呈现为一份只读副本的**路径**，模型只能知道文件存在、多大、在哪，读不到内容。这条边界写进了 README 的「已知边界」。
  - 没有附件服务的 profile（例如极简 headless）遇到图片 / 文件回 **400** 并说明原因，而不是悄悄只发文本。
  - `file` 只接受内联 `file_data`：OpenAI Files API 的 `file_id` 存在调用方账号里，本机 harness 拿不到，因此明确报错。
- 回归检查新增：图片解码成 `image` 块（按序保留文本与图片位置）、`mediaType` 正确、文本文件被内联、二进制文件带 display name 入库、无附件服务时回 400。

### Verified

- 真机（`gwtest` profile，走 `ctx.llm` 的 `workbuddy` 适配器）：`workbuddy/glm-5.3-flash` 与 `workbuddy/deepseek-v4.1-flash` 对一张纯红 PNG 都答 `"Red"`；文本文件答出精确内容。`local`（Ollama）在本机未运行，纯文本请求也是 502 TRANSPORT，与本次改动无关。

### Notes

- 附件库会做一次规范化（PNG/JPEG/WebP/GIF → 统一栅格），同一张图两次请求的字节可能不同；这是宿主行为，网关不干预。
- `estimateInputTokens` 只估算文本与工具声明，因此带大图的请求会低估输入体积（`maxInputTokens` 护栏对图片不敏感）。

## 1.0.8 (2026-10-23)

### Fixes

- **工具调用与工具结果配对失败 → 上游给出空回复**。OpenAI 用 `id` 把 assistant 的 `tool_calls` 和 `tool` 结果配对；客户端只要在 assistant 那侧漏了 `id`（或自己另造一个），网关原来会**生成一个随机 id**，于是这个调用在 adapter 眼里没有结果 —— 实测（真实上游 `workbuddy-global/deepseek-v4.1-flash`）：
  - assistant `tool_calls` **带** `id`、`tool` 结果引用同一个 id → `text=10, finish=stop`（正常）；
  - assistant `tool_calls` **缺** `id`、`tool` 结果引用 `call_1` → **`text=0`**，正是「深度思考结束、准备回复时断开」的那个症状。
  - **修法**：`alignToolCallIds()` 先扫一遍消息，把每个 assistant 轮后面紧跟的 `tool` 结果的 `tool_call_id` 按位置收集起来，`translate()` 用**结果侧的 id 覆盖**调用侧缺失/不一致的 id。结果侧的 id 才是后续对话真正引用的那个，按它配对才能让 adapter 看到「有结果的调用」。
- 回归检查扩到 **13/13**：新增「assistant 的 tool call 没有 id 时，被对齐到结果的 id」。

### Notes

- 顺带记录一条与本版无关但同源的事实：profile 里 `workbuddy-global/deepseek-v4.1-flash` 声明的 `contextWindow` 是 **1000000**（来自插件解析的上游目录），而实测该模型可用窗口远小于此。网关的 413 护栏按声明值判断，因此 177k token 的请求不会被拦 —— 要按真实上限拦截，请显式设 `maxInputTokens`（例如 `180000`）。

## 1.0.7 (2026-10-23)

### Added

- **输入体积护栏**：`maxInputTokens`（`0` = 用模型声明的 contextWindow；provider 没声明就不拦）与 `maxMessages`（历史超限时丢弃最早的若干条，**保证保留部分从 `user` 开始** —— 从 `tool` 结果或「工具调用被丢掉」的 assistant 轮开始，adapter 无法重放）。超限时回 `413 CONTEXT_WINDOW_EXCEEDED`，并在消息里写出「估算 N tokens，上限 M」。
  - **为什么需要**：网关是无状态转发，而客户端（实测：WorkBuddy 桌面端）每轮把整段历史重发一遍 —— 记录里 `systemChars=49596`、`tools=23`、`messages` 从 312 涨到 317。网关不压缩，请求一轮比一轮大，直到上游给出「只有推理、`finish=stop`、正文为空」这种无用响应。在边界上明确失败并报出体积，比把一个空回复转发给调用方有用。
- **`recent` 记录上游真实用量与估算**：`usage`（上游的 `prompt_tokens`/`completion_tokens`/`total_tokens`）、`inputTokensEst`（本地估算）、`contextWindow`（模型声明值）、`truncatedMessages`（被丢弃的条数）。估算值靠 `usage.prompt_tokens` 校准，而不是长期靠猜。
- 回归检查扩到 **12/12**：新增「超限请求回 413 且带体积」「未超限不受影响」「`maxMessages` 在 user 边界截断」。

## 1.0.6 (2026-10-23)

### Fixes

- **「推理写完了、正文一个字没有」被当成成功返回**。实测记录（`recent`）：`finish=stop, textBytes=0, reasoningBytes=5610, outcome=ok` —— 上游在推理结束后直接收尾，网关如实转发了一个**空成功**。客户端（WorkBuddy）看到的就是「深度思考结束 → 没有回复 → 像断开」。
  - **按宿主语义改成 `EMPTY_RESPONSE`**：`@deepseek-ai/dsh-llm-pi-ai` 把「`stop` 且无 content block」映射成 `EMPTY_RESPONSE`，而这个 code 本来就在默认可重试集合里。网关现在做同样的事：**还没写出任何字节时**重试；已经写出（例如推理已经流给客户端）时，以流内 `data: {"error":{…,"code":"EMPTY_RESPONSE"}}` + `data: [DONE]` 收尾，让客户端显示「上游没有返回正文」而不是「连接断了」。
  - **不再可能返回空成功**：`finish=stop` 且 `textBytes=0` 且没有 tool call，一律按失败记账（`failures` 也会 +1）。
- **`recent` 里补上请求形状**：`maxTokens` / `effort` / `tools` / `systemChars` / `messages` / `roles`。空回复最常见的成因是客户端给的预算被推理吃掉（`maxTokens` 偏小），而这一点只从响应侧看不出来；把请求形状和结果并排记录，才能一眼判断是「客户端预算」还是「上游行为」。
- 回归检查扩到 **9/9**：新增「无正文的 stop 变成显式 EMPTY_RESPONSE」「无输出的空 stop 会被重试」「请求形状被记录」。

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
