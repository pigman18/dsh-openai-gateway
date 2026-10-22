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
- **侧边栏模型网关页** —— 打开即见接口地址、密钥（打码 / 显示 / 复制）、端口（可直接改，回车即应用），以及按 provider 折叠分组的完整模型清单：每个模型 ID 一个复制按钮，每组可整组复制，也可一键复制全部。
- **流式与非流式都支持** —— `"stream": true` 返回标准 SSE（`data: …` 逐帧，`[DONE]` 收尾），非流式返回完整 `chat.completion`。
- **工具调用** —— `tools` 正常转发，结果以 `tool_calls` 返回，`arguments` 的分片会被拼装完整，`finish_reason` 为 `tool_calls`；`tool` 消息按其 `tool_call_id` 回到对应调用。
- **推理内容与用量** —— 模型产出思考时以 `reasoning_content` 单独返回；`usage` 映射为 `prompt_tokens` / `completion_tokens` / `total_tokens`，有 reasoning / cache 细分时一并带上。
- **`reasoning_effort` 按目标模型真实档位映射** —— 映射到该模型自己声明的档位集合；不支持的档位降到最接近的或直接丢弃，**不会**因此拒掉整个请求。
- **对 `stop` 被拒的上游自动降级** —— 某些 adapter 不接受 `stop`，会先返回 `UNSUPPORTED_OPTION`；网关识别该情况后去掉 `stop` 重试一次，而不是把请求判死。
- **浏览器直连** —— `/v1/*` 自带 CORS 预检（`OPTIONS` 无需鉴权即答 204），前端项目可以把它当普通 OpenAI 端点用。
- **只绑回环** —— 仅监听 `127.0.0.1`，不是网络服务。页面用的控制接口还额外要求同源、`POST` 与 JSON Content-Type。

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

## 接口

`/v1/*` 由网关自己的固定端口提供；`/plugins/…` 三条控制接口挂在宿主 web server 上（页面同源、回环校验）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/models` | 所有 provider 的所有模型（`?refresh=1` 跳过 60 秒缓存） |
| `GET` | `/v1/models/<provider>/<model>` | 单个模型 |
| `POST` | `/v1/chat/completions` | 对话补全，流式或非流式 |
| `POST` | `/v1/completions` | 同一处理器，兼容只认旧路径的客户端 |
| `OPTIONS` | `/v1/*` | CORS 预检，无需鉴权 |
| `GET` | `/plugins/dsh-openai-gateway/status` | 页面读取的状态文档，附带完整模型清单 |
| `POST` | `/plugins/dsh-openai-gateway/settings` | `{"port": 8787}` 改端口，端口被占返回 409 |
| `POST` | `/plugins/dsh-openai-gateway/key` | `{"action":"regenerate"}` 换密钥 |

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
{ "port": 8787, "apiKey": "sk-dsh-…" }        # 权限 0600
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

## 已知边界

- **外部客户端不能传图片与文件**：会话之外的调用方拿不到可持久化的附件引用，因此这部分会被丢弃，只转发文本。
- **provider 注入的提示会原样透传**：例如账号池换号时上游返回的一行说明，会作为普通 assistant 文本出现，不会被网关吞掉或改写。
- **没有 web server 的 profile（headless）**：没有页面与控制接口，但 `/v1/*` 仍按固定端口提供服务。
- 只绑定 `127.0.0.1`，不要把它转发到网络上。

## 许可

MIT · 见 [LICENSE](LICENSE)
