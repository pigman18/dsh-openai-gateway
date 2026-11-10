# dsh-openai-gateway

<p align="center"><b>把 DeepSeek Harness 里已配置的全部 provider、全部模型，暴露成一个固定的 OpenAI 兼容接口 —— 端口与密钥都固化在本地，重启不变。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#兼容的-provider-插件">兼容的 provider 插件</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#端口与密钥">端口与密钥</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pigman18/dsh-openai-gateway?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/pigman18/dsh-openai-gateway/stargazers"><img src="https://img.shields.io/github/stars/pigman18/dsh-openai-gateway?style=flat-square" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/dsh-plugin-blue?style=flat-square" alt="dsh plugin">
</p>

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它在本地回环上监听一个**固定端口**，把所有已注册 provider 的模型按 `provider/model` 暴露为 OpenAI 兼容接口；同时往左侧边栏加一个 **模型网关** 页面，用来查看地址与密钥、改端口、换密钥、以及逐个复制模型 ID。

**没有任何按厂商重写的转发逻辑。** 请求走宿主的 `ctx.llm` 服务，因此每个请求进入的正是该 provider 已有的那个 adapter —— 它自己的凭据、请求头、重试与账号池行为、模型门禁都原地保留。这也是它能「顺带」支持所有 provider 插件的原因：只要有插件把 provider 注册进 `ctx.llm`，它就自动出现在网关里，不需要任何适配。

## 功能特性

- **一个入口，全部模型** —— `/v1/models` 列出所有 provider 的所有模型，ID 为 `provider/model`（如 `workbuddy/deepseek-v4.1-flash`、`opencode2dsh/deepseek-v4.1-flash-free`、`local/qwen3.5:4b`）。当某个裸 ID 只被一个 provider 提供时也接受；多个 provider 撞名时明确报错并列出候选，不做猜测。
- **端口固化** —— 网关自己监听 `127.0.0.1:8787`，与界面端口无关（界面端口每次启动都可能变，网关的地址不会）。端口被占用时自动落到系统分配的随机端口继续服务，页面会标明「随机（8787 被占用）」，而不是起不来。
- **密钥固化** —— 首次启动生成 `sk-dsh-…` 并写入 `$DSH_HOME/openai-gateway/settings.json`（0600），跨重启不变；页面上的 **生成** 按钮可换新（两步确认，旧钥立即失效）。旧版本的 `api-key` 文件会被自动迁移，已配置的客户端不受影响。
- **侧边栏模型网关仪表盘** —— 顶部一条吸顶栏显示运行状态与刷新；下面五块指标（请求数 / 失败数、模型数与 provider 数、令牌用量、流量、运行时长），再往下是两列卡片：地址与端口、隧道、密钥、模型别名，然后是**可搜索**的模型目录（按 provider 分组折叠，支持按 ID / 名称 / provider 过滤），以及最近请求表（时间、模型、成功或失败码、令牌进→出、耗时）。所有颜色、边框、圆角、阴影、字号都取自宿主主题 token，亮色与暗色主题都跟随，不写死任何色值。
- **流式与非流式都支持** —— `"stream": true` 返回标准 SSE（`data: …` 逐帧，`[DONE]` 收尾），非流式返回完整 `chat.completion`。
- **工具调用** —— `tools` 正常转发，结果以 `tool_calls` 返回，`arguments` 的分片会被拼装完整，`finish_reason` 为 `tool_calls`；`tool` 消息按其 `tool_call_id` 回到对应调用。assistant 侧漏了 `id` 时会按结果的 id 对齐，而不是另造一个（上游对「没有结果的调用」只会回空回复）。
- **图片与文件** —— `image_url` / `input_image` 与 `file` / `input_file` 都支持。图片：`data:` URL 直接解码，`http(s)` 图片由网关抓取（上限 25 MiB），然后**存进宿主的附件库**（`ctx.attachments`），模型拿到的是持久化的图片块而不是只有调用方够得着的 URL；一条 user 消息里的多张图按一条批次入库，附件的张数与字节上限照旧生效，模型不支持图片时由宿主降级成一行说明文字。文件：**能当文本读的直接内联成文本**（`[attached file: name]` + 内容，2 MiB 以内、UTF-8 且无 NUL 字节），其余（PDF、图片、压缩包等）存进附件库并作为 `file` 块交给模型。没有附件服务的 profile 会明确回 400，而不是悄悄只发文本。
- **推理内容与用量** —— 模型产出思考时以 `reasoning_content` 单独返回；`usage` 映射为 `prompt_tokens` / `completion_tokens` / `total_tokens`，有 reasoning / cache 细分时一并带上。
- **`reasoning_effort` 按目标模型真实档位映射** —— 映射到该模型自己声明的档位集合；不支持的档位降到最接近的或直接丢弃，**不会**因此拒掉整个请求。
- **对 `stop` 被拒的上游自动降级** —— 某些 adapter 不接受 `stop`，会先返回 `UNSUPPORTED_OPTION`；网关识别该情况后去掉 `stop` 重试一次，而不是把请求判死。
- **浏览器直连** —— `/v1/*` 自带 CORS 预检（`OPTIONS` 无需鉴权即答 204），前端项目可以把它当普通 OpenAI 端点用。
- **模型别名** —— Cursor 这类客户端只会发它自己写死的模型名（`gpt-4o`、`claude-sonnet-5.5`…）。给它们配一条别名，映射到任意 `provider/model` 即可路由；撞名的裸 ID 也靠别名消歧。别名会同时出现在 `/v1/models` 里，客户端下拉框能直接看到。
- **对外地址 / 隧道** —— 页面同时显示**对外地址**与**本机地址**。可以自己在外面开隧道再把 hostname 填进 `publicBaseUrl`，也可以让插件自己拉起 `ngrok` / `cloudflared` 进程、自动读出公网 URL，退出 DSH 时一并关闭。
- **只绑回环** —— 仅监听 `127.0.0.1`，不是网络服务。页面用的控制接口还额外要求同源、`POST` 与 JSON Content-Type；隧道连的也是这个回环地址，所以**不需要**改成 `0.0.0.0`。

## 兼容的 provider 插件

网关不认识任何厂商，只读宿主已注册的 provider。以下是真实环境里跑通过的组合，也就是 `1.0.0` 的实测范围：

| provider ID | 由谁提供 | 说明 |
| --- | --- | --- |
| `workbuddy` / `workbuddy-global` | [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) | 国内版与国际版 WorkBuddy，含账号池换号 |
| `workbuddy-xdpool` | `dsh-workbuddy-xdpool` | WorkBuddy 账号池插件 |
| `opencode2dsh` | [`@opencode2dsh/dsh-plugin`](https://www.npmjs.com/package/@opencode2dsh/dsh-plugin) | 免费额度模型（如 `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`） |
| `local` | `@deepseek-ai/dsh-llm-pi-ai` 的本地路由 | 例如指向 Ollama（`http://127.0.0.1:11434/v1`） |
| `deepseek-official` / `deepseek-account` | DSH 内置 DeepSeek provider | 官方通道与账号通道 |

任何其它把 provider 注册进 `ctx.llm` 的插件（自建 OpenAI 兼容后端、其它厂商连接器）同样自动可用；上表只列出实测过的。**转发时不需要你手动补任何 header**：上游需要的请求头由各自 adapter 负责，网关只把 OpenAI 形状的请求翻译成 adapter 的调用。

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:pigman18/dsh-openai-gateway
```

开发时直接链本地目录：

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-openai-gateway
```

安装或更新后**重启 DSH**：宿主侧插件在启动时装载，浏览器前半段也只在启动时装配。

## 使用

1. 侧边栏点 **模型网关**，页面顶部就是接口地址（默认 `http://127.0.0.1:8787/v1`）与 API Key。
2. 把它当普通 OpenAI 端点填进任意客户端：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"workbuddy/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

3. 模型名直接从页面复制，或在 `/v1/models` 里查。

4. 图片照 OpenAI 的写法内联即可（`data:` URL 或 `http(s)` 图片地址都行）：

```json
{
  "model": "workbuddy/glm-5.3-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "这张图里是什么？" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo…" } }
      ]
    }
  ]
}
```

文件同理，用 `{"type":"file","file":{"filename":"notes.txt","file_data":"data:text/plain;base64,…"}}`。

### 页面上的两块计数

指标区的**令牌**与**流量**来自宿主侧的累计，只统计当前这一次运行（网关重启即归零），所以数值旁边标注了起始时刻（`自 HH:MM 起`）。

- **令牌**：把每个请求上游回报的 `usage` 累加起来，下方小字是「入 / 出」。只统计**上游真的报了用量**的请求；一个 provider 若不报 usage，令牌数不会因此被摊薄，`calls` 计数也不会虚增。
- **流量**：进出 `/v1` 表面的实际字节数（请求体 + 响应体与 SSE 帧，不含响应头）。控制接口的往返不计入，否则刷新页面就会把流量撑大。

两块的数值都在 `GET /plugins/dsh-openai-gateway/status` 里以 `usageTotals` 与 `bytes` 两个字段给出；**最近请求表**逐行显示同样的用量，可与指标区交叉核对。

## 给 Cursor 这类「只接受外链」的客户端

Cursor 的自定义 Base URL 不接受 `localhost` / `127.0.0.1`，必须是一个公网 HTTPS 地址。网关保持只绑回环，由隧道把回环地址映射出去，两条路都行：

**A. 插件自己拉起隧道（页面上一键）**

在 bundle 配置里指定方式，或直接在页面的「隧道」卡片点 **启动**：

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      tunnel:
        provider: ngrok       # 或 cloudflared
        autostart: true       # 随网关启动
```

- 插件 `spawn` 出 `ngrok http <端口>` / `cloudflared tunnel --url http://127.0.0.1:<端口>`，从它自己的输出里读出公网 URL，写进状态文档与页面。
- 退出 DSH（或插件被卸载）时子进程一并结束，不会留下一个占着 dev domain 的孤儿进程。
- ngrok 需要事先 `ngrok config add-authtoken <token>`；`cloudflared` 的快速隧道（`--url`）不需要登录，但每次启动的域名会变 —— 要稳定域名请用 ngrok 的 free dev domain。
- **`autostart: true` 是让域名一直可用的前提**：ngrok 的 dev domain 属于你的账号、跨重启不变，但**域名在线的前提是有一个 ngrok 进程正在跑**。不配 `autostart` 时隧道停在 `idle`，`baseUrl` 回落到回环地址，此时访问那个域名会得到 `ERR_NGROK_3200`（endpoint offline）——这不是域名失效，是隧道没开。

**B. 自己在外面开隧道，把地址填进来**

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      publicBaseUrl: https://your-name.ngrok-free.dev/v1
```

`publicBaseUrl` 优先于隧道自动读到的地址，也优先于回环地址 —— 页面「对外地址」与 curl 示例都会跟着变。

> **配置写在哪个文件**：插件已经装进某个 profile 时，`- insert:` 是给还没插入这条的 bundle 用的；已经在 profile 的 `cordis.patch.yml` 里列出的（形如 `- id: dsh-openai-gateway` / `disabled: false`），直接在那条下面加 `config:` 即可，不要再 `insert` 一次。下面这种写法同样生效：
>
> ```yaml
> - id: dsh-openai-gateway
>   disabled: false
>   config:
>     tunnel:
>       provider: ngrok
>       autostart: true
>     aliases:
>       gpt-4o: workbuddy-global/deepseek-v4.1-flash-sg
> ```
>
> 改完 `cordis.patch.yml` 后插件会重载并按新配置重新拉起隧道，无需手动重启 DSH。

> **只公开 `/v1`。** `/plugins/dsh-openai-gateway/*` 是改端口、换密钥的控制接口，隧道必须只指向 `/v1`，不要把宿主端口整个暴露出去。

## 模型别名

外部客户端发什么名字，由它自己决定；别名把那些名字接到真实的 `provider/model` 上：

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      aliases:
        gpt-4o: workbuddy/deepseek-v4.1-flash
        claude-sonnet-5.5: trae-global/qwen3.8-max
        deepseek-v4.1-flash: opencode2dsh/deepseek-v4.1-flash-free   # 撞名裸 ID 也能这样消歧
```

也可以在页面的「模型别名」卡片里增删并保存（写回 `settings.json`，重启仍在）。规则：

- 目标必须是 `provider/model`；没有 provider 前缀的目标会被丢弃，不会留下一个必然 404 的别名。
- 别名先于目录解析，所以它**能压过撞名的裸 ID** —— `deepseek-v4.1-flash` 同时被三个 provider 提供时，一条别名就把它指到一个确定的去处。
- 别名会出现在 `/v1/models` 里（带 `alias_of` 字段），客户端的模型下拉框能直接看到。
- 响应里的 `model` 字段回显**调用方发来的名字**，而不是上游真实 ID。

## 接口

`/v1/*` 由网关自己的固定端口提供；`/plugins/…` 控制接口挂在宿主 web server 上（页面同源、回环校验）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/models` | 所有 provider 的所有模型 + 全部别名（`?refresh=1` 跳过 60 秒缓存） |
| `GET` | `/v1/models/<provider>/<model>` | 单个模型；`/v1/models/<别名>` 也返回该别名的 `alias_of` |
| `POST` | `/v1/chat/completions` | 对话补全，流式或非流式；`model` 可以是 `provider/model`、别名、或不撞名的裸 ID |
| `POST` | `/v1/completions` | 同一处理器，兼容只认旧路径的客户端 |
| `OPTIONS` | `/v1/*` | CORS 预检，无需鉴权 |
| `GET` | `/plugins/dsh-openai-gateway/status` | 页面读取的状态文档，附带完整模型清单（超过 60 秒缓存会先重建；`?refresh=1` 强制重建）、`aliases`、`tunnel`、`baseUrl` / `localBaseUrl`、`usageTotals` 与 `bytes` 两块累计，与 `recent`：最近 20 次请求的耗时、首字节、尝试次数、用量与结束原因 |
| `POST` | `/plugins/dsh-openai-gateway/settings` | `{"port": 8787}` 改端口，端口被占返回 409 |
| `POST` | `/plugins/dsh-openai-gateway/key` | `{"action":"regenerate"}` 换密钥 |
| `POST` | `/plugins/dsh-openai-gateway/aliases` | `{"aliases":{"gpt-4o":"provider/model"}}` 整体替换别名表，`{}` 清空 |
| `POST` | `/plugins/dsh-openai-gateway/tunnel` | `{"action":"start"}` / `{"action":"stop"}` 启停插件拉起的隧道进程 |

鉴权为 `Authorization: Bearer <key>`，比较使用常量时间比较。

## 工作原理

```text
OpenAI 客户端 ──▶ http://127.0.0.1:8787/v1 ──▶ ctx.llm ──▶ provider adapter ──▶ 上游
                                                  │             （workbuddy / opencode2dsh /
                                                  │              pi-ai 本地路由 / …）
                                                  └── /v1/models 把它们全列出来
```

- 请求体被翻译成 `ctx.llm.prepareCall(config, signal, configure)` 的调用：`system` / `developer` 消息折进 system 提示，`user` / `assistant` / `tool` 转成 LLM 消息块，`tools` 转成函数声明。
- 响应流（`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish`）再拼回 OpenAI 的 `chat.completion` 或 SSE 帧。
- 一个准备好的调用只允许派发一次，这点由宿主保证；网关对每个请求单独准备。

## 端口与密钥

两者都持久化在一个插件自有文件里，重启后无需任何配置：

```
$DSH_HOME/openai-gateway/settings.json        # 默认 ~/.dsh/openai-gateway/settings.json
{ "port": 8787, "apiKey": "sk-dsh-…", "aliases": { "gpt-4o": "provider/model" } }
```

- **端口**：优先 `8787`；启动时若已被占用，落到系统分配的随机端口继续服务（页面显示被占用的原端口）。页面改端口立即生效；改到被占用端口返回 409 且**继续在原端口服务**，不会把自己搞挂。
- **密钥**：首次启动生成；**生成** 之后旧钥立刻失效。删掉 `settings.json` 即回到默认（会重新生成密钥）。
- 密钥不写进 profile，只能通过回环状态接口读回。

## 配置

bundle 行上可选：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时插件空转：页面显示未启用，`/v1/*` 返回 `503` |
| `port` | 已存值 / `8787` | 首选监听端口，显式值优先于已存值 |
| `apiKey` | 已存值 | 固定密钥，优先于已存值 |
| `bodyLimitBytes` | `8388608` | 请求体上限 |
| `catalogTtlMs` | `60000` | `/v1/models` 缓存时长 |
| `retryMaxRetries` | `5` | 瞬时失败（`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`）的重试次数，与宿主 `llm-retry` 默认一致 |
| `retryInitialDelayMs` | `500` | 退避起始间隔 |
| `retryMaxDelayMs` | `10000` | 退避上限；上游给出的重置点超过它就按「请稍后再来」直接失败 |
| `silentFlushMs` | `10000` | 流式响应静默多久后提交响应头并开始保活 |
| `keepAliveMs` | `15000` | 保活 `: keep-alive` 注释的间隔 |
| `maxInputTokens` | `0`（关） | 估算输入超过它就回 `413 CONTEXT_WINDOW_EXCEEDED`；`0` 时改用模型声明的 contextWindow（provider 没声明就不拦） |
| `maxMessages` | `0`（关） | 历史超过这么多条就丢弃最早的若干条，且保证保留部分从 `user` 开始 |
| `publicBaseUrl` | 未设 | 对外地址（如 `https://name.ngrok-free.dev/v1`）。设置后页面的「对外地址」与 curl 示例改用它；不合法时忽略 |
| `tunnel` | 未设 | `{ provider: "ngrok" \| "cloudflared", autostart: true }`，让插件自己拉起隧道进程 |
| `aliases` | 未设 | `{ "客户端发来的名字": "provider/model" }`，优先于已存的别名表 |

## 已知边界

- **图片按宿主的策略处理**：入库时会做一次规范化（宿主把 PNG/JPEG/WebP/GIF 转成统一栅格），所以同一张图两次请求的字节可能不同；媒体类型、张数与总字节上限由附件库决定，超限回 400 并带出原因。
- **`file` 只接受内联的 `file_data`**：OpenAI 的 Files API（`file_id`）把文件存在调用方账号里，本机 harness 拿不到，因此这种情况会明确报错而不是假装成功。
- **二进制文件只能给到路径**：宿主交给模型的「文件」是一份只读副本的路径（这是它的设计：模型用自己的文件工具去读）。外部客户端调用的模型没有那些工具，所以二进制文件（PDF / docx / 压缩包）只能让模型知道「有这么个文件、多大、在哪」，读不到内容 —— 文本类文件才走内联。
- **provider 注入的提示会原样透传**：例如账号池换号时上游返回的一行说明，会作为普通 assistant 文本出现，不会被网关吞掉或改写。
- **没有 web server 的 profile（headless）**：没有页面与控制接口，但 `/v1/*` 仍按固定端口提供服务。
- **长任务建议用 `stream: true`**：非流式请求在整段生成期间不会写出任何字节，任何读超时都会命中。
- **超过 `silentFlushMs` 才失败的流式请求，错误以流内事件到达**：响应头一旦提交（为了保活），首字之前的失败只能写成 `data: {"error": …}` + `data: [DONE]`，不再有 HTTP 状态码。
- **隧道是插件的子进程**：一个 ngrok free 账号只有一个 dev domain，同域第二个连接会被 `ERR_NGROK_334` 拒绝。手动开的 ngrok 要先关掉，插件才能接管；否则页面上的隧道状态会显示失败原因。
- **`ERR_NGROK_3200` 表示域名离线**：dev domain 属于账号、地址稳定，但没有 ngrok 进程在跑时它就是离线的。要么开 `autostart`，要么在页面「隧道」卡片点启动。
- **ngrok free 计划对浏览器 UA 插拦截页**：`ERR_NGROK_6024` 只影响用浏览器直接打开调试；Cursor 的 UA（实测 `cursor/0.48.9`）以及 `python-requests`、`OpenAI-Python`、`curl` 都直接放行。带 `Authorization` 头时也不会被拦。
- 只绑定 `127.0.0.1`，不要把它转发到网络上；对外只经隧道公开 `/v1`。

## 许可

MIT · 见 [LICENSE](LICENSE)
