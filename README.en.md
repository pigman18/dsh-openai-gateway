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
- **Sidebar dashboard** — a sticky header carries the running state and a refresh control; below it five metric tiles (requests / failures, models and providers, token usage, traffic, uptime), then a two-column card grid (address and port, tunnel, key, model aliases), a **searchable** catalog grouped by provider (filter by id, name, or provider), and a recent-request table (time, model, ok or failure code, tokens in → out, duration). Every colour, border, radius, shadow and type size comes from a host theme token, so light and dark both follow with no hard-coded values.
- **Streaming and non-streaming** — `"stream": true` returns standard SSE (`data: …` frames, `[DONE]` last); otherwise a full `chat.completion`.
- **Tool calls** — `tools` are forwarded, calls come back as `tool_calls` with reassembled `arguments` and `finish_reason: "tool_calls"`, and a `tool` message resolves by its `tool_call_id`. When the assistant turn omits the id, the result's id wins instead of a freshly invented one — an upstream answers a call with no result with an empty reply.
- **Images and files** — `image_url` / `input_image` and `file` / `input_file` are supported. Images: `data:` URLs are decoded, `http(s)` images are fetched by the gateway (25 MiB cap), and both are **committed to the host attachment store** (`ctx.attachments`) so the model receives durable image blocks rather than a URL only the caller can reach; images in one user message are admitted as a single batch, so the store's count and byte limits still apply, and a text-only model gets the host's placeholder line. Files: **anything readable as text is inlined** (`[attached file: name]` plus the content, up to 2 MiB, valid UTF-8 without NUL bytes); everything else (PDF, images, archives) is stored and handed over as a `file` block. A profile without an attachment store answers 400 instead of quietly sending text only.
- **Reasoning and usage** — model reasoning is returned separately as `reasoning_content`; `usage` maps to `prompt_tokens` / `completion_tokens` / `total_tokens`, carrying reasoning and cache details when the provider reports them.
- **`reasoning_effort` mapped to what the model really offers** — mapped onto the effort ids that target model advertises; an unsupported level degrades to the nearest advertised one or is dropped, never turned into a rejected request.
- **`stop` fallback** — an adapter that refuses `stop` answers `UNSUPPORTED_OPTION`; the gateway notices and retries once without it instead of failing the request.
- **Browser-friendly** — `/v1/*` answers CORS preflight itself (`OPTIONS` gets 204 without a key), so a web front end can treat it as an ordinary OpenAI endpoint.
- **Loopback only** — binds `127.0.0.1`. The control routes the page uses additionally require a same-origin `POST` with a JSON content type. A tunnel connects to that loopback address, so you never have to bind `0.0.0.0`.
- **Model aliases** — clients such as Cursor only send the model names they hard-code (`gpt-4o`, `claude-sonnet-5.5`, …). An alias maps such a name onto any `provider/model`; it also disambiguates a bare id that several providers share. Aliases are advertised in `/v1/models`, so a client's model picker sees them.
- **Public address / tunnel** — the page shows a **public URL** and a **local URL**. Either run a tunnel yourself and set `publicBaseUrl`, or let the plugin spawn `ngrok` / `cloudflared`, read the published URL from its output, and close the child when DSH exits.

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

4. Inline images the OpenAI way — a `data:` URL or an `http(s)` image address both work:

```json
{
  "model": "workbuddy/glm-5.3-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo…" } }
      ]
    }
  ]
}
```

Files work the same way: `{"type":"file","file":{"filename":"notes.txt","file_data":"data:text/plain;base64,…"}}`.

### The two live counters

The **Tokens** and **Traffic** tiles come from totals the host accumulates. They describe this run only — a gateway restart zeroes them — which is why each tile is captioned with its start time (`since HH:MM`).

- **Tokens** sums the `usage` each request's upstream reported; the caption under the value is "in / out". Only requests whose upstream actually reported usage are counted, so a provider that reports none cannot dilute the figure, and `calls` is not inflated either.
- **Traffic** is the real byte count over the `/v1` surface (request bodies plus response bodies and SSE frames; headers excluded). Control-route round trips are not counted, or a page refresh would inflate the tile.

Both appear in `GET /plugins/dsh-openai-gateway/status` as `usageTotals` and `bytes`. The **recent requests** table shows the same usage per row, so the tile and the table can be cross-checked.

## For clients that refuse a local URL (Cursor)

Cursor's custom base URL rejects `localhost` / `127.0.0.1`; it needs a public HTTPS address. The gateway stays on loopback and a tunnel maps it out. Two ways:

**A. Let the plugin run the tunnel (one button on the page)**

Name the provider in the bundle config, or press **Start** on the page's **Tunnel** card:

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      tunnel:
        provider: ngrok       # or cloudflared
        autostart: true       # start with the gateway
```

- The plugin spawns `ngrok http <port>` / `cloudflared tunnel --url http://127.0.0.1:<port>`, reads the public URL out of its own output, and reports it in the status document and on the page.
- When DSH exits (or the plugin is unloaded) the child is killed, so no orphan is left holding the dev domain.
- `ngrok` needs `ngrok config add-authtoken <token>` beforehand. A `cloudflared` quick tunnel (`--url`) needs no login, but its hostname changes on every start — use ngrok's free dev domain if you need a stable one.
- **`autostart: true` is what keeps the hostname reachable.** ngrok's dev domain belongs to your account and survives restarts, but it is only online while an ngrok process is running. Without `autostart` the tunnel sits at `idle`, `baseUrl` falls back to loopback, and visiting the domain returns `ERR_NGROK_3200` (endpoint offline) — that is not a dead domain, it is a tunnel that was never started.

**B. Run a tunnel yourself and set the address**

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      publicBaseUrl: https://your-name.ngrok-free.dev/v1
```

`publicBaseUrl` wins over the URL a tunnel publishes and over the loopback address: the page's public row and the curl example follow it.

> **Which file the config goes in**: `- insert:` is for a bundle that has not listed the plugin yet. If your profile's `cordis.patch.yml` already has an entry shaped like `- id: dsh-openai-gateway` / `disabled: false`, add `config:` under that entry instead of inserting a second copy. This form works too:
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
> Editing `cordis.patch.yml` reloads the plugin, which restarts the tunnel from the new config; no manual DSH restart is needed.

> **Publish `/v1` only.** `/plugins/dsh-openai-gateway/*` mutates the port and the key — the tunnel must point at `/v1`, never at the whole harness port.

## Model aliases

An external client sends whatever name it was configured with; an alias attaches that name to a real `provider/model`:

```yaml
- insert:
    - id: dsh-openai-gateway
      name: dsh-openai-gateway
      aliases:
        gpt-4o: workbuddy/deepseek-v4.1-flash
        claude-sonnet-5.5: trae-global/qwen3.8-max
        deepseek-v4.1-flash: opencode2dsh/deepseek-v4.1-flash-free   # also disambiguates a colliding bare id
```

You can also add and remove them on the page's **Model aliases** card (written back to `settings.json`, so they survive a restart). Rules:

- The target must be `provider/model`; a target without a provider prefix is dropped rather than left as an alias that always 404s.
- An alias resolves before the catalog, so it **beats a colliding bare id** — when three providers share `deepseek-v4.1-flash`, one alias points it at a single destination.
- Aliases appear in `/v1/models` (with an `alias_of` field), so a client's model picker can see them.
- The `model` field in a response echoes **the name the caller sent**, not the upstream id.

## Endpoints

`/v1/*` is served by the gateway's own fixed port; the `/plugins/…` control routes live on the harness web server (same-origin, loopback-gated).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | Every model of every provider, plus every alias (`?refresh=1` bypasses the 60 s cache) |
| `GET` | `/v1/models/<provider>/<model>` | One model; `/v1/models/<alias>` returns that alias's `alias_of` too |
| `POST` | `/v1/chat/completions` | Chat completions, streaming or not; `model` may be `provider/model`, an alias, or an unambiguous bare id |
| `POST` | `/v1/completions` | Same handler, for clients that insist on the legacy path |
| `OPTIONS` | `/v1/*` | CORS preflight, answered without a key |
| `GET` | `/plugins/dsh-openai-gateway/status` | Status document the page reads; carries the whole catalog (rebuilt once the 60 s cache expires; `?refresh=1` forces a rebuild), `aliases`, `tunnel`, `baseUrl` / `localBaseUrl`, the `usageTotals` and `bytes` counters, plus `recent`: the last 20 requests with duration, first-byte time, attempts, usage and outcome |
| `POST` | `/plugins/dsh-openai-gateway/settings` | `{"port": 8787}` — rebind, `409` if that port is taken |
| `POST` | `/plugins/dsh-openai-gateway/key` | `{"action":"regenerate"}` — mint a new key |
| `POST` | `/plugins/dsh-openai-gateway/aliases` | `{"aliases":{"gpt-4o":"provider/model"}}` — replace the whole table; `{}` clears it |
| `POST` | `/plugins/dsh-openai-gateway/tunnel` | `{"action":"start"}` / `{"action":"stop"}` — run or stop the tunnel the plugin supervises |

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
{ "port": 8787, "apiKey": "sk-dsh-…", "aliases": { "gpt-4o": "provider/model" } }
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
| `maxInputTokens` | `0` (off) | Refuse with `413 CONTEXT_WINDOW_EXCEEDED` when the estimated input exceeds it; `0` falls back to the model's declared context window (no cap when the provider declares none) |
| `maxMessages` | `0` (off) | Drop the oldest turns beyond this many, always keeping the history starting at a `user` message |
| `publicBaseUrl` | unset | The address external clients should use (e.g. `https://name.ngrok-free.dev/v1`). The page's public row and the curl example follow it; an unusable value is ignored |
| `tunnel` | unset | `{ provider: "ngrok" \| "cloudflared", autostart: true }` — let the plugin supervise a tunnel process |
| `aliases` | unset | `{ "name the client sends": "provider/model" }`; wins over the stored alias table |

## Known limits

- **Images follow the host's policy**: admission normalizes them (PNG/JPEG/WebP/GIF become one raster form), so the same picture may differ byte-for-byte between requests; the media types, count and aggregate byte limits are the attachment store's, and exceeding them answers 400 with the reason.
- **`file` takes inline `file_data` only**: OpenAI's Files API keeps uploads in the caller's account, which this harness cannot reach, so a `file_id` is refused with a clear message instead of pretending.
- **A binary file only yields a path**: the host hands a model a read-only copy's path (by design — the model is expected to open it with its own file tools). A model driven by an outside client has no such tools, so for PDFs, docx or archives it learns only that the file exists, how big it is and where — not its contents. Text files are inlined instead.
- **Provider-injected notices pass through**: for example an account-pool failover line from upstream arrives as ordinary assistant text, neither swallowed nor rewritten.
- **A profile with no web server (headless)** has no page and no control routes, but `/v1/*` still serves on the fixed port.
- **Prefer `stream: true` for long work**: a non-streaming request writes nothing until the whole answer is ready, so any read timeout will hit it.
- **A streaming failure after `silentFlushMs` arrives in-stream**: once the headers are committed (to keep the connection warm), a pre-content failure can only be reported as `data: {"error": …}` + `data: [DONE]`, without an HTTP status.
- **The tunnel is a child process of the plugin**: one ngrok free account has a single dev domain, and a second connection to it is refused with `ERR_NGROK_334`. A manually started ngrok has to be stopped before the plugin can take over, or the page's tunnel status shows that failure.
- **`ERR_NGROK_3200` means the endpoint is offline**: the dev domain belongs to your account and its address is stable, but it is offline whenever no ngrok process is running. Set `autostart`, or press Start on the page's tunnel card.
- **ngrok's free plan interposes a browser warning**: `ERR_NGROK_6024` only affects opening the URL in a browser to debug. Cursor's user agent (measured `cursor/0.48.9`) plus `python-requests`, `OpenAI-Python` and `curl` all pass through, and any request carrying an `Authorization` header is not interposed.
- It binds `127.0.0.1` only; do not forward it to a network, and publish only `/v1` through the tunnel.

## License

MIT · see [LICENSE](LICENSE)
