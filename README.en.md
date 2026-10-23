# dsh-openai-gateway

<p align="center"><b>Exposes every model of every provider configured in DeepSeek Harness through one fixed OpenAI-compatible endpoint — port and key frozen locally, stable across restarts.</b></p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#install">Install</a> ·
  <a href="#supported-provider-plugins">Provider plugins</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#port-and-key">Port and key</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/pigman18/dsh-openai-gateway?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/pigman18/dsh-openai-gateway/stargazers"><img src="https://img.shields.io/github/stars/pigman18/dsh-openai-gateway?style=flat-square" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/dsh-plugin-blue?style=flat-square" alt="dsh plugin">
</p>

A standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle plugin. It listens on a **fixed loopback port**, exposes every model of every registered provider as `provider/model` over an OpenAI-compatible surface, and adds a **Model gateway** page to the sidebar where you can read the address and key, change the port, rotate the key, and copy any model id.

**No per-vendor forwarding code.** Requests go through the host's `ctx.llm` service, so each one enters the adapter that provider already uses — its own credentials, request headers, retry and account-pool behaviour, and model gates all stay exactly where they were. That is also why it supports provider plugins for free: any plugin that registers a provider with `ctx.llm` shows up in the gateway, with nothing to adapt.

## Features

- **One endpoint, every model** — `/v1/models` lists every model of every provider as `provider/model` (`workbuddy/deepseek-v4.1-flash`, `opencode2dsh/deepseek-v4.1-flash-free`, `local/qwen3.5:4b`, …). A bare id also works when exactly one provider serves it; when several do, the request is rejected with the candidates listed instead of guessing.
- **Fixed port** — the gateway listens on `127.0.0.1:8787` itself, independent of the UI port (which the OS may pick differently on each start). If that port is already taken it comes up on an OS-assigned one and says so on the page (`random (8787 was taken)`) rather than failing.
- **Fixed key** — `sk-dsh-…` is minted on first start and stored in `$DSH_HOME/openai-gateway/settings.json` (mode 0600), so it survives restarts; **Regenerate** on the page mints a new one (two-step confirm, the old key stops working at once). A legacy `api-key` file is migrated on first load, so an already-configured client keeps working.
- **Sidebar page** — base URL, key (masked / reveal / copy), port (editable, Enter applies), and the whole catalog grouped by provider in collapsible groups: a copy button per model id, per provider, or for everything.
- **Streaming and non-streaming** — `"stream": true` returns standard SSE (`data: …` frames, `[DONE]` last); otherwise a full `chat.completion`.
- **Tool calls** — `tools` are forwarded, calls come back as `tool_calls` with reassembled `arguments` and `finish_reason: "tool_calls"`, and a `tool` message resolves by its `tool_call_id`.
- **Reasoning and usage** — model reasoning is returned separately as `reasoning_content`; `usage` maps to `prompt_tokens` / `completion_tokens` / `total_tokens`, carrying reasoning and cache details when the provider reports them.
- **`reasoning_effort` mapped to what the model really offers** — mapped onto the effort ids that target model advertises; an unsupported level degrades to the nearest advertised one or is dropped, never turned into a rejected request.
- **`stop` fallback** — an adapter that refuses `stop` answers `UNSUPPORTED_OPTION`; the gateway notices and retries once without it instead of failing the request.
- **Browser-friendly** — `/v1/*` answers CORS preflight itself (`OPTIONS` gets 204 without a key), so a web front end can treat it as an ordinary OpenAI endpoint.
- **Loopback only** — binds `127.0.0.1`. The control routes the page uses additionally require a same-origin `POST` with a JSON content type.

## Supported provider plugins

The gateway knows no vendor; it reads whatever providers the host has registered. These combinations were exercised against real providers, which is the `1.0.0` test surface:

| Provider id | Supplied by | Notes |
| --- | --- | --- |
| `workbuddy` / `workbuddy-global` | [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) | WorkBuddy mainland and international, account pool included |
| `workbuddy-xdpool` | `dsh-workbuddy-xdpool` | WorkBuddy account-pool plugin |
| `opencode2dsh` | [`@opencode2dsh/dsh-plugin`](https://www.npmjs.com/package/@opencode2dsh/dsh-plugin) | Free-tier models such as `deepseek-v4.1-flash-free`, `glm-5.3-flash-free` |
| `local` | a `@deepseek-ai/dsh-llm-pi-ai` local route | e.g. pointing at Ollama (`http://127.0.0.1:11434/v1`) |
| `deepseek-official` / `deepseek-account` | built-in DSH DeepSeek providers | Official channel and account channel |

Any other plugin that registers a provider with `ctx.llm` (a self-hosted OpenAI-compatible backend, another vendor connector) works the same way; the table only lists what was actually tested. **Nothing has to be added to the outgoing headers by hand**: each adapter owns what its upstream needs, and the gateway only translates an OpenAI-shaped request into that adapter's call.

## Install

From GitHub:

```sh
dsh plugin --profile <profile> add github:pigman18/dsh-openai-gateway
```

While developing, link the working copy:

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-openai-gateway
```

**Restart DSH** after installing or updating: the host half loads at startup, and the browser half is composed at startup too.

## Usage

1. Click **Model gateway** in the sidebar. The top of the page is the base URL (default `http://127.0.0.1:8787/v1`) and the API key.
2. Point any OpenAI-compatible client at them:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"workbuddy/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

3. Copy model ids from the page, or read them from `/v1/models`.

## Endpoints

`/v1/*` is served by the gateway's own fixed port; the three `/plugins/…` control routes live on the harness web server (same-origin, loopback-gated).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | Every model of every provider (`?refresh=1` bypasses the 60 s cache) |
| `GET` | `/v1/models/<provider>/<model>` | One model |
| `POST` | `/v1/chat/completions` | Chat completions, streaming or not |
| `POST` | `/v1/completions` | Same handler, for clients that insist on the legacy path |
| `OPTIONS` | `/v1/*` | CORS preflight, answered without a key |
| `GET` | `/plugins/dsh-openai-gateway/status` | Status document the page reads; carries the whole catalog (rebuilt once the 60 s cache expires; `?refresh=1` forces a rebuild) |
| `POST` | `/plugins/dsh-openai-gateway/settings` | `{"port": 8787}` — rebind, `409` if that port is taken |
| `POST` | `/plugins/dsh-openai-gateway/key` | `{"action":"regenerate"}` — mint a new key |

Requests are authorised with `Authorization: Bearer <key>`, compared in constant time.

## How it works

```text
OpenAI client ──▶ http://127.0.0.1:8787/v1 ──▶ ctx.llm ──▶ provider adapter ──▶ upstream
                                                 │              (workbuddy / opencode2dsh /
                                                 │               pi-ai local route / …)
                                                 └── /v1/models lists them all
```

- A request body is translated into `ctx.llm.prepareCall(config, signal, configure)`: `system` / `developer` messages fold into the system prompt, `user` / `assistant` / `tool` messages become LLM message blocks, `tools` become function declarations.
- The response stream (`text-delta` / `reasoning-delta` / `tool-call-delta` / `usage` / `finish`) is reassembled into an OpenAI `chat.completion` or SSE frames.
- The host guarantees a prepared call is dispatched at most once; the gateway prepares one per request.

## Port and key

Both live in one plugin-owned file, so nothing needs reconfiguring after a restart:

```
$DSH_HOME/openai-gateway/settings.json      # default ~/.dsh/openai-gateway/settings.json
{ "port": 8787, "apiKey": "sk-dsh-…" }      # mode 0600
```

- **Port** — prefers `8787`. If it is already bound at start, the gateway serves on an OS-assigned port instead of going down, and the page shows the port that was taken. Changing it from the page rebinds immediately; a port that is already in use is reported (`409`) and the gateway keeps serving on the old one.
- **Key** — minted on first start; **Regenerate** makes the old one stop authorising at once. Deleting `settings.json` returns to defaults and mints a new key.
- The key is never written into the profile; the only way to read it back is the loopback status route.

## Configuration

Optional keys on the bundle row:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin inert: the page reports off and `/v1/*` answers `503` |
| `port` | stored / `8787` | Preferred listen port; an explicit value wins over the stored one |
| `apiKey` | stored | Pin a key instead of the stored one |
| `bodyLimitBytes` | `8388608` | Request body cap |
| `catalogTtlMs` | `60000` | `/v1/models` cache lifetime |
| `retryMaxRetries` | `5` | Retries for transient failures (`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`), matching the host's `llm-retry` defaults |
| `retryInitialDelayMs` | `500` | First backoff delay |
| `retryMaxDelayMs` | `10000` | Backoff ceiling; an upstream reset point beyond it is answered, not waited out |
| `silentFlushMs` | `10000` | How long a streaming response may stay quiet before its headers commit and pings begin |
| `keepAliveMs` | `15000` | Interval between `: keep-alive` SSE comments |

## Known limits

- **External clients cannot send images or files**: a caller outside the session has no durable attachment reference, so those parts are dropped and only text is forwarded.
- **Provider-injected notices pass through**: for example an account-pool failover line from upstream arrives as ordinary assistant text, neither swallowed nor rewritten.
- **A profile with no web server (headless)** has no page and no control routes, but `/v1/*` still serves on the fixed port.
- **Prefer `stream: true` for long work**: a non-streaming request writes nothing until the whole answer is ready, so any read timeout will hit it.
- **A streaming failure after `silentFlushMs` arrives in-stream**: once the headers are committed (to keep the connection warm), a pre-content failure can only be reported as `data: {"error": …}` + `data: [DONE]`, without an HTTP status.
- It binds `127.0.0.1` only; do not forward it to a network.

## License

MIT · see [LICENSE](LICENSE)
