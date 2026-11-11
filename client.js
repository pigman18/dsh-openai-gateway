/**
 * dsh-openai-gateway — Browser half.
 *
 * One row in the sidebar's global panel list, beside the host's own pages,
 * opening a gateway dashboard: the endpoint and key, a tunnel switch, the model
 * aliases, a searchable catalogue, and what the gateway has actually served.
 * The page reads the loopback status route the host half publishes; it never
 * talks to a model provider itself.
 *
 * Styling rule for this file: every colour, border, and shadow is a `--dsw-*`
 * theme token with no literal fallback. A token that a future host renames
 * degrades the look but never breaks rendering; a literal colour would freeze
 * the page in one theme. `tests/client-render.spec.mjs` enforces this.
 */
window.__ModuleLoader__.load({
	id: "dsh-openai-gateway",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let { createElement: h, useCallback, useEffect, useState } = react;

		//#region constants
		const NS = "dsh-openai-gateway";
		/** Panel key and `sidebar.panellist` id: one name addresses both. */
		const PANEL_ID = "dsh-openai-gateway";
		const STATUS_PATH = "/plugins/dsh-openai-gateway/status";
		const SETTINGS_PATH = "/plugins/dsh-openai-gateway/settings";
		const KEY_PATH = "/plugins/dsh-openai-gateway/key";
		const ALIAS_PATH = "/plugins/dsh-openai-gateway/aliases";
		const TUNNEL_PATH = "/plugins/dsh-openai-gateway/tunnel";
		const AUTHTOKEN_PATH = "/plugins/dsh-openai-gateway/authtoken";
		const STYLE_ATTR = "data-dsh-openai-gateway";
		//#endregion

		//#region dictionaries
		const zh = {
			"nav": "模型网关",
			"page.title": "模型网关",
			"page.subtitle": "把已配置 provider 的全部模型暴露为一个 OpenAI 兼容接口",
			"page.on": "运行中",
			"page.off": "已关闭",
			"page.offHint": "网关在插件配置中被关闭，下面的地址与密钥暂不可用。",
			"page.apiKey": "API Key",
			"page.keyFile": "密钥保存在",
			"page.port": "端口",
			"page.portApply": "应用",
			"page.portPinned": "固定",
			"page.portRandom": "随机（{port} 被占用）",
			"page.portHint": "网关独占这个端口，与界面端口无关；改完立即生效，已配置的客户端要同步改地址。",
			"page.portInvalid": "端口需为 1024–65535 之间的整数",
			"page.portBusy": "该端口已被占用，换一个或留空让它随机",
			"page.portFailed": "切换端口失败",
			"page.portDone": "已切到 {port}",
			"page.regenerate": "生成",
			"page.regenerateConfirm": "确认更换？",
			"page.keyRotated": "已生成新密钥，旧密钥立即失效，请更新客户端",
			"page.models": "模型目录",
			"page.modelCount": "{count} 个模型 · {providers} 个 provider",
			"page.copy": "复制",
			"page.copied": "已复制",
			"page.reveal": "显示",
			"page.hide": "隐藏",
			"page.copyAll": "复制全部 ID",
			"page.allCopied": "已复制全部 {count} 个",
			"page.refresh": "刷新",
			"page.loading": "读取中…",
			"page.unavailable": "状态接口不可用，插件可能未启用",
			"page.retry": "重试",
			"page.noModels": "该 provider 暂未报告模型",
			"page.usage": "客户端这样填",
			"page.usageHint": "Base URL 填上面的接口地址，模型名用 provider/model，例如 {example}。鉴权与上游请求头由各 provider 适配器自行处理。",
			"page.copyCurl": "复制示例",
			"page.public": "对外地址",
			"page.local": "本机地址",
			"page.publicHint": "Cursor 这类只接受外链的客户端填这一行；本机客户端填下面那行。",
			"page.tunnel": "隧道",
			"page.tunnelIdle": "未启动",
			"page.tunnelStarting": "启动中…",
			"page.tunnelRunning": "已连接",
			"page.tunnelFailed": "失败",
			"page.tunnelStopped": "已停止",
			"page.tunnelUnconfigured": "未配置",
			"page.tunnelStart": "启动",
			"page.tunnelStop": "停止",
			"page.tunnelHint": "由插件自己拉起隧道进程，退出 DSH 时一并关闭。也可以在外面手动开隧道，再把地址填进配置。",
			"page.tunnelProvider": "方式",
			"page.setup": "ngrok 账号",
			"page.setupReady": "已配置",
			"page.setupMissing": "未配置",
			"page.setupHint": "ngrok 需要先有一个账号，隧道才能拿到固定域名。注册与取 token 在浏览器里完成，插件不能代你注册。",
			"page.setupStep1": "1. 打开注册页，用邮箱或 Google / GitHub 登录",
			"page.setupStep2": "2. 复制页面上的 authtoken",
			"page.setupStep3": "3. 粘到下面，保存后立即生效",
			"page.setupOpenSignup": "打开注册页",
			"page.setupOpenToken": "打开 token 页",
			"page.setupPlaceholder": "粘贴 ngrok authtoken",
			"page.setupSave": "保存 token",
			"page.setupSaving": "保存中…",
			"page.setupSaved": "token 已写入 ngrok 配置",
			"page.setupBad": "保存失败，请检查 token 是否正确",
			"page.setupInvalid": "这不像一个 ngrok authtoken（至少 20 个字符、不含空格）",
			"page.setupFile": "写入位置",
			"page.alias": "模型别名",
			"page.aliasHint": "给外部客户端用的短名字，映射到 provider/model。Cursor 发 gpt-4o 这类名字时靠它路由；撞名的模型必须走别名。",
			"page.aliasName": "别名",
			"page.aliasTarget": "目标 provider/model",
			"page.aliasAdd": "添加",
			"page.aliasSave": "保存",
			"page.aliasSaved": "别名已保存",
			"page.aliasBad": "别名或目标格式不对（目标需为 provider/model）",
			"page.aliasEmpty": "还没有别名",
			"page.aliasRemove": "删除",
			"page.aria": "模型网关",
			"panel.empty": "暂无模型",
			"stat.requests": "请求",
			"stat.failed": "失败 {count}",
			"stat.models": "模型",
			"stat.providers": "{count} 个 provider",
			"stat.tokens": "令牌",
			"stat.tokenHint": "入 {input} · 出 {output}",
			"stat.traffic": "流量",
			"stat.trafficHint": "收 {input} · 发 {output}",
			"stat.uptime": "运行时长",
			"stat.since": "自 {time} 起",
			"stat.noData": "本版未统计",
			"search.label": "搜索模型",
			"search.placeholder": "按 ID、名称或 provider 过滤",
			"search.empty": "没有匹配的模型",
			"recent.title": "最近请求",
			"recent.time": "时间",
			"recent.model": "模型",
			"recent.result": "结果",
			"recent.tokens": "令牌",
			"recent.took": "耗时",
			"recent.ok": "成功",
			"recent.failed": "失败",
			"recent.empty": "还没有请求记录",
			"recent.window": "只保留最近 {count} 条",
		};
		const en = {
			"nav": "Model gateway",
			"page.title": "Model gateway",
			"page.subtitle": "Every configured provider's models behind one OpenAI-compatible surface",
			"page.on": "Running",
			"page.off": "Disabled",
			"page.offHint": "The gateway is disabled in its plugin configuration; the endpoint and key below are inactive.",
			"page.apiKey": "API key",
			"page.keyFile": "Key file",
			"page.port": "Port",
			"page.portApply": "Apply",
			"page.portPinned": "fixed",
			"page.portRandom": "random ({port} was taken)",
			"page.portHint": "The gateway owns this port, independent of the UI port. Changes apply immediately — update clients that already point at the old one.",
			"page.portInvalid": "Port must be an integer between 1024 and 65535",
			"page.portBusy": "That port is already in use — pick another one",
			"page.portFailed": "Could not change the port",
			"page.portDone": "Now on {port}",
			"page.regenerate": "Regenerate",
			"page.regenerateConfirm": "Confirm?",
			"page.keyRotated": "New key minted. The old one stopped working — update your clients.",
			"page.models": "Model catalogue",
			"page.modelCount": "{count} models · {providers} providers",
			"page.copy": "Copy",
			"page.copied": "Copied",
			"page.reveal": "Show",
			"page.hide": "Hide",
			"page.copyAll": "Copy all ids",
			"page.allCopied": "Copied all {count}",
			"page.refresh": "Refresh",
			"page.loading": "Loading…",
			"page.unavailable": "Status route unavailable — the plugin may not be enabled",
			"page.retry": "Retry",
			"page.noModels": "This provider reports no models",
			"page.usage": "Client setup",
			"page.usageHint": "Put the base URL above in your client and address models as provider/model, for example {example}. Auth and upstream headers stay with each provider adapter.",
			"page.copyCurl": "Copy example",
			"page.public": "Public URL",
			"page.local": "Local URL",
			"page.publicHint": "Clients that only accept a remote endpoint (Cursor) use the first row; clients on this machine use the second.",
			"page.tunnel": "Tunnel",
			"page.tunnelIdle": "Not started",
			"page.tunnelStarting": "Starting…",
			"page.tunnelRunning": "Connected",
			"page.tunnelFailed": "Failed",
			"page.tunnelStopped": "Stopped",
			"page.tunnelUnconfigured": "Not configured",
			"page.tunnelStart": "Start",
			"page.tunnelStop": "Stop",
			"page.tunnelHint": "The plugin runs the tunnel process itself and closes it with DSH. You can also run one outside and put its hostname in the config.",
			"page.tunnelProvider": "Provider",
			"page.setup": "ngrok account",
			"page.setupReady": "Configured",
			"page.setupMissing": "Not configured",
			"page.setupHint": "ngrok needs an account before a tunnel can claim a stable domain. Signing up and copying the token happen in a browser; the plugin cannot create the account for you.",
			"page.setupStep1": "1. Open the signup page and log in with email, Google or GitHub",
			"page.setupStep2": "2. Copy the authtoken shown there",
			"page.setupStep3": "3. Paste it below — saving applies it immediately",
			"page.setupOpenSignup": "Open signup",
			"page.setupOpenToken": "Open token page",
			"page.setupPlaceholder": "Paste the ngrok authtoken",
			"page.setupSave": "Save token",
			"page.setupSaving": "Saving…",
			"page.setupSaved": "The token was written to the ngrok config",
			"page.setupBad": "Could not save it — check that the token is correct",
			"page.setupInvalid": "That does not look like an ngrok authtoken (20+ characters, no spaces)",
			"page.setupFile": "Written to",
			"page.alias": "Model aliases",
			"page.aliasHint": "Short names an external client may send, mapped to provider/model. Cursor sends its own ids such as gpt-4o; colliding bare ids need an alias.",
			"page.aliasName": "Alias",
			"page.aliasTarget": "Target provider/model",
			"page.aliasAdd": "Add",
			"page.aliasSave": "Save",
			"page.aliasSaved": "Aliases saved",
			"page.aliasBad": "The alias or target is malformed (target must be provider/model)",
			"page.aliasEmpty": "No aliases yet",
			"page.aliasRemove": "Remove",
			"page.aria": "Model gateway",
			"panel.empty": "No models",
			"stat.requests": "Requests",
			"stat.failed": "{count} failed",
			"stat.models": "Models",
			"stat.providers": "{count} providers",
			"stat.tokens": "Tokens",
			"stat.tokenHint": "in {input} · out {output}",
			"stat.traffic": "Traffic",
			"stat.trafficHint": "in {input} · out {output}",
			"stat.uptime": "Uptime",
			"stat.since": "since {time}",
			"stat.noData": "not tracked by this host",
			"search.label": "Search models",
			"search.placeholder": "Filter by id, name, or provider",
			"search.empty": "No model matches",
			"recent.title": "Recent requests",
			"recent.time": "Time",
			"recent.model": "Model",
			"recent.result": "Result",
			"recent.tokens": "Tokens",
			"recent.took": "Took",
			"recent.ok": "ok",
			"recent.failed": "failed",
			"recent.empty": "No requests yet",
			"recent.window": "Only the last {count} are kept",
		};
		//#endregion

		//#region styles
		/**
		 * Local spacing scale plus the host's own tokens. The scale is a
		 * plain number ladder, so padding stays consistent across the page;
		 * everything visible — colour, border, radius, shadow, type — comes
		 * from `--dsw-*` so light and dark themes both work untouched.
		 */
		const CSS = `
[${STYLE_ATTR}] { display: block; height: 100%; overflow: auto; }
[${STYLE_ATTR}] * { box-sizing: border-box; }
[${STYLE_ATTR}] .gw-page {
	--gw-s1: 4px; --gw-s2: 8px; --gw-s3: 12px; --gw-s4: 16px; --gw-s5: 24px; --gw-s6: 32px;
	max-width: 1040px; margin: 0 auto; padding: 0 var(--gw-s5) 64px;
	color: var(--dsw-alias-label-primary);
	font: var(--dsw-font-xs-13);
}

/* ---- sticky header ---- */
[${STYLE_ATTR}] .gw-head {
	position: sticky; top: 0; z-index: 2;
	display: flex; align-items: flex-start; justify-content: space-between; gap: var(--gw-s4);
	margin: 0 calc(var(--gw-s5) * -1) var(--gw-s5);
	padding: var(--gw-s4) var(--gw-s5);
	background: var(--dsw-alias-bg-base);
	border-bottom: 1px solid var(--dsw-alias-border-l1);
	box-shadow: var(--dsw-elevation-soft);
}
[${STYLE_ATTR}] .gw-title { margin: 0; font: var(--dsw-font-l-20); font-weight: 600; }
[${STYLE_ATTR}] .gw-sub { margin: var(--gw-s1) 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
[${STYLE_ATTR}] .gw-head-actions { display: flex; align-items: center; gap: var(--gw-s2); flex: none; }

/* ---- status pill ---- */
[${STYLE_ATTR}] .gw-pill {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 4px 11px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
	font-size: 12px; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-dot {
	width: 7px; height: 7px; border-radius: 50%; flex: none;
	background: var(--dsw-alias-state-idle-primary);
}
[${STYLE_ATTR}] .gw-dot.is-on { background: var(--dsw-alias-state-success-primary); }
[${STYLE_ATTR}] .gw-dot.is-bad { background: var(--dsw-alias-state-error-primary); }

/* ---- buttons ---- */
[${STYLE_ATTR}] .gw-btn {
	appearance: none; cursor: pointer; font: inherit; font-size: 12px;
	padding: 5px 11px; border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-primary);
	white-space: nowrap;
	transition: background .12s ease, border-color .12s ease;
}
[${STYLE_ATTR}] .gw-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
[${STYLE_ATTR}] .gw-btn:disabled { opacity: .55; cursor: default; }
[${STYLE_ATTR}] .gw-btn.is-primary {
	border-color: transparent;
	background: var(--dsw-alias-brand-primary);
	color: var(--dsw-alias-label-primary-foreground);
}
[${STYLE_ATTR}] .gw-btn.is-primary:hover { background: var(--dsw-alias-brand-primary); opacity: .88; }
[${STYLE_ATTR}] .gw-btn.is-quiet {
	border-color: transparent; background: transparent;
	color: var(--dsw-alias-brand-primary);
}
[${STYLE_ATTR}] .gw-btn.is-quiet:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* ---- metric tiles ---- */
[${STYLE_ATTR}] .gw-stats {
	display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
	gap: var(--gw-s3); margin-bottom: var(--gw-s4);
}
[${STYLE_ATTR}] .gw-stat {
	display: flex; flex-direction: column; gap: 2px; min-width: 0;
	padding: var(--gw-s3) var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-layer-1);
}
[${STYLE_ATTR}] .gw-stat-label {
	color: var(--dsw-alias-label-caption); font-size: 12px;
	letter-spacing: .02em; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-stat-value {
	font-size: 22px; font-weight: 600; line-height: 1.2;
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-stat-hint {
	color: var(--dsw-alias-label-tertiary); font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---- two-column sections ---- */
[${STYLE_ATTR}] .gw-grid {
	display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--gw-s4); margin-bottom: var(--gw-s4);
}
[${STYLE_ATTR}] .gw-card {
	min-width: 0;
	padding: var(--gw-s4) var(--gw-s5);
	margin-bottom: var(--gw-s4);
	border-radius: var(--dsw-radius-lg);
	border: 1px solid var(--dsw-alias-settings-card-stroke);
	background: var(--dsw-alias-settings-card-fill);
}
[${STYLE_ATTR}] .gw-grid > .gw-card { margin-bottom: 0; }
[${STYLE_ATTR}] .gw-label {
	display: flex; align-items: center; justify-content: space-between;
	gap: var(--gw-s3); margin-bottom: var(--gw-s2);
}
[${STYLE_ATTR}] .gw-label-title {
	font: var(--dsw-font-s-14); font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-label-side { display: inline-flex; align-items: center; gap: 6px; flex: none; }
[${STYLE_ATTR}] .gw-value { display: flex; align-items: center; gap: var(--gw-s2); min-width: 0; }
[${STYLE_ATTR}] .gw-note { margin-top: var(--gw-s2); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
[${STYLE_ATTR}] .gw-note + .gw-label { margin-top: var(--gw-s3); }
/* The three setup steps read as one block, so the numbers line up and the
   list does not borrow the page's default indent. */
[${STYLE_ATTR}] .gw-steps {
	margin: var(--gw-s2) 0 0; padding: 0; list-style: none;
	display: grid; gap: 3px;
	color: var(--dsw-alias-label-secondary); font-size: 11px;
}
[${STYLE_ATTR}] .gw-steps li { padding-left: 0; }

/* ---- code and input ---- */
[${STYLE_ATTR}] .gw-code {
	flex: 1 1 auto; min-width: 0; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all;
	padding: 6px 10px; border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-input {
	font: inherit; font-size: 12px; min-width: 0;
	padding: 5px 9px; border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-input::placeholder { color: var(--dsw-alias-label-caption); }
[${STYLE_ATTR}] .gw-input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }
[${STYLE_ATTR}] .gw-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
/* The token field shares the .gw-value row with its buttons, so it takes the
   remaining width instead of sizing to its placeholder. */
[${STYLE_ATTR}] .gw-value .gw-input { flex: 1 1 auto; }
[${STYLE_ATTR}] .gw-port-row {
	display: flex; align-items: center; gap: var(--gw-s2);
	margin-top: var(--gw-s3); padding-top: var(--gw-s3);
	border-top: 1px solid var(--dsw-alias-border-l1);
}
[${STYLE_ATTR}] .gw-port-row .gw-input { width: 96px; text-align: right; }
[${STYLE_ATTR}] .gw-hint-inline { color: var(--dsw-alias-label-tertiary); font-size: 11px; }

/* ---- notices ---- */
[${STYLE_ATTR}] .gw-notice { margin-top: var(--gw-s2); font-size: 12px; }
[${STYLE_ATTR}] .gw-notice.is-ok { color: var(--dsw-alias-state-success-primary); }
[${STYLE_ATTR}] .gw-notice.is-bad { color: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTR}] .gw-notice.is-warn { color: var(--dsw-alias-state-warn-primary); }

/* ---- model search ---- */
[${STYLE_ATTR}] .gw-search { display: flex; align-items: center; gap: var(--gw-s2); margin-bottom: var(--gw-s3); }
[${STYLE_ATTR}] .gw-search .gw-input { flex: 1 1 auto; }

/* ---- provider groups ---- */
[${STYLE_ATTR}] .gw-group { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-group:first-of-type { border-top: none; }
[${STYLE_ATTR}] .gw-group > summary {
	cursor: pointer; list-style: none;
	padding: var(--gw-s2) 6px;
	display: flex; align-items: center; justify-content: space-between; gap: var(--gw-s3);
}
[${STYLE_ATTR}] .gw-group > summary::-webkit-details-marker { display: none; }
[${STYLE_ATTR}] .gw-group-name {
	display: flex; align-items: center; gap: 7px;
	font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-group-count {
	color: var(--dsw-alias-label-caption); font-weight: 400; font-size: 11px;
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-caret { color: var(--dsw-alias-label-caption); transition: transform .12s ease; }
[${STYLE_ATTR}] .gw-group[open] .gw-caret { transform: rotate(90deg); }

/* ---- rows ---- */
[${STYLE_ATTR}] .gw-row {
	display: flex; align-items: center; gap: var(--gw-s3);
	padding: 5px 8px 5px 24px;
	border-radius: var(--dsw-radius-xs);
}
[${STYLE_ATTR}] .gw-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-row-id {
	flex: 1 1 auto; min-width: 0; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all;
}
[${STYLE_ATTR}] .gw-row-name {
	flex: 0 1 auto; max-width: 38%; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	color: var(--dsw-alias-label-caption); font-size: 11px;
}
[${STYLE_ATTR}] .gw-alias-row {
	display: flex; align-items: center; gap: var(--gw-s2);
	padding: 5px 4px; border-radius: var(--dsw-radius-xs);
}
[${STYLE_ATTR}] .gw-alias-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-alias-name {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all; flex: none;
}
[${STYLE_ATTR}] .gw-alias-arrow { color: var(--dsw-alias-label-caption); font-size: 11px; flex: none; }
[${STYLE_ATTR}] .gw-alias-target {
	flex: 1 1 auto; min-width: 0; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	color: var(--dsw-alias-label-tertiary); font-size: 11px;
}

/* ---- recent requests ---- */
[${STYLE_ATTR}] .gw-table { display: flex; flex-direction: column; }
[${STYLE_ATTR}] .gw-thead,
[${STYLE_ATTR}] .gw-trow {
	display: grid;
	grid-template-columns: 76px minmax(0, 1.7fr) 92px 108px 72px;
	gap: var(--gw-s3); align-items: center;
	padding: 6px 8px;
}
[${STYLE_ATTR}] .gw-thead {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[${STYLE_ATTR}] .gw-trow { border-radius: var(--dsw-radius-xs); }
[${STYLE_ATTR}] .gw-trow:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-tcell {
	min-width: 0; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	font-size: 12px;
}
[${STYLE_ATTR}] .gw-tnum { font-variant-numeric: tabular-nums; }
[${STYLE_ATTR}] .gw-badge {
	display: inline-flex; align-items: center;
	padding: 1px 8px; border-radius: 999px;
	border: 1px solid transparent;
	background: var(--dsw-alias-bg-layer-2);
	font-size: 11px;
}
[${STYLE_ATTR}] .gw-badge.is-ok {
	color: var(--dsw-alias-state-success-primary);
	border-color: var(--dsw-alias-state-success-secondary);
}
[${STYLE_ATTR}] .gw-badge.is-bad {
	color: var(--dsw-alias-state-error-primary);
	border-color: var(--dsw-alias-state-error-primary);
}
[${STYLE_ATTR}] .gw-empty {
	padding: var(--gw-s4) 0;
	color: var(--dsw-alias-label-tertiary); font-size: 12px;
	text-align: center;
}

/* ---- curl example ---- */
[${STYLE_ATTR}] .gw-snippet {
	display: block; margin-top: var(--gw-s2);
	white-space: pre-wrap; word-break: break-all;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all;
	padding: var(--gw-s3);
	border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-icon { display: inline-flex; align-items: center; justify-content: center; }

@media (max-width: 900px) {
	[${STYLE_ATTR}] .gw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	[${STYLE_ATTR}] .gw-grid { grid-template-columns: minmax(0, 1fr); }
	[${STYLE_ATTR}] .gw-thead,
	[${STYLE_ATTR}] .gw-trow { grid-template-columns: 64px minmax(0, 1fr) 84px; }
	[${STYLE_ATTR}] .gw-thead > :nth-child(4),
	[${STYLE_ATTR}] .gw-thead > :nth-child(5),
	[${STYLE_ATTR}] .gw-trow > :nth-child(4),
	[${STYLE_ATTR}] .gw-trow > :nth-child(5) { display: none; }
}
`;
		//#endregion

		//#region helpers
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				try {
					const area = document.createElement("textarea");
					area.value = text;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					const ok = document.execCommand("copy");
					area.remove();
					return ok;
				} catch {
					return false;
				}
			}
		}

		function mask(key) {
			if (typeof key !== "string" || key.length === 0) return "";
			if (key.length <= 12) return "•".repeat(key.length);
			return `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}`;
		}

		function fill(text, values) {
			let out = text;
			for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(String(value));
			return out;
		}

		/** `37058` reads as `37.1k`; below a thousand stays exact. */
		function formatTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value < 1000) return String(Math.round(value));
			if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
			if (value < 1000000) return `${Math.round(value / 1000)}k`;
			return `${(value / 1000000).toFixed(1)}M`;
		}

		function formatBytes(value) {
			if (!Number.isFinite(value) || value <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let size = value;
			let index = 0;
			while (size >= 1024 && index < units.length - 1) {
				size /= 1024;
				index += 1;
			}
			return index === 0 ? `${Math.round(size)} ${units[index]}` : `${size.toFixed(1)} ${units[index]}`;
		}

		/** Coarse on purpose: "how long has it been up" needs no milliseconds. */
		function formatDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0s";
			const total = Math.floor(ms / 1000);
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (days > 0) return `${days}d ${hours}h`;
			if (hours > 0) return `${hours}h ${minutes}m`;
			if (minutes > 0) return `${minutes}m ${seconds}s`;
			return `${seconds}s`;
		}

		function clockOf(at) {
			if (!Number.isFinite(at)) return "—";
			const date = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		//#endregion

		//#region sidebar icon
		/**
		 * The sidebar row's icon: a port with a request passing through it. The
		 * host supplies `size` and `active`, so the mark follows the column.
		 */
		function GatewayIcon(owner) {
			const props = owner ?? {};
			const size = typeof props.size === "number" ? props.size : 16;
			const active = props.active === true;
			return h(
				"span",
				{ className: "gw-icon", style: { width: `${size}px`, height: `${size}px` } },
				h(
					"svg",
					{
						width: size,
						height: size,
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: active ? 2 : 1.8,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						"aria-hidden": "true",
					},
					h("rect", { x: 8, y: 7, width: 8, height: 10, rx: 2.5 }),
					h("path", { d: "M2.5 12h4" }),
					h("path", { d: "M21.5 12h-4" }),
					h("path", { d: "M5.5 9.6 3.1 12l2.4 2.4" }),
					h("path", { d: "M18.5 9.6 20.9 12l-2.4 2.4" }),
				),
			);
		}
		//#endregion

		//#region page
		function GatewayPage(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [status, setStatus] = useState(null);
			const [failed, setFailed] = useState(false);
			const [copied, setCopied] = useState("");
			const [revealed, setRevealed] = useState(false);
			const [portDraft, setPortDraft] = useState("");
			const [notice, setNotice] = useState(null);
			const [confirmKey, setConfirmKey] = useState(false);
			const [aliasDraft, setAliasDraft] = useState({ name: "", target: "" });
			// `null` means "not edited yet": the table below is then read straight
			// from the status document. It is only set once the user adds or
			// removes a row, so a refresh never clobbers an in-progress edit.
			const [aliasDraftRows, setAliasDraftRows] = useState(null);
			const [busyTunnel, setBusyTunnel] = useState(false);
			// The guided ngrok setup. The token lives only in this input and in the
			// POST body: it is never read back from the host, never kept in state
			// after saving, and never rendered anywhere else on the page.
			const [tokenDraft, setTokenDraft] = useState("");
			const [busyToken, setBusyToken] = useState(false);
			const [query, setQuery] = useState("");
			// Providers start expanded; the set records the ones the user closed.
			// Storing the exception keeps the default right when the catalogue
			// grows, instead of seeding one entry per provider on every refresh.
			const [closedGroups, setClosedGroups] = useState(() => new Set());

			// One same-origin read: the status document carries the whole catalog.
			// `/v1/models` lives on the gateway's own port, so asking for it from
			// this page would be a cross-origin call — and would leave the list
			// empty whenever the browser refused it.
			//
			// `force` is what the Refresh button passes: the host rebuilds the
			// catalog instead of replaying the snapshot it already has, so a
			// provider that bound its adapter late still shows up on demand.
			const load = useCallback(async (force = false) => {
				setFailed(false);
				try {
					const response = await fetch(force ? `${STATUS_PATH}?refresh=1` : STATUS_PATH, {
						cache: "no-store",
						credentials: "same-origin",
						headers: { Accept: "application/json" },
					});
					if (!response.ok) throw new Error(`status ${response.status}`);
					setStatus(await response.json());
				} catch {
					setFailed(true);
				}
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			const isOn = status !== null && status.enabled === true;

			// The alias table is server state; `aliasDraftRows` only exists once
			// the user edits it, so the first render already shows what the host
			// has instead of waiting for an effect to copy it across.
			const aliasTable = Array.isArray(status?.aliases) ? status.aliases : [];
			const aliasRows = aliasDraftRows ?? aliasTable;

			const copy = useCallback(async (which, value) => {
				if (await copyText(value)) {
					setCopied(which);
					setTimeout(() => setCopied(""), 1500);
				}
			}, []);

			/** Persist a new listen port; the host rebinds immediately. */
			const submitPort = useCallback(async () => {
				const port = Number(String(portDraft).trim());
				if (!Number.isInteger(port) || port < 1024 || port > 65535) {
					setNotice({ scope: "port", kind: "bad", text: t("page.portInvalid") });
					return;
				}
				try {
					const response = await fetch(SETTINGS_PATH, {
						method: "POST",
						cache: "no-store",
						credentials: "same-origin",
						headers: { Accept: "application/json", "Content-Type": "application/json" },
						body: JSON.stringify({ port }),
					});
					const body = await response.json().catch(() => ({}));
					if (!response.ok) {
						setNotice({
							scope: "port",
							kind: "bad",
							text: response.status === 409 ? t("page.portBusy") : t("page.portFailed"),
						});
						return;
					}
					setNotice({ scope: "port", kind: "ok", text: fill(t("page.portDone"), { port: body.port }) });
					setPortDraft("");
					await load();
				} catch {
					setNotice({ scope: "port", kind: "bad", text: t("page.portFailed") });
				}
			}, [portDraft, load, t]);

			/** Mint a new key; the old one stops authorising at once. */
			const rotateKey = useCallback(async () => {
				if (!confirmKey) {
					setConfirmKey(true);
					setTimeout(() => setConfirmKey(false), 4000);
					return;
				}
				setConfirmKey(false);
				try {
					const response = await fetch(KEY_PATH, {
						method: "POST",
						cache: "no-store",
						credentials: "same-origin",
						headers: { Accept: "application/json", "Content-Type": "application/json" },
						body: JSON.stringify({ action: "regenerate" }),
					});
					if (!response.ok) {
						setNotice({ scope: "key", kind: "bad", text: t("page.portFailed") });
						return;
					}
					setRevealed(true);
					setNotice({ scope: "key", kind: "ok", text: t("page.keyRotated") });
					await load();
				} catch {
					setNotice({ scope: "key", kind: "bad", text: t("page.portFailed") });
				}
			}, [confirmKey, load, t]);

			const noticeFor = (scope) =>
				notice !== null && notice.scope === scope
					? h(
							"div",
							{
								className: `gw-notice ${
									notice.kind === "ok" ? "is-ok" : notice.kind === "warn" ? "is-warn" : "is-bad"
								}`,
							},
							notice.text,
						)
					: null;

			/** Add the draft row to the local table; nothing is written yet. */
			const addAlias = useCallback(() => {
				const alias = String(aliasDraft.name).trim();
				const target = String(aliasDraft.target).trim();
				if (alias.length === 0 || target.indexOf("/") <= 0) {
					setNotice({ scope: "alias", kind: "bad", text: t("page.aliasBad") });
					return;
				}
				setAliasDraftRows((rows) => [
					...(rows ?? aliasTable).filter((row) => row.alias !== alias),
					{ alias, target },
				]);
				setAliasDraft({ name: "", target: "" });
			}, [aliasDraft, aliasTable, t]);

			const removeAlias = useCallback(
				(alias) => {
					setAliasDraftRows((rows) => (rows ?? aliasTable).filter((row) => row.alias !== alias));
				},
				[aliasTable],
			);

			/** Replace the host's whole table with the local draft. */
			const saveAliases = useCallback(async () => {
				const table = {};
				for (const row of aliasRows ?? []) table[row.alias] = row.target;
				try {
					const response = await fetch(ALIAS_PATH, {
						method: "POST",
						cache: "no-store",
						credentials: "same-origin",
						headers: { Accept: "application/json", "Content-Type": "application/json" },
						body: JSON.stringify({ aliases: table }),
					});
					if (!response.ok) {
						setNotice({ scope: "alias", kind: "bad", text: t("page.aliasBad") });
						return;
					}
					setNotice({ scope: "alias", kind: "ok", text: t("page.aliasSaved") });
					// Hand the table back to the host: after the reload the rows
					// come from the status document again, so what is shown is what
					// was actually persisted.
					setAliasDraftRows(null);
					await load();
				} catch {
					setNotice({ scope: "alias", kind: "bad", text: t("page.aliasBad") });
				}
			}, [aliasRows, load, t]);

			/** Start or stop the supervised tunnel process. */
			const toggleTunnel = useCallback(
				async (action) => {
					setBusyTunnel(true);
					try {
						const response = await fetch(TUNNEL_PATH, {
							method: "POST",
							cache: "no-store",
							credentials: "same-origin",
							headers: { Accept: "application/json", "Content-Type": "application/json" },
							body: JSON.stringify({ action }),
						});
						if (!response.ok) {
							setNotice({ scope: "tunnel", kind: "bad", text: t("page.tunnelFailed") });
							return;
						}
						// The URL arrives asynchronously (the agent has to connect
						// first), so the page polls once more after the call returns.
						await load();
						setTimeout(() => load(), 4000);
					} catch {
						setNotice({ scope: "tunnel", kind: "bad", text: t("page.tunnelFailed") });
					} finally {
						setBusyTunnel(false);
					}
				},
				[load, t],
			);

			/**
			 * Hand the pasted authtoken to the host, which runs
			 * `ngrok config add-authtoken`. The token is dropped from this
			 * component's state the moment the request settles, whichever way it
			 * went, so it cannot linger in a screenshot or a re-render.
			 */
			const saveToken = useCallback(async () => {
				const token = tokenDraft.trim();
				if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
					setNotice({ scope: "setup", kind: "bad", text: t("page.setupInvalid") });
					return;
				}
				setBusyToken(true);
				try {
					const response = await fetch(AUTHTOKEN_PATH, {
						method: "POST",
						cache: "no-store",
						credentials: "same-origin",
						headers: { Accept: "application/json", "Content-Type": "application/json" },
						body: JSON.stringify({ token }),
					});
					const payload = await response.json().catch(() => ({}));
					if (!response.ok) {
						setNotice({
							scope: "setup",
							kind: "bad",
							text:
								payload.error === "token-invalid"
									? t("page.setupInvalid")
									: typeof payload.message === "string" && payload.message !== ""
										? payload.message
										: t("page.setupBad"),
						});
						return;
					}
					setTokenDraft("");
					setNotice({ scope: "setup", kind: "good", text: t("page.setupSaved") });
					// The host starts the tunnel itself once a token is present, so the
					// URL may still be connecting on this pass.
					await load();
					setTimeout(() => load(), 4000);
				} catch {
					setNotice({ scope: "setup", kind: "bad", text: t("page.setupBad") });
				} finally {
					setBusyToken(false);
				}
			}, [tokenDraft, load, t]);

			const toggleGroup = useCallback((provider) => {
				setClosedGroups((previous) => {
					const next = new Set(previous);
					if (next.has(provider)) next.delete(provider);
					else next.add(provider);
					return next;
				});
			}, []);

			// Group the flat catalog by provider, in the host's own provider order.
			const models = Array.isArray(status?.models) ? status.models : null;
			const groups = [];
			if (models !== null) {
				const order = Array.isArray(status?.providers) ? status.providers.map((entry) => entry.id) : [];
				const byProvider = new Map();
				for (const model of models) {
					const provider = typeof model.provider === "string" ? model.provider : "?";
					if (!byProvider.has(provider)) byProvider.set(provider, []);
					byProvider.get(provider).push(model);
				}
				for (const provider of [...byProvider.keys()].sort((a, b) => {
					const ia = order.indexOf(a);
					const ib = order.indexOf(b);
					return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
				})) {
					groups.push({ provider, models: byProvider.get(provider) });
				}
			}

			// A query filters across all three identity fields a client may know:
			// the addressable id, the display name, and the provider.
			const needle = query.trim().toLowerCase();
			const visibleGroups =
				needle.length === 0
					? groups
					: groups
							.map((group) => ({
								provider: group.provider,
								models: group.models.filter((model) => {
									const name = typeof model.name === "string" ? model.name : "";
									return (
										model.id.toLowerCase().includes(needle) ||
										name.toLowerCase().includes(needle) ||
										group.provider.toLowerCase().includes(needle)
									);
								}),
							}))
							.filter((group) => group.models.length > 0);

			const allIds = models === null ? [] : models.map((model) => model.id);
			const example = allIds.length > 0 ? allIds[0] : "provider/model";
			const baseUrl = status?.baseUrl ?? "";
			const localUrl = status?.localBaseUrl ?? "";
			const tunnel = status?.tunnel ?? null;
			// The host reports whether an ngrok token exists and where the two
			// pages live; it never reports the token itself.
			const setupReady = status?.authtoken?.configured === true;
			const setupLinks = {
				signup: status?.authtoken?.signupUrl ?? "https://dashboard.ngrok.com/signup",
				token: status?.authtoken?.tokenUrl ?? "https://dashboard.ngrok.com/get-started/your-authtoken",
			};
			const tunnelStatus = typeof tunnel?.status === "string" ? tunnel.status : "unconfigured";
			const tunnelLabel =
				tunnelStatus === "running"
					? t("page.tunnelRunning")
					: tunnelStatus === "starting"
						? t("page.tunnelStarting")
						: tunnelStatus === "failed"
							? t("page.tunnelFailed")
							: tunnelStatus === "stopped"
								? t("page.tunnelStopped")
								: tunnelStatus === "idle"
									? t("page.tunnelIdle")
									: t("page.tunnelUnconfigured");
			const curlExample = `curl ${baseUrl}/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"${example}","messages":[{"role":"user","content":"hi"}]}'`;

			/* Counters. `usageTotals` and `bytes` only exist on hosts that
			 * accumulate them; when absent the tiles say so instead of showing
			 * a zero that would read as "nothing happened". */
			const requests = Number.isFinite(status?.requests) ? status.requests : 0;
			const failures = Number.isFinite(status?.failures) ? status.failures : 0;
			const usageTotals = status?.usageTotals ?? null;
			const bytes = status?.bytes ?? null;
			const providerCount = Array.isArray(status?.providers)
				? status.providers.length
				: groups.length;
			const uptime = Number.isFinite(status?.startedAt) ? Date.now() - status.startedAt : 0;
			const recent = Array.isArray(status?.recent) ? status.recent : [];

			const statTile = (key, label, value, hint) =>
				h(
					"div",
					{ className: "gw-stat", key },
					h("span", { className: "gw-stat-label" }, label),
					h("span", { className: "gw-stat-value" }, value),
					h("span", { className: "gw-stat-hint" }, hint),
				);

			const body = [];

			if (failed) {
				body.push(
					h(
						"div",
						{ className: "gw-card", key: "failed" },
						h("div", { className: "gw-notice is-bad" }, t("page.unavailable")),
						h(
							"button",
							{ type: "button", className: "gw-btn", style: { marginTop: "8px" }, onClick: () => load() },
							t("page.retry"),
						),
					),
				);
			}

			if (status !== null && !isOn) {
				body.push(h("div", { className: "gw-card", key: "off" }, t("page.offHint")));
			}

			if (status !== null) {
				body.push(
					h(
						"section",
						{ className: "gw-stats", key: "stats" },
						statTile(
							"requests",
							t("stat.requests"),
							String(requests),
							fill(t("stat.failed"), { count: failures }),
						),
						statTile(
							"models",
							t("stat.models"),
							String(allIds.length),
							fill(t("stat.providers"), { count: providerCount }),
						),
						statTile(
							"tokens",
							t("stat.tokens"),
							usageTotals === null ? "—" : formatTokens(usageTotals.totalTokens),
							usageTotals === null
								? t("stat.noData")
								: fill(t("stat.tokenHint"), {
										input: formatTokens(usageTotals.inputTokens),
										output: formatTokens(usageTotals.outputTokens),
									}),
						),
						statTile(
							"traffic",
							t("stat.traffic"),
							bytes === null ? "—" : formatBytes((bytes.in ?? 0) + (bytes.out ?? 0)),
							bytes === null
								? t("stat.noData")
								: fill(t("stat.trafficHint"), {
										input: formatBytes(bytes.in),
										output: formatBytes(bytes.out),
									}),
						),
						statTile(
							"uptime",
							t("stat.uptime"),
							formatDuration(uptime),
							fill(t("stat.since"), { time: clockOf(status.startedAt) }),
						),
					),
					h(
						"div",
						{ className: "gw-grid", key: "grid" },
						h(
							"section",
							{ className: "gw-card", key: "url" },
							h(
								"div",
								{ className: "gw-label" },
								h("span", { className: "gw-label-title" }, t("page.public")),
								h(
									"span",
									{ className: "gw-label-side" },
									h(
										"button",
										{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("url", baseUrl) },
										copied === "url" ? t("page.copied") : t("page.copy"),
									),
								),
							),
							h("div", { className: "gw-value" }, h("code", { className: "gw-code" }, baseUrl || "—")),
							h("div", { className: "gw-note" }, t("page.publicHint")),
							h(
								"div",
								{ className: "gw-label", style: { marginTop: "var(--gw-s3)" } },
								h("span", { className: "gw-label-title" }, t("page.local")),
								h(
									"span",
									{ className: "gw-label-side" },
									h(
										"button",
										{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("local", localUrl) },
										copied === "local" ? t("page.copied") : t("page.copy"),
									),
								),
							),
							h("div", { className: "gw-value" }, h("code", { className: "gw-code" }, localUrl || "—")),
							h(
								"div",
								{ className: "gw-port-row" },
								h("span", { className: "gw-hint-inline" }, t("page.port")),
								h("input", {
									className: "gw-input gw-mono",
									type: "text",
									inputMode: "numeric",
									value: portDraft,
									placeholder: status.port === null ? "" : String(status.port),
									"aria-label": t("page.port"),
									onChange: (event) => setPortDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") submitPort();
									},
								}),
								h("button", { type: "button", className: "gw-btn", onClick: submitPort }, t("page.portApply")),
								h(
									"span",
									{ className: "gw-hint-inline" },
									status.portFallback
										? fill(t("page.portRandom"), { port: status.preferredPort })
										: t("page.portPinned"),
								),
							),
							h("div", { className: "gw-note" }, t("page.portHint")),
							noticeFor("port"),
						),
						h(
							"section",
							{ className: "gw-card", key: "setup" },
							h(
								"div",
								{ className: "gw-label" },
								h("span", { className: "gw-label-title" }, t("page.setup")),
								h(
									"span",
									{ className: "gw-label-side" },
									h(
										"span",
										{
											className: "gw-hint-inline",
											style: {
												color: setupReady
													? "var(--dsw-alias-state-success-primary)"
													: "var(--dsw-alias-state-idle-primary)",
											},
										},
										setupReady ? t("page.setupReady") : t("page.setupMissing"),
									),
									h(
										"a",
										{
											className: "gw-btn is-quiet",
											href: setupLinks.signup,
											target: "_blank",
											rel: "noreferrer noopener",
										},
										t("page.setupOpenSignup"),
									),
								),
							),
							h("div", { className: "gw-note" }, t("page.setupHint")),
							h(
								"ol",
								{ className: "gw-steps" },
								h("li", null, t("page.setupStep1")),
								h("li", null, t("page.setupStep2")),
								h("li", null, t("page.setupStep3")),
							),
							h(
								"div",
								{ className: "gw-value" },
								h("input", {
									className: "gw-input",
									type: "password",
									autoComplete: "off",
									spellCheck: false,
									placeholder: t("page.setupPlaceholder"),
									value: tokenDraft,
									disabled: busyToken,
									onChange: (event) => setTokenDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter" && !busyToken) saveToken();
									},
								}),
								h(
									"button",
									{
										type: "button",
										className: "gw-btn",
										disabled: busyToken || tokenDraft.trim() === "",
										onClick: () => saveToken(),
									},
									busyToken ? t("page.setupSaving") : t("page.setupSave"),
								),
								h(
									"a",
									{
										className: "gw-btn is-quiet",
										href: setupLinks.token,
										target: "_blank",
										rel: "noreferrer noopener",
									},
									t("page.setupOpenToken"),
								),
							),
							typeof status?.authtoken?.file === "string" && status.authtoken.file !== ""
								? h(
										"div",
										{ className: "gw-note" },
										`${t("page.setupFile")}: `,
										h("code", { className: "gw-code" }, status.authtoken.file),
									)
								: null,
							noticeFor("setup"),
						),
						h(
							"section",
							{ className: "gw-card", key: "tunnel" },
							h(
								"div",
								{ className: "gw-label" },
								h("span", { className: "gw-label-title" }, t("page.tunnel")),
								h(
									"span",
									{ className: "gw-label-side" },
									h(
										"span",
										{ className: "gw-hint-inline" },
										tunnel?.provider === null || tunnel?.provider === undefined
											? tunnelLabel
											: `${tunnelLabel} · ${tunnel.provider}`,
									),
									h(
										"button",
										{
											type: "button",
											className: "gw-btn",
											disabled: busyTunnel,
											onClick: () =>
												toggleTunnel(tunnelStatus === "running" || tunnelStatus === "starting" ? "stop" : "start"),
										},
										tunnelStatus === "running" || tunnelStatus === "starting"
											? t("page.tunnelStop")
											: t("page.tunnelStart"),
									),
								),
							),
							tunnel?.url !== null && tunnel?.url !== undefined
								? h(
										"div",
										{ className: "gw-value" },
										h("code", { className: "gw-code" }, `${tunnel.url}/v1`),
										h(
											"button",
											{
												type: "button",
												className: "gw-btn is-quiet",
												onClick: () => copy("tunnel", `${tunnel.url}/v1`),
											},
											copied === "tunnel" ? t("page.copied") : t("page.copy"),
										),
									)
								: null,
							tunnel?.error !== null && tunnel?.error !== undefined
								? h("div", { className: "gw-notice is-bad" }, tunnel.error)
								: null,
							h("div", { className: "gw-note" }, t("page.tunnelHint")),
							noticeFor("tunnel"),
						),
						h(
							"section",
							{ className: "gw-card", key: "key" },
							h(
								"div",
								{ className: "gw-label" },
								h("span", { className: "gw-label-title" }, t("page.apiKey")),
								h(
									"span",
									{ className: "gw-label-side" },
									h(
										"button",
										{ type: "button", className: "gw-btn is-quiet", onClick: () => setRevealed((value) => !value) },
										revealed ? t("page.hide") : t("page.reveal"),
									),
									h(
										"button",
										{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("key", status.apiKey ?? "") },
										copied === "key" ? t("page.copied") : t("page.copy"),
									),
									h(
										"button",
										{ type: "button", className: `gw-btn ${confirmKey ? "" : "is-quiet"}`, onClick: rotateKey },
										confirmKey ? t("page.regenerateConfirm") : t("page.regenerate"),
									),
								),
							),
							h(
								"div",
								{ className: "gw-value" },
								h("code", { className: "gw-code" }, revealed ? (status.apiKey ?? "—") : mask(status.apiKey)),
							),
							typeof status.settingsFile === "string"
								? h("div", { className: "gw-note" }, `${t("page.keyFile")} ${status.settingsFile}`)
								: null,
							noticeFor("key"),
						),
						h(
							"section",
							{ className: "gw-card", key: "alias" },
							h(
								"div",
								{ className: "gw-label" },
								h("span", { className: "gw-label-title" }, t("page.alias")),
								h(
									"span",
									{ className: "gw-label-side" },
									h("button", { type: "button", className: "gw-btn", onClick: saveAliases }, t("page.aliasSave")),
								),
							),
							h("div", { className: "gw-note" }, t("page.aliasHint")),
							(aliasRows ?? []).length === 0
								? h("div", { className: "gw-empty" }, t("page.aliasEmpty"))
								: (aliasRows ?? []).map((row) =>
										h(
											"div",
											{ className: "gw-alias-row", key: row.alias },
											h("code", { className: "gw-alias-name" }, row.alias),
											h("span", { className: "gw-alias-arrow" }, "→"),
											h("span", { className: "gw-alias-target" }, row.target),
											h(
												"button",
												{ type: "button", className: "gw-btn is-quiet", onClick: () => removeAlias(row.alias) },
												t("page.aliasRemove"),
											),
										),
									),
							h(
								"div",
								{ className: "gw-port-row" },
								h("input", {
									className: "gw-input gw-mono",
									type: "text",
									style: { width: "132px", textAlign: "left" },
									value: aliasDraft.name,
									placeholder: t("page.aliasName"),
									"aria-label": t("page.aliasName"),
									onChange: (event) => setAliasDraft((draft) => ({ ...draft, name: event.target.value })),
								}),
								h("input", {
									className: "gw-input gw-mono",
									type: "text",
									style: { flex: "1 1 auto", minWidth: "120px", textAlign: "left" },
									value: aliasDraft.target,
									placeholder: t("page.aliasTarget"),
									"aria-label": t("page.aliasTarget"),
									onChange: (event) => setAliasDraft((draft) => ({ ...draft, target: event.target.value })),
									onKeyDown: (event) => {
										if (event.key === "Enter") addAlias();
									},
								}),
								h("button", { type: "button", className: "gw-btn", onClick: addAlias }, t("page.aliasAdd")),
							),
							noticeFor("alias"),
						),
					),
				);
			}

			body.push(
				h(
					"section",
					{ className: "gw-card", key: "models" },
					h(
						"div",
						{ className: "gw-label" },
						h("span", { className: "gw-label-title" }, t("page.models")),
						h(
							"span",
							{ className: "gw-label-side" },
							h(
								"span",
								{ className: "gw-hint-inline" },
								fill(t("page.modelCount"), { count: allIds.length, providers: providerCount }),
							),
							allIds.length > 0
								? h(
										"button",
										{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("all", allIds.join("\n")) },
										copied === "all" ? fill(t("page.allCopied"), { count: allIds.length }) : t("page.copyAll"),
									)
								: null,
							h("button", { type: "button", className: "gw-btn is-quiet", onClick: () => load(true) }, t("page.refresh")),
						),
					),
					h(
						"div",
						{ className: "gw-search" },
						h("input", {
							className: "gw-input",
							type: "search",
							value: query,
							placeholder: t("search.placeholder"),
							"aria-label": t("search.label"),
							onChange: (event) => setQuery(event.target.value),
						}),
					),
					status === null
						? h("div", { className: "gw-empty" }, t("page.loading"))
						: groups.length === 0
							? h("div", { className: "gw-empty" }, t("panel.empty"))
							: visibleGroups.length === 0
								? h("div", { className: "gw-empty" }, t("search.empty"))
								: visibleGroups.map((group) =>
										h(
											"details",
											{
												className: "gw-group",
												key: group.provider,
												// While a query is active every surviving group is
												// expanded: the matches are what the user asked for.
												open: needle.length > 0 || !closedGroups.has(group.provider),
											},
											h(
												"summary",
												{
													onClick: (event) => {
														event.preventDefault();
														if (needle.length > 0) return;
														toggleGroup(group.provider);
													},
												},
												h(
													"span",
													{ className: "gw-group-name" },
													h("span", { className: "gw-caret" }, "▸"),
													group.provider,
													h("span", { className: "gw-group-count" }, String(group.models.length)),
												),
												h(
													"button",
													{
														type: "button",
														className: "gw-btn is-quiet",
														onClick: (event) => {
															event.preventDefault();
															event.stopPropagation();
															copy(group.provider, group.models.map((model) => model.id).join("\n"));
														},
													},
													copied === group.provider ? t("page.copied") : t("page.copy"),
												),
											),
											group.models.map((model) =>
												h(
													"div",
													{ className: "gw-row", key: model.id },
													h("code", { className: "gw-row-id" }, model.id),
													typeof model.name === "string" && model.name !== model.id
														? h("span", { className: "gw-row-name" }, model.name)
														: null,
													h(
														"button",
														{ type: "button", className: "gw-btn", onClick: () => copy(model.id, model.id) },
														copied === model.id ? t("page.copied") : t("page.copy"),
													),
												),
											),
										),
									),
				),
			);

			body.push(
				h(
					"section",
					{ className: "gw-card", key: "usage" },
					h(
						"div",
						{ className: "gw-label" },
						h("span", { className: "gw-label-title" }, t("page.usage")),
						h(
							"span",
							{ className: "gw-label-side" },
							h(
								"button",
								{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("curl", curlExample) },
								copied === "curl" ? t("page.copied") : t("page.copyCurl"),
							),
						),
					),
					h("div", { className: "gw-note" }, fill(t("page.usageHint"), { example })),
					h("code", { className: "gw-snippet" }, curlExample),
				),
			);

			body.push(
				h(
					"section",
					{ className: "gw-card", key: "recent" },
					h(
						"div",
						{ className: "gw-label" },
						h("span", { className: "gw-label-title" }, t("recent.title")),
						h(
							"span",
							{ className: "gw-label-side" },
							h("span", { className: "gw-hint-inline" }, fill(t("recent.window"), { count: recent.length })),
						),
					),
					recent.length === 0
						? h("div", { className: "gw-empty" }, t("recent.empty"))
						: h(
								"div",
								{ className: "gw-table" },
								h(
									"div",
									{ className: "gw-thead" },
									h("span", null, t("recent.time")),
									h("span", null, t("recent.model")),
									h("span", null, t("recent.result")),
									h("span", { className: "gw-tnum" }, t("recent.tokens")),
									h("span", { className: "gw-tnum" }, t("recent.took")),
								),
								recent.map((entry, index) => {
									const ok = entry?.outcome === "ok";
									const usage = entry?.usage;
									return h(
										"div",
										{ className: "gw-trow", key: `${entry?.at ?? index}-${index}` },
										h("span", { className: "gw-tcell gw-tnum" }, clockOf(entry?.at)),
										h("span", { className: "gw-tcell gw-mono" }, entry?.model ?? "—"),
										h(
											"span",
											{ className: "gw-tcell" },
											h(
												"span",
												{ className: `gw-badge ${ok ? "is-ok" : "is-bad"}` },
												ok ? t("recent.ok") : (entry?.code ?? t("recent.failed")),
											),
										),
										h(
											"span",
											{ className: "gw-tcell gw-tnum" },
											usage === undefined || usage === null
												? "—"
												: `${formatTokens(usage.inputTokens)} → ${formatTokens(usage.outputTokens)}`,
										),
										h(
											"span",
											{ className: "gw-tcell gw-tnum" },
											Number.isFinite(entry?.ms) ? `${entry.ms}ms` : "—",
										),
									);
								}),
							),
				),
			);

			const dotClass = status === null ? "" : isOn ? "is-on" : "is-bad";
			return h(
				"div",
				{ [STYLE_ATTR]: "", role: "region", "aria-label": t("page.aria") },
				h(
					"div",
					{ className: "gw-page" },
					h(
						"header",
						{ className: "gw-head" },
						h(
							"div",
							null,
							h("h1", { className: "gw-title" }, t("page.title")),
							h("p", { className: "gw-sub" }, t("page.subtitle")),
						),
						h(
							"div",
							{ className: "gw-head-actions" },
							h(
								"span",
								{ className: "gw-pill" },
								h("span", { className: `gw-dot ${dotClass}` }),
								status === null ? t("page.loading") : isOn ? t("page.on") : t("page.off"),
							),
							h(
								"button",
								{ type: "button", className: "gw-btn is-primary", onClick: () => load(true) },
								t("page.refresh"),
							),
						),
					),
					...body,
				),
			);
		}
		//#endregion

		//#region plugin
		/** Slot registry plus the locale dictionary seat. */
		const inject = ["slots", "locale"];
		const name = NS;

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute(STYLE_ATTR, "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-openai-gateway: styles");

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-openai-gateway: dictionaries");

			const t = ctx.locale.bind(NS);

			// The page the sidebar row opens: the `main` slot keyed by the row id.
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, GatewayPage),
			);

			// The row itself, beside the host's own global pages. Its label is a
			// thunk so it follows the active locale without re-registering.
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: PANEL_ID, order: 60, label: () => t("nav"), locale: NS },
					GatewayIcon,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
