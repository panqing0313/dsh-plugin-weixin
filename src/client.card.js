window.__ModuleLoader__.load({
	id: "dsh-plugin-weixin",
	// A package-local lazy chunk. The loader's contract (client-modules) is:
	// a package contributes ONE boot-graph entry (its `./client` export), and any
	// source `import()` inside it compiles to `require.async("./client.<name>.js")`
	// — the loader then fetches `/plugins/<id>/client.<name>.js` at the owner's
	// revision, registers it under `<id>/client.<name>.js`, and materializes it on
	// first use. The file name has to match /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
	// or the loader rejects the registration outright.
	//
	// Everything below is the settings card: nine sections plus the tab shell. It
	// is the bulk of this plugin's UI and it is only reachable from two slots, so
	// it has no business in the bundle the shell loads on every page. The chunk is
	// self-contained by construction — a chunk may not require its own owner (that
	// is a materialization cycle), so the handful of design tokens and helpers it
	// shares with the entry arrive through `createCardModule(deps)` instead.
	chunk: "client.card.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/**
		 * Build the card against the entry module's design vocabulary.
		 *
		 * @param {object} deps everything the sections used to close over
		 * @returns {{WeixinSettingsCard: Function}}
		 */
		exports.createCardModule = (deps) => {
			const {
				PKG,
				PLUGIN_VERSION,
				callRemote,
				PICK_UNAVAILABLE,
				SOURCE_CHOICES,
				PROXY_CHOICES,
				ctx,
				t,
				createElement,
				C,
				RADIUS,
				panelStyle,
				hintStyle,
				captionStyle,
				panelTitleStyle,
				buttonStyle,
				buttonStyleFor,
				primaryButtonStyle,
				inputStyle,
				dotStyle,
				pillStyle,
				noticeStyle,
				progressTrackStyle,
				progressFillStyle,
				unwrap,
				isCancellation,
				useLocaleText,
				pickDirectory,
			} = deps;

			//#region design layer
			/**
			 * The card's own stylesheet.
			 *
			 * Inline styles can express layout but not keyframes, hover or focus;
			 * the host's tokens stop at colours. Everything here is additive and
			 * namespaced, and the whole block is guarded because the card is also
			 * imported by the test stub, which has no `document`.
			 */
			const STYLE_ID = "dsh-weixin-card-styles";
			const STYLE_TEXT = `
@keyframes wx-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes wx-pulse { 0%, 100% { opacity: .9; transform: scale(1); } 50% { opacity: .35; transform: scale(.72); } }
@keyframes wx-spin { to { transform: rotate(360deg); } }
@keyframes wx-sweep { from { background-position: -160% 0; } to { background-position: 260% 0; } }
@keyframes wx-shimmer { from { opacity: .45; } to { opacity: 1; } }
.weixin-card-enter { animation: wx-fade-in .22s ease-out both; }
.weixin-tab { transition: background-color .15s ease, color .15s ease, border-color .15s ease, transform .15s ease; }
.weixin-tab:hover { background: rgba(127, 127, 127, .12); }
.weixin-tab:active { transform: scale(.97); }
.weixin-tab:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
.weixin-row { transition: background-color .15s ease, border-color .15s ease; }
.weixin-row:hover { background: rgba(127, 127, 127, .08); }
.weixin-lift { transition: box-shadow .18s ease, transform .18s ease; }
.weixin-lift:hover { box-shadow: 0 8px 22px rgba(0, 0, 0, .12); transform: translateY(-1px); }
.weixin-indeterminate {
	background-image: linear-gradient(90deg, transparent, ${C.brand}, transparent);
	background-size: 220% 100%;
	animation: wx-sweep 1.25s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
	.weixin-card-enter, .weixin-indeterminate { animation: none !important; }
	.weixin-lift, .weixin-tab, .weixin-row { transition: none !important; }
}
`;
			function ensureCardStyles() {
				if (typeof document === "undefined" || document === null) return;
				if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) return;
				const host = document.head ?? document.body ?? document.documentElement;
				if (host === null || host === undefined || typeof host.appendChild !== "function") return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLE_TEXT;
				host.appendChild(style);
			}

			const reducedMotion = () =>
				typeof window === "object" && window !== null && typeof window.matchMedia === "function"
					? window.matchMedia("(prefers-reduced-motion: reduce)").matches
					: false;

			/** A small rotating arc; the only moving part of a busy state. */
			function Spinner({ size = 14, color = C.brand }) {
				return createElement("span", {
					"aria-hidden": "true",
					style: {
						display: "inline-block",
						flex: "0 0 auto",
						width: size,
						height: size,
						borderRadius: "50%",
						border: `2px solid ${C.border}`,
						borderTopColor: color,
						animation: reducedMotion() ? "none" : "wx-spin .8s linear infinite",
					},
				});
			}

			/** A dot that breathes while the thing it describes is live. */
			function PulseDot({ tone = "ok", size = 8 }) {
				const color = tone === "ok" ? C.success : tone === "warn" ? C.warn : tone === "danger" ? C.danger : C.idle;
				return createElement("span", {
						"aria-hidden": "true",
						style: { position: "relative", display: "inline-block", flex: "0 0 auto", width: size, height: size },
					},
					createElement("span", {
						style: {
							position: "absolute",
							inset: 0,
							borderRadius: "50%",
							background: color,
							opacity: 0.28,
							animation: reducedMotion() ? "none" : "wx-pulse 1.9s ease-in-out infinite",
						},
					}),
					createElement("span", {
						style: { position: "absolute", inset: size / 4, borderRadius: "50%", background: color },
					}));
			}

			/**
			 * A determinate bar when the caller knows the fraction, an animated
			 * sweep when it does not — never a fake percentage.
			 */
			function Progress({ value, height = 6, tone = "brand" }) {
				const color = tone === "ok" ? C.success : tone === "warn" ? C.warn : tone === "danger" ? C.danger : C.brand;
				// Deliberately not built from the shared track token: its one use
				// belongs to the ASR download bar, whose guard the client test
				// pins to the measured percentage.
				const track = {
					position: "relative",
					width: "100%",
					height,
					borderRadius: RADIUS.pill,
					overflow: "hidden",
					background: C.surfaceSunken,
				};
				if (typeof value === "number" && Number.isFinite(value)) {
					const pct = Math.max(0, Math.min(100, value));
					return createElement("div", {
							role: "progressbar",
							"aria-valuenow": Math.round(pct),
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							style: track,
						},
						createElement("div", {
							style: {
								...progressFillStyle,
								height: "100%",
								width: `${pct}%`,
								borderRadius: RADIUS.pill,
								background: color,
								transition: "width .35s ease",
							},
						}));
				}
				return createElement("div", { role: "progressbar", style: track },
					createElement("div", {
						className: "weixin-indeterminate",
						style: { height: "100%", width: "45%", borderRadius: RADIUS.pill },
					}));
			}

			function Badge({ text, tone = "neutral" }) {
				const tones = {
					ok: [C.successSubtle, C.success],
					warn: [C.warnSubtle, C.warn],
					danger: [C.surfaceSunken, C.danger],
					brand: [C.surfaceSunken, C.brand],
					neutral: [C.surfaceSunken, C.labelSecondary],
				};
				const [background, color] = tones[tone] ?? tones.neutral;
				return createElement("span", {
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "1px 8px",
						borderRadius: RADIUS.pill,
						background,
						color,
						fontSize: 11,
						lineHeight: "18px",
						fontWeight: 500,
						whiteSpace: "nowrap",
					},
				}, text);
			}

			/** One number with its label: the shape every summary row wants. */
			function StatTile({ label, value, hint, tone = "neutral" }) {
				const color = tone === "ok" ? C.success : tone === "warn" ? C.warn : tone === "danger" ? C.danger : C.labelPrimary;
				return createElement("div", {
						className: "weixin-lift",
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 2,
							padding: "9px 11px",
							borderRadius: RADIUS.control,
							border: `1px solid ${C.border}`,
							background: C.surfaceSunken,
							minWidth: 84,
							flex: "1 1 84px",
						},
					},
					createElement("span", { style: { fontSize: 11, lineHeight: "16px", color: C.labelTertiary } }, label),
					createElement("span", { style: { fontSize: 18, lineHeight: "24px", fontWeight: 650, color } }, value),
					hint ? createElement("span", { style: { fontSize: 11, lineHeight: "15px", color: C.labelTertiary } }, hint) : null);
			}

			function EmptyState({ text }) {
				return createElement("div", {
					style: {
						padding: "26px 12px",
						textAlign: "center",
						color: C.labelTertiary,
						fontSize: 12,
						lineHeight: "20px",
						border: `1px dashed ${C.border}`,
						borderRadius: RADIUS.control,
					},
				}, text);
			}

			/** Tab glyphs: 15px strokes, no icon font, no dependency. */
			function TabIcon({ id, active }) {
				const stroke = active ? C.brand : C.labelTertiary;
				const common = {
					width: 15,
					height: 15,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke,
					strokeWidth: 1.9,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { flex: "0 0 auto", display: "block" },
				};
				const shapes = {
					account: [createElement("circle", { key: "h", cx: 12, cy: 8, r: 4 }), createElement("path", { key: "b", d: "M4.5 20a7.5 7.5 0 0 1 15 0" })],
					sessions: [createElement("path", { key: "b", d: "M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-5.2A7.5 7.5 0 0 1 11.5 4h2A7.5 7.5 0 0 1 21 11.5Z" })],
					options: [
						createElement("path", { key: "a", d: "M4 7h9M17 7h3" }),
						createElement("circle", { key: "b", cx: 15, cy: 7, r: 2 }),
						createElement("path", { key: "c", d: "M4 17h3M11 17h9" }),
						createElement("circle", { key: "d", cx: 9, cy: 17, r: 2 }),
					],
					voice: [
						createElement("rect", { key: "a", x: 9, y: 3, width: 6, height: 11, rx: 3 }),
						createElement("path", { key: "b", d: "M5 11a7 7 0 0 0 14 0M12 18v3" }),
					],
					journal: [
						createElement("rect", { key: "a", x: 4, y: 4, width: 16, height: 16, rx: 3 }),
						createElement("path", { key: "b", d: "M8 9h8M8 13h8M8 17h5" }),
					],
					stats: [
						createElement("path", { key: "a", d: "M5 20V11M12 20V5M19 20v-6" }),
					],
					reminders: [
						createElement("circle", { key: "a", cx: 12, cy: 12, r: 8 }),
						createElement("path", { key: "b", d: "M12 8v4.2l3 1.8" }),
					],
					persona: [
						createElement("path", { key: "a", d: "M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9 12 3.5Z" }),
					],
					about: [
						createElement("circle", { key: "a", cx: 12, cy: 12, r: 8 }),
						createElement("path", { key: "b", d: "M12 11v5M12 8h.01" }),
					],
				};
				return createElement("svg", common, ...(shapes[id] ?? shapes.about));
			}
			//#endregion design layer

		/**
		 * 最近被 allowlist 拒掉的陌生人，一人一行、一键加白。
		 *
		 * 拒收是静默的，但这块面板把「静默」和「没人来」分开：同事换了微信号、
		 * 朋友重新扫码 —— 他们的新 id 都会落在这里，点一下就进白名单，下一条
		 * 消息直接放行（配置是每条消息实时读的，不需要重启）。
		 */
		function StrangerSection({ t }) {
			const [rows, setRows] = react.useState(null);
			const [busyId, setBusyId] = react.useState("");
			const [notice, setNotice] = react.useState("");
			const load = react.useCallback(async () => {
				try {
					const res = await callRemote(() => ctx.remote.weixin.strangers());
					setRows(Array.isArray(res?.strangers) ? res.strangers : []);
				} catch {
					setRows([]);
				}
			}, []);
			react.useEffect(() => { load(); }, [load]);
			const allow = async (senderId) => {
				setBusyId(senderId);
				setNotice("");
				try {
					await callRemote(() => ctx.remote.weixin.strangerAllow(senderId));
					setNotice(t("Added to the allowlist — their next message just works.", "已加入白名单，下一条消息直接放行。"));
				} catch {
					setNotice(t("Allow failed, please try again.", "加白失败，请重试。"));
				} finally {
					setBusyId("");
					load();
				}
			};
			const visible = Array.isArray(rows) ? rows.slice(0, 8) : [];
			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					createElement("span", { style: panelTitleStyle }, t("Strangers the allowlist refused", "被拒的陌生人")),
					createElement("span", { style: { flex: 1 } }),
					createElement("button", { onClick: () => load(), style: buttonStyleFor(false) }, t("Refresh", "刷新"))),
				rows === null
					? createElement("span", { style: captionStyle }, t("Loading…", "读取中…"))
					: visible.length === 0
						? createElement("span", { style: captionStyle }, t("Nobody has been refused yet.", "还没有被拒的发送者。"))
						: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
							visible.map((row) => createElement("div", {
									key: row.senderId,
									className: "weixin-row",
									style: {
										display: "flex", flexDirection: "column", gap: 3,
										padding: "8px 10px",
										border: `1px solid ${C.border}`,
										borderRadius: RADIUS.control,
										background: C.surfaceSunken,
									},
								},
								createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
									createElement("span", { style: { fontSize: 13, fontWeight: 600, color: C.labelPrimary } }, row.senderId),
									createElement("span", { style: { fontSize: 12, color: C.labelTertiary } },
										t(`refused ${row.count} times · last ${new Date(row.lastAt).toLocaleString()}`,
											`被拒 ${row.count} 次 · 最近 ${new Date(row.lastAt).toLocaleString()}`)),
									createElement("span", { style: { flex: 1 } }),
									createElement("button", {
										onClick: () => allow(row.senderId),
										style: buttonStyleFor(true),
										disabled: busyId === row.senderId,
									}, busyId === row.senderId ? t("Allowing…", "加白中…") : t("Allow", "加白"))),
								row.lastText ? createElement("span", {
									style: { fontSize: 12, color: C.labelSecondary, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
								}, row.lastText) : null))),
				notice ? createElement("span", { style: captionStyle }, notice) : null);
			}

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

			// How often the card re-reads its status while it is mounted. The
			// settings page is often left open, and the account state changes
			// elsewhere: another device logs in or out, or the server-side session
			// expires. A status read is cheap but not free, so 15s is the compromise
			// -- fast enough that the card is not visibly stale when the operator
			// looks back at it (and a session expiring is noticed within one tick),
			// slow enough that an idle settings page is not a request per second.
			const STATUS_POLL_MS = 15000;

			react.useEffect(() => {
				refreshStatus();
				// The background refresh is a browser affordance: it exists to notice
				// changes made on another device and it watches the window and the
				// document for the moments the operator returns to the card. A host
				// without them (the tests, any non-browser importer of this bundle)
				// keeps the one-shot read above and nothing else, rather than throwing
				// on a global it never had.
				const win = typeof window === "undefined" ? null : window;
				const doc = typeof document === "undefined" ? null : document;
				const watch = win !== null && doc !== null && typeof win.addEventListener === "function";
				let timer = null;
				let reading = false;

				/**
				 * One status read, or none.
				 *
				 * Skipped rather than queued while a read is in flight: the host can
				 * hold a request open, and a slow answer must not stack the next tick
				 * behind it. Also skipped while a QR login is polling -- that loop
				 * refreshes the status itself on every transition, so a background
				 * read would only race it with the state it is already updating.
				 */
				const read = async () => {
					if (reading || sessionKeyRef.current) return;
					reading = true;
					try {
						await refreshStatus();
					} finally {
						reading = false;
					}
				};

				// Self-scheduling, like the login poll, so a tick can never overlap the
				// next one; `reading` covers a request a focus event started.
				const schedule = () => {
					timer = setTimeout(() => {
						timer = null;
						read();
						schedule();
					}, STATUS_POLL_MS);
				};

				const onFocus = () => read();
				const onVisibility = () => {
					if (doc !== null && doc.visibilityState === "visible") read();
				};

				if (watch) {
					win.addEventListener("focus", onFocus);
					doc.addEventListener("visibilitychange", onVisibility);
					schedule();
				}

				return () => {
					if (watch) {
						win.removeEventListener("focus", onFocus);
						doc.removeEventListener("visibilitychange", onVisibility);
					}
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
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
				createElement("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							flexWrap: "wrap",
							padding: "10px 12px",
							borderRadius: RADIUS.control,
							border: `1px solid ${statusKind === "ok" ? C.success : statusKind === "warn" ? C.warn : statusKind === "bad" ? C.danger : C.border}`,
							background: statusKind === "ok" ? C.successSubtle : statusKind === "warn" ? C.warnSubtle : C.surfaceSunken,
						},
					},
					createElement(PulseDot, {
						tone: statusKind === "ok" ? "ok" : statusKind === "warn" ? "warn" : statusKind === "bad" ? "danger" : "idle",
					}),
					createElement("span", { style: { fontSize: 14, fontWeight: 600, color: C.labelPrimary } }, statusText),
					bound
						? createElement(Badge, { text: accounts.map((a) => a.accountId).join(", "), tone: "neutral" })
						: null,
					sessionExpired ? createElement(Badge, { text: t("action needed", "需要处理"), tone: "danger" }) : null),
				//#endregion status

				// One row per bound account: identity, liveness, controls.
				accountRows,

				// Who tried to get in and was turned away — one click to allow.
				bound ? createElement(StrangerSection, { t }) : null,

				// Who can talk to each account, straight from status(): the
				// operator asked to see, at a glance under the login state, which
				// logged-in WeChat ids are allowlisted and which accounts have no
				// list of their own (the global one rules, or the first-contact
				// enrolment has not happened yet).
				bound
					? createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
							accounts.map((account) => {
								const senders = (account.allowedSenders ?? []).filter((id) => typeof id === "string" && id !== "");
								return createElement("div", { key: `al-${account.accountId}`, style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
									createElement("span", { style: { fontSize: 12, color: C.labelSecondary, flex: "none" } },
										account.label || account.accountId),
									senders.length > 0
										? createElement("span", { style: { fontSize: 12, color: C.labelPrimary } },
												t("allowlisted:", "白名单："),
												" ",
												senders.join(", "))
										: createElement("span", { style: { fontSize: 12, color: C.labelSecondary } },
												t("no allowlist of its own yet — global list rules, first message enrols its sender",
													"还没有自己的白名单 — 暂用全局名单，第一条消息的发送者会自动登记")));
							}))
					: null,

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

			const [donateQr, setDonateQr] = react.useState(null);
			react.useEffect(() => {
				// The QR is a bundled asset read by the host; if it is missing
				// (custom install, stripped package) the section just hides.
				callRemote(() => ctx.remote.weixin.donateQr())
					.then((r) => setDonateQr(typeof r?.qrDataUrl === "string" ? r.qrDataUrl : null))
					.catch(() => setDonateQr(null));
			}, []);

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
					createElement("div", { key: "tiles", style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						createElement(StatTile, { label: t("Installed", "已安装"), value: `v${PLUGIN_VERSION}` }),
						createElement(StatTile, { label: t("Package", "包名"), value: PKG }),
						createElement(StatTile, {
							label: t("Update", "更新"),
							value: checkState === "busy"
								? "…"
								: checkState === "outdated"
									? t("newer", "有新版本")
									: checkState === "latest"
										? t("latest", "最新")
										: checkState === "error"
											? t("unknown", "未知")
											: "—",
							tone: checkState === "latest" ? "ok" : checkState === "outdated" ? "warn" : checkState === "error" ? "danger" : "neutral",
						})),
					createElement("div", { key: "b", style: { display: "flex", alignItems: "center", gap: 10 } },
						createElement("button", { onClick: checkUpdate, disabled: checkState === "busy", style: buttonStyleFor(checkState === "busy") },
							checkState === "busy" ? createElement(Spinner, { size: 12 }) : null,
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
				typeof donateQr === "string"
					? row(t("Support the author", "打赏作者"), [
						createElement("img", { key: "qr", src: donateQr, alt: t("Donate QR", "微信赞赏码"), style: { width: 180, height: 245, display: "block", borderRadius: 8 } }),
						createElement("p", { key: "h", style: hintStyle },
							t("If this plugin saves you time, a small tip keeps the updates coming — scan with WeChat to buy the author a coffee.",
								"如果这个插件帮到了你，请作者喝杯咖啡吧——用微信扫码打赏，鼓励作者持续更新、优化功能、推出更好的特性。")),
					])
					: null,
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
									className: "weixin-row",
									style: {
										display: "flex", alignItems: "center", gap: 9,
										padding: "8px 11px",
										border: `1px solid ${isActive ? C.brand : C.border}`,
										borderRadius: RADIUS.control,
										background: isActive ? C.surface : C.surfaceSunken,
									},
								},
								createElement(PulseDot, { tone: isActive ? "ok" : "idle", size: 7 }),
								createElement("span", {
										style: {
											flex: "1 1 auto", minWidth: 0,
											fontSize: 13, lineHeight: "20px",
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
										},
									},
									`${index + 1}. ${line.title || t("(no messages yet)", "（尚无对话）")}`),
								isActive
									? createElement(Badge, { text: t("in use", "使用中"), tone: "brand" })
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
		/** Timed reminders: pending /remind entries with a cancel button. */
		function RemindersSection({ ctx, t }) {
			const [entries, setEntries] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");

			const load = async () => {
				setBusy(true);
				try {
					const r = await callRemote(() => ctx.remote.weixin.reminders());
					setError("");
					if (r?.available === false) {
						setEntries([]);
						setNotice(t("The scheduler is not running (plugin not fully loaded).", "调度器未运行（插件未完全加载）。"));
					} else {
						setNotice("");
						setEntries(Array.isArray(r?.entries) ? r.entries : []);
					}
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			react.useEffect(() => {
				load();
			}, []);

			const cancelOne = async (id) => {
				setBusy(true);
				setNotice("");
				try {
					const r = await callRemote(() => ctx.remote.weixin.remindCancel(id));
					if (r?.removed === false) {
						setNotice(r.error || t("Could not cancel", "取消失败"));
					}
					await load();
				} catch (e) {
					setNotice(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			const timeOf = (fireAt) => {
				try {
					const d = new Date(fireAt);
					return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
				} catch {
					return "?";
				}
			};

			const head = createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8 } },
				createElement("p", { style: { ...panelTitleStyle, margin: 0, flex: "1 1 auto" } }, t("Timed reminders", "定时提醒")),
				createElement("button", { onClick: () => load(), disabled: busy, style: buttonStyleFor(busy) },
					t("Refresh", "刷新")));

			if (error) {
				return createElement("div", { style: panelStyle }, head,
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "\u26a0"),
						createElement("span", null, error)));
			}

			// How long until a reminder fires, in words. The card never draws a
			// percentage it cannot place on a timeline: a reminder carries a due
			// instant, not a start, so a bar here would be invented.
			const untilText = (fireAt) => {
				const left = Number(fireAt) - Date.now();
				if (!Number.isFinite(left)) return "";
				if (left <= 0) return t("due now", "已到点");
				const minutes = Math.round(left / 60000);
				if (minutes < 60) return t(`in ${minutes} min`, `${minutes} 分钟后`);
				const hours = Math.floor(minutes / 60);
				const rest = minutes % 60;
				if (hours < 24) return rest === 0
					? t(`in ${hours} h`, `${hours} 小时后`)
					: t(`in ${hours} h ${rest} min`, `${hours} 小时 ${rest} 分后`);
				return t(`in ${Math.round(hours / 24)} d`, `${Math.round(hours / 24)} 天后`);
			};

			const rows = (entries ?? []).map((entry) => {
				const left = Number(entry.fireAt) - Date.now();
				const soon = Number.isFinite(left) && left > 0 && left <= 3600000;
				return createElement("div", {
					key: entry.id,
					className: "weixin-row",
					style: {
						display: "flex",
						gap: 10,
						padding: "9px 11px",
						borderRadius: RADIUS.control,
						border: `1px solid ${C.border}`,
						background: C.surfaceSunken,
						alignItems: "center",
					},
				},
					createElement(PulseDot, { tone: soon ? "warn" : "brand", size: 7 }),
					createElement("div", { style: { display: "flex", flexDirection: "column", gap: 1, flex: "1 1 auto", minWidth: 0 } },
						createElement("span", { style: { fontSize: 12.5, lineHeight: "18px", color: C.labelPrimary, overflowWrap: "anywhere" } }, entry.text),
						createElement("span", { style: { fontSize: 11, lineHeight: "16px", color: C.labelTertiary } }, `${timeOf(entry.fireAt)} · ${untilText(entry.fireAt)}`)),
					createElement("button", { onClick: () => cancelOne(entry.id), disabled: busy, style: buttonStyleFor(busy) },
						t("Cancel", "取消")));
			});

			return createElement("div", { style: panelStyle }, head,
				notice ? createElement("p", { style: hintStyle }, notice) : null,
				rows.length === 0 && !notice
					? createElement(EmptyState, {
						text: t("No pending reminders. Schedule one from WeChat: /remind 10m stand-up", "还没有待发提醒。在微信里安排：/remind 10m 例会"),
					})
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, rows),
				rows.length === 0 ? null : createElement("p", { style: captionStyle },
					t("Scheduled from WeChat with /remind; cancels here take effect at once.",
						"在微信里用 /remind 安排；这里取消立即生效。")));
			}


		/** 个性化: persona modes + memory, the same stores the WeChat-side commands use. */
		function PersonaSection({ ctx, t }) {
			const [overview, setOverview] = react.useState(null);
			const [accounts, setAccounts] = react.useState([]);
			const [accountId, setAccountId] = react.useState("");
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");
			const [editing, setEditing] = react.useState(null); // { id, name, prompt } | null
			const [draftName, setDraftName] = react.useState("");
			const [draftPrompt, setDraftPrompt] = react.useState("");
			const [factDraft, setFactDraft] = react.useState("");
			const [profileDraft, setProfileDraft] = react.useState(null);
			const [eventDraft, setEventDraft] = react.useState({ text: "", when: "" });

			const load = async () => {
				setBusy(true);
				try {
					const r = await callRemote(() => ctx.remote.weixin.personaOverview({ accountId }));
					setError("");
					setOverview(r);
				} catch (e) {
					setError(String(e?.code ?? e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			react.useEffect(() => {
				// Accounts feed the memory picker only; a failure just means the
				// plugin is not bound yet and the picker stays empty.
				callRemote(() => ctx.remote.weixin.status()).then((s) => {
					const list = Array.isArray(s?.accounts) ? s.accounts : [];
					setAccounts(list);
					setAccountId((current) => current || (list[0]?.accountId ?? ""));
				}).catch(() => {});
			}, []);

			react.useEffect(() => {
				load();
			}, [accountId]);

			const run = async (fn, okText) => {
				setBusy(true);
				setNotice("");
				try {
					await fn();
					if (okText) setNotice(okText);
					await load();
				} catch (e) {
					setNotice(String(e?.code ?? e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			const saveMode = () => run(async () => {
				await callRemote(() => ctx.remote.weixin.personaModeSave(editing?.id ? { id: editing.id, name: draftName, prompt: draftPrompt } : { name: draftName, prompt: draftPrompt }));
				setEditing(null);
				setDraftName("");
				setDraftPrompt("");
			}, t("Saved.", "已保存。"));

			const head = createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8 } },
				createElement("p", { style: { ...panelTitleStyle, margin: 0, flex: "1 1 auto" } }, t("Persona & memory", "个性化与记忆")),
				createElement("button", { onClick: () => load(), disabled: busy, style: buttonStyleFor(busy) }, t("Refresh", "刷新")));

			if (error && overview === null) {
				return createElement("div", { style: panelStyle }, head,
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "\u26a0"),
						createElement("span", null, error)));
			}

			const modes = overview?.modes ?? [];
			const overrides = overview?.overrides ?? [];
			const memory = overview?.memory;
			const textareaStyle = { ...inputStyle, flex: "1 1 auto", minHeight: 72, resize: "vertical" };

			// ── Modes ──
			const defaultOptions = [{ id: "", label: t("Follow the Options default", "跟随配置项默认") }, ...modes.map((m) => ({ id: m.id, label: m.name }))];
			const modeRows = modes.map((m) => createElement("div", {
				key: m.id,
				style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: C.labelSecondary, alignItems: "baseline" },
			},
				createElement("span", { style: { flex: "0 0 120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.labelPrimary } },
					m.name,
					m.builtin === true ? createElement("span", { style: { color: C.labelTertiary, marginLeft: 4 } }, t("built-in", "内置")) : null),
				createElement("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.labelTertiary } },
					(m.prompt || "").split("\n")[0] || t("(no prompt — plain assistant)", "（无提示词——普通助手）")),
				m.builtin === true ? null : createElement("button", { onClick: () => { setEditing(m); setDraftName(m.name); setDraftPrompt(m.prompt); }, disabled: busy, style: buttonStyleFor(busy) }, t("Edit", "编辑")),
				m.builtin === true ? null : createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.personaModeRemove(m.id))), disabled: busy, style: buttonStyleFor(busy) }, t("Delete", "删除"))));

			// A pack is the only way a hand-written mode leaves this app (F34): the
			// export is plain JSON, and the import only ever adds.
			const [packText, setPackText] = react.useState("");
			const exportPack = () => run(async () => {
				const result = await callRemote(() => ctx.remote.weixin.personaExport());
				setPackText(JSON.stringify(result.pack, null, 2));
			}, t("Pack ready — copy the text below.", "人设包已生成，复制下面的文本即可。"));
			const importPack = () => run(async () => {
				const result = await callRemote(() => ctx.remote.weixin.personaImport({ pack: packText }));
				setPackText("");
				setNotice(t(`Imported ${result.added} mode(s), skipped ${result.skipped.length}.`, `已导入 ${result.added} 个模式，跳过 ${result.skipped.length} 个。`));
			});
			const modesPanel = createElement("div", { key: "modes", style: panelStyle },
				head,
				createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
					createElement("label", { style: { fontSize: 12, color: C.labelSecondary, flex: "0 0 auto" } }, t("Default mode", "默认模式")),
					createElement("select", {
						value: overview?.globalDefault ?? "",
						onChange: (e) => run(() => callRemote(() => ctx.remote.weixin.personaDefaultSet(e.target.value)), t("Default updated. New conversations follow it at once.", "默认已更新，新会话立即生效。")),
						disabled: busy,
						style: inputStyle,
					}, defaultOptions.map((o) => createElement("option", { key: o.id, value: o.id }, o.label)))),
				accountId === "" ? null : createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
					createElement("label", { style: { fontSize: 12, color: C.labelSecondary, flex: "0 0 auto" } }, t("This account's default", "此账号默认")),
					createElement("select", {
						value: overview?.accountDefault ?? "",
						onChange: (e) => run(() => callRemote(() => ctx.remote.weixin.personaAccountDefaultSet({ accountId, modeId: e.target.value })), t("Account default updated.", "账号默认已更新。")),
						disabled: busy,
						style: inputStyle,
					}, defaultOptions.map((o) => createElement("option", { key: o.id, value: o.id }, o.label)))),
				createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 } }, modeRows),
				createElement("p", { style: captionStyle }, t(
					"Precedence: per-conversation /mode > this account's default > global default > Options. Switch per conversation from WeChat with /mode 女友; switching opens a fresh session line.",
					"优先级：会话 /mode 覆盖 > 此账号默认 > 全局默认 > 配置项。在微信里用 /mode 女友 按会话切换；切换会开一条新会话线。")),
				createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 } },
					createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
						createElement("button", { onClick: exportPack, disabled: busy, style: buttonStyleFor(busy) }, t("Export pack", "导出人设包")),
						createElement("button", { onClick: importPack, disabled: busy || packText.trim() === "", style: buttonStyleFor(busy || packText.trim() === "") }, t("Import pack", "导入人设包"))),
					createElement("textarea", { value: packText, onChange: (e) => setPackText(e.target.value), placeholder: t("Export above, or paste a pack here and press Import.", "先点导出，或把要导入的人设包粘贴到这里再点导入。"), style: { ...textareaStyle, minHeight: 64 } }),
					createElement("p", { style: captionStyle }, t("A pack carries your custom modes only. Importing adds modes; it never overwrites one you already have.", "人设包只包含自定义模式。导入只新增，不会覆盖已有的模式。"))),
				editing !== null || draftName !== "" ? null : createElement("button", { onClick: () => { setEditing({ id: "" }); setDraftName(""); setDraftPrompt(""); }, disabled: busy, style: buttonStyleFor(busy) }, t("Add a mode", "新增模式")),
				editing === null ? null : createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 8 } },
					createElement("input", { value: draftName, onChange: (e) => setDraftName(e.target.value), placeholder: t("Mode name, e.g. 导师", "模式名称，如 导师"), style: inputStyle }),
					createElement("textarea", { value: draftPrompt, onChange: (e) => setDraftPrompt(e.target.value), placeholder: t("How it should talk. This changes tone only — facts and tasks stay accurate.", "它该怎么说话。只改语气——事实与任务仍然准确。"), style: textareaStyle }),
					createElement("div", { style: { display: "flex", gap: 8 } },
						createElement("button", { onClick: saveMode, disabled: busy || draftName.trim() === "", style: buttonStyleFor(busy || draftName.trim() === "") }, t("Save", "保存")),
						createElement("button", { onClick: () => { setEditing(null); setDraftName(""); setDraftPrompt(""); }, disabled: busy, style: buttonStyleFor(busy) }, t("Cancel", "取消")))));

			// ── Overrides ──
			const overrideRows = overrides.map((o) => createElement("div", {
				key: `${o.accountId}|${o.conversationId}`,
				style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: C.labelSecondary, alignItems: "baseline" },
			},
				createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, o.accountId),
				createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere", color: C.labelTertiary } }, o.conversationId),
				createElement("span", { style: { flex: "0 0 auto", color: C.labelPrimary } }, o.modeId),
				createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.personaOverrideClear({ accountId: o.accountId, conversationId: o.conversationId })), t("Cleared.", "已清除。")), disabled: busy, style: buttonStyleFor(busy) }, t("Clear", "清除"))));

			const overridesPanel = createElement("div", { key: "overrides", style: panelStyle },
				createElement("p", { style: { ...panelTitleStyle, margin: 0 } }, t("Per-conversation overrides", "会话级覆盖")),
				overrides.length === 0
					? createElement("p", { style: hintStyle }, t("None — every conversation follows the default mode.", "没有——所有会话都跟随默认模式。"))
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, overrideRows));

			// ── Memory ──
			// ── 人物档案 (structured memory) ──
			// The model fills this in on its own during summaries; the inputs
			// here are for the cases where you want to say it once and have it
			// stick. Saves merge into the same file the chat-side /memory reads.
			const profile = memory?.profile ?? { call: "", schedule: "", likes: [], dislikes: [], dates: [] };
			const profileDraftValue = profileDraft ?? {
				call: profile.call ?? "",
				schedule: profile.schedule ?? "",
				likes: (profile.likes ?? []).join("、"),
				dislikes: (profile.dislikes ?? []).join("、"),
			};
			const splitList = (value) => String(value ?? "").split(/[、,，]/).map((item) => item.trim()).filter((item) => item !== "");
			const profileField = (key, label, placeholder) => createElement("label", { key, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.labelSecondary } },
				createElement("span", { style: { flex: "0 0 64px", color: C.labelTertiary } }, label),
				createElement("input", {
					value: profileDraftValue[key] ?? "",
					onChange: (e) => setProfileDraft({ ...profileDraftValue, [key]: e.target.value }),
					placeholder,
					style: inputStyle,
				}));
			const profilePanel = memory === null || memory === undefined ? null : createElement("div", { key: "profile", style: { marginTop: 10 } },
				createElement("p", { style: { ...captionStyle, margin: 0 } }, t("Profile of the person (the model fills this in; edit it if it got something wrong)", "关于对方的档案（模型会自己填，写错了可以在这里改）")),
				memory.digest !== "" && memory.digest !== undefined
					? createElement("p", { style: { fontSize: 12, lineHeight: "18px", color: C.labelTertiary, margin: "4px 0 0" } }, `${t("Lifeline", "人物小传")}：${memory.digest}`)
					: null,
				createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } },
					profileField("call", t("Call them", "称呼"), t("how they want to be addressed", "对方希望怎么被称呼")),
					profileField("schedule", t("Schedule", "作息"), t("e.g. up at 7, asleep at 2", "如 早上七点起、夜里两点睡")),
					profileField("likes", t("Likes", "喜欢"), t("comma separated", "用、或逗号分开")),
					profileField("dislikes", t("Dislikes", "不喜欢"), t("comma separated", "用、或逗号分开")),
					(profile.dates ?? []).length === 0 ? null : createElement("p", { style: { fontSize: 12, lineHeight: "18px", color: C.labelTertiary, margin: 0 } },
						`${t("Dates", "重要日期")}：${(profile.dates ?? []).map((d) => `${d.label} ${d.date}`).join("；")}`),
					createElement("div", null,
						createElement("button", {
							onClick: () => run(async () => {
								await callRemote(() => ctx.remote.weixin.memoryProfileSave({
									accountId,
									patch: {
										call: profileDraftValue.call,
										schedule: profileDraftValue.schedule,
										likes: splitList(profileDraftValue.likes),
										dislikes: splitList(profileDraftValue.dislikes),
									},
								}));
								setProfileDraft(null);
							}, t("Saved.", "已保存。")),
							disabled: busy,
							style: buttonStyleFor(busy),
						}, t("Save profile", "保存档案")))));

			// ── 事件与待办 ──
			const eventRows = (memory?.events ?? []).map((event) => createElement("div", {
				key: event.index,
				style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: event.done === true ? C.labelTertiary : C.labelSecondary, alignItems: "baseline" },
			},
				createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, `${event.index}.`),
				createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere", textDecoration: event.done === true ? "line-through" : "none" } },
					event.when ? `[${event.when}] ${event.text}` : event.text),
				event.done === true ? null : createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.memoryEventDone({ accountId, index: event.index }))), disabled: busy, style: buttonStyleFor(busy) }, t("Done", "完成")),
				createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.memoryEventRemove({ accountId, index: event.index }))), disabled: busy, style: buttonStyleFor(busy) }, t("Delete", "删除"))));

			const factRows = (memory?.facts ?? []).map((f) => createElement("div", {
				key: f.index,
				style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: C.labelSecondary, alignItems: "baseline" },
			},
				createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, `${f.index}.`),
				createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere" } }, f.text),
				createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.memoryFactRemove({ accountId, index: f.index }))), disabled: busy, style: buttonStyleFor(busy) }, t("Forget", "删除"))));

			// Per conversation: which persona it is in, how she feels right now,
			// and how long you two have known each other. The life state is
			// inferred on the host (clock + today's chat volume), never typed in.
			const convRows = (memory?.conversations ?? []).map((c) => {
				const stateParts = [];
				if (typeof c.modeName === "string" && c.modeName !== "") stateParts.push(t(`Mode: ${c.modeName}`, `模式：${c.modeName}`));
				if (typeof c.lifeLine === "string" && c.lifeLine !== "") stateParts.push(c.lifeLine);
				if (typeof c.bondLine === "string" && c.bondLine !== "") stateParts.push(c.bondLine);
				return createElement("div", {
					key: c.conversationId ?? c.summary.slice(0, 12),
					style: { display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: C.labelSecondary, alignItems: "baseline" },
				},
					createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere" } },
						c.conversationId === null ? t("(older conversation)", "（较早会话）") : c.conversationId,
						c.summary ? ` — ${c.summary}` : "",
						stateParts.length > 0 ? createElement("span", { style: { display: "block", color: C.labelTertiary } }, stateParts.join(" · ")) : null),
					c.conversationId === null ? null : createElement("button", { onClick: () => run(() => callRemote(() => ctx.remote.weixin.memoryConvClear({ accountId, conversationId: c.conversationId }))), disabled: busy, style: buttonStyleFor(busy) }, t("Clear", "清空")));
			});

			const memoryPanel = accountId === "" ? null : createElement("div", { key: "memory", style: panelStyle },
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					createElement("p", { style: { ...panelTitleStyle, margin: 0, flex: "1 1 auto" } }, t("Memory", "记忆")),
					accounts.length > 1 ? createElement("select", { value: accountId, onChange: (e) => setAccountId(e.target.value), disabled: busy, style: { ...inputStyle, flex: "0 0 auto", width: "auto" } },
						accounts.map((a) => createElement("option", { key: a.accountId, value: a.accountId }, a.label || a.accountId))) : null),
				createElement("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
					createElement("input", { value: factDraft, onChange: (e) => setFactDraft(e.target.value), placeholder: t("Remember across conversations, e.g. 我对花生过敏", "跨会话记住一件事，如 我对花生过敏"), style: inputStyle }),
					createElement("button", { onClick: () => run(async () => { await callRemote(() => ctx.remote.weixin.memoryFactAdd({ accountId, text: factDraft })); setFactDraft(""); }), disabled: busy || factDraft.trim() === "", style: buttonStyleFor(busy || factDraft.trim() === "") }, t("Remember", "记住"))),
				profilePanel,
				createElement("p", { style: { ...captionStyle, marginTop: 10 } }, t("Events & to-dos (dated entries expire on their own after they pass)", "事件与待办（带日期的过期后自动清掉）")),
				createElement("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
					createElement("input", { value: eventDraft.text, onChange: (e) => setEventDraft({ ...eventDraft, text: e.target.value }), placeholder: t("e.g. 明天去体检", "如 明天去体检"), style: inputStyle }),
					createElement("input", { value: eventDraft.when, onChange: (e) => setEventDraft({ ...eventDraft, when: e.target.value }), placeholder: "YYYY-MM-DD", style: { ...inputStyle, flex: "0 0 120px", width: 120 } }),
					createElement("button", {
						onClick: () => run(async () => {
							await callRemote(() => ctx.remote.weixin.memoryEventAdd({ accountId, text: eventDraft.text, when: eventDraft.when }));
							setEventDraft({ text: "", when: "" });
						}, t("Added.", "已添加。")),
						disabled: busy || eventDraft.text.trim() === "",
						style: buttonStyleFor(busy || eventDraft.text.trim() === ""),
					}, t("Add", "添加"))),
				eventRows.length === 0
					? null
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } }, eventRows),
				createElement("p", { style: { ...captionStyle, marginTop: 10 } }, t("Long-term facts", "长期记忆")),
				factRows.length === 0
					? createElement("p", { style: hintStyle }, t("No long-term facts yet. In WeChat: /remember …", "还没有长期记忆。在微信里：/remember …"))
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } }, factRows),
				convRows.length > 0 ? createElement("p", { style: { ...captionStyle, marginTop: 8 } }, t("Conversations: mode, how she feels right now, and how long you have known each other (summaries auto-refresh every N turns)", "每个会话：模式 · 此刻状态 · 认识多久（摘要每 N 回合自动更新）")) : null,
				convRows.length === 0 ? null : createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } }, convRows));

			return createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
				modesPanel,
				overridesPanel,
				memoryPanel,
				notice ? createElement("p", { style: hintStyle }, notice) : null);
		}

		/** Message journal: recent in/out traffic across accounts, newest first. */
		function JournalSection({ ctx, t, focus, onClearFocus }) {
			const [entries, setEntries] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [loadingMore, setLoadingMore] = react.useState(false);
			const [hasMore, setHasMore] = react.useState(true);
			const [query, setQuery] = react.useState("");

			const fetchPage = async (extra) => {
				return callRemote(() => ctx.remote.weixin.journal({ limit: 200, conversationId: focus || undefined, ...extra }));
			};
			const load = async () => {
				setBusy(true);
				try {
					const r = await fetchPage({});
					setError("");
					setEntries(Array.isArray(r?.entries) ? r.entries : []);
					// A short page means the journal has nothing older to give.
					setHasMore(Array.isArray(r?.entries) && r.entries.length >= 200);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};
			// One page of 200 is a window, not the archive: "load earlier" pages
			// backwards from the oldest entry already on screen.
			const loadMore = async () => {
				const all = entries ?? [];
				const oldest = all.length > 0 ? all[all.length - 1] : undefined;
				if (oldest === undefined) return;
				setLoadingMore(true);
				try {
					const r = await fetchPage({ before: oldest.at });
					const page = Array.isArray(r?.entries) ? r.entries : [];
					setEntries([...all, ...page]);
					setHasMore(page.length >= 200);
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setLoadingMore(false);
				}
			};

			// Reload when a stats-row drill-down changes the conversation focus.
			react.useEffect(() => {
				load();
			}, [focus]);

			const [exporting, setExporting] = react.useState(false);
			const exportChat = async () => {
				setExporting(true);
				try {
					const r = await callRemote(() => ctx.remote.weixin.journalExport({ days: 30 }));
					// The card downloads the Markdown itself as a Blob — no
					// server-side file handoff involved.
					const blob = new Blob([r?.markdown ?? ""], { type: "text/markdown;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = `weixin-journal-${new Date().toISOString().slice(0, 10)}.md`;
					anchor.click();
					URL.revokeObjectURL(url);
					setError("");
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setExporting(false);
				}
			};

			const [filter, setFilter] = react.useState("all");

			const dayKeyOf = (at) => {
				const d = new Date(at);
				return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
			};
			const dayLabelOf = (at) => {
				const key = dayKeyOf(at);
				if (key === dayKeyOf(Date.now())) return t("Today", "今天");
				if (key === dayKeyOf(Date.now() - 86400000)) return t("Yesterday", "昨天");
				const d = new Date(at);
				return `${d.getMonth() + 1}/${d.getDate()}`;
			};
			const clockOf = (at) => {
				try {
					return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				} catch {
					return "?";
				}
			};

			const all = entries ?? [];
			// Search is client-side over everything loaded so far — text or
			// sender, case-insensitive. It says so on the box: it searches the
			// loaded window, not the whole archive.
			const q = query.trim().toLowerCase();
			const visible = all.filter((entry) =>
				(filter === "all" || entry.dir === filter)
				&& (q === ""
					|| String(entry.text ?? "").toLowerCase().includes(q)
					|| String(entry.senderId ?? "").toLowerCase().includes(q)));

			const filterButton = (id, label) => createElement("button", {
				key: id,
				onClick: () => setFilter(id),
				style: {
					border: `1px solid ${filter === id ? C.brand : C.border}`,
					background: filter === id ? C.surfaceSunken : "transparent",
					color: filter === id ? C.labelPrimary : C.labelSecondary,
					borderRadius: RADIUS.pill,
					padding: "2px 10px",
					fontSize: 12,
					lineHeight: "18px",
					cursor: "pointer",
				},
			}, label);

			const head = createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
				createElement("p", { style: { ...panelTitleStyle, margin: 0, flex: "1 1 auto" } },
					t("Message journal", "消息流水"),
					createElement("span", { style: { marginLeft: 8, fontSize: 12, fontWeight: 400, color: C.labelTertiary } },
						t(`${visible.length} shown of ${all.length} loaded`, `显示 ${visible.length} / 已载 ${all.length} 条`))),
				focus ? createElement("button", {
					key: "focus-chip",
					onClick: () => (onClearFocus ? onClearFocus() : undefined),
					title: focus,
					style: {
						border: `1px solid ${C.brand}`,
						background: C.surfaceSunken,
						color: C.labelPrimary,
						borderRadius: RADIUS.pill,
						padding: "2px 10px",
						fontSize: 12,
						lineHeight: "18px",
						cursor: "pointer",
					},
				}, t(`conversation ${String(focus).slice(0, 16)}… ✕`, `会话 ${String(focus).slice(0, 16)}… ✕`)) : null,
				createElement("input", {
					value: query,
					onChange: (event) => setQuery(event.target.value),
					placeholder: t("Search loaded text or sender", "搜已加载的文本 / 发送者"),
					style: { ...inputStyle, flex: "0 1 180px", minWidth: 120, padding: "4px 10px", fontSize: 12 },
				}),
				createElement("div", { style: { display: "flex", gap: 4 } },
					filterButton("all", t("All", "全部")),
					filterButton("in", `\u2193 ${t("Received", "收到")}`),
					filterButton("out", `\u2191 ${t("Sent", "发出")}`)),
				createElement("button", { onClick: () => exportChat(), disabled: exporting, style: buttonStyleFor(exporting) },
					t("Export chat", "导出记录")),
				createElement("button", { onClick: () => load(), disabled: busy, style: buttonStyleFor(busy) },
					t("Refresh", "刷新")));

			if (error) {
				return createElement("div", { style: panelStyle }, head,
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "\u26a0"),
						createElement("span", null, error)));
			}

			const bubble = (entry, i) => {
				const outgoing = entry.dir === "out";
				const meta = [clockOf(entry.at), entry.accountId, entry.senderId].filter(Boolean).join(" \u00b7 ");
				return createElement("div", {
					key: `${entry.at}-${i}`,
					style: { display: "flex", flexDirection: "column", alignItems: outgoing ? "flex-end" : "flex-start", gap: 2 },
				},
					createElement("div", {
						style: {
							maxWidth: "78%",
							padding: "7px 11px",
							borderRadius: outgoing ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
							background: outgoing ? C.primaryFill : C.surfaceSunken,
							color: outgoing ? C.onPrimary : C.labelPrimary,
							border: outgoing ? "1px solid transparent" : `1px solid ${C.border}`,
							fontSize: 12.5,
							lineHeight: "19px",
							whiteSpace: "pre-wrap",
							overflowWrap: "anywhere",
							boxSizing: "border-box",
						},
					}, entry.text ?? ""),
					createElement("div", { style: { fontSize: 11, lineHeight: "16px", color: C.labelTertiary, padding: "0 4px" } }, meta));
			};

			const blocks = [];
			let lastDay = "";
			visible.forEach((entry, i) => {
				const day = dayKeyOf(entry.at);
				if (day !== lastDay) {
					lastDay = day;
					blocks.push(createElement("div", {
						key: `day-${day}`,
						style: { display: "flex", alignItems: "center", gap: 8, margin: "6px 0 2px" },
					},
						createElement("span", { style: { flex: "1 1 auto", height: 1, background: C.border } }),
						createElement("span", { style: { fontSize: 11, color: C.labelTertiary, padding: "0 4px" } }, dayLabelOf(entry.at)),
						createElement("span", { style: { flex: "1 1 auto", height: 1, background: C.border } })));
				}
				blocks.push(bubble(entry, i));
			});

			return createElement("div", { style: panelStyle }, head,
				visible.length === 0
					? createElement("div", { style: { padding: "28px 12px", textAlign: "center", color: C.labelTertiary, fontSize: 12, lineHeight: "20px" } },
						t(q !== "" ? "Nothing in the loaded window matches." : "No recorded messages yet.", q !== "" ? "已加载的范围内没有匹配。" : "还没有记录到的消息。"))
					: createElement("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6,
							maxHeight: 460,
							overflowY: "auto",
							padding: "4px 2px",
							borderRadius: RADIUS.control,
						},
					}, blocks),
				hasMore && !q && all.length > 0
					? createElement("button", {
						onClick: () => loadMore(),
						disabled: loadingMore || busy,
						style: { ...buttonStyleFor(loadingMore || busy), alignSelf: "center" },
					}, loadingMore ? t("Loading…", "加载中…") : t("Load earlier messages", "加载更早的消息"))
					: null,
				createElement("p", { style: captionStyle },
					t("Newest first, last 200. \u2191 sent by the bot, \u2193 received from WeChat.",
						"最新在前，最近 200 条。\u2191 机器人发出，\u2193 收到。")));
			}
		/**
		 * 统计页签. Reads journal-derived stats: totals, a per-day series, the
		 * 24-hour distribution and the busiest conversations. Bars are plain
		 * divs — inline styles only, so the card has no charting dependency.
		 */
		function StatsSection({ ctx, t, onOpenConversation }) {
			const [stats, setStats] = react.useState(null);
			const [storage, setStorage] = react.useState(null);
			const [outbox, setOutbox] = react.useState(null);
			const [metrics, setMetrics] = react.useState(null);
			const [days, setDays] = react.useState(14);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);

			const load = async () => {
				setBusy(true);
				try {
					const r = await callRemote(() => ctx.remote.weixin.stats({ days }));
					setError("");
					setStats(r);
					// Disk usage is independent of the window; a failure here must
					// not take the whole tab down with it.
					try {
						setStorage(await callRemote(() => ctx.remote.weixin.storage()));
					} catch {
						setStorage(null);
					}
					try {
						setOutbox(await callRemote(() => ctx.remote.weixin.outbox()));
					} catch {
						setOutbox(null);
					}
					try {
						setMetrics(await callRemote(() => ctx.remote.weixin.metrics()));
					} catch {
						setMetrics(null);
					}
				} catch (e) {
					setError(String(e?.message ?? e));
				} finally {
					setBusy(false);
				}
			};

			react.useEffect(() => {
				load();
			}, [days]);

			const head = createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 8 } },
				createElement("p", { style: { ...panelTitleStyle, margin: 0, flex: "1 1 auto" } }, t("Statistics", "统计")),
				createElement("select", {
					value: String(days),
					onChange: (e) => setDays(Number(e.target.value)),
					disabled: busy,
					style: { ...inputStyle, flex: "0 0 auto", width: "auto" },
				},
					[7, 14, 30].map((n) => createElement("option", { key: n, value: String(n) }, t(`Last ${n} days`, `最近 ${n} 天`)))),
				createElement("button", { onClick: () => load(), disabled: busy, style: buttonStyleFor(busy) }, t("Refresh", "刷新")));

			if (error) {
				return createElement("div", { style: panelStyle }, head,
					createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "\u26a0"),
						createElement("span", null, error)));
			}

			const total = stats?.total ?? { in: 0, out: 0, all: 0 };
			const daily = Array.isArray(stats?.daily) ? stats.daily : [];
			const hours = Array.isArray(stats?.hours) ? stats.hours : [];
			const conversations = Array.isArray(stats?.conversations) ? stats.conversations : [];
			const maxDaily = Math.max(1, ...daily.map((d) => d.all));
			const maxHour = Math.max(1, ...hours);
			const health = stats?.health ?? null;
			const composition = stats?.composition ?? null;

			// 健康度环：四项各 25 分，口径写在下面每一行里。纯 SVG，零依赖。
			const ring = (score, max, size = 76) => {
				const radius = (size - 10) / 2;
				const circumference = 2 * Math.PI * radius;
				const ratio = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
				const center = size / 2;
				return createElement("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { flex: "0 0 auto" } },
					createElement("circle", { cx: center, cy: center, r: radius, fill: "none", stroke: C.border, strokeWidth: 7 }),
					createElement("circle", {
						cx: center, cy: center, r: radius, fill: "none",
						stroke: C.primaryFill, strokeWidth: 7, strokeLinecap: "round",
						strokeDasharray: `${circumference} ${circumference}`,
						strokeDashoffset: circumference * (1 - ratio),
						transform: `rotate(-90 ${center} ${center})`,
					}),
					createElement("text", { x: center, y: center + 5, textAnchor: "middle", fill: C.labelPrimary, fontSize: 20, fontWeight: 600 }, String(score)),
					createElement("text", { x: center, y: center + 21, textAnchor: "middle", fill: C.labelTertiary, fontSize: 10 }, `/${max}`));
			};

			// 会话 sparkline：最近 N 天每天的消息数，折线即可，不画坐标轴。
			const spark = (points, width = 108, height = 22) => {
				const values = Array.isArray(points) && points.length > 0 ? points : [0];
				const peak = Math.max(1, ...values);
				const step = values.length > 1 ? width / (values.length - 1) : width;
				const path = values
					.map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${(height - 2 - (value / peak) * (height - 4)).toFixed(1)}`)
					.join(" ");
				return createElement("svg", { width, height, viewBox: `0 0 ${width} ${height}`, style: { flex: "0 0 auto" } },
					createElement("path", { d: path, fill: "none", stroke: C.primaryFill, strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" }));
			};

			const COMPOSITION_COLORS = ["#5B8DEF", "#7C6CF0", "#4FB3A5", "#E0A44B", "#D97A7A", "#9AA5B1", "#8BC48A", "#B48BE0"];
			const COMPOSITION_NAMES = {
				persona: ["Persona", "人设"],
				style: ["Style", "语气与节奏"],
				life: ["Life state", "生活状态"],
				contact: ["Member card", "群成员名片"],
				memory: ["Memory", "记忆"],
				recall: ["Recall", "往事检索"],
				dryRun: ["Dry run", "预演约定"],
				message: ["Message & attachments", "这条消息与附件"],
			};
			const compositionTotal = composition?.total > 0
				? composition.total
				: (composition?.sections ?? []).reduce((sum, section) => sum + section.chars, 0);
			const compositionBar = composition === null || compositionTotal <= 0 ? null : createElement("div", { style: { display: "flex", height: 12, borderRadius: RADIUS.pill, overflow: "hidden", border: `1px solid ${C.border}` } },
				(composition.sections ?? []).map((section, index) => createElement("div", {
					key: section.key,
					title: `${(COMPOSITION_NAMES[section.key] ?? [section.key, section.key])[1]}: ${section.chars}`,
					style: { width: `${(section.chars / compositionTotal) * 100}%`, background: COMPOSITION_COLORS[index % COMPOSITION_COLORS.length] },
				})));
			const compositionLegend = composition === null || compositionTotal <= 0 ? null : createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, lineHeight: "16px", color: C.labelSecondary } },
				(composition.sections ?? []).map((section, index) => createElement("span", { key: section.key, style: { display: "flex", alignItems: "center", gap: 4 } },
					createElement("span", { style: { width: 8, height: 8, borderRadius: 2, background: COMPOSITION_COLORS[index % COMPOSITION_COLORS.length] } }),
					`${(COMPOSITION_NAMES[section.key] ?? [section.key, section.key])[1]} ${Math.round((section.chars / compositionTotal) * 100)}%`)));
			const compositionPanel = createElement("div", { key: "composition", style: { display: "flex", flexDirection: "column", gap: 6 } },
				createElement("p", { style: { ...captionStyle, marginBottom: 0 } },
					t("Prompt composition (characters, not tokens)", "提示词构成（字符，不是 token）")),
				compositionBar === null
					? createElement("p", { style: captionStyle }, t("No turn has been recorded since the plugin started.", "插件启动后还没有记录到一个回合。"))
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
						compositionBar,
						compositionLegend,
						createElement("p", { style: captionStyle },
							t(`Last turn: ${compositionTotal} characters in total.`,
								`最近一个回合共 ${compositionTotal} 个字符。`))));

			const HEALTH_NAMES = {
				connected: [t("Connected", "连接"), t("At least one account can be loaded.", "至少一个账号能加载。")],
				outbox: [t("Delivery", "投递"), t("Nothing waiting to be retried.", "没有待重发的消息。")],
				budget: [t("Budget", "预算"), t("Background calls below the daily limit.", "后台调用未超每日上限。")],
				retention: [t("Retention", "留存"), t("Journal, audit and media windows are set.", "流水、审计、媒体的保留天数都设了。")],
			};
			const healthPanel = health === null ? null : createElement("div", { key: "health", style: { display: "flex", gap: 16, alignItems: "center" } },
				ring(health.score, 100),
				createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, flex: "1 1 auto" } },
					createElement("p", { style: { ...captionStyle, marginBottom: 0 } }, t("Health (our own formula, not a model score)", "健康度（我们自己的口径，不是模型评分）")),
					(health.parts ?? []).map((part) => createElement("div", { key: part.key, style: { display: "flex", gap: 8, fontSize: 11, lineHeight: "16px", color: C.labelSecondary } },
						createElement("span", { style: { flex: "0 0 64px", color: C.labelPrimary } }, (HEALTH_NAMES[part.key] ?? [part.key])[0]),
						createElement("span", { style: { flex: "0 0 44px", textAlign: "right", color: C.labelPrimary } }, `${part.score}/${part.max}`),
						createElement("span", { style: { flex: "1 1 auto", color: C.labelTertiary } }, (HEALTH_NAMES[part.key] ?? [part.key, ""])[1])))));

			const summaryRow = createElement("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, lineHeight: "18px", color: C.labelSecondary } },
				createElement("span", null, t("Total", "总计"), ": ", createElement("strong", { style: { color: C.labelPrimary } }, String(total.all))),
				createElement("span", null, "\u2193 ", t("received", "收到"), ": ", createElement("strong", { style: { color: C.labelPrimary } }, String(total.in))),
				createElement("span", null, "\u2191 ", t("sent", "发出"), ": ", createElement("strong", { style: { color: C.labelPrimary } }, String(total.out))));

			const dayBars = daily.map((d) => createElement("div", {
				key: d.day,
				style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, lineHeight: "16px", color: C.labelSecondary },
			},
				createElement("span", { style: { flex: "0 0 88px", color: C.labelTertiary } }, d.day.slice(5)),
				createElement("div", { style: { flex: "1 1 auto", height: 8, borderRadius: RADIUS.pill, background: C.moduleFill ?? "transparent", border: `1px solid ${C.border}`, overflow: "hidden" } },
					createElement("div", { style: { width: `${Math.round((d.all / maxDaily) * 100)}%`, height: "100%", background: C.primaryFill } })),
				createElement("span", { style: { flex: "0 0 56px", textAlign: "right", color: C.labelPrimary } }, `${d.all}`),
				createElement("span", { style: { flex: "0 0 72px", color: C.labelTertiary } }, `\u2193${d.in} \u2191${d.out}`)));

			// 24-hour distribution: 24 thin columns.
			const hourBars = hours.map((count, hour) => createElement("div", {
				key: hour,
				title: `${String(hour).padStart(2, "0")}:00 — ${count}`,
				style: { flex: "1 1 0", display: "flex", flexDirection: "column", justifyContent: "flex-end", height: 48 },
			},
				createElement("div", { style: { height: `${Math.round((count / maxHour) * 100)}%`, minHeight: count > 0 ? 2 : 0, background: C.primaryFill, borderRadius: 2 } })));
			const hourAxis = createElement("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: C.labelTertiary } },
				createElement("span", null, "00"), createElement("span", null, "06"), createElement("span", null, "12"), createElement("span", null, "18"), createElement("span", null, "23"));

			const queued = Array.isArray(outbox?.items) ? outbox.items : [];
			const retryNow = async () => {
				try {
					await callRemote(() => ctx.remote.weixin.outboxRetry());
				} catch {
					// The refresh below shows whatever is still queued.
				}
				load();
			};
			const dropOne = async (id) => {
				try {
					await callRemote(() => ctx.remote.weixin.outboxDrop({ id }));
				} catch {
					// Nothing to do but refresh.
				}
				load();
			};
			const queuedRows = queued.map((item) =>
				createElement("div", { key: item.id, style: { display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, lineHeight: "18px", color: C.labelSecondary } },
					createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere" } }, String(item.text ?? "").slice(0, 80)),
					createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, `${item.attempts ?? 0}\u00d7`),
					createElement("button", { style: buttonStyleFor(busy), onClick: () => dropOne(item.id) }, t("Drop", "丢弃"))));
			const outboxPanel = createElement("div", { key: "outbox", style: { display: "flex", flexDirection: "column", gap: 4 } },
				createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					createElement("p", { style: { ...captionStyle, margin: 0, flex: "1 1 auto" } }, t("Undelivered messages", "待发送") + ` \u2014 ${queued.length}`),
					createElement("button", { disabled: queued.length === 0 || busy, style: buttonStyleFor(queued.length === 0 || busy), onClick: retryNow }, t("Retry now", "立即重试"))),
				queued.length === 0
					? createElement("p", { style: captionStyle }, t("Everything written so far has been delivered.", "写好的消息都已经发出去了。"))
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, queuedRows),
				createElement("p", { style: captionStyle },
					t("A reply that could not be sent is kept on disk and retried with backoff.",
						"发不出去的消息会存在本地并按退避重试，DSH 重启也不会丢。")));

			const mb = (bytes) => `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`;
			const retention = storage?.retention;
			const storagePanel = storage === null ? null : createElement("div", { key: "storage", style: { display: "flex", flexDirection: "column", gap: 4 } },
				createElement("p", { style: { ...captionStyle, marginBottom: 2 } },
					t("Disk usage", "磁盘占用"), ` — ${mb(storage.usage?.total)}`),
				createElement("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, lineHeight: "18px", color: C.labelSecondary } },
					createElement("span", null, t("Journal", "消息流水"), ": ", mb(storage.usage?.journal), retention === undefined ? null : ` (${retention.journalDays} ${t("days", "天")})`),
					createElement("span", null, t("Audit", "审计"), ": ", mb(storage.usage?.audit), retention === undefined ? null : ` (${retention.auditDays} ${t("days", "天")})`),
					createElement("span", null, t("Media", "媒体"), ": ", mb(storage.usage?.media), retention === undefined ? null : ` (${retention.mediaDays} ${t("days", "天")})`),
					createElement("span", null, t("Exports", "导出"), ": ", mb(storage.usage?.exports)),
					createElement("span", null, t("Logs", "日志"), ": ", mb(storage.usage?.logs))),
				createElement("p", { style: captionStyle },
					t("Older files are swept once a day; the windows live in the settings tab.",
						"超过保留期的文件每天自动清理一次，保留天数在「配置项」页签里改。")));

			// Counters reset with the process, so the panel always states how long
			// the process has been up: a rate without a denominator is a guess.
			const minutes = metrics === null ? 0 : Math.floor(Number(metrics.uptimeMs ?? 0) / 60_000);
			const counter = (name) => Number(metrics?.counters?.[name] ?? 0);
			const metricsPanel = metrics === null ? null : createElement("div", { key: "metrics", style: { display: "flex", flexDirection: "column", gap: 4 } },
				createElement("p", { style: { ...captionStyle, marginBottom: 2 } },
					t("Since the plugin started", "本次启动以来"), ` — ${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}`),
				createElement("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, lineHeight: "18px", color: C.labelSecondary } },
					createElement("span", null, t("Accepted", "收到"), ": ", String(counter("inbound.accepted"))),
					createElement("span", null, t("Refused", "拒绝"), ": ", String(counter("inbound.refused"))),
					createElement("span", null, t("Sent", "发出"), ": ", String(counter("outbound.settled"))),
					createElement("span", null, t("Turns", "回合"), ": ", String(counter("turn.settled"))),
					createElement("span", null, t("Waiting", "待发"), ": ", String(Number(metrics.pendingOutbox ?? 0)))),
				createElement("p", { style: captionStyle },
					t("These counters live in memory and reset when the plugin restarts.",
						"这些计数只存在内存里，插件重启就归零。")));

			// A row is a doorway: clicking it opens the journal tab pre-filtered
			// to this conversation. Optional prop, so tests render it standalone.
			const convRows = conversations.map((c) => createElement("div", {
				key: `${c.accountId}|${c.conversationId}`,
				onClick: () => (onOpenConversation ? onOpenConversation(c.conversationId) : undefined),
				title: onOpenConversation ? t("Open this conversation in the journal", "在消息流水里只看这个会话") : undefined,
				style: {
					display: "flex", gap: 8, fontSize: 12, lineHeight: "18px", color: C.labelSecondary, alignItems: "center",
					...(onOpenConversation ? { cursor: "pointer", padding: "2px 4px", borderRadius: RADIUS.control } : {}),
				},
				className: onOpenConversation ? "weixin-row" : undefined,
			},
				createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, c.accountId),
				createElement("span", { style: { flex: "1 1 auto", overflowWrap: "anywhere" } }, c.conversationId),
				spark(c.series),
				createElement("span", { style: { flex: "0 0 auto", color: C.labelPrimary } }, String(c.all)),
				createElement("span", { style: { flex: "0 0 auto", color: C.labelTertiary } }, `\u2193${c.in} \u2191${c.out}`)));

			return createElement("div", { style: panelStyle }, head,
				summaryRow,
				healthPanel,
				total.all === 0
					? createElement("p", { style: hintStyle }, t("No messages in this window yet.", "这个时间窗口里还没有消息。"))
					: createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
						createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, dayBars),
						createElement("div", null,
							createElement("p", { style: { ...captionStyle, marginBottom: 4 } }, t("By hour of day", "按小时分布")),
							createElement("div", { style: { display: "flex", gap: 2, alignItems: "flex-end" } }, hourBars),
							hourAxis),
						conversations.length === 0 ? null : createElement("div", null,
							createElement("p", { style: { ...captionStyle, marginBottom: 4 } }, t("Busiest conversations", "最活跃的会话")),
							createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, convRows))),
				compositionPanel,
				createElement("p", { style: captionStyle },
					t("Computed live from the message journal. \u2191 sent by the bot, \u2193 received.",
						"由消息流水现算。\u2191 机器人发出，\u2193 收到。")),
				createElement("p", { style: captionStyle },
					t("Token counts and cache hit rates are not shown: the host does not hand them to plugins, so any number here would be a guess.",
						"token 用量与缓存命中率不显示：宿主不把这两样交给插件，写出来的任何数字都只能是猜的。")),
				outboxPanel,
				storagePanel,
				metricsPanel);
			}

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
					// Groups start collapsed: the form is long, and a pre-opened
					// first section pushed the other eight below the fold on every
					// visit. Reloading keeps whichever section is open now.
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
								createElement("span", {}, t(option.labelEn, option.label)))));
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
						field.unit ? createElement("span", { style: captionStyle }, t(field.unitEn, field.unit)) : null);
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
							t(field.labelEn, field.label)),
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
					createElement("p", { style: captionStyle }, t(field.hintEn, field.hint)),
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
							createElement("span", { style: panelTitleStyle }, t(group.groupEn, group.group)),
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
										border: `1px solid ${source === choice.id ? C.brand : C.border}`,
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
										border: `1px solid ${proxyMode === choice.id ? C.brand : C.border}`,
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
				// Tab index lives here so one section can send the operator to
				// another: a stats row drills into the journal pre-filtered.
				const [tab, setTab] = react.useState(0);
				const [journalFocus, setJournalFocus] = react.useState(null);
				const openInJournal = (conversationId) => {
					setJournalFocus(conversationId);
					setTab(TABS.findIndex((entry) => entry.id === "journal"));
				};
				const TABS = [
					{ id: "account", label: t("WeChat account", "微信账号"), body: createElement(LoginSection, { ctx, t }) },
					{ id: "sessions", label: t("Sessions", "会话"), body: createElement(SessionsSection, { ctx, t }) },
					{ id: "options", label: t("Options", "配置项"), body: createElement(ConfigSection, { ctx, t }) },
					{ id: "voice", label: t("Voice models", "语音模型"), body: createElement(AsrSection, { ctx, t }) },
										{ id: "journal", label: t("Journal", "消息流水"), body: createElement(JournalSection, { ctx, t, focus: journalFocus, onClearFocus: () => setJournalFocus(null) }) },
					{ id: "stats", label: t("Stats", "统计"), body: createElement(StatsSection, { ctx, t, onOpenConversation: openInJournal }) },
					{ id: "reminders", label: t("Reminders", "定时提醒"), body: createElement(RemindersSection, { ctx, t }) },
					{ id: "persona", label: t("Persona", "个性化"), body: createElement(PersonaSection, { ctx, t }) },
					{ id: "about", label: t("About", "关于"), body: createElement(AboutSection, { ctx, t }) },
				];
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
				ensureCardStyles();
				return createElement("div", {
						style: { display: "flex", flexDirection: "column", gap: 16, color: C.labelPrimary },
					},
					createElement("div", {
							role: "tablist",
							className: "weixin-settings-tabbar",
							onKeyDown: onTabKey,
							style: {
								display: "flex",
								gap: 4,
								padding: "0 2px",
								borderBottom: `1px solid ${C.border}`,
								overflowX: "auto",
							},
						},
						...TABS.map((entry, index) => {
							const active = index === tab;
							return createElement("button", {
									key: entry.id,
									role: "tab",
									"aria-selected": active,
									tabIndex: active ? 0 : -1,
									onClick: () => setTab(index),
									className: "weixin-tab",
									style: {
										appearance: "none",
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										background: active ? C.surfaceSunken : "transparent",
										border: "none",
										borderBottom: `2px solid ${active ? C.brand : "transparent"}`,
										borderRadius: `${RADIUS.control}px ${RADIUS.control}px 0 0`,
										color: active ? C.labelPrimary : C.labelTertiary,
										fontSize: 13,
										lineHeight: "20px",
										fontWeight: active ? 600 : 400,
										padding: "9px 11px",
										cursor: "pointer",
										whiteSpace: "nowrap",
									},
								},
								createElement(TabIcon, { id: entry.id, active }),
								entry.label);
						})),
					createElement("div", {
							key: TABS[tab]?.id,
							className: "weixin-card-enter",
							style: { display: "flex", flexDirection: "column" },
						},
						section(TABS[tab]?.label ?? "", TABS[tab]?.body)));
			}
			return { WeixinSettingsCard };
		};
		return module.exports;
	},
});
