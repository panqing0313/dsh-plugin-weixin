window.__ModuleLoader__.load({
	id: "dsh-plugin-weixin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region schema thunks (minimal strict codecs; wire is plain JSON)
		let _str$value;
		const _str = () => (_str$value ??= intersection(string(), unknown()));
		let _strMap$value;
		const _strMap = () => (_strMap$value ??= intersection(record(string()), unknown()));
		let _num$value;
		const _num = () => (_num$value ??= intersection(number(), unknown()));
		let _statusResult$value;
		const _statusResult = () => (_statusResult$value ??= intersection(unknown(), unknown()));

		function intersection(left, right) {
			return { type: "intersection", left, right };
		}
		function string() {
			return { type: "string" };
		}
		function number() {
			return { type: "number" };
		}
		function record(key) {
			return { type: "record", key };
		}
		function unknown() {
			return { type: "unknown" };
		}
		//#endregion

		const PKG = "dsh-plugin-weixin";
		// Kept in step with package.json by bin/release.mjs bumpVersion() — the card
		// cannot import package.json, so the release script rewrites this line.
		const PLUGIN_VERSION = "0.7.0";
		const NS = "dshPluginWeixin";

		const TYPERT_REMOTE = {
			package: PKG,
			descriptors: [
				// weixin namespace (WeixinLoginController)
				{
					id: `${PKG}#weixin/startLogin`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "startLogin",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/startLogin:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/poll`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "poll",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/poll:param`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/poll:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/submitVerifyCode`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "submitVerifyCode",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:p0`, create: _str } },
						{ name: "code", wire: "code", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/cancel`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "cancel",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/cancel:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/cancel:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/status`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/status:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/logout`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "logout",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/logout:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/logout:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/sessions`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "sessions",
					invocation: { kind: "direct" },
					parameters: [],
					// `unknown ∩ unknown`, like every other result here: the
					// protocol requires a strict codec, and this one accepts any
					// shape, so adding a field to a session line cannot make the
					// card fail to mount.
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/sessions:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/useSession`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "useSession",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "conversationId", wire: "conversationId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:p0`, create: _str } },
						{ name: "index", wire: "index", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:p1`, create: _num } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/removeSession`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "removeSession",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "conversationId", wire: "conversationId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:p0`, create: _str } },
						{ name: "index", wire: "index", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:p1`, create: _num } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/pause`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "pause",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/pause:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/pause:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/resume`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "resume",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/resume:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/resume:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/label`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "label",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/label:p0`, create: _str } },
						{ name: "text", wire: "text", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/label:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/label:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/allowlist`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "allowlist",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p0`, create: _str } },
						{ name: "senders", wire: "senders", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p1`, create: _str } },
						{ name: "chats", wire: "chats", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p2`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:result`, create: _statusResult },
				},
				// weixinAsr namespace (AsrController)
				{
					id: `${PKG}#weixinAsr/listModels`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "listModels",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/listModels:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/setModelDir`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "setModelDir",
					invocation: { kind: "direct" },
					parameters: [{ name: "dir", wire: "dir", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setModelDir:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setModelDir:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/downloadModel`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "downloadModel",
					invocation: { kind: "direct" },
					parameters: [{ name: "repo", wire: "repo", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadModel:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadModel:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/downloadStatus`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "downloadStatus",
					invocation: { kind: "direct" },
					parameters: [{ name: "repo", wire: "repo", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadStatus:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadStatus:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/getDownloadSettings`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "getDownloadSettings",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/getDownloadSettings:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/setDownloadSettings`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "setDownloadSettings",
					invocation: { kind: "direct" },
					// `wire` MUST equal the parameter name. Two parameters may not
					// share a wire field, so a second `wire: "input"` would throw
					// at mount time and take the whole plugin down with it.
					parameters: [
						{ name: "endpoint", wire: "endpoint", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:p0`, create: _str } },
						{ name: "proxy", wire: "proxy", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:result`, create: _statusResult },
				},
				// weixinConfig namespace (ConfigController) — the options form.
				{
					id: `${PKG}#weixinConfig/list`,
					service: "configController",
					namespace: "weixinConfig",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/list:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinConfig/save`,
					service: "configController",
					namespace: "weixinConfig",
					method: "save",
					invocation: { kind: "direct" },
					// The batch is a JSON string, not a structured array: the wire
					// validates each parameter against a declared codec and this
					// plugin's codec vocabulary has no array node, so an array
					// parameter would be refused before the method ran.
					parameters: [
						{ name: "entriesJson", wire: "entriesJson", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:p0`, create: _str } },
						{ name: "lang", wire: "lang", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinConfig/reset`,
					service: "configController",
					namespace: "weixinConfig",
					method: "reset",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "pathsJson", wire: "pathsJson", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/reset:p0`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/reset:result`, create: _statusResult },
				},
			],
		};

		//#region UI components

		/** Outcome of a chooser attempt, so the caller can say what happened. */
		const PICK_CANCELLED = "cancelled";
		const PICK_UNAVAILABLE = "unavailable";

		/**
		 * Where models may be downloaded from.
		 *
		 * The mirror first because the official site is unreachable on a
		 * degraded international route while the mirror works — measured on this
		 * machine: huggingface.co completes a TCP handshake and then transfers
		 * nothing, and its weight CDN does not answer at all.
		 *
		 * `custom` carries no endpoint: it exists so the radio group can show
		 * that an endpoint set elsewhere is in effect, and choosing it is a
		 * no-op rather than a silent reset to a default.
		 */
		const SOURCE_CHOICES = [
			{
				id: "mirror",
				endpoint: "https://hf-mirror.com",
				labelZh: "国内镜像（推荐）",
				labelEn: "Mirror (recommended)",
			},
			{
				id: "official",
				endpoint: "https://huggingface.co",
				labelZh: "官方站 huggingface.co",
				labelEn: "Official huggingface.co",
			},
			{ id: "custom", endpoint: "", labelZh: "自定义地址", labelEn: "Custom" },
		];

		/**
		 * Whether the download goes through a proxy.
		 *
		 * `direct` is the default because it is what works on an unproxied
		 * network; naming a proxy when there is none breaks a download that
		 * would otherwise have succeeded.
		 */
		const PROXY_CHOICES = [
			{
				id: "direct",
				labelZh: "直连",
				labelEn: "Direct",
				hintZh: "不使用代理",
				hintEn: "No proxy",
			},
			{
				id: "custom",
				labelZh: "使用代理",
				labelEn: "Use a proxy",
				hintZh: "例如 http://127.0.0.1:7897",
				hintEn: "e.g. http://127.0.0.1:7897",
			},
		];

		/**
		 * Open the host's native directory chooser.
		 *
		 * The shell mounts the workspace controller's `directoryPicker` Remote on
		 * every platform — the web client's platform-neutral assembly calls
		 * `$mount` for it — so the Remote is the ordinary path:
		 *
		 *  1. `ctx.remote.directoryPicker.pick()` — the ordinary path.
		 *  2. `globalThis.__DSH_DIRECTORY_PICKER__.pick()` — the Electron IPC
		 *     bridge. It is injected only when `location.protocol` is
		 *     `dsh-app:`, so on the http Web GUI it is absent by design.
		 *
		 * `ctx` MUST be a context that declares `remote.directoryPicker`. Every
		 * namespace is its own Cordis service, and reading an undeclared service
		 * yields `undefined` silently rather than throwing — which is exactly how
		 * a mounted picker came to look absent.
		 *
		 * Returns `{ok: true, path}` with a real path, `{ok: false, reason}`
		 * with PICK_CANCELLED when the operator dismissed the dialog, or
		 * PICK_UNAVAILABLE when nothing could be reached. Cancelling is not an
		 * error, but it must not be reported as a missing capability: collapsing
		 * the two is what made a working chooser look broken.
		 */
		async function pickDirectory(ctx) {
			const picker = ctx.remote?.directoryPicker;
			if (picker?.pick !== undefined) {
				try {
					// `pick` takes no positional arguments. Its descriptor is
					// `parameters: []` with `cancellation: {parameter: "signal"}`,
					// so the signal travels on the call options, never as arg 0.
					const path = unwrap(await picker.pick());
					return typeof path === "string" && path !== ""
						? { ok: true, path }
						: { ok: false, reason: PICK_CANCELLED };
				} catch (error) {
					// Dismissing the dialog is reported as a cancellation. Any
					// other failure is a real fault and falls through so the
					// bridge, when present, still gets its chance.
					if (isCancellation(error)) return { ok: false, reason: PICK_CANCELLED };
				}
			}
			const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
			if (bridge?.pick !== undefined) {
				try {
					const path = await bridge.pick();
					return typeof path === "string" && path !== ""
						? { ok: true, path }
						: { ok: false, reason: PICK_CANCELLED };
				} catch {
					return { ok: false, reason: PICK_UNAVAILABLE };
				}
			}
			return { ok: false, reason: PICK_UNAVAILABLE };
		}

		/**
		 * Unwrap a Remote invocation result.
		 *
		 * Every client Remote call resolves to an envelope — `{ok: true, value}`
		 * on success, `{ok: false, error}` for a withdrawal, cancellation or
		 * carrier fault — never to the bare host return value. Reading the host
		 * fields straight off that envelope yields `undefined` for everything,
		 * which is what made the QR image and the model list render empty.
		 */
		function unwrap(result) {
			if (result !== null && typeof result === "object" && "ok" in result) {
				if (!result.ok) throw result.error ?? new Error("remote call failed");
				return result.value;
			}
			// Already bare (older carrier, or a stubbed call in tests).
			return result;
		}

		/** Call a Remote method and return its unwrapped host value. */
		async function callRemote(fn, ...args) {
			return unwrap(await fn(...args));
		}

		/**
		 * Whether a Remote failure is a cancellation rather than a fault.
		 *
		 * The carrier reports a withdrawn and a cancelled invocation through the
		 * same `{ok: false, error}` envelope, distinguished only by the error
		 * code, so the code is what has to be read. Dismissing a file dialog is
		 * an ordinary outcome and must not be shown as a failure.
		 */
		function isCancellation(error) {
			const code = error?.code ?? error?.name;
			return code === "cancelled" || code === "canceled" || code === "aborted" || code === "AbortError";
		}

		function useLocaleText(ctx) {
			// Simple bilingual labels without the locale dictionaries: the plugin
			// card stays self-contained and reads the client's current language.
			//
			// The service DSH actually provides exposes `getSnapshot()` /
			// `getLocale()` returning `{ active: "zh" | "en", ... }`, plus
			// `resolveText()`. There is no `locale.current.language`, which is what
			// this used to read -- so on an English client every lookup fell
			// through to the `"zh"` default and the card rendered Chinese next to
			// an English shell. The older shapes are kept as fallbacks because
			// this plugin is installed into whatever DSH the user runs, and the
			// service is not versioned with it.
			const snapshot = ctx.locale?.getSnapshot?.() ?? ctx.locale?.getLocale?.();
			// `locale.current` is a function on some hosts and an object on others,
			// so accept either rather than picking up the function itself.
			const rawCurrent = typeof ctx.locale?.current === "function" ? ctx.locale.current() : ctx.locale?.current;
			const lang =
				snapshot?.active ??
				(typeof rawCurrent === "string" ? rawCurrent : rawCurrent?.language) ??
				ctx.locale?.language ??
				"zh";
			const zh = typeof lang === "string" && lang.toLowerCase().startsWith("zh");
			return {
				lang,
				t: (en, zhText) => (zh ? zhText : en),
			};
		}

		//#region design vocabulary

		/**
		 * The host's design tokens, so this card follows the app's light and dark
		 * themes instead of hardcoding colors that only work in one of them.
		 *
		 * The fallbacks are the light-theme values, and they matter: a token the
		 * running shell does not define would otherwise resolve to nothing and
		 * render as `transparent`/`inherit`, i.e. invisible text on some themes.
		 */
		const C = {
			labelPrimary: "var(--dsw-alias-label-primary, #1f2329)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary, #9aa0a6)",
			border: "var(--dsw-alias-border-l2)",
			surface: "var(--dsw-alias-bg-layer-1, #fff)",
			surfaceSunken: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
			moduleFill: "var(--dsw-alias-bg-module-platform)",
			brand: "var(--dsw-alias-brand-primary)",
			primaryFill: "var(--dsw-alias-button-primary-fill)",
			onPrimary: "var(--dsw-alias-label-primary-foreground)",
			success: "var(--dsw-alias-state-success-primary, #22a06b)",
			successSubtle: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			danger: "var(--dsw-alias-state-error-primary, #d92d20)",
			warn: "var(--dsw-alias-state-warn-primary, #d97706)",
			warnSubtle: "var(--dsw-alias-state-warn-tertiary, #fff4e5)",
			idle: "var(--dsw-alias-label-dimmed, #9aa0a6)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
		};

		const RADIUS = { card: 12, control: 8, pill: 999 };

		/** A panel that groups related controls, matching the host's own cards. */
		const panelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "13px 15px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.card,
			background: C.moduleFill,
			color: C.labelPrimary,
		};

		/** Secondary text: real token color, not a faded primary. */
		const hintStyle = { margin: 0, fontSize: 13, lineHeight: "20px", color: C.labelSecondary };
		const captionStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: C.labelTertiary };

		/** The card's own section heading inside a panel. */
		const panelTitleStyle = { margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: C.labelPrimary };

		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			boxSizing: "border-box",
			minHeight: 32,
			padding: "4px 12px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.control,
			background: C.surface,
			color: C.labelPrimary,
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			whiteSpace: "nowrap",
			cursor: "pointer",
		};
		const primaryButtonStyle = {
			...buttonStyle,
			borderColor: C.primaryFill,
			background: C.primaryFill,
			color: C.onPrimary,
		};
		/** `:disabled` cannot be expressed inline, so callers pass the flag. */
		const buttonStyleFor = (disabled) => (disabled ? { ...buttonStyle, opacity: 0.5, cursor: "default" } : buttonStyle);

		const inputStyle = {
			boxSizing: "border-box",
			flex: 1,
			minWidth: 0,
			minHeight: 32,
			padding: "4px 10px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.control,
			background: C.surface,
			color: C.labelPrimary,
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
		};

		/**
		 * A status dot.
		 *
		 * Color alone must not carry the meaning, so every caller pairs this with
		 * a label; the dot is what makes the state scannable at a glance.
		 */
		function dotStyle(kind) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: kind === "ok" ? C.success : kind === "bad" ? C.danger : kind === "warn" ? C.warn : C.idle,
			};
		}

		/** A small pill for a state worth calling out, e.g. "expired". */
		function pillStyle(kind) {
			const bad = kind === "bad";
			return {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "1px 8px",
				borderRadius: RADIUS.pill,
				fontSize: 12,
				lineHeight: "18px",
				background: bad ? "var(--dsw-alias-state-error-subtle, rgba(217, 45, 32, 0.12))" : C.successSubtle,
				color: bad ? C.danger : C.success,
				whiteSpace: "nowrap",
			};
		}

		/** An inline notice for a problem the operator has to act on. */
		const noticeStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: `1px solid ${C.warn}`,
			borderRadius: RADIUS.control,
			background: C.warnSubtle,
			color: C.labelPrimary,
			fontSize: 13,
			lineHeight: "20px",
		};

		// A determinate bar reads as measured progress; it is only rendered when
		// the CLI actually reported a percentage, never as decoration.
		const progressTrackStyle = {
			height: 6,
			borderRadius: RADIUS.pill,
			background: C.surfaceSunken,
			overflow: "hidden",
			maxWidth: 320,
		};

		const progressFillStyle = {
			height: "100%",
			borderRadius: RADIUS.pill,
			background: C.brand,
			transition: "width 240ms ease",
		};

		//#endregion design vocabulary

		function LoginSection({ ctx, t }) {
			const [state, setState] = react.useState({ phase: "idle" }); // idle|qr|needcode|confirmed|failed|blocked
			const [qrUrl, setQrUrl] = react.useState(null);
			const [qrDataUrl, setQrDataUrl] = react.useState(null);
			const [sessionKey, setSessionKey] = react.useState(null);
			const [code, setCode] = react.useState("");
			const [message, setMessage] = react.useState("");
			const [accounts, setAccounts] = react.useState([]);
			const [sessionExpired, setSessionExpired] = react.useState(false);
			const [loggingOut, setLoggingOut] = react.useState(false);
			const [logoutNotice, setLogoutNotice] = react.useState("");
			const [copied, setCopied] = react.useState(false);
			const pollRef = react.useRef(null);
			// The session key lives in a ref as well as in state: the poll loop is
			// asynchronous, and a closure over the render's `sessionKey` would keep
			// the null the component started with forever.
			const sessionKeyRef = react.useRef(null);

			const stopPolling = react.useCallback(() => {
				sessionKeyRef.current = null;
				if (pollRef.current) {
					clearTimeout(pollRef.current);
					pollRef.current = null;
				}
			}, []);

			const refreshStatus = react.useCallback(async () => {
				try {
					const s = await callRemote(() => ctx.remote.weixin.status());
					setAccounts(s?.accounts ?? []);
					setSessionExpired(s?.sessionExpired === true);
				} catch {
					// remote not mounted yet
				}
			}, [ctx]);

			react.useEffect(() => {
				refreshStatus();
				return () => {
					stopPolling();
					if (sessionKey) ctx.remote.weixin.cancel(sessionKey).catch(() => {});
				};
			}, [refreshStatus, stopPolling]);

			const start = async () => {
				setMessage("");
				setCopied(false);
				try {
					const r = await callRemote(() => ctx.remote.weixin.startLogin());
					setQrUrl(r?.qrcodeUrl ?? null);
					setQrDataUrl(r?.qrDataUrl ?? null);
					setSessionKey(r?.sessionKey);
					setState({ phase: "qr" });
					stopPolling();
					sessionKeyRef.current = r?.sessionKey ?? null;
					// The server holds each status request open for ~30s, so this is a
					// self-scheduling loop rather than a fixed interval: the next call is
					// queued only once the previous one has come back. A 1s interval left
					// ~30 requests in flight at once and swallowed every answer -- which is
					// where a scan shows up -- so the card could never leave the QR page.
					const tick = async () => {
						pollRef.current = null;
						const key = sessionKeyRef.current;
						if (!key) return;
						let next = false;
						try {
							const p = await callRemote(() => ctx.remote.weixin.poll(key));
							if (p.status === "confirmed") {
								stopPolling();
								setState({ phase: "confirmed" });
								setMessage(p.accountId ? `${t("Bound account", "已绑定账号")}: ${p.accountId}` : "");
								refreshStatus();
							} else if (p.status === "need_verifycode") {
								setState({ phase: "needcode" });
								setMessage(p.message ?? "");
								next = true;
							} else if (p.status === "refreshed") {
								setQrUrl(p.qrcodeUrl ?? null);
								setQrDataUrl(p.qrDataUrl ?? null);
								setState({ phase: "qr" });
								next = true;
							} else if (p.status === "failed") {
								stopPolling();
								setState({ phase: "failed" });
								setMessage(p.message ?? "");
								// The host can already hold a credential when a login reports failure,
								// so re-read the real state instead of trusting the message alone.
								refreshStatus();
							} else if (p.status === "alreadyBound") {
								// The bot is still bound on the server but this host no longer holds
								// the token, and only the phone can break that link. It is a dead end
								// until then, so it gets its own state rather than a red caption.
								stopPolling();
								setState({ phase: "blocked" });
								setMessage(p.message ?? "");
								refreshStatus();
							} else {
								next = true;
							}
						} catch (err) {
							// A forgotten session is terminal: the host no longer holds this login,
							// so polling it again can only fail. Anything else is transient.
							if (err?.code === "no_login") {
								stopPolling();
								setState({ phase: "failed" });
								setMessage(t("This login is no longer active. Scan again to log in.", "本次登录已失效，请重新扫码登录。"));
								refreshStatus();
							} else {
								next = true;
							}
						}
						if (next && sessionKeyRef.current) {
							pollRef.current = setTimeout(tick, 1000);
						}
					};
					pollRef.current = setTimeout(tick, 0);
				} catch (err) {
					setState({ phase: "failed" });
					setMessage(String(err?.message ?? err));
				}
			};

			const submitCode = async () => {
				if (!sessionKey || !code.trim()) return;
				await callRemote(() => ctx.remote.weixin.submitVerifyCode(sessionKey, code.trim()));
				setCode("");
				setState({ phase: "qr" });
				setMessage("");
			};

			const cancel = async () => {
				stopPolling();
				if (sessionKey) await ctx.remote.weixin.cancel(sessionKey).catch(() => {});
				setState({ phase: "idle" });
				setMessage("");
			};

			/**
			 * Forget the bound account, after asking.
			 *
			 * The confirmation is not ceremony: the credentials are the only copy
			 * of the login, and recovering them means scanning again. It also
			 * names the account, because an operator with more than one bound
			 * account must see which one is about to go.
			 */
			const leaveAccount = async () => {
				const which = accounts.map((a) => a.accountId).join(", ");
				const ok = globalThis.confirm?.(
					t(
						`Log out ${which || "this account"}? Its saved credentials are deleted and you will have to scan the QR code again.`,
						`确定退出登录 ${which || "当前账号"}？将删除已保存的登录凭证，需要重新扫码才能再次使用。`,
					),
				);
				if (ok === false) return;
				setLoggingOut(true);
				setLogoutNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.logout(""));
					const removed = Array.isArray(r?.removed) ? r.removed : [];
					if (removed.length === 0) {
						setLogoutNotice(t("No saved account was found to remove.", "没有找到可退出的账号。"));
					} else {
						setLogoutNotice(t(
							"Credentials deleted. Reload DSH to stop the running poll loop, then scan again to re-bind.",
							"凭证已删除。请重载 DSH 以停止正在运行的轮询，然后重新扫码绑定。",
						));
					}
					await refreshStatus();
				} catch (err) {
					setLogoutNotice(String(err?.message ?? err));
				} finally {
					setLoggingOut(false);
				}
			};

			const copyLink = async () => {
				if (!qrUrl) return;
				try {
					await navigator.clipboard.writeText(qrUrl);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					setMessage(t("Copy failed, please copy manually", "复制失败，请手动复制"));
				}
			};

			// Per-account controls. The card's top line answers "is anything
			// bound?"; these rows answer "is *this* account alive, and what can I
			// do about it" — pause/resume without losing the login, rename to
			// something an operator recognizes, and a per-account logout so a
			// second bound account is not dragged down with the first.
			const [busyAccount, setBusyAccount] = react.useState(null);
			const [accountNotice, setAccountNotice] = react.useState("");
			// Inline edit row state. The desktop shell is an Electron renderer,
			// and Electron does not implement window.prompt — it returns
			// undefined, so a prompt-based editor silently did nothing. The
			// editor therefore lives in the card: an input row under the
			// account being edited, committed by a button instead of a modal.
			const [editing, setEditing] = react.useState(null); // { accountId, kind: "label"|"allowlist", draft }

			const setPausedFor = async (account, paused) => {
				setBusyAccount(account.accountId);
				setAccountNotice("");
				try {
					// Each branch wraps its own call: the envelope unwrap is
					// per-invocation, and a shared wrapper around the ternary
					// would leave the second branch's result unwrapped.
					await (paused
						? callRemote(() => ctx.remote.weixin.pause(account.accountId))
						: callRemote(() => ctx.remote.weixin.resume(account.accountId)));
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			const renameAccount = (account) => {
				setEditing({ accountId: account.accountId, kind: "label", draft: account.label ?? "" });
			};

			const editAllowlist = (account) => {
				const current = (account.allowedSenders ?? []).join(", ");
				setEditing({ accountId: account.accountId, kind: "allowlist", draft: current });
			};

			const submitEditing = async () => {
				if (!editing) return;
				const { accountId, kind, draft } = editing;
				setBusyAccount(accountId);
				setAccountNotice("");
				try {
					if (kind === "label") {
						await callRemote(() => ctx.remote.weixin.label(accountId, draft));
					} else {
						await callRemote(() => ctx.remote.weixin.allowlist(accountId, draft, ""));
					}
					setEditing(null);
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			const logoutOne = async (account) => {
				const ok = globalThis.confirm?.(
					t(
						`Log out ${account.label || account.accountId}? Its saved credentials are deleted and you will have to scan the QR code again.`,
						`确定退出登录 ${account.label || account.accountId}？将删除该账号的登录凭证，需要重新扫码才能再次使用。`,
					),
				);
				if (ok === false) return;
				setBusyAccount(account.accountId);
				setAccountNotice("");
				try {
					await callRemote(() => ctx.remote.weixin.logout(account.accountId));
					await refreshStatus();
				} catch (err) {
					setAccountNotice(String(err?.message ?? err));
				} finally {
					setBusyAccount(null);
				}
			};

			// "silent for …" from the registry's lastSeenAt, coarse on purpose:
			// the point is to spot a dead account, not to time anything.
			const seenText = (iso) => {
				if (typeof iso !== "string" || iso === "") return null;
				const ms = Date.now() - Date.parse(iso);
				if (!Number.isFinite(ms) || ms < 0) return null;
				const minutes = Math.floor(ms / 60000);
				if (minutes < 1) return t("active just now", "刚刚有消息");
				if (minutes < 60) return t(`last message ${minutes} min ago`, `${minutes} 分钟前有消息`);
				const hours = Math.floor(minutes / 60);
				if (hours < 24) return t(`last message ${hours} h ago`, `${hours} 小时前有消息`);
				return t(`last message ${Math.floor(hours / 24)} d ago`, `${Math.floor(hours / 24)} 天前有消息`);
			};

			const bound = accounts.length > 0;
			// One status line: a colored dot for the state, the account as the
			// value. Stating "no account" in grey text made a real state read
			// like absent information, and an expired session looked identical
			// to a healthy one because the token file is complete either way.
			const statusKind = sessionExpired ? "bad" : bound ? "ok" : "idle";
			const statusText = sessionExpired
				? t("Session expired", "登录已过期")
				: bound
					? t("Bound", "已绑定")
					: t("Not logged in", "未登录");
			// The per-account rows are the card's answer to "which account is
			// which, and is it actually receiving": label (or raw id) plus the
			// registry's last message time, then the four controls. Pausing is
			// deliberately not logout — the credential stays, so resuming needs
			// no re-scan.
			const accountRows = bound
				? createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						accounts.map((account) => {
							const busy = busyAccount === account.accountId;
							const seen = seenText(account.lastSeenAt);
							return createElement("div", {
									key: account.accountId,
									style: {
										display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
										padding: "7px 10px",
										border: `1px solid ${C.border}`,
										borderRadius: RADIUS.control,
										background: C.surfaceSunken,
									},
								},
								createElement("span", {
									style: { fontSize: 13, fontWeight: 500, color: C.labelPrimary },
								}, account.label || account.accountId),
								account.label ? createElement("span", {
									style: { fontSize: 12, color: C.labelSecondary },
								}, account.accountId) : null,
								account.paused ? createElement("span", { style: pillStyle("idle") }, t("paused", "已暂停")) : null,
								seen ? createElement("span", { style: { fontSize: 12, color: C.labelSecondary } }, seen) : null,
								createElement("span", { style: { flex: 1 } }),
								createElement("button", {
									onClick: () => renameAccount(account),
									style: buttonStyleFor(false),
								}, t("Rename", "改名称")),
								createElement("button", {
									onClick: () => editAllowlist(account),
									style: buttonStyleFor(false),
								}, t("Allowlist", "白名单")),
								createElement("button", {
									onClick: () => setPausedFor(account, !account.paused),
									disabled: busy,
									style: buttonStyleFor(busy),
								}, account.paused
									? t("Resume", "恢复")
									: busy ? t("Pausing…", "正在暂停…") : t("Pause", "暂停")),
								createElement("button", {
									onClick: () => logoutOne(account),
									disabled: busy,
									style: buttonStyleFor(busy),
								}, busy ? t("Logging out…", "正在退出…") : t("Log out", "退出登录")),
								editing?.accountId === account.accountId
									? createElement("div", {
											style: { display: "flex", alignItems: "center", gap: 6, flexBasis: "100%" },
										},
										createElement("input", {
											value: editing.draft,
											onChange: (event) => setEditing({ ...editing, draft: event.target.value }),
											placeholder: editing.kind === "allowlist"
												? t("comma-separated sender ids; empty = global list", "逗号分隔的发送者 id；留空 = 用全局白名单")
												: t("e.g. work account", "例如：工作号"),
											style: inputStyle,
										}),
										createElement("button", {
											onClick: () => void submitEditing(),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Save", "保存")),
										createElement("button", {
											onClick: () => setEditing(null),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Cancel", "取消")))
									: null);
						}))
				: null;

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },

				//#region status
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" } },
					createElement("span", { style: dotStyle(statusKind) }),
					createElement("span", { style: { fontSize: 14, fontWeight: 500, color: C.labelPrimary } }, statusText),
					bound
						? createElement("span", { style: { fontSize: 13, color: C.labelSecondary } },
								accounts.map((a) => a.accountId).join(", "))
						: null,
					sessionExpired ? createElement("span", { style: pillStyle("bad") }, t("action needed", "需要处理")) : null),
				//#endregion status

				// One row per bound account: identity, liveness, controls.
				accountRows,

				accountNotice
					? createElement("div", { style: noticeStyle },
							createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
							createElement("span", null, accountNotice))
					: null,

				// The expiry is the one state where the operator must act, and it
				// cannot be inferred from the account list, so it gets a notice
				// rather than a line of colored text.
				sessionExpired
					? createElement("div", { style: noticeStyle },
							createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
							createElement("span", null, t(
								"The saved session has expired, so incoming messages are not being received. Scan again to log in.",
								"登录已过期，当前收不到微信消息。请重新扫码登录。",
							)))
					: null,

				state.phase === "idle" || state.phase === "confirmed" || state.phase === "failed"
					|| state.phase === "blocked"
					? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							createElement("button", {
								onClick: start,
								style: primaryButtonStyle,
							}, bound || sessionExpired
								? sessionExpired
									? t("Scan again to log in", "重新扫码登录")
									: t("Add another WeChat account", "新增账号登录")
								: t("Scan QR code to log in", "扫码登录微信")),
							// Only offered when there is something to forget. A
							// logout is destructive, so it is never the primary
							// button and it asks first.
							bound
								? createElement("button", {
										onClick: leaveAccount,
										disabled: loggingOut,
										style: buttonStyleFor(loggingOut),
									}, loggingOut
										? t("Logging out…", "正在退出…")
										: t("Log out", "退出登录"))
								: null)
					: null,

				logoutNotice
					? createElement("div", { style: hintStyle }, logoutNotice)
					: null,

				state.phase === "qr"
					? createElement("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								gap: 10,
								padding: "15px",
								border: `1px solid ${C.border}`,
								borderRadius: RADIUS.card,
								background: C.surfaceSunken,
							},
						},
							// A QR on a bare background is unreliable to scan: the
							// quiet zone has to be light, and the surrounding panel may
							// be dark.
							createElement("div", {
									style: { padding: 10, borderRadius: RADIUS.control, background: "#fff", lineHeight: 0 },
								},
								qrDataUrl
									? createElement("img", { src: qrDataUrl, alt: "QR", style: { width: 200, height: 200, display: "block" } })
									// `qrUrl` is a LOGIN LINK (https://liteapp.weixin.qq.com/q/…),
									// never an image: putting it in an <img src> renders the
									// browser's broken-image glyph, which is what a Windows user
									// saw instead of a QR code. When there is no image, say so
									// and point at the buttons below rather than showing a
									// torn-page icon.
									: createElement("div", { style: { width: 200, height: 200, display: "grid", placeItems: "center", textAlign: "center", padding: 12, color: C.labelTertiary, fontSize: 12, lineHeight: 1.6, boxSizing: "border-box" } },
											t("No QR image. Open the link below to scan it.", "二维码图片不可用，请点下面的「在浏览器打开」扫码"))),
							createElement("div", { style: hintStyle }, t("Scan with WeChat on your phone", "用手机微信扫码登录")),
							qrUrl
								? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" } },
										createElement("a", {
											href: qrUrl,
											target: "_blank",
											rel: "noopener noreferrer",
											style: { ...buttonStyle, textDecoration: "none" },
										}, t("Open link in browser", "在浏览器打开")),
										createElement("button", { onClick: copyLink, style: buttonStyle },
											copied ? t("Copied", "已复制") : t("Copy link", "复制链接")))
								: null,
							createElement("button", { onClick: cancel, style: buttonStyle }, t("Cancel", "取消")))
					: null,

				state.phase === "needcode"
					? createElement("div", { style: panelStyle },
							createElement("p", { style: hintStyle },
								message || t("Enter the verification code shown on your phone", "请输入手机上显示的验证码")),
							createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
								createElement("input", {
									value: code,
									onChange: (e) => setCode(e.target.value),
									placeholder: "123456",
									inputMode: "numeric",
									style: { ...inputStyle, maxWidth: 160 },
								}),
								createElement("button", { onClick: submitCode, style: primaryButtonStyle }, t("Submit", "提交")),
								createElement("button", { onClick: cancel, style: buttonStyle }, t("Cancel", "取消"))))
					: null,

				state.phase === "blocked" && message
					? createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, message))
					: null,

				message && state.phase !== "needcode" && state.phase !== "blocked"
					? createElement("div", { style: captionStyle }, message)
					: null,
			);
		}

		/**
		 * The About tab: version, update check, project links, where the data
		 * lives. The update check is browser-side on purpose — the card already
		 * runs in a renderer with `fetch`, and one GET against the npm registry
		 * needs no host round-trip or new Remote method. Registry misses are a
		 * normal outcome (GitHub may be unreachable in-network), so the failure
		 * text says so instead of implying the plugin is broken.
		 */
		function AboutSection({ ctx, t }) {
			const [checkState, setCheckState] = react.useState("idle");
			const [notice, setNotice] = react.useState("");

			const checkUpdate = async () => {
				setCheckState("busy");
				setNotice("");
				try {
					const response = await fetch(`https://registry.npmjs.org/${PKG}/latest`);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const meta = await response.json();
					const latest = typeof meta?.version === "string" ? meta.version : "";
					if (!latest) throw new Error("no version in registry answer");
					if (latest === PLUGIN_VERSION) {
						setCheckState("latest");
						setNotice(t(`Already on the latest version (${PLUGIN_VERSION}).`, `已是最新版本（${PLUGIN_VERSION}）。`));
					} else {
						setCheckState("outdated");
						setNotice(t(
							`A newer version is out: ${latest} (installed ${PLUGIN_VERSION}). Update with "npm install dsh-plugin-weixin@${latest}" or the plugin market.`,
							`有新版本：${latest}（当前 ${PLUGIN_VERSION}）。可用「npm install dsh-plugin-weixin@${latest}」或在插件市场更新。`,
						));
					}
				} catch (e) {
					setCheckState("error");
					setNotice(t(
						`Could not reach the npm registry (${String(e?.message ?? e)}). The network may be blocking it; the plugin itself is fine.`,
						`无法访问 npm registry（${String(e?.message ?? e)}）。可能是网络拦截，插件本身没有问题。`,
					));
				}
			};

			// The About tab reuses the card's own panel language (panelStyle /
			// panelTitleStyle) instead of bare text on the page background: the
			// first cut was plain divs and read as an afterthought next to the
			// other tabs.
			const linkStyle = { color: C.brand, textDecoration: "none" };
			const versionPill = {
				display: "inline-flex",
				alignItems: "center",
				padding: "1px 8px",
				borderRadius: RADIUS.pill,
				background: C.surfaceSunken,
				color: C.labelSecondary,
				fontSize: 12,
				lineHeight: "18px",
			};
			// createElement's first argument is the element TYPE, not its style:
			// passing the panelStyle OBJECT as the type is exactly the white
			// screen the user saw ("object is not a valid React element type"
			// thrown the moment this tab rendered). The style rides on props.
			const row = (title, body) => createElement("div", { style: panelStyle },
				createElement("p", { style: panelTitleStyle }, title),
				body);
			// A numbered step line for the usage guide. The number sits in a
			// sunken circle so the sequence reads at a glance, without tables.
			const step = (n, text) => createElement("div", { key: `s${n}`, style: { display: "flex", gap: 8, alignItems: "baseline" } },
				createElement("span", { style: { ...versionPill, flex: "none", minWidth: 20, justifyContent: "center", borderRadius: RADIUS.pill } }, String(n)),
				createElement("span", { style: hintStyle }, text));
			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				row(t("How to use", "使用说明"), [
					step(1, t("Open the 微信账号 tab and scan the QR code with WeChat — the account comes online at once, no reload needed.",
						"打开「微信账号」页签，用微信扫二维码——登录后立即生效，不用重启。")),
					step(2, t("In 授权, add the WeChat ids allowed to talk to your agent (everything else is refused).",
						"在「授权」里把允许使用 Agent 的微信 id 加进白名单（其余一律拒绝）。")),
					step(3, t("Message the bound WeChat from any allowed account; DSH replies in the same chat. Send /help there to see the commands.",
						"用白名单里的微信给机器人发消息，DSH 在同一会话里回复；微信里发 /help 可看全部命令。")),
					step(4, t("Use the 会话 tab for multiple DSH sessions per chat (/new, /list, /use), and pause an account there when you need quiet.",
						"「会话」页签可给一个微信会话挂多条 DSH 会话（/new、/list、/use）；需要安静时在「微信账号」页签暂停该账号。")),
				]),
				row(t("Version", "版本"), [
					createElement("div", { key: "v", style: { display: "flex", alignItems: "center", gap: 8 } },
						createElement("span", { style: versionPill }, `v${PLUGIN_VERSION}`),
						createElement("span", { style: hintStyle }, PKG)),
					createElement("div", { key: "b", style: { display: "flex", alignItems: "center", gap: 10 } },
						createElement("button", { onClick: checkUpdate, disabled: checkState === "busy", style: buttonStyleFor(checkState === "busy") },
							checkState === "busy" ? t("Checking…", "检查中…") : t("Check for updates", "检查更新")),
						notice ? createElement("span", { style: captionStyle }, notice) : null),
				]),
				row(t("Project", "项目"), [
					createElement("a", { key: "l", href: "https://github.com/panqing0313/dsh-plugin-weixin", target: "_blank", rel: "noreferrer", style: linkStyle },
						"github.com/panqing0313/dsh-plugin-weixin"),
					createElement("p", { key: "h", style: hintStyle },
						t("Scan a QR code to bind a personal WeChat as a bot, chat with multiple accounts, per-account allowlists, session lines, voice replies.",
							"扫码把个人微信绑成机器人：多账号、按账号白名单、会话线、语音回复。")),
				]),
				row(t("Data location", "数据位置"), createElement("p", { style: hintStyle },
					t("State lives in ~/.dsh/weixin (accounts, registry, sessions, logs). Uninstalling the plugin does not delete it; removing that folder clears everything.",
						"本地状态都在 ~/.dsh/weixin（账号、登记表、会话、日志）。卸载插件不会删除它们；删除该目录即清空全部状态。"))));
		}

		/**
		 * Session lines: one WeChat conversation can hold several DSH sessions.
		 *
		 * Read-only over the store: `/new` and `/use` are meant to be sent from
		 * WeChat, where the user already is. The card exists so the operator can
		 * see which line is live and jump back to an older one without having to
		 * remember its number.
		 */
		function SessionsSection({ ctx, t }) {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");

			const load = async () => {
				try {
					// `callRemote` already unwraps the carrier envelope, so `r` is
					// the host's own return value, not `{ok, value}`.
					const r = await callRemote(() => ctx.remote.weixin.sessions());
					setError("");
					setData(Array.isArray(r?.conversations) ? r.conversations : []);
				} catch (e) {
					setError(String(e?.message ?? e));
					setData(null);
				}
			};

			react.useEffect(() => {
				load();
			}, []);

			const pick = async (conversationId, index) => {
				setBusy(true);
				setNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.useSession(conversationId, index));
					if (r?.switched === false) {
						setNotice(r.error || t("Could not switch", "切换失败"));
					} else {
						setNotice(t("Switched. New messages go to this session.", "已切换，接下来的消息进入这条会话。"));
					}
					await load();
				} catch (e) {
					setNotice(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			const removeOne = async (conversationId, index, lineCount) => {
				// The card's only destructive session action, so it asks first —
				// same shape as logout. Deleting the line in use is allowed: the
				// store falls back to the first surviving line, and deleting the
				// last line removes the whole conversation entry (the next
				// message re-creates a fresh line), so the confirm never guards
				// an unreachable state.
				const last = lineCount <= 1;
				const ok = globalThis.confirm?.(
					t(
						"Delete this session line? Its context is dropped from the list; the conversation keeps its other lines.",
						last
							? "确定删除这条会话？这是最后一条会话线，删除后整个会话条目会移除，下一条消息会自动新建会话。"
							: "确定删除这条会话？它的上下文将从列表移除；该微信会话的其他会话线不受影响。",
					),
				);
				if (ok === false) return;
				setBusy(true);
				setNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.removeSession(conversationId, index + 1));
					if (r?.removed === false) {
						setNotice(r.error || t("Could not delete", "删除失败"));
					} else {
						setNotice(t("Deleted.", "已删除。"));
					}
					await load();
				} catch (e) {
					setNotice(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			if (error) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: panelTitleStyle }, t("Sessions", "会话")),
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, error)));
			}
			if (data === null) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: hintStyle }, t("Loading…", "加载中…")));
			}
			if (data.length === 0) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: panelTitleStyle }, t("Sessions", "会话")),
					createElement("p", { style: hintStyle },
						t("No conversation yet. Send the bot a message to start one.",
							"还没有会话。给机器人发一条消息就会创建。")));
			}

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				...data.map((conversation) => createElement("div", {
						key: conversation.conversationId,
						style: panelStyle,
					},
					createElement("p", { style: { ...panelTitleStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						// Tell accounts apart: the registry label (or the raw id)
						// when the conversation is scoped to an account, nothing for
						// a bare key left over from before multi-account support.
						typeof conversation.accountId === "string" && conversation.accountId !== ""
							? createElement("span", { style: pillStyle("ok") },
								typeof conversation.accountLabel === "string" && conversation.accountLabel !== ""
									? conversation.accountLabel
									: conversation.accountId)
							: null,
						createElement("span", null, conversation.conversationId)),
					createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
						...conversation.lines.map((line, index) => {
							const isActive = line.sessionId === conversation.active;
							return createElement("div", {
									key: line.sessionId,
									style: {
										display: "flex", alignItems: "center", gap: 8,
										padding: "7px 10px",
										border: `1px solid ${isActive ? C.brand : C.border}`,
										borderRadius: RADIUS.control,
										background: isActive ? C.surface : C.surfaceSunken,
									},
								},
								createElement("span", { style: { flex: "0 0 auto", color: isActive ? C.brand : C.idle } }, isActive ? "▶" : "·"),
								createElement("span", {
										style: {
											flex: "1 1 auto", minWidth: 0,
											fontSize: 13, lineHeight: "20px",
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
										},
									},
									`${index + 1}. ${line.title || t("(no messages yet)", "（尚无对话）")}`),
								isActive
									? createElement("span", { style: { flex: "0 0 auto", fontSize: 12, color: C.brand } }, t("in use", "使用中"))
									: createElement("span", { style: { flex: "0 0 auto" } },
										createElement("button", {
											onClick: () => pick(conversation.conversationId, index),
											disabled: busy,
											style: buttonStyleFor(busy),
										}, t("Use", "切换"))),
								// Delete is offered on EVERY row, including the one in use:
								// the store falls back to the first surviving line, and
								// deleting the last line removes the whole entry (the
								// next message re-creates one), so no confirm can orphan
								// the conversation.
								createElement("button", {
									onClick: () => void removeOne(conversation.conversationId, index, conversation.lines.length),
									disabled: busy,
									style: buttonStyleFor(busy),
								}, t("Delete", "删除")));
						})),
					createElement("p", { style: captionStyle },
						t("Send /new in WeChat to start another, /list to see them all.",
							"在微信里发 /new 开新会话，发 /list 查看全部。")))),
				notice
					? createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null, notice))
					: null);
		}

		/**
		 * Every configurable option, rendered from what the host reports.
		 *
		 * The form is data-driven on purpose: the host sends the field list
		 * (type, label, default, current value, where that value came from), and
		 * this component renders whatever arrives. Adding an option on the host
		 * therefore makes it editable here with no change to this file.
		 *
		 * Values are held as strings while editing — a text input has no other
		 * type — and the host coerces them, so this component never has to know
		 * whether "1500" is a number, a list, or a JSON blob.
		 */
		function ConfigSection({ ctx, t }) {
			const [groups, setGroups] = react.useState([]);
			const [draft, setDraft] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [message, setMessage] = react.useState("");
			const [error, setError] = react.useState("");
			const [configPath, setConfigPath] = react.useState("");
			const [openGroup, setOpenGroup] = react.useState("");
			// The host answers with localized validation messages, so it needs to
			// know which language the card is showing.
			const { lang } = useLocaleText(ctx);
			/**
			 * A Remote failure carries a stable `code` beside its message. The code
			 * is what makes a report actionable — "bad_value" points at the field's
			 * validation — so it is kept visible when the message alone would not
			 * identify the offending input.
			 */
			const messageOf = (err) => {
				const text = String(err?.message ?? err);
				const code = err?.code;
				return code && code !== "unknown" ? `${text} (${code})` : text;
			};

			const load = react.useCallback(async () => {
				try {
					const r = await callRemote(() => ctx.remote.weixinConfig.list());
					const next = {};
					for (const group of r?.groups ?? []) {
						for (const field of group.fields ?? []) next[field.path] = field.value;
					}
					setGroups(r?.groups ?? []);
					setDraft(next);
					setConfigPath(r?.configFile ?? "");
					setOpenGroup((current) => current || r?.groups?.[0]?.group || "");
					return r;
				} catch {
					// The remote may not be mounted yet; the card shows the
					// empty state rather than an error the user cannot act on.
					return undefined;
				}
			}, [ctx]);

			react.useEffect(() => {
				load();
			}, [load]);

			/** Which fields differ from what the host reports as saved. */
			const dirtyPaths = [];
			for (const group of groups) {
				for (const field of group.fields ?? []) {
					if (field.readOnly) continue;
					if (String(draft[field.path] ?? "") !== String(field.value ?? "")) {
						dirtyPaths.push(field.path);
					}
				}
			}

			const save = async () => {
				setBusy(true);
				setMessage("");
				setError("");
				try {
					// Only the changed fields are sent, so two people editing
					// different sections do not overwrite each other's work with
					// stale values they never touched.
					const entries = dirtyPaths.map((path) => ({ path, value: draft[path] ?? "" }));
					if (entries.length === 0) {
						setMessage(t("Nothing to save.", "没有需要保存的改动。"));
						return;
					}
					// The batch travels as a JSON string: the wire has no array
					// codec, so a structured array would be rejected at the gateway.
					await callRemote(() => ctx.remote.weixinConfig.save(JSON.stringify(entries), lang));
					await load();
					setMessage(t("Saved.", "已保存。"));
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			const resetAll = async () => {
				setBusy(true);
				setMessage("");
				setError("");
				try {
					const paths = groups.flatMap((group) =>
						(group.fields ?? []).filter((field) => !field.readOnly && field.source === "saved").map((field) => field.path));
					await callRemote(() => ctx.remote.weixinConfig.reset(JSON.stringify(paths)));
					await load();
					setMessage(t("Reset to defaults.", "已恢复默认值。"));
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			const resetOne = async (path) => {
				setBusy(true);
				setError("");
				try {
					await callRemote(() => ctx.remote.weixinConfig.reset(JSON.stringify([path])));
					await load();
					setMessage("");
				} catch (err) {
					setError(messageOf(err));
				} finally {
					setBusy(false);
				}
			};

			if (groups.length === 0) {
				return createElement("div", { style: panelStyle },
					createElement("p", { style: hintStyle }, t("Loading options…", "正在读取配置…")));
			}

			const renderField = (field) => {
				const value = draft[field.path] ?? "";
				const changed = String(value) !== String(field.value ?? "");
				const set = (next) => setDraft((current) => ({ ...current, [field.path]: next }));
				// The control is chosen by the type the host declared, so the
				// browser enforces the same shape the host will validate.
				let control;
				if (field.type === "boolean") {
					control = createElement("label", {
							style: { display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 },
						},
						createElement("input", {
							type: "checkbox",
							checked: value === true || value === "true",
							disabled: field.readOnly,
							onChange: (event) => set(event.target.checked),
							style: { width: 15, height: 15, accentColor: C.primaryFill, cursor: "pointer" },
						}),
						createElement("span", { style: { color: C.labelPrimary } },
							value === true || value === "true" ? t("On", "开启") : t("Off", "关闭")));
				} else if (field.type === "enum") {
					control = createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
						...(field.options ?? []).map((option) =>
							createElement("label", {
									key: option.value,
									style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 },
								},
								createElement("input", {
									type: "radio",
									name: `weixin-${field.path}`,
									checked: value === option.value,
									disabled: field.readOnly,
									onChange: () => set(option.value),
									style: { accentColor: C.primaryFill, cursor: "pointer" },
								}),
								createElement("span", {}, t(option.label, option.labelEn)))));
				} else if (field.type === "stringList" || field.type === "text") {
					control = createElement("textarea", {
						value,
						disabled: field.readOnly,
						rows: field.type === "stringList" ? 3 : 4,
						onChange: (event) => set(event.target.value),
						style: { ...inputStyle, flex: "initial", width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: "20px" },
					});
				} else if (field.type === "number") {
					control = createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						createElement("input", {
							type: "number",
							value,
							disabled: field.readOnly,
							min: field.min,
							max: field.max,
							step: field.step,
							onChange: (event) => set(event.target.value),
							style: { ...inputStyle, flex: "0 0 auto", width: 160 },
						}),
						field.unit ? createElement("span", { style: captionStyle }, t(field.unit, field.unitEn)) : null);
				} else {
					control = createElement("input", {
						type: "text",
						value,
						disabled: field.readOnly,
						onChange: (event) => set(event.target.value),
						style: { ...inputStyle, width: "100%" },
					});
				}
				return createElement("div", {
						key: field.path,
						style: { display: "flex", flexDirection: "column", gap: 5, padding: "10px 0", borderTop: `1px solid ${C.border}` },
					},
					createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						createElement("span", { style: { fontSize: 13, fontWeight: 600, color: C.labelPrimary } },
							t(field.label, field.labelEn)),
						// Where the value comes from decides what a reset will
						// do, so it is shown rather than inferred.
						field.source === "saved"
							? createElement("span", { style: { ...captionStyle, padding: "1px 6px", border: `1px solid ${C.border}`, borderRadius: RADIUS.pill } },
									t("saved", "已保存"))
							: field.source === "config"
								? createElement("span", { style: { ...captionStyle, padding: "1px 6px", border: `1px solid ${C.border}`, borderRadius: RADIUS.pill } },
										t("from config", "来自配置"))
								: null,
						field.readOnly
							? createElement("span", { style: captionStyle }, t("(read-only here)", "（此处只读）"))
							: null,
						field.source === "saved" && !field.readOnly
							? createElement("button", {
									onClick: () => resetOne(field.path),
									disabled: busy,
									style: { ...buttonStyle, minHeight: 24, padding: "1px 8px", fontSize: 12, marginLeft: "auto" },
								}, t("Reset", "恢复默认"))
							: null),
					control,
					createElement("p", { style: captionStyle }, t(field.hint, field.hintEn)),
					changed
						? createElement("p", { style: { ...captionStyle, color: C.warn } }, t("Not saved yet.", "尚未保存。"))
						: null);
			};

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				createElement("p", { style: hintStyle },
					t("These are the plugin's options. Saving writes them to the file below, so they survive a restart.",
						"这里是插件的全部可配置项。保存会写入下方文件，重启后依然生效。")),
				error ? createElement("p", { style: { ...hintStyle, color: C.danger } }, error) : null,
				message ? createElement("p", { style: { ...hintStyle, color: C.success } }, message) : null,
				...groups.map((group) => {
					const open = openGroup === group.group;
					return createElement("div", { key: group.group, style: panelStyle },
						createElement("button", {
								onClick: () => setOpenGroup(open ? "" : group.group),
								style: {
									display: "flex", alignItems: "center", gap: 8, width: "100%",
									appearance: "none", background: "transparent", border: "none",
									padding: 0, cursor: "pointer", font: "inherit", textAlign: "left",
								},
							},
							createElement("span", { style: { color: C.labelTertiary, fontSize: 11 } }, open ? "▾" : "▸"),
							createElement("span", { style: panelTitleStyle }, t(group.group, group.groupEn)),
							createElement("span", { style: { ...captionStyle, marginLeft: "auto" } },
								`${(group.fields ?? []).length}`)),
						open ? createElement("div", {}, ...(group.fields ?? []).map(renderField)) : null);
				}),
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
					createElement("button", {
						onClick: save,
						disabled: busy || dirtyPaths.length === 0,
						style: dirtyPaths.length === 0 || busy ? buttonStyleFor(true) : primaryButtonStyle,
					}, busy ? t("Saving…", "保存中…") : t("Save", "保存")),
					createElement("button", { onClick: resetAll, disabled: busy, style: buttonStyleFor(busy) },
						t("Reset all", "全部恢复默认")),
					dirtyPaths.length > 0
						? createElement("span", { style: captionStyle },
								t(`${dirtyPaths.length} unsaved change(s)`, `${dirtyPaths.length} 项未保存`))
						: null),
				configPath
					? createElement("p", { style: captionStyle }, t("Stored in: ", "保存在："), configPath)
					: null);
		}

		function AsrSection({ ctx, t }) {
			const [models, setModels] = react.useState([]);
			const [modelDir, setModelDir] = react.useState("");
			const [dirInput, setDirInput] = react.useState("");
			// The download format must match the engine that will load it: mlx
			// weights only run on Apple silicon, CTranslate2 weights run anywhere.
			// Guessing wrong costs the user a 460MB download, so the default
			// follows the machine the GUI is running on.
			const [repo, setRepo] = react.useState(defaultAsrRepo());
			const [dlStatus, setDlStatus] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [savingDir, setSavingDir] = react.useState(false);
			const [pickingDir, setPickingDir] = react.useState(false);
			const [browseMsg, setBrowseMsg] = react.useState("");
			const [dirMsg, setDirMsg] = react.useState("");
			const [dlSettings, setDlSettings] = react.useState({});
			const [source, setSource] = react.useState("mirror");
			const [proxyMode, setProxyMode] = react.useState("direct");
			const [proxyInput, setProxyInput] = react.useState("");
			const [savingSource, setSavingSource] = react.useState(false);
			const [savingProxy, setSavingProxy] = react.useState(false);
			const [sourceMsg, setSourceMsg] = react.useState("");
			const [proxyMsg, setProxyMsg] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const r = await callRemote(() => ctx.remote.weixinAsr.listModels());
					setModels(r?.models ?? []);
					setModelDir(r?.modelDir ?? "");
					setDirInput(r?.modelDir ?? "");
				} catch {
					// remote not mounted yet
				}
				try {
					// The host derives `source` from the endpoint it is actually
					// using, so the radio group reflects the running route rather
					// than a guess made from the last click.
					const s = await callRemote(() => ctx.remote.weixinAsr.getDownloadSettings());
					setDlSettings(s ?? {});
					setSource(s?.source ?? "mirror");
					const saved = s?.proxy ?? "";
					setProxyInput(saved);
					setProxyMode(saved ? "custom" : "direct");
				} catch {
					// download settings are optional; the card still works
				}
			}, [ctx]);

			react.useEffect(() => {
				refresh();
			}, [refresh]);

			const browseDir = async () => {
				setPickingDir(true);
				setBrowseMsg("");
				try {
					const picked = await pickDirectory(ctx);
					if (picked.ok) {
						setDirInput(picked.path);
						return;
					}
					// Cancelling needs no message: the operator knows what they
					// just did, and a note would read as a complaint. Only a
					// missing chooser is worth explaining.
					if (picked.reason === PICK_UNAVAILABLE) {
						setBrowseMsg(t(
							"No directory chooser is available here; type the path instead.",
							"当前环境没有目录选择器，请手动输入路径。",
						));
					}
				} finally {
					setPickingDir(false);
				}
			};

			const saveDir = async () => {
				const target = dirInput.trim();
				if (!target) return;
				setSavingDir(true);
				setDirMsg("");
				try {
					const r = await callRemote(() => ctx.remote.weixinAsr.setModelDir(target));
					setModelDir(r?.modelDir ?? target);
					setDirInput(r?.modelDir ?? target);
					setModels(r?.models ?? []);
					setDirMsg(t("Directory updated", "目录已更新"));
				} catch (err) {
					setDirMsg(String(err?.message ?? err));
				} finally {
					setSavingDir(false);
				}
			};

			const chooseSource = (id) => {
				if (id === source) return;
				const choice = SOURCE_CHOICES.find((c) => c.id === id);
				if (!choice?.endpoint) return; // "custom" is not settable from here
				// Staged, not written: clicking around the radios must not churn
				// the host's download route. The change lands when the operator
				// presses Save in the pending bar.
				setSource(id);
				setSourceMsg(t("Changed — press Save to apply", "已修改——按「保存」生效"));
			};

			// The value to save is passed IN, never read from `proxyInput`.
			//
			// `saveProxy` closes over the `proxyInput` of the render it was
			// created in, and no re-render happens before `saveProxy()` is
			// called right below — so `setProxyInput("")` followed by
			// `saveProxy()` saves the OLD proxy back, and clicking "直连"
			// silently kept the proxy it was supposed to remove. The parameter
			// is what makes clearing actually clear.
			const saveProxy = async (value) => {
				const next = String(value ?? proxyInput).trim();
				setSavingProxy(true);
				setProxyMsg("");
				try {
					const r = await callRemote(() => ctx.remote.weixinAsr.setDownloadSettings(undefined, next));
					setDlSettings(r ?? {});
					setProxyInput(r?.proxy ?? "");
					setProxyMsg(t("Saved — applies to the next download", "已保存，对下一次下载生效"));
				} catch (err) {
					setProxyMsg(String(err?.message ?? err));
				} finally {
					setSavingProxy(false);
				}
			};

			// One write for everything staged in the download-settings panels.
			// `undefined` keeps the value the host already has: the endpoint
			// from the chosen source, the proxy from the radio state.
			const saveDownloadSettings = async () => {
				const choice = SOURCE_CHOICES.find((c) => c.id === source);
				const endpoint = choice?.endpoint;
				if (!endpoint) return; // "custom" cannot be written from here
				const proxy = proxyMode === "direct" ? "" : String(proxyInput).trim();
				setSavingSource(true);
				setSourceMsg("");
				try {
					const r = await callRemote(() => ctx.remote.weixinAsr.setDownloadSettings(endpoint, proxy));
					setDlSettings(r ?? {});
					setSource(r?.source ?? source);
					setProxyInput(r?.proxy ?? "");
					setProxyMode(r?.proxy ? "custom" : "direct");
					setSourceMsg(t("Saved — applies to the next download", "已保存，对下一次下载生效"));
				} catch (err) {
					// A failed write must not leave the radio showing a route the
					// host is not using, so re-read it instead of trusting the click.
					setSourceMsg(String(err?.message ?? err));
					try {
						const s = await callRemote(() => ctx.remote.weixinAsr.getDownloadSettings());
						setDlSettings(s ?? {});
						setSource(s?.source ?? source);
					} catch {
						// leave the previous value
					}
				} finally {
					setSavingSource(false);
				}
			};

			const discardDownloadSettings = async () => {
				// Re-read what the host is actually using; the staged edits die.
				try {
					const s = await callRemote(() => ctx.remote.weixinAsr.getDownloadSettings());
					setDlSettings(s ?? {});
					setSource(s?.source ?? "mirror");
					const saved = s?.proxy ?? "";
					setProxyInput(saved);
					setProxyMode(saved ? "custom" : "direct");
				} catch {
					// leave the staged values rather than guessing
				}
				setSourceMsg("");
				setProxyMsg("");
			};

			const download = async () => {
				if (!repo.trim()) return;
				setBusy(true);
				try {
					await callRemote(() => ctx.remote.weixinAsr.downloadModel(repo.trim()));
					const timer = setInterval(async () => {
						try {
							const s = await callRemote(() => ctx.remote.weixinAsr.downloadStatus(repo.trim()));
							setDlStatus({ ...s });
							if (s.status === "done") {
								clearInterval(timer);
								setBusy(false);
								refresh();
							} else if (s.status === "failed") {
								clearInterval(timer);
								setBusy(false);
							}
						} catch {
							// keep polling on transient errors
						}
					}, 2000);
				} catch (err) {
					setDlStatus({ status: "failed", message: String(err?.message ?? err) });
					setBusy(false);
				}
			};

			const installed = models.length > 0;

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },

				//#region directory
				createElement("div", { style: panelStyle },
					createElement("div", { style: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" } },
						createElement("span", { style: dotStyle(installed ? "ok" : "idle") }),
						createElement("span", { style: panelTitleStyle }, t("Voice models directory", "语音模型目录"))),
					createElement("p", { style: captionStyle },
						// The path is the value being reported, so it gets the
						// primary color and wrapping: long paths must not stretch
						// the card or be truncated away.
						createElement("code", {
							style: {
								fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
								fontSize: 12,
								color: modelDir ? C.labelPrimary : C.labelTertiary,
								overflowWrap: "anywhere",
							},
						}, modelDir || t("(not set)", "（未设置）"))),
					createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						createElement("input", {
							value: dirInput,
							onChange: (e) => setDirInput(e.target.value),
							placeholder: modelDir || "/path/to/models",
							style: inputStyle,
						}),
						// Choosing a directory by hand is the likeliest source of
						// typos here, and a wrong model directory fails much later
						// as "no model available", so offer the host's own chooser.
						createElement("button", { onClick: browseDir, disabled: pickingDir, style: buttonStyleFor(pickingDir) },
							pickingDir ? t("Opening…", "打开中…") : t("Browse…", "浏览…")),
						createElement("button", { onClick: saveDir, disabled: savingDir, style: primaryButtonStyle },
							savingDir ? t("Saving…", "保存中…") : t("Set directory", "设置目录"))),
					browseMsg ? createElement("p", { style: captionStyle }, browseMsg) : null,
					dirMsg ? createElement("p", { style: captionStyle }, dirMsg) : null),
				//#endregion directory

				//#region installed models
				createElement("div", { style: panelStyle },
					createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" } },
						createElement("span", { style: panelTitleStyle }, t("Installed models", "已安装模型")),
						createElement("span", { style: captionStyle }, t(`${models.length} found`, `共 ${models.length} 个`))),
					installed
						? createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								...models.map((m) =>
									createElement("div", {
											key: m.name,
											style: {
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 12,
												padding: "7px 10px",
												borderRadius: RADIUS.control,
												background: C.surface,
												fontSize: 13,
												lineHeight: "20px",
											},
										},
										// The repo id is what transcription is
										// configured with; the folder name is what
										// Finder shows. Both are useful, and showing
										// only the folder hid the fact that the slash
										// in the repo id became `__`.
										createElement("span", {
											style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
										},
											createElement("span", {
												style: { color: C.labelPrimary, overflowWrap: "anywhere" },
											}, m.repoId ?? m.name),
											m.repoId && m.repoId !== m.name
												? createElement("span", {
														style: { color: C.labelTertiary, fontSize: 11, overflowWrap: "anywhere" },
													}, m.name)
												: null),
										createElement("span", { style: { color: C.labelTertiary, flex: "0 0 auto" } },
											`${(m.sizeBytes / 1048576).toFixed(0)} MB`))))
						: createElement("p", { style: captionStyle }, t("No models installed yet", "尚未安装模型"))),
				//#endregion installed models

				//#region download source
				createElement("div", { style: panelStyle },
					createElement("span", { style: panelTitleStyle }, t("Download source", "下载源")),
					createElement("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
						...SOURCE_CHOICES.map((choice) =>
							createElement("label", {
									key: choice.id,
									style: {
										display: "flex",
										alignItems: "flex-start",
										gap: 9,
										padding: "7px 10px",
										borderRadius: RADIUS.control,
										border: `1px solid ${source === choice.id ? C.stateOk : C.border}`,
										background: source === choice.id ? C.bgLayer2 : "transparent",
										cursor: savingSource ? "default" : "pointer",
									},
								},
								createElement("input", {
									type: "radio",
									name: "weixin-download-source",
									checked: source === choice.id,
									disabled: savingSource,
									onChange: () => {
										// Staged like the proxy radios; the pending bar
										// writes (or discards) the whole set at once.
										chooseSource(choice.id);
									},
									style: { marginTop: 3, flex: "0 0 auto" },
								}),
								createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
									createElement("span", { style: { color: C.labelPrimary, fontSize: 13, lineHeight: "20px" } },
										t(choice.labelEn, choice.labelZh)),
									createElement("span", { style: { color: C.labelTertiary, fontSize: 12, lineHeight: "18px", overflowWrap: "anywhere" } },
										choice.endpoint))))),
					// A custom endpoint is any URL the operator typed elsewhere;
					// showing it read-only keeps the radio group honest without
					// turning the card into a URL editor.
					source === "custom"
						? createElement("p", { style: captionStyle },
								t(`Current: ${dlSettings.endpoint || "—"}`, `当前：${dlSettings.endpoint || "—"}`))
						: null,
					sourceMsg ? createElement("p", { style: captionStyle }, sourceMsg) : null,
					createElement("p", { style: captionStyle },
						t(
							"The official site is unreachable on some networks. The mirror serves the same files.",
							"官方站点在部分网络下无法访问，镜像提供的是同样的文件。",
						))),
				//#endregion download source

				//#region pending download-settings bar
				// One bar for the staged source/proxy edits. Keeping it between
				// the two panels means the save affordance is visible while
				// either radio group is being changed.
				createElement("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							flexWrap: "wrap",
							padding: "7px 10px",
							borderRadius: RADIUS.control,
							border: `1px solid ${C.border}`,
							background: C.surface,
						},
					},
					createElement("span", { style: { color: C.labelTertiary, fontSize: 12, lineHeight: "18px", flex: "1 1 auto" } },
						t("Download source and proxy are saved together.", "下载源与代理一起保存。")),
					createElement("button", {
							onClick: saveDownloadSettings,
							disabled: savingSource,
							style: primaryButtonStyle,
						},
						savingSource ? t("Saving…", "保存中…") : t("Save", "保存")),
					createElement("button", {
							onClick: discardDownloadSettings,
							disabled: savingSource,
							style: buttonStyleFor(false),
						},
						t("Reset", "还原"))),
				//#endregion pending download-settings bar

				//#region proxy
				createElement("div", { style: panelStyle },
					createElement("span", { style: panelTitleStyle }, t("Proxy", "代理")),
					createElement("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
						...PROXY_CHOICES.map((choice) =>
							createElement("label", {
									key: choice.id,
									style: {
										display: "flex",
										alignItems: "flex-start",
										gap: 9,
										padding: "7px 10px",
										borderRadius: RADIUS.control,
										border: `1px solid ${proxyMode === choice.id ? C.stateOk : C.border}`,
										background: proxyMode === choice.id ? C.bgLayer2 : "transparent",
										cursor: "pointer",
									},
								},
								createElement("input", {
									type: "radio",
									name: "weixin-download-proxy",
									checked: proxyMode === choice.id,
									onChange: () => {
										// Staged like the source radios; the pending bar
										// writes (or discards) the whole set at once.
										setProxyMode(choice.id);
										setProxyMsg("");
									},
									style: { marginTop: 3, flex: "0 0 auto" },
								}),
								createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
									createElement("span", { style: { color: C.labelPrimary, fontSize: 13, lineHeight: "20px" } },
										t(choice.labelEn, choice.labelZh)),
									createElement("span", { style: { color: C.labelTertiary, fontSize: 12, lineHeight: "18px" } },
										t(choice.hintEn, choice.hintZh)))))),
					proxyMode === "custom"
						? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
								createElement("input", {
									value: proxyInput,
									onChange: (e) => setProxyInput(e.target.value),
									placeholder: "http://127.0.0.1:7897",
									style: { ...inputStyle, flex: "1 1 220px" },
								}),
								createElement("button", {
										// Wrapped, not passed directly: React hands the
										// click event to the handler, and `saveProxy`
										// would stringify it into "[object Object]".
										onClick: () => saveProxy(proxyInput),
										disabled: savingProxy,
										style: buttonStyleFor(savingProxy),
									},
									savingProxy ? t("Saving…", "保存中…") : t("Save", "保存")))
						: null,
					proxyMsg ? createElement("p", { style: captionStyle }, proxyMsg) : null,
					// macOS keeps its proxy in the system network settings, which
					// only the system stack reads: a browser can be proxied while
					// every command-line download is not. That gap is the whole
					// reason this is a question and not a detection.
					createElement("p", { style: captionStyle },
						t(
							"The system proxy is not visible to downloads; name it here if you use one.",
							"系统代理对下载不可见：若你在用代理，需要在这里填写。",
						))),
				//#endregion proxy

				//#region download
				createElement("div", { style: panelStyle },
					createElement("span", { style: panelTitleStyle }, t("Download a model", "下载模型")),
					createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						createElement("input", {
							value: repo,
							onChange: (e) => setRepo(e.target.value),
							placeholder: "mlx-community/whisper-small-mlx",
							style: inputStyle,
						}),
						createElement("button", { onClick: download, disabled: busy, style: buttonStyleFor(busy) },
							busy ? t("Downloading…", "下载中…") : t("Download", "下载"))),
					// The host now reports real readings parsed from the CLI's own
					// tqdm output, so show them. A bar is only drawn when a
					// percentage is actually known — an indeterminate download
					// says "downloading" instead of parking a bar at a number
					// nobody measured.
					dlStatus.status === "running"
						? createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
									createElement("span", { style: dotStyle("warn") }),
									createElement("span", { style: hintStyle },
										typeof dlStatus.percent === "number"
											? t(`Downloading… ${dlStatus.percent}%`, `下载中… ${dlStatus.percent}%`)
											: t("Downloading…", "下载中…")),
									// The host reports this as a ready-made `done/total`
									// string. It used to be read as an object here, so
									// the card rendered a literal "undefined/undefined"
									// next to a perfectly good percentage — the shape
									// was never agreed, and nothing checked.
									typeof dlStatus.files === "string" && dlStatus.files
										? createElement("span", { style: captionStyle }, dlStatus.files)
										: null),
								typeof dlStatus.percent === "number"
									? createElement("div", { style: progressTrackStyle },
											createElement("div", {
												style: {
													...progressFillStyle,
													width: `${Math.max(0, Math.min(100, dlStatus.percent))}%`,
												},
											}))
									: null)
						: null,
					dlStatus.status === "done"
						? createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
								createElement("span", { style: dotStyle("ok") }),
								createElement("span", { style: hintStyle }, t("Download complete", "下载完成")),
								// The host dates the run so the card can say how long it
								// took without inventing a rate from a percentage it
								// cannot place in time; it was measured and then never
								// shown, which is a report the operator cannot use to
								// tell a slow mirror from a stuck one.
								typeof dlStatus.elapsedMs === "number"
									? createElement("span", { style: captionStyle },
											t(`${Math.round(dlStatus.elapsedMs / 1000)}s`, `${Math.round(dlStatus.elapsedMs / 1000)} 秒`))
									: null)
						: null,
					dlStatus.status === "failed"
						? createElement("div", { style: noticeStyle },
								createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
								createElement("span", null, dlStatus.message))
						: null,
					createElement("p", { style: captionStyle },
						t(
							"Downloaded models are picked up automatically by bin/asr-bridge.py — no further selection needed.",
							"下载后 bin/asr-bridge.py 会自动找到它，不需要再手动选择。",
						))),
				//#endregion download
			);
		}

		/**
		 * The model repo to preselect in the download box.
		 *
		 * `navigator.userAgent` reports the platform this GUI is running on, which
		 * is the machine that will also run the bridge.
		 */
		function defaultAsrRepo() {
			const ua = typeof navigator === "object" && navigator !== null ? String(navigator.userAgent ?? "") : "";
			// An Apple silicon browser is the only case where mlx weights are
			// loadable; everywhere else the CTranslate2 build is the right default.
			return /Mac/.test(ua) ? "mlx-community/whisper-small-mlx" : "Systran/faster-whisper-small";
		}

		// react.createElement binding (JSX-free)
		const createElement = react.createElement;

		//#endregion

		// ----------------------------------------------------- session row mark --

		// The WeChat mark a Session row leads with, on the Sessions this plugin
		// opened. The `sidebar.session.row.leading` seat (declared by
		// ui-workspace — the same seat ui-schedule's clock occupies) renders only
		// while the row's primary status is idle and is left blank on an archived
		// row; search results have no leading seat at all. The seat receives the
		// row's Session identity and nothing else, so the occupant decides from
		// `sessionId` alone.
		//
		// Only *our* Sessions carry the mark. `baseSessionIdFor` mints
		// `weixin-<slug>`, and a new line appends `--<stamp>`; an ordinary
		// workspace Session keeps its unrelated `session-<uuid>` id, so a prefix
		// test shows the mark exactly where WeChat opened the conversation — and
		// never on someone else's rows.
		const SESSION_ID_PREFIX = "weixin-";

		// WeChat's own logo: the simple-icons "WeChat" path (24x24 viewBox) — the
		// same glyph the host draws for `weixin.qq.com` links, so this mark and a
		// WeChat link in a transcript read as one identity. Kept inline because
		// the client bundle may only require `react` and `react/jsx-runtime`; a
		// glyph module is not on that list.
		const WECHAT_GLYPH = "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z";

		// WeChat green, the brand's own value. The `--dsw-alias-state-success-*`
		// tokens sit near it but are the interface's "everything is fine" green
		// rather than WeChat's, and a brand mark that shifts with the shell's
		// state palette stops being a brand mark.
		const WECHAT_GREEN = "#07C160";

		/** Whether a Session id belongs to a conversation this plugin opened. */
		function isWeixinSession(sessionId) {
			return typeof sessionId === "string" && sessionId.startsWith(SESSION_ID_PREFIX);
		}

		// Which account a session line belongs to, for the faint ownership hint
		// on the sidebar row. Only `sessions()` knows the line→account mapping
		// (the session id's slug is the CONVERSATION's, not the account's, so it
		// cannot be derived from the id), and the row seat renders for every
		// session on screen, so the mapping is fetched once per mount and cached
		// module-wide: the seat must stay cheap, and a failed fetch must never
		// break the row — the hint is a hint, not a feature the row depends on.
		let sessionOwnerMap = null; // Map<sessionId, {accountId, accountLabel}>
		let sessionOwnerFetched = false;
		// The seat's occupant receives only the row's Session identity — no
		// injection context — so registerUi parks its ctx here for the fetch.
		let sessionOwnerCtx = null;

		async function loadSessionOwners(ctx) {
			if (sessionOwnerFetched) return sessionOwnerMap;
			sessionOwnerFetched = true;
			try {
				const data = await callRemote(() => ctx.remote.weixin.sessions());
				const map = new Map();
				for (const conversation of data?.conversations ?? []) {
					if (typeof conversation?.accountId !== "string" || conversation.accountId === "") continue;
					for (const line of conversation.lines ?? []) {
						if (typeof line?.sessionId === "string") {
							map.set(line.sessionId, { accountId: conversation.accountId, accountLabel: conversation.accountLabel ?? null });
						}
					}
				}
				console.error("MAP BUILT size=" + map.size);
							sessionOwnerMap = map;
			} catch {
				// Remote not mounted yet, or the host refused: render no hint.
				sessionOwnerMap = null;
			}
			return sessionOwnerMap;
		}

		/** At most 6 visible characters, then an ellipsis, per the card's spec. */
		function ownerHintText(text) {
			const chars = Array.from(typeof text === "string" ? text : "");
			return chars.length <= 6 ? text : chars.slice(0, 6).join("") + "…";
		}

		/**
		 * The faint account hint beside the WeChat mark. Reads the cached
		 * session→owner map; sessions it cannot attribute (pre-multi-account
		 * history, a mapping not loaded yet) render no hint at all. The seat
		 * passes no ctx, so the hook falls back to the one registerUi parked.
		 */
		function useSessionOwner(sessionId) {
			const [owner, setOwner] = react.useState(() => sessionOwnerMap?.get(sessionId) ?? null);
			react.useEffect(() => {
				if (!sessionOwnerCtx) return undefined;
				let alive = true;
				loadSessionOwners(sessionOwnerCtx).then((map) => {
					console.error("THEN alive=" + alive + " hit=" + !!map?.get(sessionId));
								if (alive) setOwner(map?.get(sessionId) ?? null);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, [sessionId]);
			return owner;
		}

		/**
		 * The row mark for one of this plugin's Sessions.
		 *
		 * Returns `null` for every other Session, which is the whole point: the
		 * seat is shared with the host's own marks, so an occupant that claimed
		 * every row would stamp the WeChat logo on unrelated conversations.
		 * Decorative only — the seat is not a button and has no tab stop, so the
		 * glyph is `aria-hidden` and carries no label of its own.
		 *
		 * @param props.sessionId - the row's Session identity.
		 * @returns the glyph, or `null` for a Session this plugin did not open.
		 */
		function SessionRowMark({ sessionId }) {
			if (!isWeixinSession(sessionId)) return null;
			// Ownership moved INTO the title (`备注名: 标题`, see titledWithAccount
			// in sessions.js) after two hint-element attempts were squeezed by the
			// host's row — text inside the title flows, nothing competes for
			// width. The mark is the plain glyph again; useSessionOwner and the
			// owner fetch stay (the card still reads attribution), only the row
			// hint element is gone.
			return createElement("span", {
					className: "weixin-session-row-mark",
					"aria-hidden": "true",
					style: { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", gap: 4 },
				},
				createElement("svg", {
					width: 14,
					height: 14,
					viewBox: "0 0 24 24",
					fill: WECHAT_GREEN,
					focusable: "false",
					"aria-hidden": "true",
					style: { flex: "none" },
				}, createElement("path", { d: WECHAT_GLYPH })));
		}

		// This list must NOT name the namespaces: `remote.weixin` only comes into
		// existence inside apply() when $mount installs it, so waiting for it here
		// is a deadlock — the boot audit reports
		// `pending (waiting for services: remote.weixin, remote.weixinAsr)`.
		// `remote` itself is safe because the api-gateway provides it before any
		// bundle activates. The namespaces are declared on the inner ctx.inject
		// below, which runs after $mount has created them.
		const inject = ["remote", "slots", "locale"];

		function registerUi(ctx) {
			const { t } = useLocaleText(ctx);
			// Park the ui context for the row-mark's owner fetch: the seat hands
			// its occupant the Session identity only, so the hint hook has no ctx
			// of its own to read remote.weixin.sessions() through.
			sessionOwnerCtx = ctx;
			const actions = {
				noop: async () => {},
			};

			// The same card twice, in two homes: the plugin's own bundle page
			// (plugins.bundle.config) and the shell Settings navigation
			// (settings.section — the slot dsh-im uses for its「IM机器人」page).
			// One component, two registrations, so the copy never forks.
			function WeixinSettingsCard() {
				// A section heading sits outside its panel so the panel edge
				// reads as the group boundary; an icon-free heading at 14/600
				// matches the host's own settings sections.
				const section = (title, body) =>
					createElement("section", { style: { display: "flex", flexDirection: "column", gap: 8 } },
						createElement("h3", {
							style: { margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: C.labelPrimary },
						}, title),
						body);
				// Two tabs instead of one long scroll. State only exists at
				// runtime; in the stub environment useState keeps the first
				// tab, which matches what the tests assert.
				const TABS = [
					{ id: "account", label: t("WeChat account", "微信账号"), body: createElement(LoginSection, { ctx, t }) },
					{ id: "sessions", label: t("Sessions", "会话"), body: createElement(SessionsSection, { ctx, t }) },
					{ id: "options", label: t("Options", "配置项"), body: createElement(ConfigSection, { ctx, t }) },
					{ id: "voice", label: t("Voice models", "语音模型"), body: createElement(AsrSection, { ctx, t }) },
					{ id: "about", label: t("About", "关于"), body: createElement(AboutSection, { ctx, t }) },
				];
				const [tab, setTab] = react.useState(0);
				// Arrow keys move between tabs: the bar is a real tablist,
				// not just two buttons that happen to look like one.
				const onTabKey = (event) => {
					if (event.key === "ArrowRight") {
						event.preventDefault();
						setTab((tab + 1) % TABS.length);
					} else if (event.key === "ArrowLeft") {
						event.preventDefault();
						setTab((tab + TABS.length - 1) % TABS.length);
					}
				};
				return createElement("div", {
						style: { display: "flex", flexDirection: "column", gap: 20, color: C.labelPrimary },
					},
					createElement("div", {
							role: "tablist",
							className: "weixin-settings-tabbar",
							onKeyDown: onTabKey,
							style: { display: "flex", gap: 2, borderBottom: `1px solid ${C.border}`, overflowX: "auto" },
						},
						...TABS.map((entry, index) =>
							createElement("button", {
									key: entry.id,
									role: "tab",
									"aria-selected": index === tab,
									tabIndex: index === tab ? 0 : -1,
									onClick: () => setTab(index),
									style: {
										appearance: "none",
										background: "transparent",
										border: "none",
										borderBottom: `2px solid ${index === tab ? C.stateOk : "transparent"}`,
										color: index === tab ? C.labelPrimary : C.labelTertiary,
										fontSize: 13,
										lineHeight: "20px",
										fontWeight: index === tab ? 600 : 400,
										padding: "8px 12px",
										cursor: "pointer",
									},
							}, entry.label))),
					section(TABS[tab]?.label ?? "", TABS[tab]?.body));
			}

			ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: PKG,
						locale: NS,
						inject: () => actions,
					},
					WeixinSettingsCard));

			// The shell Settings modal: one nav entry opening the same card.
			// `label` is a locale thunk so switching the interface language
			// renames the entry without a reload (the navigation re-renders on
			// the section ledger bump). Order 22 sits just after dsh-im's 21.
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: `${PKG}-settings`,
						order: 22,
						label: () => t("WeChat", "微信"),
						locale: NS,
						inject: () => actions,
					},
					WeixinSettingsCard));

			// The session row mark. ui-workspace declares this seat on every
			// Session row and renders it only while the row is idle, so the
			// occupant is asked about rows it has nothing to do with — hence
			// `SessionRowMark` returning `null` rather than an empty glyph.
			// Order 20 sits after ui-schedule's 10: when a WeChat Session also
			// has an active scheduled task the host's clock still leads, and
			// the mark follows it instead of competing for the same cell.
			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register(
					{
						name: "sidebar.session.row.leading",
						id: `${PKG}-row-mark`,
						order: 20,
						locale: NS,
						inject: () => actions,
					},
					SessionRowMark));
		}

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			// Every namespace is its own Cordis service, so each one the card
			// reaches for must be named here. Reading an undeclared service
			// returns `undefined` instead of throwing, so a missing entry does
			// not fail loudly — it silently downgrades a working feature, which
			// is how the directory chooser came to report itself absent.
			// `remote.directoryPicker` belongs to the shell's own assembly, not
			// to this plugin, so it needs the same explicit declaration.
			const ui = ctx.inject(
				["remote.weixin", "remote.weixinAsr", "remote.weixinConfig", "remote.directoryPicker", "slots", "locale"],
				registerUi,
			);
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				await disposeRemote();
				throw error;
			}
			return async () => {
				await ui.dispose();
				await disposeRemote();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exported for the test suite: the chooser's cancel/absent-profile paths
		// are the ones that regress silently, and they are not reachable from the
		// component tree without a DOM.
		exports.pickDirectory = pickDirectory;
		return module.exports;
	}
});
