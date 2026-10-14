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

		function LoginSection({ ctx, t }) {
			const [state, setState] = react.useState({ phase: "idle" }); // idle|qr|needcode|confirmed|failed
			const [qrUrl, setQrUrl] = react.useState(null);
			const [qrDataUrl, setQrDataUrl] = react.useState(null);
			const [sessionKey, setSessionKey] = react.useState(null);
			const [code, setCode] = react.useState("");
			const [message, setMessage] = react.useState("");
			const [accounts, setAccounts] = react.useState([]);
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
					const s = await ctx.remote.weixin.status();
					setAccounts(s.accounts ?? []);
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
					const r = await ctx.remote.weixin.startLogin();
					setQrUrl(r.qrcodeUrl ?? null);
					setQrDataUrl(r.qrDataUrl ?? null);
					setSessionKey(r.sessionKey);
					setState({ phase: "qr" });
					stopPolling();
					pollRef.current = setInterval(async () => {
						try {
							const p = await ctx.remote.weixin.poll(sessionKey);
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
				await ctx.remote.weixin.submitVerifyCode(sessionKey, code.trim());
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

			const accountLine =
				accounts.length > 0
					? `${t("Bound", "已绑定")}: ${accounts.map((a) => a.accountId).join(", ")}`
					: t("No account bound yet", "尚未绑定账号");

			return createElement("div", { style: { display: "grid", gap: 12 } },
				createElement("div", { style: { opacity: 0.75 } }, accountLine),
				state.phase === "idle" || state.phase === "confirmed" || state.phase === "failed"
					? createElement("button", { onClick: start }, t("Scan QR code to log in", "扫码登录微信"))
					: null,
				state.phase === "qr"
					? createElement("div", { style: { display: "grid", gap: 8, justifyItems: "center" } },
							qrDataUrl
								? createElement("img", { src: qrDataUrl, alt: "QR", style: { width: 220, height: 220 } })
								: qrUrl
									? createElement("img", { src: qrUrl, alt: "QR", style: { width: 220, height: 220 } })
									: createElement("div", { style: { opacity: 0.7 } }, t("Loading QR code…", "二维码加载中…")),
							createElement("div", null, t("Scan with WeChat on your phone", "用手机微信扫码登录")),
							qrUrl
								? createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" } },
										createElement("a", { href: qrUrl, target: "_blank", rel: "noopener noreferrer" },
											t("Open link in browser", "在浏览器打开")),
										createElement("button", { onClick: copyLink }, copied ? t("Copied", "已复制") : t("Copy link", "复制链接")))
								: null,
							createElement("button", { onClick: cancel }, t("Cancel", "取消")))
					: null,
				state.phase === "needcode"
					? createElement("div", { style: { display: "grid", gap: 8 } },
							createElement("div", null, message || t("Enter the verification code shown on your phone", "请输入手机上显示的验证码")),
							createElement("input", {
								value: code,
								onChange: (e) => setCode(e.target.value),
								placeholder: "123456",
								inputMode: "numeric",
							}),
							createElement("div", { style: { display: "flex", gap: 8 } },
								createElement("button", { onClick: submitCode }, t("Submit", "提交")),
								createElement("button", { onClick: cancel }, t("Cancel", "取消"))))
					: null,
				message && state.phase !== "needcode" ? createElement("div", null, message) : null,
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
			const [dirMsg, setDirMsg] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const r = await ctx.remote.weixinAsr.listModels();
					setModels(r.models ?? []);
					setModelDir(r.modelDir ?? "");
					setDirInput(r.modelDir ?? "");
				} catch {
					// remote not mounted yet
				}
			}, [ctx]);

			react.useEffect(() => {
				refresh();
			}, [refresh]);

			const saveDir = async () => {
				const target = dirInput.trim();
				if (!target) return;
				setSavingDir(true);
				setDirMsg("");
				try {
					const r = await ctx.remote.weixinAsr.setModelDir(target);
					setModelDir(r.modelDir ?? target);
					setDirInput(r.modelDir ?? target);
					setModels(r.models ?? []);
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
					await ctx.remote.weixinAsr.downloadModel(repo.trim());
					const timer = setInterval(async () => {
						try {
							const s = await ctx.remote.weixinAsr.downloadStatus(repo.trim());
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

			return createElement("div", { style: { display: "grid", gap: 10 } },
				createElement("div", { style: { opacity: 0.75 } },
					t("Voice models directory", "语音模型目录"), ": ", modelDir || "—"),
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
					createElement("input", {
						value: dirInput,
						onChange: (e) => setDirInput(e.target.value),
						placeholder: modelDir || "/path/to/models",
						style: { flex: 1 },
					}),
					createElement("button", { onClick: saveDir, disabled: savingDir },
						savingDir ? t("Saving…", "保存中…") : t("Set directory", "设置目录"))),
				dirMsg ? createElement("div", { style: { opacity: 0.75 } }, dirMsg) : null,
				models.length > 0
					? createElement("div", null,
							createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, t("Installed models", "已安装模型")),
							...models.map((m) =>
								createElement("div", { key: m.name, style: { display: "flex", justifyContent: "space-between" } },
									createElement("span", null, m.name),
									createElement("span", { style: { opacity: 0.6 } }, `${(m.sizeBytes / 1048576).toFixed(0)} MB`))))
					: createElement("div", { style: { opacity: 0.6 } }, t("No models installed yet", "尚未安装模型")),
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
					createElement("input", {
						value: repo,
						onChange: (e) => setRepo(e.target.value),
						placeholder: "mlx-community/whisper-small-mlx",
						style: { flex: 1 },
					}),
					createElement("button", { onClick: download, disabled: busy }, busy ? t("Downloading…", "下载中…") : t("Download", "下载"))),
				dlStatus.status === "failed" ? createElement("div", { style: { color: "crimson" } }, dlStatus.message) : null,
				createElement("div", { style: { opacity: 0.6, fontSize: "0.9em" } },
					t(
						"Select the downloaded model in the plugin settings under Voice → model.",
						"下载完成后，在插件设置的「语音 → model」里选择该模型。",
					)),
			);
		}

		// react.createElement binding (JSX-free)
		const createElement = react.createElement;

		//#endregion

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
						return createElement("div", { style: { display: "grid", gap: 20 } },
							createElement("section", { style: { display: "grid", gap: 8 } },
								createElement("h3", { style: { margin: 0 } }, t("WeChat account", "微信账号")),
								createElement(LoginSection, { ctx, t })),
							createElement("section", { style: { display: "grid", gap: 8 } },
								createElement("h3", { style: { margin: 0 } }, t("Voice models", "语音模型")),
								createElement(AsrSection, { ctx, t })));
					},
				));
		}

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			const ui = ctx.inject(["remote", "slots", "locale"], registerUi);
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
		return module.exports;
	}
});
