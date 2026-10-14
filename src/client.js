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
		let _statusResult$value;
		const _statusResult = () => (_statusResult$value ??= intersection(unknown(), unknown()));

		function intersection(left, right) {
			return { type: "intersection", left, right };
		}
		function string() {
			return { type: "string" };
		}
		function record(key) {
			return { type: "record", key };
		}
		function unknown() {
			return { type: "unknown" };
		}
		//#endregion

		const PKG = "dsh-plugin-weixin";
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
			const lang = ctx.locale?.current?.language ?? ctx.locale?.language ?? "zh";
			const zh = lang.startsWith("zh");
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
								? t("Scan again to log in", "重新扫码登录")
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
									: qrUrl
										? createElement("img", { src: qrUrl, alt: "QR", style: { width: 200, height: 200, display: "block" } })
										: createElement("div", { style: { width: 200, height: 200, display: "grid", placeItems: "center", color: C.labelTertiary } },
												t("Loading QR code…", "二维码加载中…"))),
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

		function AsrSection({ ctx, t }) {
			const [models, setModels] = react.useState([]);
			const [modelDir, setModelDir] = react.useState("");
			const [dirInput, setDirInput] = react.useState("");
			const [repo, setRepo] = react.useState("mlx-community/whisper-small-mlx");
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

			const chooseSource = async (id) => {
				if (id === source || savingSource) return;
				const choice = SOURCE_CHOICES.find((c) => c.id === id);
				if (!choice?.endpoint) return; // "custom" is not settable from here
				setSavingSource(true);
				setSourceMsg("");
				try {
					// `undefined` = "leave the proxy as it is". Sending "" here
					// would clear it every time the source changed.
					const r = await callRemote(() => ctx.remote.weixinAsr.setDownloadSettings(choice.endpoint, undefined));
					setDlSettings(r ?? {});
					setSource(r?.source ?? id);
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

			const chooseProxyMode = (id) => {
				setProxyMode(id);
				setProxyMsg("");
				// Picking "direct" is the whole setting: clear it now rather
				// than making the operator also press Save to undo a proxy.
				// Pass the empty value explicitly — see saveProxy.
				if (id === "direct" && dlSettings.proxy) {
					setProxyInput("");
					saveProxy("");
				}
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
									onChange: () => chooseSource(choice.id),
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
									onChange: () => chooseProxyMode(choice.id),
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
									dlStatus.files
										? createElement("span", { style: captionStyle },
												`${dlStatus.files.done}/${dlStatus.files.total}`)
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
								createElement("span", { style: hintStyle }, t("Download complete", "下载完成")))
						: null,
					dlStatus.status === "failed"
						? createElement("div", { style: noticeStyle },
								createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
								createElement("span", null, dlStatus.message))
						: null,
					createElement("p", { style: captionStyle },
						t(
							"Select the downloaded model in the plugin settings under Voice → model.",
							"下载完成后，在插件设置的「语音 → model」里选择该模型。",
						))),
				//#endregion download
			);
		}

		// react.createElement binding (JSX-free)
		const createElement = react.createElement;

		//#endregion

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
			const actions = {
				noop: async () => {},
			};

			ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: PKG,
						locale: NS,
						inject: () => actions,
					},
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
						return createElement("div", {
								style: { display: "flex", flexDirection: "column", gap: 20, color: C.labelPrimary },
							},
							section(t("WeChat account", "微信账号"), createElement(LoginSection, { ctx, t })),
							section(t("Voice models", "语音模型"), createElement(AsrSection, { ctx, t })));
					},
				));
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
				["remote.weixin", "remote.weixinAsr", "remote.directoryPicker", "slots", "locale"],
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
