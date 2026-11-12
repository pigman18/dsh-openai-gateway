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
			"page.tunnelSignup": "注册 ngrok 账号",
			"page.tunnelToken": "获取 authtoken",
			"page.alias": "模型路由",
			"page.aliasHint": "给外部客户端用的短名字，映射到 provider/model。可以写多个目标，每行一个：前面的不可用（额度耗尽、限流、超时、5xx）时自动换下一个，失败的目标冷却 5 分钟。Cursor 发 gpt-4o 这类名字时靠它路由；撞名的模型必须走路由。",
			"page.aliasName": "路由名",
			"page.aliasTarget": "目标 provider/model（每行一个，按顺序兜底）",
			"page.aliasAdd": "添加",
			"page.aliasSave": "保存",
			"page.aliasSaved": "路由已保存",
			"page.aliasBad": "路由名或目标格式不对（目标需为 provider/model，每行一个）",
			"page.aliasEmpty": "还没有路由",
			"page.aliasRemove": "删除",
			"page.aliasCooling": "冷却中",
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
			"tab.overview": "概览",
			"tab.routes": "路由",
			"tab.tunnel": "隧道",
			"tab.catalog": "目录",
			"tab.settings": "设置",
			"routes.name": "路由名",
			"routes.chain": "尝试顺序",
			"routes.health": "健康度",
			"routes.count": "{count} 条",
			"routes.healthy": "全部可用",
			"routes.bench": "{count} 个冷却",
			"routes.fallback": "备用",
			"routes.primary": "首选",
			"routes.add": "添加路由",
			"routes.edit": "编辑",
			"routes.addTitle": "添加路由",
			"routes.editTitle": "编辑路由",
			"routes.close": "关闭",
			"routes.cancel": "取消",
			"routes.confirm": "保存路由",
			"routes.nameLabel": "路由名",
			"routes.nameHint": "客户端请求时填的 model",
			"routes.available": "可用模型",
			"routes.tryOrder": "尝试顺序",
			"routes.searchHint": "按 ID、名称或 provider 搜索",
			"routes.allProviders": "全部 {count}",
			"routes.pickAll": "全选",
			"routes.pickNone": "全不选",
			"routes.groupPicked": "已选 {count}",
			"routes.usedBy": "已用于 {alias}",
			"routes.targetCount": "{count} 个目标",
			"routes.noTargets": "还没有选择目标",
			"routes.noTargetsHint": "从左边勾选，勾选顺序就是兜底顺序。",
			"routes.noMatch": "没有匹配的模型",
			"routes.noMatchHint": "换个关键字，或点「全部」清除 provider 过滤。",
			"routes.primaryHint": "首选，直接服务",
			"routes.fallbackHint": "第 {index} 顺位兜底",
			"routes.orderHint": "顺序就是兜底顺序：第 1 个是首选，后面的依次顶上。拖动或按 ↑ ↓ 调整。",
			"routes.needTarget": "至少选一个目标才能保存",
			"routes.needName": "还需要一个路由名",
			"routes.summary": "{name} → {count} 个目标，按顺序兜底",
			"routes.dragHint": "拖动调整顺序",
			"routes.moveUp": "上移",
			"routes.moveDown": "下移",
			"routes.removeTarget": "移除",
			"cool.title": "冷却中",
			"cool.summary": "{count} 个目标正在冷却，最近一个还有 {seconds}s 恢复。冷却期间请求直接跳过它，不会先失败一次。",
			"cool.none": "所有目标都可用",
			"tunnel.title": "公网隧道",
			"tunnel.sub": "把本机网关挂到一个公网地址上，供只能填外链的客户端使用。",
			"tunnel.heroRunning": "公网地址",
			"tunnel.heroDown": "尚未开启",
			"tunnel.heroDownHint": "开启后这里会出现一个可复制的公网地址。",
			"tunnel.noUrl": "隧道未开启",
			"tunnel.pid": "进程 {pid}",
			"tunnel.autostart": "随 DSH 启动",
			"tunnel.autostartOn": "已开启",
			"tunnel.autostartOff": "已关闭",
			"tunnel.autostartHint": "由插件配置里的 tunnel.autostart 决定，在 DSH 配置中修改，界面上不提供开关。",
			"tunnel.providerTitle": "隧道方式",
			"tunnel.providerHint": "选定方式后再开启隧道；隧道已在运行时切换方式需要重启。",
			"tunnel.restart": "用 {provider} 重启",
			"tunnel.restartHint": "当前隧道用的是 {current}，切换会短暂断开公网地址。",
			"tunnel.ngrokDesc": "需要 authtoken，免费版每次重启换域名",
			"tunnel.cloudflaredDesc": "无需账号，域名随机且更短",
			"tunnel.credTitle": "这个隧道方式还缺凭据",
			"tunnel.credBody": "ngrok 需要一个账号和 authtoken：注册后在后台复制 token，然后执行 {cmd}，再回到这里开启隧道。",
			"settings.title": "接入设置",
			"settings.sub": "地址、密钥与端口，改完立即生效。",
			"settings.endpoints": "接入地址",
			"settings.endpointsSub": "外部客户端填对外地址，本机客户端填本机地址。",
			"settings.localSub": "与对外地址指向同一个网关，只在本机可达。",
			"settings.key": "密钥",
			"settings.keySub": "换密钥后旧密钥立刻失效，已配置的客户端要同步更新。",
			"settings.port": "监听端口",
			"settings.portSub": "网关独占这个端口，与界面端口无关。",
			"settings.example": "请求示例",
			"settings.exampleSub": "把 {key} 换成上面的密钥即可直接跑通。",
		};
		const en = {
			"nav": "Model gateway",
			"page.title": "Model gateway",
			"page.subtitle": "Every configured provider's models behind one OpenAI-compatible surface",
			"page.on": "Running",
			"page.off": "Off",
			"page.offHint": "The gateway is disabled in the plugin config; the address and key below are not live.",
			"page.apiKey": "API key",
			"page.keyFile": "Key stored in",
			"page.port": "Port",
			"page.portApply": "Apply",
			"page.portPinned": "Pinned",
			"page.portRandom": "Random ({port} was taken)",
			"page.portHint": "The gateway owns this port; it is unrelated to the UI port. A change applies at once, so update any client already pointing here.",
			"page.portInvalid": "The port must be an integer between 1024 and 65535",
			"page.portBusy": "That port is taken; pick another or leave it empty to let the host choose",
			"page.portFailed": "Could not switch the port",
			"page.portDone": "Now on {port}",
			"page.regenerate": "Regenerate",
			"page.regenerateConfirm": "Confirm?",
			"page.keyRotated": "New key minted; the old one stopped working, so update your clients",
			"page.models": "Model catalogue",
			"page.modelCount": "{count} models · {providers} providers",
			"page.copy": "Copy",
			"page.copied": "Copied",
			"page.reveal": "Show",
			"page.hide": "Hide",
			"page.copyAll": "Copy all IDs",
			"page.allCopied": "Copied all {count}",
			"page.refresh": "Refresh",
			"page.loading": "Reading…",
			"page.unavailable": "The status route is unavailable; the plugin may be disabled",
			"page.retry": "Retry",
			"page.noModels": "This provider reports no models yet",
			"page.usage": "Client setup",
			"page.usageHint": "Point the base URL at the address above and name the model provider/model, for example {example}. Each provider adapter handles its own auth and upstream headers.",
			"page.copyCurl": "Copy example",
			"page.public": "Public address",
			"page.local": "Local address",
			"page.publicHint": "Clients that only accept a public link, such as Cursor, take this row; local clients take the one below.",
			"page.tunnel": "Tunnel",
			"page.tunnelIdle": "Not started",
			"page.tunnelStarting": "Starting…",
			"page.tunnelRunning": "Connected",
			"page.tunnelFailed": "Failed",
			"page.tunnelStopped": "Stopped",
			"page.tunnelUnconfigured": "Not configured",
			"page.tunnelStart": "Start",
			"page.tunnelStop": "Stop",
			"page.tunnelHint": "The plugin spawns the tunnel itself and closes it when DSH exits. You can also open one externally and put its address in the config.",
			"page.tunnelProvider": "Method",
			"page.tunnelSignup": "Create an ngrok account",
			"page.tunnelToken": "Get an authtoken",
			"page.alias": "Model routes",
			"page.aliasHint": "Short names for external clients, mapped to provider/model. Multiple targets are allowed, one per line: when an earlier one is unavailable (quota spent, rate limited, timed out, 5xx) the next one answers, and the failed target cools down for 5 minutes. This is how Cursor's gpt-4o gets routed; a model whose name collides must go through a route.",
			"page.aliasName": "Route name",
			"page.aliasTarget": "Target provider/model (one per line, tried in order)",
			"page.aliasAdd": "Add",
			"page.aliasSave": "Save",
			"page.aliasSaved": "Routes saved",
			"page.aliasBad": "That route name or target is malformed (targets are provider/model, one per line)",
			"page.aliasEmpty": "No routes yet",
			"page.aliasRemove": "Remove",
			"page.aliasCooling": "Cooling down",
			"page.aria": "Model gateway",
			"panel.empty": "No models",
			"stat.requests": "Requests",
			"stat.failed": "{count} failed",
			"stat.models": "Models",
			"stat.providers": "{count} providers",
			"stat.tokens": "Tokens",
			"stat.tokenHint": "in {input} · out {output}",
			"stat.traffic": "Traffic",
			"stat.trafficHint": "rx {input} · tx {output}",
			"stat.uptime": "Uptime",
			"stat.since": "since {time}",
			"stat.noData": "Not counted by this host",
			"search.label": "Search models",
			"search.placeholder": "Filter by ID, name, or provider",
			"search.empty": "No matching model",
			"recent.title": "Recent requests",
			"recent.time": "Time",
			"recent.model": "Model",
			"recent.result": "Result",
			"recent.tokens": "Tokens",
			"recent.took": "Took",
			"recent.ok": "ok",
			"recent.failed": "failed",
			"recent.empty": "No requests recorded yet",
			"recent.window": "last {count} kept",
			"tab.overview": "Overview",
			"tab.routes": "Routes",
			"tab.tunnel": "Tunnel",
			"tab.catalog": "Catalogue",
			"tab.settings": "Settings",
			"routes.name": "Route",
			"routes.chain": "Try order",
			"routes.health": "Health",
			"routes.count": "{count} routes",
			"routes.healthy": "All available",
			"routes.bench": "{count} cooling",
			"routes.fallback": "fallback",
			"routes.primary": "primary",
			"routes.add": "Add route",
			"routes.edit": "Edit",
			"routes.addTitle": "Add a route",
			"routes.editTitle": "Edit route",
			"routes.close": "Close",
			"routes.cancel": "Cancel",
			"routes.confirm": "Save route",
			"routes.nameLabel": "Route name",
			"routes.nameHint": "the model a client asks for",
			"routes.available": "Available models",
			"routes.tryOrder": "Try order",
			"routes.searchHint": "Search by id, name, or provider",
			"routes.allProviders": "All {count}",
			"routes.pickAll": "Select all",
			"routes.pickNone": "Clear all",
			"routes.groupPicked": "{count} picked",
			"routes.usedBy": "used by {alias}",
			"routes.targetCount": "{count} targets",
			"routes.noTargets": "No targets yet",
			"routes.noTargetsHint": "Tick on the left; the tick order becomes the fallback order.",
			"routes.noMatch": "No matching model",
			"routes.noMatchHint": "Try another keyword, or click “All” to clear the provider filter.",
			"routes.primaryHint": "primary, serves directly",
			"routes.fallbackHint": "fallback #{index}",
			"routes.orderHint": "The order is the fallback order: the first target serves, the rest step up. Drag or use ↑ ↓ to reorder.",
			"routes.needTarget": "Pick at least one target to save",
			"routes.needName": "A route name is still needed",
			"routes.summary": "{name} → {count} targets, tried in order",
			"routes.dragHint": "Drag to reorder",
			"routes.moveUp": "Move up",
			"routes.moveDown": "Move down",
			"routes.removeTarget": "Remove",
			"cool.title": "Cooling down",
			"cool.summary": "{count} targets are benched; the next recovers in {seconds}s. Requests skip them instead of failing once first.",
			"cool.none": "Every target is available",
			"tunnel.title": "Public tunnel",
			"tunnel.sub": "Expose the local gateway on a public address for clients that only accept a link.",
			"tunnel.heroRunning": "Public address",
			"tunnel.heroDown": "Not open yet",
			"tunnel.heroDownHint": "Once started, a copyable public address appears here.",
			"tunnel.noUrl": "Tunnel not open",
			"tunnel.pid": "pid {pid}",
			"tunnel.autostart": "Start with DSH",
			"tunnel.autostartOn": "On",
			"tunnel.autostartOff": "Off",
			"tunnel.autostartHint": "Set by tunnel.autostart in the plugin config; change it in the DSH config, there is no switch here.",
			"tunnel.providerTitle": "Tunnel method",
			"tunnel.providerHint": "Pick a method, then start the tunnel. Switching while it runs needs a restart.",
			"tunnel.restart": "Restart with {provider}",
			"tunnel.restartHint": "The tunnel currently uses {current}; switching drops the public address briefly.",
			"tunnel.ngrokDesc": "Needs an authtoken; the free tier changes domain on restart",
			"tunnel.cloudflaredDesc": "No account; random, shorter domain",
			"tunnel.credTitle": "This method still needs a credential",
			"tunnel.credBody": "ngrok needs an account and an authtoken: sign up, copy the token from the dashboard, run {cmd}, then come back and start the tunnel.",
			"settings.title": "Access settings",
			"settings.sub": "Addresses, key, and port; changes apply at once.",
			"settings.endpoints": "Endpoints",
			"settings.endpointsSub": "External clients take the public address; local clients take the local one.",
			"settings.localSub": "Same gateway as the public address, reachable only from this machine.",
			"settings.key": "Key",
			"settings.keySub": "Regenerating invalidates the old key at once, so update every configured client.",
			"settings.port": "Listen port",
			"settings.portSub": "The gateway owns this port; it is unrelated to the UI port.",
			"settings.example": "Request example",
			"settings.exampleSub": "Replace {key} with the key above and it runs as-is.",
		};
		//#endregion

		//#region styles
		/**
		 * Local spacing scale plus the host's own tokens. The scale is a plain
		 * number ladder, so padding stays consistent across the page; everything
		 * visible — colour, border, radius, shadow, type — comes from `--dsw-*`
		 * so light and dark themes both work untouched.
		 *
		 * No literal colours: a hex here would freeze the page in one theme.
		 * `tests/style-tokens.spec.mjs` fails the build if one appears.
		 */
		const CSS = `
[${STYLE_ATTR}] {
	/* The spacing ladder. Declared on the scope attribute itself, not on
	   .gw-page: the route editor is portalled to document.body, which is outside
	   .gw-page, so anything declared there resolves to nothing inside the dialog
	   and every var() padding collapses to 0. The scrim carries this attribute
	   itself, so declaring here reaches both the page and the portal. */
	--gw-s1: 4px; --gw-s2: 8px; --gw-s3: 12px; --gw-s4: 16px; --gw-s5: 24px; --gw-s6: 32px;
	/* Control-height ladder. One height per role instead of a height per
	   component, so a row of mixed controls lines up by construction. */
	--gw-ctl-h: 28px; --gw-ctl-h-sm: 24px; --gw-ctl-h-xs: 22px;
	display: block; height: 100%; overflow: auto;
}
[${STYLE_ATTR}] * { box-sizing: border-box; }
[${STYLE_ATTR}] .gw-page {
	max-width: 1040px; margin: 0 auto; padding: 0 var(--gw-s5) 56px;
	color: var(--dsw-alias-label-primary);
	font: var(--dsw-font-xs-13);
}

/* ---- sticky header ---- */
[${STYLE_ATTR}] .gw-head {
	position: sticky; top: 0; z-index: 2;
	display: flex; align-items: flex-start; justify-content: space-between; gap: var(--gw-s4);
	margin: 0 calc(var(--gw-s5) * -1) var(--gw-s4);
	padding: var(--gw-s4) var(--gw-s5);
	background: var(--dsw-alias-bg-base);
	border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[${STYLE_ATTR}] .gw-brand { display: flex; align-items: center; gap: var(--gw-s3); min-width: 0; }
[${STYLE_ATTR}] .gw-logo {
	width: 34px; height: 34px; flex: none;
	display: inline-flex; align-items: center; justify-content: center;
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-state-business-tertiary);
	color: var(--dsw-alias-state-business-primary);
	font-weight: 700; font-size: 15px;
}
[${STYLE_ATTR}] .gw-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
[${STYLE_ATTR}] .gw-title { margin: 0; font: var(--dsw-font-s-14); font-weight: 600; line-height: 1.35; }
[${STYLE_ATTR}] .gw-sub { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.45; }
[${STYLE_ATTR}] .gw-head-actions { display: flex; align-items: center; gap: var(--gw-s2); flex: none; }

/* ---- status pill ---- */
[${STYLE_ATTR}] .gw-pill {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 3px 10px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l2);
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
[${STYLE_ATTR}] .gw-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }

/* ---- buttons ----
   Heights come from the --gw-ctl-* ladder rather than from padding, so a button
   beside an input or a chip is the same height by construction instead of by
   arithmetic that drifts with font metrics. */
[${STYLE_ATTR}] .gw-btn {
	appearance: none; cursor: pointer; font: inherit; font-size: 12px;
	display: inline-flex; align-items: center; justify-content: center;
	height: var(--gw-ctl-h); padding: 0 12px;
	border-radius: var(--dsw-radius-sm);
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
	background: var(--dsw-alias-state-business-primary);
	color: var(--dsw-alias-label-primary-foreground);
}
[${STYLE_ATTR}] .gw-btn.is-primary:hover { background: var(--dsw-alias-state-business-primary); opacity: .88; }
[${STYLE_ATTR}] .gw-btn.is-quiet {
	border-color: transparent; background: transparent;
	color: var(--dsw-alias-state-business-primary);
}
[${STYLE_ATTR}] .gw-btn.is-quiet:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-btn.is-danger { color: var(--dsw-alias-state-error-primary); border-color: transparent; background: transparent; }
[${STYLE_ATTR}] .gw-btn.is-danger:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-btn.is-sm { height: var(--gw-ctl-h-sm); padding: 0 10px; font-size: 11.5px; }

/* ---- tab bar: a segmented control, one panel per tab ---- */
[${STYLE_ATTR}] .gw-tabs {
	display: flex; gap: 4px; padding: 4px;
	margin-bottom: var(--gw-s4);
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: var(--dsw-radius-md);
	background: var(--dsw-alias-bg-layer-2);
}
[${STYLE_ATTR}] .gw-tab {
	appearance: none; font: inherit; cursor: pointer; flex: 1 1 0;
	display: inline-flex; align-items: center; justify-content: center; gap: 6px;
	height: var(--gw-ctl-h); padding: 0 8px;
	border: 0; border-radius: var(--dsw-radius-sm);
	background: transparent;
	color: var(--dsw-alias-label-tertiary);
	font-size: 12.5px; font-weight: 500;
	white-space: nowrap;
	transition: color .15s ease, background .15s ease;
}
[${STYLE_ATTR}] .gw-tab:hover { color: var(--dsw-alias-label-primary); }
[${STYLE_ATTR}] .gw-tab:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: -1px; }
[${STYLE_ATTR}] .gw-tab.is-active {
	color: var(--dsw-alias-label-primary);
	background: var(--dsw-alias-bg-layer-1);
	box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2);
}
[${STYLE_ATTR}] .gw-tab-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-caption); }
[${STYLE_ATTR}] .gw-tab-dot.is-ok { background: var(--dsw-alias-state-success-primary); }
[${STYLE_ATTR}] .gw-tab-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }
[${STYLE_ATTR}] .gw-tab-dot.is-bad { background: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTR}] .gw-tab-dot.is-brand { background: var(--dsw-alias-state-business-primary); }
[${STYLE_ATTR}] .gw-tab-n {
	font-size: 11px; font-weight: 600;
	padding: 0 6px; border-radius: 999px;
	background: var(--dsw-alias-bg-layer-3);
	color: var(--dsw-alias-label-secondary);
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-tab-n.is-warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }

/* ---- panels: all stay mounted so a hidden tab keeps its state, but only the
   active one is laid out. display:none also takes it out of the a11y tree. */
[${STYLE_ATTR}] .gw-panel { display: none; flex-direction: column; gap: var(--gw-s3); }
[${STYLE_ATTR}] .gw-panel.is-active { display: flex; }

/* ---- cards and section heads ---- */
[${STYLE_ATTR}] .gw-card {
	min-width: 0;
	padding: var(--gw-s3) var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
}
[${STYLE_ATTR}] .gw-sec { display: flex; flex-direction: column; gap: var(--gw-s3); }
[${STYLE_ATTR}] .gw-sec-head {
	display: flex; align-items: flex-start; justify-content: space-between;
	gap: var(--gw-s3); flex-wrap: wrap;
}
[${STYLE_ATTR}] .gw-sec-titles { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
[${STYLE_ATTR}] .gw-sec-title {
	margin: 0; display: inline-flex; align-items: center; gap: var(--gw-s2);
	font: var(--dsw-font-s-14); font-weight: 600; line-height: 1.35;
}
[${STYLE_ATTR}] .gw-sec-sub { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.55; }
[${STYLE_ATTR}] .gw-sec-side { display: flex; align-items: center; gap: var(--gw-s2); flex-wrap: wrap; }
[${STYLE_ATTR}] .gw-tag {
	display: inline-flex; align-items: center; gap: 4px;
	padding: 1px 8px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
	font-size: 11px; font-weight: 500;
}

/* ---- the tunnel status bar on the overview tab ---- */
[${STYLE_ATTR}] .gw-bar {
	display: flex; align-items: center; gap: var(--gw-s3);
	padding: 11px var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
}
[${STYLE_ATTR}] .gw-bar-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
[${STYLE_ATTR}] .gw-bar-name { font-size: 13px; font-weight: 600; }
[${STYLE_ATTR}] .gw-bar-meta {
	color: var(--dsw-alias-label-tertiary); font-size: 12px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---- the cooling callout: only rendered when something is benched ---- */
[${STYLE_ATTR}] .gw-cool {
	display: flex; align-items: flex-start; gap: var(--gw-s2);
	padding: 10px var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-state-warn-primary);
	background: var(--dsw-alias-state-warn-tertiary);
	color: var(--dsw-alias-label-primary);
	font-size: 12px; line-height: 1.65;
}
[${STYLE_ATTR}] .gw-cool-ico { color: var(--dsw-alias-state-warn-label); flex: none; font-weight: 700; }
[${STYLE_ATTR}] .gw-cool b { font-variant-numeric: tabular-nums; }
[${STYLE_ATTR}] .gw-cool code {
	font-family: var(--dsw-font-mono); font-size: 11.5px;
	background: var(--dsw-alias-bg-layer-1); padding: 0 4px; border-radius: var(--dsw-radius-xs);
}

/* ---- metric tiles ---- */
[${STYLE_ATTR}] .gw-stats {
	display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
	gap: var(--gw-s2);
}
[${STYLE_ATTR}] .gw-stat {
	display: flex; flex-direction: column; gap: 1px; min-width: 0;
	padding: 9px var(--gw-s3);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
}
[${STYLE_ATTR}] .gw-stat-value {
	font-size: 19px; font-weight: 600; line-height: 1.25;
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-stat-label { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
[${STYLE_ATTR}] .gw-stat-hint {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---- tables ---- */
[${STYLE_ATTR}] .gw-table {
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	overflow: hidden;
}
[${STYLE_ATTR}] .gw-trow {
	display: grid; align-items: center; gap: var(--gw-s3);
	padding: var(--gw-s2) var(--gw-s4);
	font-size: 12px;
}
[${STYLE_ATTR}] .gw-trow + .gw-trow { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-thead {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	background: var(--dsw-alias-bg-layer-2);
	border-bottom: 1px solid var(--dsw-alias-border-l2);
}
[${STYLE_ATTR}] .gw-tbody > .gw-trow:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-tcell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${STYLE_ATTR}] .gw-tnum { font-variant-numeric: tabular-nums; }
[${STYLE_ATTR}] .gw-mono { font-family: var(--dsw-font-mono); }

/* recent-request grid */
[${STYLE_ATTR}] .gw-grid-recent { grid-template-columns: 72px minmax(0, 1.6fr) 96px 104px 64px; }

/* route grid: name / chain / health / actions */
[${STYLE_ATTR}] .gw-grid-route { grid-template-columns: 150px minmax(0, 1fr) 106px 116px; }
/* A route row is as tall as its chain, so centring its cells would strand the
   name and the health badge halfway down a nine-target row while the actions
   sat at the top. Every cell starts at the first hop instead. */
[${STYLE_ATTR}] .gw-tbody > .gw-grid-route { align-items: start; }
[${STYLE_ATTR}] .gw-tbody > .gw-grid-route > .gw-tcell { padding-top: 2px; }

/* ---- route rows ---- */
[${STYLE_ATTR}] .gw-route-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
[${STYLE_ATTR}] .gw-route-name code {
	font-family: var(--dsw-font-mono); font-size: 12px; font-weight: 600;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-route-name small { color: var(--dsw-alias-label-caption); font-size: 11px; }
/* The row actions sit side by side and stay on the row's optical centre. Without
   an explicit flex they stack as block boxes, which pushed 编辑 and 删除 onto two
   lines and made the last column look detached from the row it belongs to.
   The row is top-aligned (see .gw-grid-route), so the buttons line up with the
   first hop without needing a nudge. */
[${STYLE_ATTR}] .gw-row-actions {
	display: flex; align-items: center; gap: var(--gw-s2);
	flex-wrap: nowrap; justify-content: flex-end;
}
[${STYLE_ATTR}] .gw-chain { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
[${STYLE_ATTR}] .gw-hop { display: flex; align-items: center; gap: 6px; min-width: 0; }
[${STYLE_ATTR}] .gw-hop-idx {
	width: 15px; height: 15px; flex: none;
	display: inline-flex; align-items: center; justify-content: center;
	border-radius: 50%; font-size: 10px; font-weight: 600;
	border: 1px solid var(--dsw-alias-border-l3);
	color: var(--dsw-alias-label-tertiary);
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-hop-idx.is-first {
	border-color: transparent;
	background: var(--dsw-alias-state-business-primary);
	color: var(--dsw-alias-label-primary-foreground);
}
[${STYLE_ATTR}] .gw-hop-id {
	flex: 1 1 auto; min-width: 0;
	font-family: var(--dsw-font-mono); font-size: 11.5px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-hop.is-cooling .gw-hop-id {
	color: var(--dsw-alias-label-caption);
	text-decoration: line-through;
	text-decoration-color: var(--dsw-alias-state-error-primary);
}
[${STYLE_ATTR}] .gw-hop-side { flex: none; display: inline-flex; align-items: center; gap: 5px; }
[${STYLE_ATTR}] .gw-meter {
	display: inline-block; width: 38px; height: 3px; flex: none;
	border-radius: 999px; overflow: hidden;
	background: var(--dsw-alias-bg-layer-3);
}
[${STYLE_ATTR}] .gw-meter > i { display: block; height: 100%; background: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTR}] .gw-hop-eta {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	font-variant-numeric: tabular-nums; min-width: 34px; text-align: right;
}

/* ---- badges ---- */
[${STYLE_ATTR}] .gw-badge {
	display: inline-flex; align-items: center; gap: 4px;
	padding: 1px 8px; border-radius: 999px;
	border: 1px solid transparent;
	background: var(--dsw-alias-bg-layer-2);
	font-size: 11px; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-badge-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: currentColor; }
[${STYLE_ATTR}] .gw-badge.is-ok {
	color: var(--dsw-alias-state-success-primary);
	border-color: var(--dsw-alias-state-success-secondary);
	background: var(--dsw-alias-state-success-tertiary);
}
[${STYLE_ATTR}] .gw-badge.is-bad {
	color: var(--dsw-alias-state-error-primary);
	border-color: var(--dsw-alias-state-error-primary);
}
[${STYLE_ATTR}] .gw-badge.is-warn {
	color: var(--dsw-alias-state-warn-label);
	border-color: var(--dsw-alias-state-warn-primary);
	background: var(--dsw-alias-state-warn-tertiary);
}
[${STYLE_ATTR}] .gw-badge.is-idle {
	color: var(--dsw-alias-label-tertiary);
	border-color: var(--dsw-alias-border-l2);
}
[${STYLE_ATTR}] .gw-badge.is-brand {
	color: var(--dsw-alias-state-business-primary);
	border-color: var(--dsw-alias-state-business-primary);
	background: var(--dsw-alias-state-business-tertiary);
}

/* ---- forms ---- */
[${STYLE_ATTR}] .gw-input {
	font: inherit; font-size: 12px; min-width: 0;
	/* Same height as .gw-btn, so a button beside a field is level. */
	height: var(--gw-ctl-h); padding: 0 10px;
	border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-input::placeholder { color: var(--dsw-alias-label-caption); }
[${STYLE_ATTR}] .gw-input:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 1px; }

/* ---- key/value rows ---- */
[${STYLE_ATTR}] .gw-kv {
	display: flex; align-items: center; justify-content: space-between;
	gap: var(--gw-s3); padding: 9px 0;
	/* Wrapping is what keeps an address whole: the control refuses to shrink,
	   so a row too narrow for both halves drops the control onto its own line
	   instead of clipping the string people are trying to copy. */
	flex-wrap: wrap;
}
[${STYLE_ATTR}] .gw-kv + .gw-kv { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-kv-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
[${STYLE_ATTR}] .gw-kv-copy b { font-size: 12.5px; font-weight: 600; }
[${STYLE_ATTR}] .gw-kv-copy small { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
[${STYLE_ATTR}] .gw-kv-ctl {
	display: flex; align-items: center; gap: 6px;
	flex: 1 0 auto; min-width: 0; max-width: 100%;
	justify-content: flex-end;
}
/* The address is the thing people copy, so it must not shrink to make room for
   its own label. Keeping it at its natural width lets the copy text on the left
   give way instead, and that is the part that still reads when truncated. */
[${STYLE_ATTR}] .gw-kv-value {
	font-family: var(--dsw-font-mono); font-size: 12px;
	color: var(--dsw-alias-label-secondary);
	flex: none; max-width: 100%;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* A control inside a value row keeps its own size: the port field was being
   squeezed to a single visible digit by the flex row around it. */
[${STYLE_ATTR}] .gw-kv-ctl .gw-input { flex: none; }

/* ---- tunnel hero ---- */
[${STYLE_ATTR}] .gw-hero {
	display: flex; flex-direction: column; gap: 6px;
	padding: var(--gw-s3) var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-2);
}
[${STYLE_ATTR}] .gw-hero.is-down {
	border-color: var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-layer-1);
}
[${STYLE_ATTR}] .gw-hero-top { display: flex; align-items: center; gap: var(--gw-s2); }
[${STYLE_ATTR}] .gw-hero-label {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	text-transform: uppercase; letter-spacing: .04em;
}
[${STYLE_ATTR}] .gw-hero-url {
	font-family: var(--dsw-font-mono); font-size: 13.5px; font-weight: 600;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	user-select: all;
}
[${STYLE_ATTR}] .gw-hero-url.is-down { color: var(--dsw-alias-label-caption); font-weight: 400; }
[${STYLE_ATTR}] .gw-hero-meta {
	display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	color: var(--dsw-alias-label-caption); font-size: 11px;
}
[${STYLE_ATTR}] .gw-sep { color: var(--dsw-alias-border-l4); }

/* ---- the credential callout ---- */
[${STYLE_ATTR}] .gw-cred {
	display: flex; flex-direction: column; gap: var(--gw-s2);
	padding: var(--gw-s3) var(--gw-s4);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-state-warn-primary);
	background: var(--dsw-alias-state-warn-tertiary);
}
[${STYLE_ATTR}] .gw-cred-title {
	display: flex; align-items: center; gap: 6px;
	font-size: 12.5px; font-weight: 600;
	color: var(--dsw-alias-state-warn-label);
}
[${STYLE_ATTR}] .gw-cred-body { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-primary); }
[${STYLE_ATTR}] .gw-cred-body code {
	font-family: var(--dsw-font-mono); font-size: 11.5px;
	background: var(--dsw-alias-bg-layer-1); padding: 0 4px; border-radius: var(--dsw-radius-xs);
}
[${STYLE_ATTR}] .gw-cred-actions { display: flex; gap: var(--gw-s2); flex-wrap: wrap; }

/* ---- provider picker ---- */
[${STYLE_ATTR}] .gw-picks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gw-s2); }
[${STYLE_ATTR}] .gw-pick {
	appearance: none; font: inherit; cursor: pointer; text-align: left;
	display: flex; align-items: flex-start; gap: var(--gw-s2);
	padding: 10px var(--gw-s3);
	border-radius: var(--dsw-radius-md);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: inherit;
	transition: border-color .15s ease, background .15s ease;
}
[${STYLE_ATTR}] .gw-pick:hover { border-color: var(--dsw-alias-border-l4); }
[${STYLE_ATTR}] .gw-pick:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
[${STYLE_ATTR}] .gw-pick.is-on {
	border-color: var(--dsw-alias-state-business-primary);
	background: var(--dsw-alias-state-business-tertiary);
}
[${STYLE_ATTR}] .gw-pick-radio {
	width: 13px; height: 13px; flex: none; margin-top: 2px;
	border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l4);
	position: relative;
}
[${STYLE_ATTR}] .gw-pick.is-on .gw-pick-radio { border-color: var(--dsw-alias-state-business-primary); }
[${STYLE_ATTR}] .gw-pick.is-on .gw-pick-radio::after {
	content: ''; position: absolute; inset: 2px;
	border-radius: 50%; background: var(--dsw-alias-state-business-primary);
}
[${STYLE_ATTR}] .gw-pick-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
[${STYLE_ATTR}] .gw-pick-name { font-family: var(--dsw-font-mono); font-size: 12px; font-weight: 600; }
[${STYLE_ATTR}] .gw-pick-desc { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }

/* ---- catalogue ---- */
[${STYLE_ATTR}] .gw-search { display: flex; align-items: center; gap: var(--gw-s2); }
[${STYLE_ATTR}] .gw-search .gw-input { flex: 1 1 auto; }
[${STYLE_ATTR}] .gw-group { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-group:first-of-type { border-top: none; }
/* The summary and its rows share a left edge and a right edge: the caret column
   is the indent the rows sit behind, so the group name and the model ids read as
   one outline rather than two lists that happen to be adjacent. */
[${STYLE_ATTR}] .gw-group > summary {
	cursor: pointer; list-style: none;
	padding: var(--gw-s1) var(--gw-s2) var(--gw-s1) var(--gw-s2);
	display: flex; align-items: center; justify-content: space-between; gap: var(--gw-s3);
	min-height: 30px;
}
[${STYLE_ATTR}] .gw-group > summary::-webkit-details-marker { display: none; }
[${STYLE_ATTR}] .gw-group-name {
	display: flex; align-items: center; gap: 6px;
	min-width: 0; font-size: 12px; font-weight: 600;
}
[${STYLE_ATTR}] .gw-group-count { color: var(--dsw-alias-label-caption); font-weight: 400; font-size: 11px; font-variant-numeric: tabular-nums; }
[${STYLE_ATTR}] .gw-caret {
	display: inline-flex; align-items: center; justify-content: center;
	width: 14px; flex: none;
	color: var(--dsw-alias-label-caption); transition: transform .12s ease;
}
[${STYLE_ATTR}] .gw-group[open] .gw-caret { transform: rotate(90deg); }
[${STYLE_ATTR}] .gw-row {
	display: flex; align-items: center; gap: var(--gw-s3);
	/* 14px caret + 6px gap puts the id under the provider name, not under the
	   caret, which is what makes the outline legible at a glance. */
	padding: var(--gw-s1) var(--gw-s2) var(--gw-s1) 28px;
	border-radius: var(--dsw-radius-xs);
	min-height: 30px;
}
[${STYLE_ATTR}] .gw-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-row-id {
	flex: 1 1 auto; min-width: 0; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	font-family: var(--dsw-font-mono); font-size: 12px; user-select: all;
}
[${STYLE_ATTR}] .gw-row-name {
	flex: 0 1 auto; max-width: 38%; overflow: hidden;
	text-overflow: ellipsis; white-space: nowrap;
	color: var(--dsw-alias-label-caption); font-size: 11px;
}
[${STYLE_ATTR}] .gw-row-id.is-routed { color: var(--dsw-alias-state-business-primary); font-weight: 600; }

/* ---- notices, empty states, snippets ---- */
[${STYLE_ATTR}] .gw-notice { font-size: 12px; line-height: 1.6; }
[${STYLE_ATTR}] .gw-notice.is-ok { color: var(--dsw-alias-state-success-primary); }
[${STYLE_ATTR}] .gw-notice.is-bad { color: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTR}] .gw-notice.is-warn { color: var(--dsw-alias-state-warn-label); }
[${STYLE_ATTR}] .gw-empty {
	padding: var(--gw-s4) 0;
	color: var(--dsw-alias-label-tertiary); font-size: 12px;
	text-align: center; line-height: 1.7;
}
[${STYLE_ATTR}] .gw-snippet {
	display: block;
	white-space: pre-wrap; word-break: break-all;
	font-family: var(--dsw-font-mono); font-size: 12px; user-select: all;
	padding: var(--gw-s3);
	border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-icon { display: inline-flex; align-items: center; justify-content: center; }

/* ---- route editor: a modal that picks targets instead of typing them ----
   The old form asked for a provider/model pair one line at a time. With 152
   models across 24 providers that meant copying ids out of the catalogue tab by
   hand and getting the order right in a textarea. This is a searchable,
   grouped, ordered picker: tick on the left, reorder on the right, save once.

   The scrim is portalled to document.body, so it carries the scope attribute
   itself rather than inheriting it from the page. That is why the rule below is
   attr.gw-scrim instead of attr .gw-scrim: the scrim is the root of its own
   subtree. The generic attr rule would give it height 100% and overflow auto,
   which fights position fixed, so both are reset here. */
[${STYLE_ATTR}].gw-scrim {
	position: fixed; inset: 0; z-index: 60;
	display: flex; align-items: center; justify-content: center;
	height: auto; overflow: visible;
	/* Breathing room around the dialog. 32px top and bottom means a tall dialog
	   never touches the viewport edge, which is what makes it read as a sheet
	   floating over the page rather than a full-screen replacement. */
	padding: var(--gw-s6);
	background: var(--dsw-alias-bg-mask-1);
}
[${STYLE_ATTR}] .gw-modal {
	display: flex; flex-direction: column;
	/* 860 leaves each picker pane ~408px, which is the width a 40-character
	   provider/model id needs beside its display name. The slot itself is
	   ~1000px, so the dialog still sits comfortably inside it. */
	width: 860px; max-width: 100%; max-height: 100%;
	min-height: 0;
	border-radius: var(--dsw-radius-lg);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	box-shadow: var(--dsw-shadow-lv3);
	color: var(--dsw-alias-label-primary);
	font: var(--dsw-font-xs-13);
	/* Clips the head and foot backgrounds to the rounded corners, so neither
	   needs its own matching radius. */
	overflow: hidden;
}
[${STYLE_ATTR}] .gw-modal-head {
	display: flex; align-items: center; justify-content: space-between; gap: var(--gw-s3);
	flex: none;
	padding: var(--gw-s3) var(--gw-s5);
	border-bottom: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
}
[${STYLE_ATTR}] .gw-modal-title { font: var(--dsw-font-s-14); font-weight: 600; }
[${STYLE_ATTR}] .gw-modal-body {
	display: flex; flex-direction: column; gap: var(--gw-s4);
	min-height: 0; overflow-y: auto;
	/* The dialog's own gutter. The head and foot use the same 24px so the title,
	   the panes, and the footer buttons all hang off one vertical line. */
	padding: var(--gw-s4) var(--gw-s5);
}
[${STYLE_ATTR}] .gw-modal-foot {
	display: flex; align-items: center; justify-content: space-between; gap: var(--gw-s4);
	flex: none;
	padding: var(--gw-s3) var(--gw-s5);
	border-top: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
}
[${STYLE_ATTR}] .gw-modal-note {
	min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-modal-actions { display: flex; align-items: center; gap: var(--gw-s2); flex: none; }
/* The two decision buttons are the primary pair on the surface, so they get one
   step more presence than the header's quiet close link. */
[${STYLE_ATTR}] .gw-modal-actions .gw-btn { padding: 0 16px; }

/* Two panes side by side; stretched so the shorter one does not leave a hole. */
[${STYLE_ATTR}] .gw-pick-grid {
	display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: var(--gw-s3); align-items: stretch; min-height: 0;
}
[${STYLE_ATTR}] .gw-pane {
	display: flex; flex-direction: column; min-width: 0; min-height: 0;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: var(--dsw-radius-sm);
	background: var(--dsw-alias-bg-layer-1);
	overflow: hidden;
}
[${STYLE_ATTR}] .gw-pane-head {
	display: flex; align-items: center; justify-content: space-between; gap: var(--gw-s2);
	flex: none;
	padding: 0 var(--gw-s3);
	height: 34px;
	border-bottom: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
	font-size: 11.5px; font-weight: 600;
}
[${STYLE_ATTR}] .gw-pane-count {
	font-weight: 400; color: var(--dsw-alias-label-caption);
	font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-pane-tools {
	display: flex; flex-direction: column; gap: var(--gw-s2);
	flex: none; padding: var(--gw-s2) var(--gw-s3);
	border-bottom: 1px solid var(--dsw-alias-border-l1);
}
[${STYLE_ATTR}] .gw-pane-tools .gw-input { width: 100%; }
[${STYLE_ATTR}] .gw-chips { display: flex; flex-wrap: wrap; gap: var(--gw-s1); }
[${STYLE_ATTR}] .gw-chip {
	appearance: none; cursor: pointer; font: inherit; font-size: 11px;
	display: inline-flex; align-items: center;
	height: var(--gw-ctl-h-xs); padding: 0 9px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-tertiary);
	white-space: nowrap;
	transition: background .12s ease, border-color .12s ease;
}
[${STYLE_ATTR}] .gw-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-chip.is-on {
	border-color: var(--dsw-alias-state-business-primary);
	background: var(--dsw-alias-state-business-tertiary);
	color: var(--dsw-alias-state-business-primary);
}
[${STYLE_ATTR}] .gw-chip:focus-visible {
	outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
	outline-offset: 1px;
}

/* The scrolling list. A bounded height keeps the modal from jumping as the
   filter narrows; flex-grow lets it fill whatever the modal has. */
[${STYLE_ATTR}] .gw-pick-list {
	flex: 1 1 auto; min-height: 190px; max-height: 340px;
	overflow-y: auto; overscroll-behavior: contain;
}
[${STYLE_ATTR}] .gw-pick-group + .gw-pick-group { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-pick-group-head {
	position: sticky; top: 0; z-index: 1;
	display: flex; align-items: center; gap: var(--gw-s2);
	width: 100%; box-sizing: border-box;
	height: 28px; padding: 0 var(--gw-s3);
	border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
	background: var(--dsw-alias-bg-layer-2);
	color: inherit; font: inherit; font-size: 11px; font-weight: 600;
	text-align: left; cursor: pointer; user-select: none;
}
[${STYLE_ATTR}] .gw-pick-group-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-pick-caret {
	color: var(--dsw-alias-label-caption); flex: none;
	display: inline-flex; transition: transform .12s ease;
}
[${STYLE_ATTR}] .gw-pick-group.is-open .gw-pick-caret { transform: rotate(90deg); }
[${STYLE_ATTR}] .gw-pick-group-count {
	flex: none; color: var(--dsw-alias-label-caption);
	font-weight: 400; font-variant-numeric: tabular-nums;
}
[${STYLE_ATTR}] .gw-pick-group-sel {
	flex: none; margin-left: auto;
	color: var(--dsw-alias-state-business-primary); font-weight: 500;
}
[${STYLE_ATTR}] .gw-pick-all {
	flex: none; margin-left: auto;
	appearance: none; cursor: pointer; font: inherit;
	font-size: 10.5px; font-weight: 500;
	display: inline-flex; align-items: center;
	height: 18px; padding: 0 7px; border-radius: var(--dsw-radius-xs);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-tertiary);
}
[${STYLE_ATTR}] .gw-pick-group-sel + .gw-pick-all { margin-left: var(--gw-s2); }
[${STYLE_ATTR}] .gw-pick-all:hover {
	color: var(--dsw-alias-state-business-primary);
	border-color: var(--dsw-alias-state-business-primary);
}
[${STYLE_ATTR}] .gw-pick-rows { display: none; }
[${STYLE_ATTR}] .gw-pick-group.is-open .gw-pick-rows { display: block; }

/* One selectable model. The whole row is the hit target, so a mis-click on the
   name still toggles it instead of doing nothing. */
[${STYLE_ATTR}] .gw-opt {
	display: flex; align-items: center; gap: var(--gw-s2);
	width: 100%; box-sizing: border-box;
	min-width: 0; padding: 6px var(--gw-s3);
	border: 0; background: transparent;
	color: inherit; font: inherit; text-align: left; cursor: pointer;
}
[${STYLE_ATTR}] .gw-opt:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${STYLE_ATTR}] .gw-opt.is-on { background: var(--dsw-alias-state-business-tertiary); }
[${STYLE_ATTR}] .gw-opt-box {
	flex: none; width: 14px; height: 14px;
	display: grid; place-items: center;
	border-radius: var(--dsw-radius-xs);
	border: 1px solid var(--dsw-alias-border-l4);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary-foreground);
}
[${STYLE_ATTR}] .gw-opt.is-on .gw-opt-box {
	border-color: var(--dsw-alias-state-business-primary);
	background: var(--dsw-alias-state-business-primary);
}
[${STYLE_ATTR}] .gw-opt-id {
	flex: 1 1 auto; min-width: 0;
	font-family: var(--dsw-font-mono); font-size: 12px;
	/* The catalogue's longest id runs 65 characters, which does not fit the
	   pane at any sane dialog width. Wrapping costs one extra line on a handful
	   of rows and keeps the discriminating tail visible; an ellipsis would hide
	   exactly the part that tells two siblings apart. */
	overflow-wrap: anywhere; word-break: break-word; line-height: 1.4;
}
/* The display name is the first thing to give up space: it is decorative for
   most providers, while the id is what has to be recognised. */
[${STYLE_ATTR}] .gw-opt-name {
	flex: 0 1 auto; max-width: 34%; min-width: 0;
	color: var(--dsw-alias-label-caption); font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-opt-flag {
	flex: none; font-size: 10.5px;
	padding: 0 6px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l2);
	color: var(--dsw-alias-label-caption);
	white-space: nowrap;
}
[${STYLE_ATTR}] .gw-opt-flag.is-used {
	color: var(--dsw-alias-state-warn-label);
	border-color: var(--dsw-alias-state-warn-primary);
	background: var(--dsw-alias-state-warn-tertiary);
}
[${STYLE_ATTR}] .gw-opt-hit {
	border-radius: var(--dsw-radius-xs);
	background: var(--dsw-alias-state-business-tertiary);
	color: var(--dsw-alias-state-business-primary);
}

/* The chosen chain: numbered, reorderable, removable. */
[${STYLE_ATTR}] .gw-chain-list {
	flex: 1 1 auto; min-height: 120px; max-height: 340px;
	overflow-y: auto; overscroll-behavior: contain;
}
[${STYLE_ATTR}] .gw-chain-item {
	display: flex; align-items: center; gap: var(--gw-s2);
	min-width: 0; padding: var(--gw-s2) var(--gw-s3);
}
[${STYLE_ATTR}] .gw-chain-item + .gw-chain-item { border-top: 1px solid var(--dsw-alias-border-l1); }
[${STYLE_ATTR}] .gw-chain-item.is-dragging { opacity: .4; }
[${STYLE_ATTR}] .gw-chain-item.is-before { box-shadow: inset 0 2px 0 var(--dsw-alias-state-business-primary); }
[${STYLE_ATTR}] .gw-chain-item.is-after { box-shadow: inset 0 -2px 0 var(--dsw-alias-state-business-primary); }
[${STYLE_ATTR}] .gw-chain-grip {
	flex: none; cursor: grab;
	color: var(--dsw-alias-label-caption);
	display: inline-flex; align-items: center;
}
[${STYLE_ATTR}] .gw-chain-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
[${STYLE_ATTR}] .gw-chain-id {
	font-family: var(--dsw-font-mono); font-size: 12px;
	/* Model ids run past 60 characters, and the chain column is only half the
	   dialog. Wrapping beats an ellipsis here: the whole point of the row is to
	   show which model it is, and a truncated tail is exactly the part that
	   differs between two ids from the same provider. */
	overflow-wrap: anywhere; word-break: break-word; line-height: 1.45;
}
[${STYLE_ATTR}] .gw-chain-meta {
	color: var(--dsw-alias-label-caption); font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-chain-tools { display: flex; gap: var(--gw-s1); flex: none; }
[${STYLE_ATTR}] .gw-icon-btn {
	appearance: none; cursor: pointer; font: inherit; font-size: 11px;
	width: var(--gw-ctl-h-sm); height: var(--gw-ctl-h-sm); padding: 0;
	display: grid; place-items: center;
	border-radius: var(--dsw-radius-xs);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-1);
	color: var(--dsw-alias-label-tertiary);
}
[${STYLE_ATTR}] .gw-icon-btn:hover:not(:disabled) {
	background: var(--dsw-alias-interactive-bg-hover);
	color: var(--dsw-alias-label-primary);
}
[${STYLE_ATTR}] .gw-icon-btn:disabled { opacity: .35; cursor: default; }
[${STYLE_ATTR}] .gw-icon-btn.is-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
[${STYLE_ATTR}] .gw-icon-btn:focus-visible {
	outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
	outline-offset: 1px;
}
[${STYLE_ATTR}] .gw-chain-empty,
[${STYLE_ATTR}] .gw-pick-empty {
	padding: var(--gw-s6) var(--gw-s4);
	text-align: center; font-size: 12px; line-height: 1.7;
	color: var(--dsw-alias-label-tertiary);
}
[${STYLE_ATTR}] .gw-chain-empty b,
[${STYLE_ATTR}] .gw-pick-empty b {
	display: block; margin-bottom: var(--gw-s1);
	font-size: 12.5px; font-weight: 600;
	color: var(--dsw-alias-label-secondary);
}
[${STYLE_ATTR}] .gw-modal-hint {
	display: flex; align-items: flex-start; gap: var(--gw-s2);
	padding: var(--gw-s2) var(--gw-s3);
	border-radius: var(--dsw-radius-sm);
	border: 1px solid var(--dsw-alias-border-l2);
	background: var(--dsw-alias-bg-layer-2);
	color: var(--dsw-alias-label-secondary);
	font-size: 11.5px; line-height: 1.6;
}
[${STYLE_ATTR}] .gw-modal-hint .gw-icon { flex: none; margin-top: 2px; color: var(--dsw-alias-state-business-primary); }
[${STYLE_ATTR}] .gw-field { display: flex; flex-direction: column; gap: 6px; }
[${STYLE_ATTR}] .gw-field-label {
	display: flex; align-items: baseline; gap: var(--gw-s2);
	font-size: 12px; font-weight: 600;
}
[${STYLE_ATTR}] .gw-field-label span {
	font-weight: 400; color: var(--dsw-alias-label-caption);
}

@media (max-width: 900px) {
	[${STYLE_ATTR}] .gw-pick-grid { grid-template-columns: minmax(0, 1fr); }
	[${STYLE_ATTR}] .gw-modal { max-height: 100%; }
	[${STYLE_ATTR}] .gw-pick-list { max-height: 220px; }
	[${STYLE_ATTR}] .gw-chain-list { max-height: 180px; }
}

@media (max-width: 900px) {
	[${STYLE_ATTR}] .gw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	[${STYLE_ATTR}] .gw-picks { grid-template-columns: minmax(0, 1fr); }
	[${STYLE_ATTR}] .gw-grid-recent { grid-template-columns: 64px minmax(0, 1fr) 88px; }
	[${STYLE_ATTR}] .gw-grid-recent > :nth-child(4),
	[${STYLE_ATTR}] .gw-grid-recent > :nth-child(5) { display: none; }
	[${STYLE_ATTR}] .gw-grid-route { grid-template-columns: 118px minmax(0, 1fr) 90px 52px; }
	[${STYLE_ATTR}] .gw-kv { align-items: flex-start; flex-direction: column; }
	[${STYLE_ATTR}] .gw-kv-ctl { max-width: 100%; width: 100%; }
	/* Stacked, the row is free to wrap the address onto its own line rather than
	   clipping it behind an ellipsis. */
	[${STYLE_ATTR}] .gw-kv-value { flex: 1 1 auto; white-space: normal; overflow-wrap: anywhere; }
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
		/** The five tabs, in bar order. `key` doubles as the dictionary suffix. */
		const TABS = ["overview", "routes", "tunnel", "catalog", "settings"];

		/** A tunnel provider's one-line pitch, kept beside the picker. */
		const TUNNEL_PROVIDERS = ["ngrok", "cloudflared"];

		/* `react-dom` is a platform seed word in the DSH shell (its boot graph maps
		 * react, react/jsx-runtime, react-dom and react-dom/client), which is what
		 * lets a plugin put an overlay outside `#root` without a build step.
		 * Resolved defensively: an older shell, or the headless render harness,
		 * may not offer it, and the modal then renders in place instead. */
		let createPortal = null;
		try {
			const reactDom = require("react-dom");
			if (typeof reactDom?.createPortal === "function") createPortal = reactDom.createPortal;
		} catch {
			createPortal = null;
		}

		/* Small glyphs for the route editor. Drawn rather than typed so they line
		 * up with the text at any zoom, and stroked with `currentColor` so they
		 * follow the surrounding token instead of hard-coding a colour. */
		const checkIcon = () =>
			h(
				"svg",
				{ width: 10, height: 10, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
				h("path", { d: "M2.2 6.4 4.7 9 9.8 3.4" }),
			);

		const caretIcon = () =>
			h("svg", { width: 9, height: 9, viewBox: "0 0 10 10", fill: "currentColor", "aria-hidden": "true" }, h("path", { d: "M3 1.5 7 5l-4 3.5z" }));

		const gripIcon = () =>
			h(
				"svg",
				{ width: 9, height: 13, viewBox: "0 0 10 14", fill: "currentColor", "aria-hidden": "true" },
				...[3, 7, 11].flatMap((y) => [
					h("circle", { key: `a${y}`, cx: 3, cy: y, r: 1.1 }),
					h("circle", { key: `b${y}`, cx: 7, cy: y, r: 1.1 }),
				]),
			);

		const infoIcon = () =>
			h(
				"svg",
				{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "aria-hidden": "true" },
				h("circle", { cx: 8, cy: 8, r: 6.4 }),
				h("path", { d: "M8 7.2v4M8 5.1v.1" }),
			);

		function GatewayPage(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [status, setStatus] = useState(null);
			const [failed, setFailed] = useState(false);
			const [copied, setCopied] = useState("");
			const [revealed, setRevealed] = useState(false);
			const [portDraft, setPortDraft] = useState("");
			const [notice, setNotice] = useState(null);
			const [confirmKey, setConfirmKey] = useState(false);
			// `null` means "not edited yet": the table below is then read straight
			// from the status document. It is only set once the user commits an
			// edit, so a refresh never clobbers an in-progress one.
			const [aliasDraftRows, setAliasDraftRows] = useState(null);
			// The route editor. `null` closes it; an object means the modal is
			// open. Everything the picker needs lives here, so closing the modal
			// throws the in-progress selection away instead of leaving it to leak
			// into the next edit.
			//
			//   mode     "add" or "edit"      — drives the title and the save path
			//   original the alias being edited, or "" for a new one
			//   name     the draft alias name
			//   targets  the chosen chain, in try order
			//   query    the picker's search text
			//   provider "" for all, else a provider id
			//   open     providers expanded in the picker
			//   drag     the id being dragged, or null
			//   drop     { id, after } while dragging over a row
			const [editor, setEditor] = useState(null);
			const [busyTunnel, setBusyTunnel] = useState(false);
			const [query, setQuery] = useState("");
			// Which tab is open. Persisted so a refresh lands back where the user
			// was instead of on the overview every time.
			const [tab, setTab] = useState(() => {
				try {
					const saved = window.localStorage.getItem("gw-tab");
					return TABS.includes(saved) ? saved : "overview";
				} catch {
					return "overview";
				}
			});
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

			// A countdown has to tick on its own: the status document is only read
			// on demand, so without this the remaining seconds would freeze at
			// whatever the last read said. One timer, only while something cools.
			const [tick, setTick] = useState(0);
			useEffect(() => {
				const timer = setInterval(() => setTick((value) => value + 1), 1000);
				return () => clearInterval(timer);
			}, []);
			void tick;

			const isOn = status !== null && status.enabled === true;

			// The alias table is server state; `aliasDraftRows` only exists once
			// the user edits it, so the first render already shows what the host
			// has instead of waiting for an effect to copy it across.
			const aliasTable = Array.isArray(status?.aliases) ? status.aliases : [];

			// Which targets are sitting out, straight from the host's cooldown
			// table. Read through a lookup rather than pre-indexed, so a row whose
			// target is not cooling costs nothing.
			const coolingList = Array.isArray(status?.failover?.cooling) ? status.failover.cooling : [];
			const coolingFor = useCallback(
				(target) => coolingList.find((entry) => entry.target === target),
				[coolingList],
			);
			// Rows arrive in one shape from the host (`{alias, targets}`) and in the
			// same shape from the local draft, so nothing has to branch on origin.
			// A row written by an older build carried a single `target` string;
			// folding it here keeps that table editable instead of crashing on it.
			const aliasRows = (aliasDraftRows ?? aliasTable).map((row) => ({
				alias: row.alias,
				targets: Array.isArray(row.targets) ? row.targets : [row.target].filter(Boolean),
			}));

			const copy = useCallback(async (which, value) => {
				if (await copyText(value)) {
					setCopied(which);
					setTimeout(() => setCopied(""), 1500);
				}
			}, []);

			const openTab = useCallback((next) => {
				setTab(next);
				try {
					window.localStorage.setItem("gw-tab", next);
				} catch {
					/* a blocked storage area must not break the tab switch */
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

			/* ---- route editor ------------------------------------------------
			 * The editor never writes on its own: it stages a chain, and `commit`
			 * folds it into the local table. Saving stays a single explicit act,
			 * exactly as before, so a cancelled dialog changes nothing.
			 */

			/** Open the picker, empty for a new route or seeded from an existing one. */
			const openEditor = useCallback(
				(mode, row) => {
					const existing = row ?? null;
					setEditor({
						mode,
						original: existing === null ? "" : existing.alias,
						name: existing === null ? "" : existing.alias,
						targets: existing === null ? [] : [...existing.targets],
						query: "",
						provider: "",
						// A fresh dialog shows the first few providers open, so the list
						// is not a wall of collapsed headers on first sight.
						open: new Set(
							(Array.isArray(status?.providers) ? status.providers : [])
								.filter((entry) => entry.models > 0)
								.slice(0, 2)
								.map((entry) => entry.id),
						),
						drag: null,
						drop: null,
					});
					setNotice(null);
				},
				[status],
			);

			const closeEditor = useCallback(() => setEditor(null), []);

			/** Toggle one target, appending so the tick order becomes the try order. */
			const toggleTarget = useCallback((id) => {
				setEditor((current) => {
					if (current === null) return current;
					const targets = current.targets.includes(id)
						? current.targets.filter((entry) => entry !== id)
						: [...current.targets, id];
					return { ...current, targets };
				});
			}, []);

			const removeTarget = useCallback((index) => {
				setEditor((current) => {
					if (current === null) return current;
					const targets = current.targets.filter((_, at) => at !== index);
					return { ...current, targets };
				});
			}, []);

			const moveTarget = useCallback((index, delta) => {
				setEditor((current) => {
					if (current === null) return current;
					const next = index + delta;
					if (next < 0 || next >= current.targets.length) return current;
					const targets = [...current.targets];
					const [moved] = targets.splice(index, 1);
					targets.splice(next, 0, moved);
					return { ...current, targets };
				});
			}, []);

			/** Drag-and-drop reordering; index-based so duplicate ids cannot confuse it. */
			const dropTarget = useCallback((from, to, after) => {
				setEditor((current) => {
					if (current === null || from === to) return current;
					const targets = [...current.targets];
					const [moved] = targets.splice(from, 1);
					let at = targets.indexOf(current.targets[to]);
					if (at < 0) at = targets.length;
					targets.splice(after ? at + 1 : at, 0, moved);
					return { ...current, targets, drag: null, drop: null };
				});
			}, []);

			/** Tick or untick every model in one provider group at once. */
			const toggleGroupTargets = useCallback((ids) => {
				setEditor((current) => {
					if (current === null) return current;
					const allIn = ids.every((id) => current.targets.includes(id));
					const targets = allIn
						? current.targets.filter((id) => !ids.includes(id))
						: [...current.targets, ...ids.filter((id) => !current.targets.includes(id))];
					return { ...current, targets };
				});
			}, []);

			/** Fold the staged chain into the local table; the host is written on Save. */
			const commitEditor = useCallback(() => {
				if (editor === null) return;
				const alias = String(editor.name).trim();
				const targets = editor.targets;
				if (alias.length === 0 || targets.length === 0) {
					setNotice({ scope: "alias", kind: "bad", text: t("page.aliasBad") });
					return;
				}
				setAliasDraftRows((rows) => {
					const base = (rows ?? aliasTable).filter(
						// A rename has to drop the old key, or the table keeps both.
						(row) => row.alias !== alias && row.alias !== editor.original,
					);
					return [...base, { alias, targets }];
				});
				setEditor(null);
				setNotice(null);
			}, [editor, aliasTable, t]);

			const removeAlias = useCallback(
				(alias) => {
					setAliasDraftRows((rows) => (rows ?? aliasTable).filter((row) => row.alias !== alias));
				},
				[aliasTable],
			);

			/** Replace the host's whole table with the local draft. */
			const saveAliases = useCallback(async () => {
				const table = {};
				for (const row of aliasRows ?? []) table[row.alias] = row.targets;
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
				async (action, provider) => {
					setBusyTunnel(true);
					try {
						const response = await fetch(TUNNEL_PATH, {
							method: "POST",
							cache: "no-store",
							credentials: "same-origin",
							headers: { Accept: "application/json", "Content-Type": "application/json" },
							body: JSON.stringify(provider === undefined ? { action } : { action, provider }),
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
			const tunnelRunning = tunnelStatus === "running" || tunnelStatus === "starting";
			const tunnelUrl = typeof tunnel?.url === "string" && tunnel.url.length > 0 ? tunnel.url : "";
			const curlExample = `curl ${baseUrl}/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"${example}","messages":[{"role":"user","content":"hi"}]}'`;

			/* Counters. `usageTotals` and `bytes` only exist on hosts that
			 * accumulate them; when absent the tiles say so instead of showing
			 * a zero that would read as "nothing happened". */
			const requests = Number.isFinite(status?.requests) ? status.requests : 0;
			const failures = Number.isFinite(status?.failures) ? status.failures : 0;
			const usageTotals = status?.usageTotals ?? null;
			const bytes = status?.bytes ?? null;
			const providerCount = Array.isArray(status?.providers) ? status.providers.length : groups.length;
			const uptime = Number.isFinite(status?.startedAt) ? Date.now() - status.startedAt : 0;
			const recent = Array.isArray(status?.recent) ? status.recent : [];

			/* Routes are the alias table plus whatever is benched right now. The
			 * count is what the tab badge shows, so a benched target is visible
			 * without opening the tab. */
			const coolingCount = coolingList.length;
			const routeCount = aliasRows.length;

			const statTile = (key, label, value, hint) =>
				h(
					"div",
					{ className: "gw-stat", key },
					h("span", { className: "gw-stat-value" }, value),
					h("span", { className: "gw-stat-label" }, label),
					h("span", { className: "gw-stat-hint" }, hint),
				);

			/* ------------------------------------------------------ panels */

			/** The tunnel status bar, on the overview: one line, one action. */
			const tunnelBar = () => {
				const dot = tunnelStatus === "running" ? "is-on" : tunnelStatus === "starting" ? "is-warn" : tunnelStatus === "failed" ? "is-bad" : "";
				return h(
					"div",
					{ className: "gw-bar" },
					h("span", { className: `gw-dot ${dot}` }),
					h(
						"div",
						{ className: "gw-bar-main" },
						h("span", { className: "gw-bar-name" }, t("tunnel.title")),
						h(
							"span",
							{ className: "gw-bar-meta" },
							tunnelRunning && tunnelUrl.length > 0
								? `${tunnelUrl}/v1`
								: tunnel?.provider
									? `${tunnelLabel} · ${tunnel.provider}`
									: tunnelLabel,
						),
					),
					h(
						"span",
						{ className: "gw-badge is-idle" },
						tunnel?.provider ? String(tunnel.provider) : t("page.tunnelUnconfigured"),
					),
					h(
						"button",
						{ type: "button", className: "gw-btn", onClick: () => openTab("tunnel") },
						t("tab.tunnel"),
					),
				);
			};

			/** The cooling strip: only meaningful when something is benched. */
			const coolingStrip = () => {
				if (coolingCount === 0) return null;
				const soonest = coolingList.reduce(
					(min, entry) => (entry.remainingMs < min ? entry.remainingMs : min),
					coolingList[0].remainingMs,
				);
				return h(
					"div",
					{ className: "gw-cool" },
					h("span", { className: "gw-cool-ico" }, "!"),
					h(
						"div",
						null,
						h("b", null, t("cool.title")),
						" — ",
						fill(t("cool.summary"), {
							count: coolingCount,
							seconds: Math.max(0, Math.ceil(soonest / 1000)),
						}),
					),
				);
			};

			const overviewPanel = () =>
				h(
					"div",
					{ className: `gw-panel ${tab === "overview" ? "is-active" : ""}`, key: "overview" },
					status === null ? h("div", { className: "gw-empty" }, t("page.loading")) : null,
					status !== null && !isOn ? h("div", { className: "gw-card" }, t("page.offHint")) : null,
					status === null ? null : tunnelBar(),
					coolingStrip(),
					status === null
						? null
						: h(
								"section",
								{ className: "gw-stats" },
								statTile("requests", t("stat.requests"), String(requests), fill(t("stat.failed"), { count: failures })),
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
					// Recent activity: the one thing that turns "it dropped again"
					// into a cause, so it belongs on the landing tab.
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("recent.title")),
								h("p", { className: "gw-sec-sub" }, fill(t("recent.window"), { count: recent.length })),
							),
						),
						recent.length === 0
							? h("div", { className: "gw-card gw-empty" }, t("recent.empty"))
							: h(
									"div",
									{ className: "gw-table" },
									h(
										"div",
										{ className: "gw-trow gw-thead gw-grid-recent" },
										h("span", null, t("recent.time")),
										h("span", null, t("recent.model")),
										h("span", null, t("recent.result")),
										h("span", { className: "gw-tnum" }, t("recent.tokens")),
										h("span", { className: "gw-tnum" }, t("recent.took")),
									),
									h(
										"div",
										{ className: "gw-tbody" },
										recent.map((entry, index) => {
											const ok = entry?.outcome === "ok";
											const usage = entry?.usage;
											return h(
												"div",
												{ className: "gw-trow gw-grid-recent", key: `${entry?.at ?? index}-${index}` },
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
					),
				);

			/** One hop of a route chain: index, id, and its health when benched. */
			const routeHop = (target, index) => {
				const cooling = coolingFor(target);
				const coolingNow = cooling !== undefined;
				const remaining = coolingNow ? Math.max(0, Math.ceil(cooling.remainingMs / 1000)) : 0;
				const cooldown = Number.isFinite(status?.failover?.cooldownMs) ? status.failover.cooldownMs : 300000;
				const share = coolingNow ? Math.max(0, Math.min(1, cooling.remainingMs / cooldown)) : 0;
				return h(
					"div",
					{ className: `gw-hop ${coolingNow ? "is-cooling" : ""}`, key: target },
					h("span", { className: `gw-hop-idx ${index === 0 ? "is-first" : ""}` }, String(index + 1)),
					h("span", { className: "gw-hop-id", title: target }, target),
					coolingNow
						? h(
								"span",
								{ className: "gw-hop-side" },
								h("span", { className: "gw-badge is-bad" }, t("page.aliasCooling")),
								h("span", { className: "gw-meter" }, h("i", { style: { width: `${share * 100}%` } })),
								h("span", { className: "gw-hop-eta" }, `${remaining}s`),
							)
						: h(
								"span",
								{ className: "gw-hop-side" },
								h("span", { className: `gw-badge ${index === 0 ? "is-brand" : "is-idle"}` }, index === 0 ? t("routes.primary") : t("routes.fallback")),
							),
				);
			};

			/* ---- the picker itself ----------------------------------------------
			 * Rendered through a portal onto `document.body` when the shell offers
			 * react-dom, so the overlay is not clipped by the slot's own scroll
			 * container. Without react-dom it renders in place, which still works
			 * because the scrim is `position: fixed` either way.
			 */
			const editorPortal = (node) => {
				if (node === null) return null;
				if (typeof createPortal !== "function") return node;
				return createPortal(node, document.body);
			};

			const routeEditor = () => {
				if (editor === null) return null;
				const current = editor;
				const needle = current.query.trim().toLowerCase();
				// The picker lists providers in the host's order, filtered by both
				// the provider chip and the search text. A query expands every
				// surviving group: the matches are what was asked for.
				const picked = [];
				for (const group of groups) {
					if (current.provider !== "" && group.provider !== current.provider) continue;
					const rows =
						needle.length === 0
							? group.models
							: group.models.filter((model) => {
									const name = typeof model.name === "string" ? model.name : "";
									return (
										model.id.toLowerCase().includes(needle) ||
										name.toLowerCase().includes(needle) ||
										group.provider.toLowerCase().includes(needle)
									);
								});
					if (rows.length > 0) picked.push({ provider: group.provider, models: rows });
				}
				const visibleCount = picked.reduce((sum, group) => sum + group.models.length, 0);
				const usedBy = new Map();
				for (const row of aliasRows) {
					if (row.alias === current.original) continue;
					for (const target of row.targets) usedBy.set(target, row.alias);
				}
				const canSave = String(current.name).trim().length > 0 && current.targets.length > 0;

				const optionRow = (model) => {
					const on = current.targets.includes(model.id);
					const owner = usedBy.get(model.id);
					// Inside a provider group the header already names the provider, so
					// repeating `provider/` on every row is both redundant and the main
					// reason a long id got clipped. The full id stays in `title` and in
					// `data-model`, so nothing is lost — only the repeated prefix.
					const prefix = `${model.provider}/`;
					const short = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
					return h(
						"button",
						{
							type: "button",
							key: model.id,
							className: `gw-opt ${on ? "is-on" : ""}`,
							"aria-pressed": on ? "true" : "false",
							"data-model": model.id,
							title: model.id,
							onClick: () => toggleTarget(model.id),
						},
						h("span", { className: "gw-opt-box" }, on ? checkIcon() : null),
						h("span", { className: "gw-opt-id" }, short),
						typeof model.name === "string" && model.name !== model.id
							? h("span", { className: "gw-opt-name" }, model.name)
							: null,
						owner === undefined ? null : h("span", { className: "gw-opt-flag is-used" }, fill(t("routes.usedBy"), { alias: owner })),
					);
				};

				const groupBlock = (group) => {
					const open = needle.length > 0 || current.open.has(group.provider);
					const ids = group.models.map((model) => model.id);
					const chosen = ids.filter((id) => current.targets.includes(id)).length;
					return h(
						"div",
						{ className: `gw-pick-group ${open ? "is-open" : ""}`, key: group.provider },
						h(
							"button",
							{
								type: "button",
								className: "gw-pick-group-head",
								"aria-expanded": open ? "true" : "false",
								onClick: () => {
									setEditor((state) => {
										if (state === null) return state;
										const next = new Set(state.open);
										if (next.has(group.provider)) next.delete(group.provider);
										else next.add(group.provider);
										return { ...state, open: next };
									});
								},
							},
							h("span", { className: "gw-pick-caret" }, h("span", { className: "gw-icon" }, caretIcon())),
							h("span", null, group.provider),
							h("span", { className: "gw-pick-group-count" }, String(group.models.length)),
							chosen === 0
								? null
								: h("span", { className: "gw-pick-group-sel" }, fill(t("routes.groupPicked"), { count: chosen })),
							h(
								"span",
								{
									className: "gw-pick-all",
									role: "button",
									tabIndex: 0,
									onClick: (event) => {
										// The header itself toggles the group, so the shortcut must
										// not also collapse the list under the user's finger.
										event.stopPropagation();
										toggleGroupTargets(ids);
									},
									onKeyDown: (event) => {
										if (event.key !== "Enter" && event.key !== " ") return;
										event.preventDefault();
										event.stopPropagation();
										toggleGroupTargets(ids);
									},
								},
								chosen === ids.length ? t("routes.pickNone") : t("routes.pickAll"),
							),
						),
						h("div", { className: "gw-pick-rows" }, ...group.models.map(optionRow)),
					);
				};

				const chainRow = (id, index) => {
					const dragging = current.drag === index;
					const mark =
						current.drop !== null && current.drop.index === index && current.drag !== null
							? current.drop.after
								? " is-after"
								: " is-before"
							: "";
					return h(
						"div",
						{
							key: `${id}#${index}`,
							className: `gw-chain-item ${dragging ? "is-dragging" : ""}${mark}`,
							draggable: true,
							onDragStart: (event) => {
								event.dataTransfer.effectAllowed = "move";
								setEditor((state) => (state === null ? state : { ...state, drag: index, drop: null }));
							},
							onDragEnd: () =>
								setEditor((state) => (state === null ? state : { ...state, drag: null, drop: null })),
							onDragOver: (event) => {
								if (current.drag === null) return;
								event.preventDefault();
								const box = event.currentTarget.getBoundingClientRect();
								const after = event.clientY > box.top + box.height / 2;
								setEditor((state) =>
									state === null || state.drag === null || (state.drop !== null && state.drop.index === index && state.drop.after === after)
										? state
										: { ...state, drop: { index, after } },
								);
							},
							onDrop: (event) => {
								event.preventDefault();
								if (current.drag === null || current.drop === null) return;
								dropTarget(current.drag, index, current.drop.after);
							},
						},
						h("span", { className: "gw-chain-grip", title: t("routes.dragHint") }, gripIcon()),
						h("span", { className: `gw-hop-idx ${index === 0 ? "is-first" : ""}` }, String(index + 1)),
						h(
							"div",
							{ className: "gw-chain-main" },
							h("span", { className: "gw-chain-id", title: id }, id),
							h(
								"span",
								{ className: "gw-chain-meta" },
								index === 0 ? t("routes.primaryHint") : fill(t("routes.fallbackHint"), { index: index + 1 }),
							),
						),
						h(
							"span",
							{ className: "gw-chain-tools" },
							h(
								"button",
								{
									type: "button",
									className: "gw-icon-btn",
									title: t("routes.moveUp"),
									"aria-label": t("routes.moveUp"),
									disabled: index === 0,
									onClick: () => moveTarget(index, -1),
								},
								"↑",
							),
							h(
								"button",
								{
									type: "button",
									className: "gw-icon-btn",
									title: t("routes.moveDown"),
									"aria-label": t("routes.moveDown"),
									disabled: index === current.targets.length - 1,
									onClick: () => moveTarget(index, 1),
								},
								"↓",
							),
							h(
								"button",
								{
									type: "button",
									className: "gw-icon-btn is-danger",
									title: t("routes.removeTarget"),
									"aria-label": t("routes.removeTarget"),
									onClick: () => removeTarget(index),
								},
								"✕",
							),
						),
					);
				};

				const providerChips = [
					h(
						"button",
						{
							type: "button",
							key: "__all",
							className: `gw-chip ${current.provider === "" ? "is-on" : ""}`,
							onClick: () => setEditor((state) => (state === null ? state : { ...state, provider: "" })),
						},
						fill(t("routes.allProviders"), { count: allIds.length }),
					),
					...groups.map((group) =>
						h(
							"button",
							{
								type: "button",
								key: group.provider,
								className: `gw-chip ${current.provider === group.provider ? "is-on" : ""}`,
								onClick: () =>
									setEditor((state) =>
										state === null
											? state
											: { ...state, provider: state.provider === group.provider ? "" : group.provider },
									),
							},
							`${group.provider} ${group.models.length}`,
						),
					),
				];

				return editorPortal(
					h(
						"div",
						{
							className: "gw-scrim",
							[STYLE_ATTR]: "",
							role: "dialog",
							"aria-modal": "true",
							"aria-label": current.mode === "edit" ? t("routes.editTitle") : t("routes.addTitle"),
							onMouseDown: (event) => {
								// Only a click on the scrim itself dismisses; a drag that
								// starts inside the modal and ends outside must not.
								if (event.target === event.currentTarget) closeEditor();
							},
						},
						h(
							"div",
							{ className: "gw-modal" },
							h(
								"div",
								{ className: "gw-modal-head" },
								h("div", { className: "gw-modal-title" }, current.mode === "edit" ? t("routes.editTitle") : t("routes.addTitle")),
								h("button", { type: "button", className: "gw-btn is-sm is-quiet", onClick: closeEditor }, t("routes.close")),
							),
							h(
								"div",
								{ className: "gw-modal-body" },
								h(
									"div",
									{ className: "gw-field" },
									h(
										"label",
										{ className: "gw-field-label", htmlFor: "gw-route-name" },
										t("routes.nameLabel"),
										h("span", null, t("routes.nameHint")),
									),
									h("input", {
										id: "gw-route-name",
										className: "gw-input gw-mono",
										type: "text",
										style: { maxWidth: "320px" },
										value: current.name,
										placeholder: t("page.aliasName"),
										onChange: (event) =>
											setEditor((state) => (state === null ? state : { ...state, name: event.target.value })),
									}),
								),
								h(
									"div",
									{ className: "gw-pick-grid" },
									h(
										"div",
										{ className: "gw-pane" },
										h(
											"div",
											{ className: "gw-pane-head" },
											h("span", null, t("routes.available")),
											h("span", { className: "gw-pane-count" }, `${visibleCount} / ${allIds.length}`),
										),
										h(
											"div",
											{ className: "gw-pane-tools" },
											h("input", {
												className: "gw-input",
												type: "search",
												value: current.query,
												placeholder: t("routes.searchHint"),
												"aria-label": t("routes.searchHint"),
												onChange: (event) =>
													setEditor((state) => (state === null ? state : { ...state, query: event.target.value })),
											}),
											h("div", { className: "gw-chips" }, ...providerChips),
										),
										h(
											"div",
											{ className: "gw-pick-list" },
											picked.length === 0
												? h(
														"div",
														{ className: "gw-pick-empty" },
														h("b", null, t("routes.noMatch")),
														t("routes.noMatchHint"),
													)
												: picked.map(groupBlock),
										),
									),
									h(
										"div",
										{ className: "gw-pane" },
										h(
											"div",
											{ className: "gw-pane-head" },
											h("span", null, t("routes.tryOrder")),
											h(
												"span",
												{ className: "gw-pane-count" },
												fill(t("routes.targetCount"), { count: current.targets.length }),
											),
										),
										h(
											"div",
											{ className: "gw-chain-list" },
											current.targets.length === 0
												? h(
														"div",
														{ className: "gw-chain-empty" },
														h("b", null, t("routes.noTargets")),
														t("routes.noTargetsHint"),
													)
												: current.targets.map(chainRow),
										),
									),
								),
								h(
									"div",
									{ className: "gw-modal-hint" },
									h("span", { className: "gw-icon" }, infoIcon()),
									h("span", null, t("routes.orderHint")),
								),
							),
							h(
								"div",
								{ className: "gw-modal-foot" },
								h(
									"span",
									{ className: "gw-modal-note" },
									current.targets.length === 0
										? t("routes.needTarget")
										: String(current.name).trim().length === 0
											? t("routes.needName")
											: fill(t("routes.summary"), {
													name: String(current.name).trim(),
													count: current.targets.length,
												}),
								),
								h(
									"div",
									{ className: "gw-modal-actions" },
									h("button", { type: "button", className: "gw-btn", onClick: closeEditor }, t("routes.cancel")),
									h(
										"button",
										{
											type: "button",
											className: "gw-btn is-primary",
											disabled: !canSave,
											onClick: commitEditor,
										},
										t("routes.confirm"),
									),
								),
							),
						),
					),
				);
			};

			const routesPanel = () => {
				const healthy = coolingCount === 0;
				return h(
					"div",
					{ className: `gw-panel ${tab === "routes" ? "is-active" : ""}`, key: "routes" },
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("page.alias")),
								h("p", { className: "gw-sec-sub" }, t("page.aliasHint")),
							),
							h(
								"div",
								{ className: "gw-sec-side" },
								h(
									"span",
									{ className: `gw-badge ${healthy ? "is-ok" : "is-warn"}` },
									healthy
										? t("routes.healthy")
										: fill(t("routes.bench"), { count: coolingCount }),
								),
								h(
									"button",
									{ type: "button", className: "gw-btn", onClick: () => openEditor("add", null) },
									t("routes.add"),
								),
								h(
									"button",
									{ type: "button", className: "gw-btn is-primary", onClick: saveAliases },
									t("page.aliasSave"),
								),
							),
						),
						routeCount === 0
							? h("div", { className: "gw-card gw-empty" }, t("page.aliasEmpty"))
							: h(
									"div",
									{ className: "gw-table" },
									h(
										"div",
										{ className: "gw-trow gw-thead gw-grid-route" },
										h("span", null, t("routes.name")),
										h("span", null, t("routes.chain")),
										h("span", null, t("routes.health")),
										h("span", null, ""),
									),
									h(
										"div",
										{ className: "gw-tbody" },
										aliasRows.map((row) => {
											const benched = row.targets.filter((target) => coolingFor(target) !== undefined).length;
											return h(
												"div",
												{ className: "gw-trow gw-grid-route", key: row.alias },
												h(
													"div",
													{ className: "gw-route-name" },
													h("code", { title: row.alias }, row.alias),
													h("small", null, fill(t("routes.count"), { count: row.targets.length })),
												),
												h("div", { className: "gw-chain" }, ...row.targets.map((target, index) => routeHop(target, index))),
												h(
													"div",
													{ className: "gw-tcell" },
													h(
														"span",
														{ className: `gw-badge ${benched === 0 ? "is-ok" : "is-warn"}` },
														benched === 0
															? t("routes.healthy")
															: fill(t("routes.bench"), { count: benched }),
													),
												),
												h(
													"div",
													{ className: "gw-row-actions" },
													h(
														"button",
														{
															type: "button",
															className: "gw-btn is-sm",
															onClick: () => openEditor("edit", row),
														},
														t("routes.edit"),
													),
													h(
														"button",
														{ type: "button", className: "gw-btn is-sm is-danger", onClick: () => removeAlias(row.alias) },
														t("page.aliasRemove"),
													),
												),
											);
										}),
									),
								),
						noticeFor("alias"),
					),
					// The editor is a modal over the page, so it is mounted beside the
					// panel rather than inside it: a dialog inside a tab would vanish
					// the moment the tab changed.
					routeEditor(),
				);
			};

			const tunnelPanel = () => {
				const running = tunnelStatus === "running";
				const currentProvider = typeof tunnel?.provider === "string" ? tunnel.provider : null;
				const chosen = typeof status?.tunnel?.provider === "string" ? status.tunnel.provider : null;
				const needsCredential = tunnel?.needsCredential === true;
				return h(
					"div",
					{ className: `gw-panel ${tab === "tunnel" ? "is-active" : ""}`, key: "tunnel" },
					needsCredential
						? h(
								"div",
								{ className: "gw-cred" },
								h("div", { className: "gw-cred-title" }, h("span", null, "!"), t("tunnel.credTitle")),
								h(
									"div",
									{ className: "gw-cred-body" },
									fill(t("tunnel.credBody"), { cmd: "ngrok config add-authtoken <token>" }),
								),
								h(
									"div",
									{ className: "gw-cred-actions" },
									h(
										"a",
										{
											className: "gw-btn is-primary",
											href: tunnel.signupUrl,
											target: "_blank",
											rel: "noreferrer noopener",
										},
										t("page.tunnelSignup"),
									),
									h(
										"a",
										{
											className: "gw-btn",
											href: tunnel.tokenUrl,
											target: "_blank",
											rel: "noreferrer noopener",
										},
										t("page.tunnelToken"),
									),
								),
							)
						: null,
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("tunnel.title")),
								h("p", { className: "gw-sec-sub" }, t("tunnel.sub")),
							),
							h(
								"div",
								{ className: "gw-sec-side" },
								h(
									"span",
									{ className: `gw-badge ${running ? "is-ok" : tunnelStatus === "failed" ? "is-bad" : "is-idle"}` },
									tunnelLabel,
								),
								h(
									"button",
									{
										type: "button",
										className: `gw-btn ${running ? "" : "is-primary"}`,
										disabled: busyTunnel,
										onClick: () => toggleTunnel(running || tunnelStatus === "starting" ? "stop" : "start"),
									},
									running || tunnelStatus === "starting" ? t("page.tunnelStop") : t("page.tunnelStart"),
								),
							),
						),
						// The hero: the one address this tab exists to hand over.
						h(
							"div",
							{ className: `gw-hero ${running && tunnelUrl.length > 0 ? "" : "is-down"}` },
							h(
								"div",
								{ className: "gw-hero-top" },
								h(
									"span",
									{ className: "gw-hero-label" },
									running && tunnelUrl.length > 0 ? t("tunnel.heroRunning") : t("tunnel.heroDown"),
								),
							),
							h(
								"div",
								{ className: `gw-hero-url ${running && tunnelUrl.length > 0 ? "" : "is-down"}` },
								running && tunnelUrl.length > 0 ? `${tunnelUrl}/v1` : t("tunnel.heroDownHint"),
							),
							h(
								"div",
								{ className: "gw-hero-meta" },
								tunnel?.provider ? h("span", null, String(tunnel.provider)) : null,
								tunnel?.provider ? h("span", { className: "gw-sep" }, "·") : null,
								Number.isFinite(tunnel?.pid) ? h("span", null, fill(t("tunnel.pid"), { pid: tunnel.pid })) : null,
								Number.isFinite(tunnel?.pid) ? h("span", { className: "gw-sep" }, "·") : null,
								h("span", null, `${t("tunnel.autostart")} ${tunnel?.autostart === true ? t("tunnel.autostartOn") : t("tunnel.autostartOff")}`),
								running && tunnelUrl.length > 0
									? h(
											"button",
											{ type: "button", className: "gw-btn is-sm is-quiet", onClick: () => copy("tunnel", `${tunnelUrl}/v1`) },
											copied === "tunnel" ? t("page.copied") : t("page.copy"),
										)
									: null,
							),
						),
						tunnel?.error !== null && tunnel?.error !== undefined
							? h("div", { className: "gw-notice is-bad" }, tunnel.error)
							: null,
						noticeFor("tunnel"),
					),
					// Provider picker: a real choice, because the host route accepts
					// `provider` on start. Switching mid-flight is spelled out as a
					// restart so nobody expects the old URL to survive.
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("tunnel.providerTitle")),
								h("p", { className: "gw-sec-sub" }, t("tunnel.providerHint")),
							),
						),
						h(
							"div",
							{ className: "gw-picks" },
							...TUNNEL_PROVIDERS.map((provider) =>
								h(
									"button",
									{
										type: "button",
										key: provider,
										className: `gw-pick ${chosen === provider ? "is-on" : ""}`,
										onClick: () => toggleTunnel("start", provider),
										disabled: busyTunnel,
									},
									h("span", { className: "gw-pick-radio" }),
									h(
										"span",
										{ className: "gw-pick-copy" },
										h("span", { className: "gw-pick-name" }, provider),
										h(
											"span",
											{ className: "gw-pick-desc" },
											provider === "ngrok" ? t("tunnel.ngrokDesc") : t("tunnel.cloudflaredDesc"),
										),
									),
								),
							),
						),
						running && currentProvider !== null && chosen !== null && currentProvider !== chosen
							? h(
									"div",
									{ className: "gw-notice is-warn" },
									fill(t("tunnel.restartHint"), { current: currentProvider }),
								)
							: null,
					),
					h(
						"div",
						{ className: "gw-card" },
						h("div", { className: "gw-notice" }, t("page.tunnelHint")),
						h("div", { className: "gw-notice" }, t("tunnel.autostartHint")),
					),
				);
			};

			const catalogPanel = () => {
				const aliasedModels = new Set();
				for (const row of aliasRows) for (const target of row.targets) aliasedModels.add(target);
				return h(
					"div",
					{ className: `gw-panel ${tab === "catalog" ? "is-active" : ""}`, key: "catalog" },
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("page.models")),
								h(
									"p",
									{ className: "gw-sec-sub" },
									fill(t("page.modelCount"), { count: allIds.length, providers: providerCount }),
								),
							),
							h(
								"div",
								{ className: "gw-sec-side" },
								allIds.length > 0
									? h(
											"button",
											{ type: "button", className: "gw-btn", onClick: () => copy("all", allIds.join("\n")) },
											copied === "all" ? fill(t("page.allCopied"), { count: allIds.length }) : t("page.copyAll"),
										)
									: null,
								h("button", { type: "button", className: "gw-btn", onClick: () => load(true) }, t("page.refresh")),
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
							? h("div", { className: "gw-card gw-empty" }, t("page.loading"))
							: groups.length === 0
								? h("div", { className: "gw-card gw-empty" }, t("panel.empty"))
								: visibleGroups.length === 0
									? h("div", { className: "gw-card gw-empty" }, t("search.empty"))
									: h(
											"div",
											{ className: "gw-card", style: { padding: "0 var(--gw-s2)" } },
											...visibleGroups.map((group) =>
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
																className: "gw-btn is-sm",
																onClick: (event) => {
																	event.preventDefault();
																	event.stopPropagation();
																	copy(group.provider, group.models.map((model) => model.id).join("\n"));
																},
															},
															copied === group.provider ? t("page.copied") : t("page.copy"),
														),
													),
													...group.models.map((model) =>
														h(
															"div",
															{ className: "gw-row", key: model.id },
															h(
																"code",
																{ className: `gw-row-id ${aliasedModels.has(model.id) ? "is-routed" : ""}`, title: model.id },
																model.id,
															),
															typeof model.name === "string" && model.name !== model.id
																? h("span", { className: "gw-row-name" }, model.name)
																: null,
															h(
																"button",
																{ type: "button", className: "gw-btn is-sm", onClick: () => copy(model.id, model.id) },
																copied === model.id ? t("page.copied") : t("page.copy"),
															),
														),
													),
												),
											),
										),
					),
				);
			};

			const settingsPanel = () => {
				const kv = (key, title, sub, control) =>
					h(
						"div",
						{ className: "gw-kv", key },
						h("div", { className: "gw-kv-copy" }, h("b", null, title), h("small", null, sub)),
						h("div", { className: "gw-kv-ctl" }, control),
					);
				return h(
					"div",
					{ className: `gw-panel ${tab === "settings" ? "is-active" : ""}`, key: "settings" },
					h(
						"section",
						{ className: "gw-sec" },
						h(
							"div",
							{ className: "gw-sec-head" },
							h(
								"div",
								{ className: "gw-sec-titles" },
								h("h2", { className: "gw-sec-title" }, t("settings.title")),
								h("p", { className: "gw-sec-sub" }, t("settings.sub")),
							),
						),
						h(
							"div",
							{ className: "gw-card" },
							h(
								"div",
								{ className: "gw-sec-title", style: { fontSize: "12.5px" } },
								t("settings.endpoints"),
							),
							h("p", { className: "gw-sec-sub" }, t("settings.endpointsSub")),
							kv(
								"public",
								t("page.public"),
								t("page.publicHint"),
								h(
									"span",
									{ className: "gw-kv-ctl" },
									h("code", { className: "gw-kv-value", title: baseUrl }, baseUrl || "—"),
									h(
										"button",
										{ type: "button", className: "gw-btn is-sm", onClick: () => copy("url", baseUrl) },
										copied === "url" ? t("page.copied") : t("page.copy"),
									),
								),
							),
							kv(
								"local",
								t("page.local"),
								t("settings.localSub"),
								h(
									"span",
									{ className: "gw-kv-ctl" },
									h("code", { className: "gw-kv-value", title: localUrl }, localUrl || "—"),
									h(
										"button",
										{ type: "button", className: "gw-btn is-sm", onClick: () => copy("local", localUrl) },
										copied === "local" ? t("page.copied") : t("page.copy"),
									),
								),
							),
						),
						h(
							"div",
							{ className: "gw-card" },
							h("div", { className: "gw-sec-title", style: { fontSize: "12.5px" } }, t("settings.key")),
							h("p", { className: "gw-sec-sub" }, t("settings.keySub")),
							kv(
								"key",
								t("page.apiKey"),
								typeof status?.settingsFile === "string"
									? `${t("page.keyFile")} ${status.settingsFile}`
									: t("settings.keySub"),
								h(
									"span",
									{ className: "gw-kv-ctl" },
									h(
										"code",
										{ className: "gw-kv-value", title: status?.apiKey ?? "" },
										revealed ? (status?.apiKey ?? "—") : mask(status?.apiKey),
									),
									h(
										"button",
										{ type: "button", className: "gw-btn is-sm", onClick: () => setRevealed((value) => !value) },
										revealed ? t("page.hide") : t("page.reveal"),
									),
									h(
										"button",
										{ type: "button", className: "gw-btn is-sm", onClick: () => copy("key", status?.apiKey ?? "") },
										copied === "key" ? t("page.copied") : t("page.copy"),
									),
									h(
										"button",
										{ type: "button", className: `gw-btn is-sm ${confirmKey ? "is-danger" : ""}`, onClick: rotateKey },
										confirmKey ? t("page.regenerateConfirm") : t("page.regenerate"),
									),
								),
							),
							noticeFor("key"),
						),
						h(
							"div",
							{ className: "gw-card" },
							h("div", { className: "gw-sec-title", style: { fontSize: "12.5px" } }, t("settings.port")),
							h("p", { className: "gw-sec-sub" }, t("settings.portSub")),
							kv(
								"port",
								t("page.port"),
								status?.portFallback
									? fill(t("page.portRandom"), { port: status.preferredPort })
									: t("page.portPinned"),
								h(
									"span",
									{ className: "gw-kv-ctl" },
									h("input", {
										className: "gw-input gw-mono",
										type: "text",
										inputMode: "numeric",
										style: { width: "78px" },
										value: portDraft,
										placeholder: status?.port === null || status?.port === undefined ? "" : String(status.port),
										"aria-label": t("page.port"),
										onChange: (event) => setPortDraft(event.target.value),
										onKeyDown: (event) => {
											if (event.key === "Enter") submitPort();
										},
									}),
									h("button", { type: "button", className: "gw-btn is-sm is-primary", onClick: submitPort }, t("page.portApply")),
								),
							),
							h("div", { className: "gw-notice" }, t("page.portHint")),
							noticeFor("port"),
						),
						h(
							"div",
							{ className: "gw-card" },
							h(
								"div",
								{ className: "gw-sec-head" },
								h(
									"div",
									{ className: "gw-sec-titles" },
									h("div", { className: "gw-sec-title", style: { fontSize: "12.5px" } }, t("settings.example")),
									h("p", { className: "gw-sec-sub" }, fill(t("settings.exampleSub"), { key: "<key>" })),
								),
								h(
									"button",
									{ type: "button", className: "gw-btn is-sm", onClick: () => copy("curl", curlExample) },
									copied === "curl" ? t("page.copied") : t("page.copyCurl"),
								),
							),
							h("code", { className: "gw-snippet" }, curlExample),
						),
					),
				);
			};

			const tabButton = (id) =>
				h(
					"button",
					{
						type: "button",
						key: id,
						className: `gw-tab ${tab === id ? "is-active" : ""}`,
						onClick: () => openTab(id),
						"aria-selected": tab === id,
						role: "tab",
					},
					id === "routes"
						? h("span", { className: `gw-tab-dot ${coolingCount > 0 ? "is-warn" : routeCount > 0 ? "is-ok" : ""}` })
						: null,
					id === "tunnel"
						? h("span", { className: `gw-tab-dot ${tunnelStatus === "running" ? "is-ok" : tunnelStatus === "failed" ? "is-bad" : ""}` })
						: null,
					t(`tab.${id}`),
					id === "routes" && routeCount > 0
						? h("span", { className: `gw-tab-n ${coolingCount > 0 ? "is-warn" : ""}` }, String(routeCount))
						: null,
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
							{ className: "gw-brand" },
							h("span", { className: "gw-logo" }, "G"),
							h(
								"div",
								{ className: "gw-titles" },
								h("h1", { className: "gw-title" }, t("page.title")),
								h("p", { className: "gw-sub" }, t("page.subtitle")),
							),
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
					failed
						? h(
								"div",
								{ className: "gw-card", style: { marginBottom: "12px" } },
								h("div", { className: "gw-notice is-bad" }, t("page.unavailable")),
								h(
									"button",
									{ type: "button", className: "gw-btn", style: { marginTop: "8px" }, onClick: () => load() },
									t("page.retry"),
								),
							)
						: null,
					h(
						"div",
						{ className: "gw-tabs", role: "tablist" },
						...TABS.map((id) => tabButton(id)),
					),
					overviewPanel(),
					routesPanel(),
					tunnelPanel(),
					catalogPanel(),
					settingsPanel(),
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
