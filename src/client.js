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
			],
		};

		//#region UI components

		/**
		 * Open the host's native directory chooser.
		 *
		 * The shell already mounts the workspace controller's `directoryPicker`
		 * Remote (namespace `directoryPicker`, method `pick`), so no new
		 * dependency is needed — but it belongs to another bundle, which may be
		 * absent from a minimal profile. Two fallbacks keep the button useful
		 * rather than merely present:
		 *
		 *  1. `ctx.remote.directoryPicker.pick()` — the ordinary path.
		 *  2. `globalThis.__DSH_DIRECTORY_PICKER__.pick()` — the same Electron
		 *     IPC bridge the shell itself falls back to, used when the Remote is
		 *     not mounted.
		 *
		 * Returns the chosen absolute path, or null when the operator cancels or
		 * no chooser exists. Cancelling is not an error, so it must not surface
		 * as one.
		 */
		async function pickDirectory(ctx) {
			const picker = ctx.remote?.directoryPicker;
			if (picker?.pick !== undefined) {
				// Built outside the try: a missing AbortController is an
				// environment fault, not a declined dialog, and letting it be
				// swallowed would silently downgrade to "no chooser available".
				const signal =
					typeof AbortController === "function" ? new AbortController().signal : undefined;
				try {
					const result = await picker.pick(signal);
					const path = unwrap(result);
					return typeof path === "string" && path !== "" ? path : null;
				} catch {
					// A missing capability or a dismissed dialog: fall through to
					// the bridge rather than reporting a failure the operator
					// cannot act on.
				}
			}
			const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
			if (bridge?.pick !== undefined) {
				try {
					const path = await bridge.pick();
					return typeof path === "string" && path !== "" ? path : null;
				} catch {
					return null;
				}
			}
			return null;
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

		//#endregion design vocabulary

		function LoginSection({ ctx, t }) {
			const [state, setState] = react.useState({ phase: "idle" }); // idle|qr|needcode|confirmed|failed
			const [qrUrl, setQrUrl] = react.useState(null);
			const [qrDataUrl, setQrDataUrl] = react.useState(null);
			const [sessionKey, setSessionKey] = react.useState(null);
			const [code, setCode] = react.useState("");
			const [message, setMessage] = react.useState("");
			const [accounts, setAccounts] = react.useState([]);
			const [sessionExpired, setSessionExpired] = react.useState(false);
			const [copied, setCopied] = react.useState(false);
			const pollRef = react.useRef(null);

			const stopPolling = react.useCallback(() => {
				if (pollRef.current) {
					clearInterval(pollRef.current);
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
					pollRef.current = setInterval(async () => {
						try {
							const p = await callRemote(() => ctx.remote.weixin.poll(sessionKey));
							if (p.status === "confirmed") {
								stopPolling();
								setState({ phase: "confirmed" });
								setMessage(p.accountId ? `${t("Bound account", "已绑定账号")}: ${p.accountId}` : "");
								refreshStatus();
							} else if (p.status === "need_verifycode") {
								setState({ phase: "needcode" });
								setMessage(p.message ?? "");
							} else if (p.status === "refreshed") {
								setQrUrl(p.qrcodeUrl ?? null);
								setQrDataUrl(p.qrDataUrl ?? null);
								setState({ phase: "qr" });
							} else if (p.status === "failed") {
								stopPolling();
								setState({ phase: "failed" });
								setMessage(p.message ?? "");
							}
						} catch {
							// transient poll failure: keep going
						}
					}, 1000);
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
					? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							createElement("button", {
								onClick: start,
								style: primaryButtonStyle,
							}, bound || sessionExpired
								? t("Scan again to log in", "重新扫码登录")
								: t("Scan QR code to log in", "扫码登录微信")))
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

				message && state.phase !== "needcode"
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

			const refresh = react.useCallback(async () => {
				try {
					const r = await callRemote(() => ctx.remote.weixinAsr.listModels());
					setModels(r?.models ?? []);
					setModelDir(r?.modelDir ?? "");
					setDirInput(r?.modelDir ?? "");
				} catch {
					// remote not mounted yet
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
					if (picked === null) {
						// Cancelling, or a profile whose shell mounts no chooser.
						setBrowseMsg(t(
							"No directory chooser is available here; type the path instead.",
							"当前环境没有目录选择器，请手动输入路径。",
						));
						return;
					}
					setDirInput(picked);
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
										createElement("span", {
											style: { color: C.labelPrimary, overflowWrap: "anywhere", minWidth: 0 },
										}, m.name),
										createElement("span", { style: { color: C.labelTertiary, flex: "0 0 auto" } },
											`${(m.sizeBytes / 1048576).toFixed(0)} MB`))))
						: createElement("p", { style: captionStyle }, t("No models installed yet", "尚未安装模型"))),
				//#endregion installed models

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
					// The host reports `running`/`done`/`failed`/`idle` and no
					// percentage, so state the phase rather than inventing a
					// progress bar that would sit at a made-up number.
					dlStatus.status === "running"
						? createElement("div", { style: { display: "flex", alignItems: "center", gap: 9 } },
								createElement("span", { style: dotStyle("warn") }),
								createElement("span", { style: hintStyle }, t("Downloading…", "下载中…")))
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
			const ui = ctx.inject(["remote.weixin", "remote.weixinAsr", "slots", "locale"], registerUi);
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
