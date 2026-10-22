/**
 * dsh-openai-gateway — Browser half.
 *
 * One row in the sidebar's global panel list, beside the host's own pages,
 * opening a gateway page: base URL, API key, and every model id with a copy
 * button. The page reads the loopback status route the host half publishes;
 * it never talks to a model provider itself.
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
			"page.baseUrl": "接口地址",
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
			"page.models": "模型",
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
			"page.aria": "模型网关",
			"panel.empty": "暂无模型",
		};
		const en = {
			"nav": "Model gateway",
			"page.title": "Model gateway",
			"page.subtitle": "Every configured provider's models behind one OpenAI-compatible surface",
			"page.on": "Running",
			"page.off": "Disabled",
			"page.offHint": "The gateway is disabled in its plugin configuration; the endpoint and key below are inactive.",
			"page.baseUrl": "Base URL",
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
			"page.models": "Models",
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
			"page.aria": "Model gateway",
			"panel.empty": "No models",
		};
		//#endregion

		//#region styles
		const CSS = `
[${STYLE_ATTR}] { display: block; height: 100%; overflow: auto; }
[${STYLE_ATTR}] * { box-sizing: border-box; }
[${STYLE_ATTR}] .gw-page {
	padding: 28px 32px 48px;
	max-width: 880px;
	margin: 0 auto;
	color: var(--dsw-alias-label-primary, inherit);
	font-family: var(--dsw-font-family, inherit);
	font-size: var(--dsw-font-xs-13, 13px);
	line-height: 1.6;
}
[${STYLE_ATTR}] .gw-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
[${STYLE_ATTR}] .gw-title { font-size: 18px; font-weight: 600; line-height: 1.3; }
[${STYLE_ATTR}] .gw-sub { margin-top: 4px; color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; }
[${STYLE_ATTR}] .gw-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
[${STYLE_ATTR}] .gw-pill {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 3px 10px; border-radius: 999px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
	background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08));
	color: var(--dsw-alias-label-secondary, inherit);
	font-size: 12px; white-space: nowrap;
}
[${STYLE_ATTR}] .gw-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-static-neutral-bluish-400, #8a8f98); }
[${STYLE_ATTR}] .gw-dot.is-on { background: var(--dsw-alias-state-business-primary, #2ea36b); }
[${STYLE_ATTR}] .gw-btn {
	appearance: none; cursor: pointer; font: inherit; font-size: 12px;
	padding: 4px 10px; border-radius: var(--dsw-radius-sm, 6px);
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
	background: var(--dsw-alias-bg-module-platform, transparent);
	color: var(--dsw-alias-label-primary, inherit);
	white-space: nowrap;
}
[${STYLE_ATTR}] .gw-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
[${STYLE_ATTR}] .gw-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 2px; }
[${STYLE_ATTR}] .gw-btn.is-quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-state-business-primary, #4d6bfe); }
[${STYLE_ATTR}] .gw-card {
	margin-bottom: 14px; padding: 14px 16px;
	border-radius: var(--dsw-radius-lg, 10px);
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2));
	background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.05));
}
[${STYLE_ATTR}] .gw-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; color: var(--dsw-alias-label-tertiary, inherit); font-size: 11px; letter-spacing: .03em; }
[${STYLE_ATTR}] .gw-value { display: flex; align-items: center; gap: 8px; }
[${STYLE_ATTR}] .gw-code {
	flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all;
	padding: 6px 9px; border-radius: var(--dsw-radius-sm, 6px);
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16));
	background: var(--dsw-alias-bg-base, rgba(0,0,0,.18));
}
[${STYLE_ATTR}] .gw-note { color: var(--dsw-alias-label-tertiary, inherit); font-size: 11px; margin-top: 8px; }
[${STYLE_ATTR}] .gw-port { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
[${STYLE_ATTR}] .gw-input {
	width: 96px; font: inherit; font-size: 12px; text-align: right;
	padding: 4px 8px; border-radius: var(--dsw-radius-sm, 6px);
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
	background: var(--dsw-alias-bg-base, transparent);
	color: var(--dsw-alias-label-primary, inherit);
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[${STYLE_ATTR}] .gw-input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: 1px; }
[${STYLE_ATTR}] .gw-port-state { color: var(--dsw-alias-label-tertiary, inherit); font-size: 11px; }
[${STYLE_ATTR}] .gw-notice { margin-top: 8px; font-size: 11px; }
[${STYLE_ATTR}] .gw-notice.is-ok { color: var(--dsw-alias-state-business-primary, #2ea36b); }
[${STYLE_ATTR}] .gw-warn { color: var(--dsw-alias-state-error-primary, #e5534b); }
[${STYLE_ATTR}] .gw-group { border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
[${STYLE_ATTR}] .gw-group:first-of-type { border-top: none; }
[${STYLE_ATTR}] .gw-group > summary {
	cursor: pointer; list-style: none; padding: 9px 2px;
	display: flex; align-items: center; justify-content: space-between; gap: 10px;
	font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary, inherit);
}
[${STYLE_ATTR}] .gw-group > summary::-webkit-details-marker { display: none; }
[${STYLE_ATTR}] .gw-group > summary::before {
	content: "\\25B8"; display: inline-block; margin-right: 7px;
	color: var(--dsw-alias-label-tertiary, inherit); transition: transform .12s ease;
}
[${STYLE_ATTR}] .gw-group[open] > summary::before { transform: rotate(90deg); }
[${STYLE_ATTR}] .gw-group-name { display: flex; align-items: center; gap: 7px; }
[${STYLE_ATTR}] .gw-group-count { color: var(--dsw-alias-label-tertiary, inherit); font-weight: 400; font-size: 11px; }
[${STYLE_ATTR}] .gw-row {
	display: flex; align-items: center; gap: 10px;
	padding: 5px 2px 5px 22px; border-radius: var(--dsw-radius-sm, 6px);
}
[${STYLE_ATTR}] .gw-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
[${STYLE_ATTR}] .gw-row-id {
	flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12px; user-select: all;
}
[${STYLE_ATTR}] .gw-row-name { flex: 0 1 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, inherit); font-size: 11px; }
[${STYLE_ATTR}] .gw-icon { display: inline-flex; align-items: center; justify-content: center; }
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

			// One same-origin read: the status document carries the whole catalog.
			// `/v1/models` lives on the gateway's own port, so asking for it from
			// this page would be a cross-origin call — and would leave the list
			// empty whenever the browser refused it.
			const load = useCallback(async () => {
				setFailed(false);
				try {
					const response = await fetch(STATUS_PATH, {
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
							{ className: `gw-notice ${notice.kind === "ok" ? "is-ok" : "gw-warn"}` },
							notice.text,
						)
					: null;

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

			const allIds = models === null ? [] : models.map((model) => model.id);
			const example = allIds.length > 0 ? allIds[0] : "provider/model";
			const baseUrl = status?.baseUrl ?? "";
			const curlExample = `curl ${baseUrl}/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"${example}","messages":[{"role":"user","content":"hi"}]}'`;

			const body = [];

			if (failed) {
				body.push(
					h(
						"div",
						{ className: "gw-card gw-warn", key: "failed" },
						h("div", null, t("page.unavailable")),
						h(
							"button",
							{ type: "button", className: "gw-btn", style: { marginTop: "8px" }, onClick: load },
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
						"div",
						{ className: "gw-card", key: "url" },
						h(
							"div",
							{ className: "gw-label" },
							h("span", null, t("page.baseUrl")),
							h(
								"button",
								{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("url", baseUrl) },
								copied === "url" ? t("page.copied") : t("page.copy"),
							),
						),
						h("div", { className: "gw-value" }, h("code", { className: "gw-code" }, baseUrl || "—")),
						h(
							"div",
							{ className: "gw-port" },
							h("span", { className: "gw-port-state" }, t("page.port")),
							h("input", {
								className: "gw-input",
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
								{ className: "gw-port-state" },
								status.portFallback
									? fill(t("page.portRandom"), { port: status.preferredPort })
									: t("page.portPinned"),
							),
						),
						h("div", { className: "gw-note" }, t("page.portHint")),
						noticeFor("port"),
					),
					h(
						"div",
						{ className: "gw-card", key: "key" },
						h(
							"div",
							{ className: "gw-label" },
							h("span", null, t("page.apiKey")),
							h(
								"span",
								{ style: { display: "inline-flex", gap: "6px" } },
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
									{
										type: "button",
										className: `gw-btn ${confirmKey ? "" : "is-quiet"}`,
										onClick: rotateKey,
									},
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
				);
			}

			body.push(
				h(
					"div",
					{ className: "gw-card", key: "models" },
					h(
						"div",
						{ className: "gw-label" },
						h(
							"span",
							null,
							`${t("page.models")} · ${fill(t("page.modelCount"), {
								count: allIds.length,
								providers: groups.length || (Array.isArray(status?.providers) ? status.providers.length : 0),
							})}`,
						),
						h(
							"span",
							{ style: { display: "inline-flex", gap: "6px" } },
							allIds.length > 0
								? h(
										"button",
										{
											type: "button",
											className: "gw-btn is-quiet",
											onClick: () => copy("all", allIds.join("\n")),
										},
										copied === "all"
											? fill(t("page.allCopied"), { count: allIds.length })
											: t("page.copyAll"),
									)
								: null,
							h("button", { type: "button", className: "gw-btn is-quiet", onClick: load }, t("page.refresh")),
						),
					),
					status === null
						? h("div", { className: "gw-note" }, t("page.loading"))
						: groups.length === 0
							? h("div", { className: "gw-note" }, t("panel.empty"))
							: groups.map((group) =>
									h(
										"details",
										{ className: "gw-group", key: group.provider, open: true },
										h(
											"summary",
											null,
											h(
												"span",
												{ className: "gw-group-name" },
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
					"div",
					{ className: "gw-card", key: "usage" },
					h(
						"div",
						{ className: "gw-label" },
						h("span", null, t("page.usage")),
						h(
							"button",
							{ type: "button", className: "gw-btn is-quiet", onClick: () => copy("curl", curlExample) },
							copied === "curl" ? t("page.copied") : t("page.copyCurl"),
						),
					),
					h("div", { className: "gw-note" }, fill(t("page.usageHint"), { example })),
					h(
						"code",
						{ className: "gw-code", style: { display: "block", marginTop: "8px", whiteSpace: "pre-wrap" } },
						curlExample,
					),
				),
			);

			return h(
				"div",
				{ [STYLE_ATTR]: "", role: "region", "aria-label": t("page.aria") },
				h(
					"div",
					{ className: "gw-page" },
					h(
						"div",
						{ className: "gw-head" },
						h(
							"div",
							null,
							h("div", { className: "gw-title" }, t("page.title")),
							h("div", { className: "gw-sub" }, t("page.subtitle")),
						),
						h(
							"div",
							{ className: "gw-head-actions" },
							h(
								"span",
								{ className: "gw-pill" },
								h("span", { className: `gw-dot ${isOn ? "is-on" : ""}` }),
								status === null ? t("page.loading") : isOn ? t("page.on") : t("page.off"),
							),
							h("button", { type: "button", className: "gw-btn", onClick: load }, t("page.refresh")),
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
