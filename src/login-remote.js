// WeixinLoginController — settings-page login orchestration.
//
// Reuses the vendored low-level API helpers (apiGetFetch/apiPostFetch) and the
// account store, but runs its own polling state machine: the CLI
// waitForWeixinLogin() blocks on stdin for the verify-code step, which is
// unusable from the settings UI. Here the verify code is submitted by the UI
// through submitVerifyCode() instead.
import { randomUUID } from "node:crypto";
import { TypertRemoteService, Remote, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { apiGetFetch, apiPostFetch } from "../vendor/openclaw-weixin/api/api.js";
import {
    loadWeixinAccount,
    listIndexedWeixinAccountIds,
    saveWeixinAccount,
    registerWeixinAccountId,
    clearWeixinAccount,
    unregisterWeixinAccountId,
} from "../vendor/openclaw-weixin/auth/accounts.js";
import { logger } from "../vendor/openclaw-weixin/util/logger.js";
import { redactToken } from "../vendor/openclaw-weixin/util/redact.js";
import { allowlistForAccount, isAccountPaused, readRegistry, setAccountAllowlist, setAccountLabel, setAccountPaused } from "./account-registry.js";
import { readSavedConfig, stateDir } from "./state.js";
import { DEFAULT_RETENTION, directoryUsage } from "./message/retention.js";
import { readOutbox } from "./message/outbox.js";
import { remoteMethods } from "./typert-js.js";
import { readGlobalMemory, listConvMemories, addGlobalFact, removeGlobalFact, clearConvMemory, bondLine, addEvent, removeEvent, completeEvent, saveProfile, formatEvents } from "./memory.js";
import {
    activeModeFor,
    listActiveOverrides,
    readAccountDefaultMode,
    readGlobalDefaultMode,
    readPersonaStore,
    resolveMode,
    setActiveMode,
    writeAccountDefaultMode,
    writeGlobalDefaultMode,
    writePersonaStore,
    clearActiveMode,
    MAX_CUSTOM_MODES,
} from "./persona.js";
import { DEFAULT_MODE_ID } from "./persona.js";
import { lifeSummary, readOrInferLifeState } from "./message/life-state.js";
import { qrDataUrl } from "./qr-png.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The donate QR ships as a bundled asset (assets/donate-qr.jpg, whitelisted in
// package.json "files"). Read it once, lazily, as a data URL - the settings
// card cannot reach plugin files by path, so the image must ride the remote
// result like the login QR does. A missing or unreadable file just means the
// About tab hides its donate section; nothing else may break because of it.
let donateQrDataUrlCache;
function donateQrDataUrl() {
    if (donateQrDataUrlCache !== undefined) return donateQrDataUrlCache;
    try {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "donate-qr.jpg");
        donateQrDataUrlCache = `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
        donateQrDataUrlCache = null;
    }
    return donateQrDataUrlCache;
}
import { SessionLines, conversationSlug } from "./sessions.js";
import { readJournal, DEFAULT_JOURNAL_LIMIT } from "./message/journal.js";
import { readJournalRange, renderChatMarkdown } from "./message/chat-export.js";
import { computeStats, buildHealth } from "./message/stats.js";
import { readPromptComposition } from "./message/prompt-composition.js";
import { readBudget } from "./budget.js";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const LOGIN_TTL_MS = 5 * 60 * 1000;
const MAX_QR_REFRESH_COUNT = 3;
const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 480_000;

const logins = new Map(); // sessionKey -> active login record

function isFresh(login) {
    return Date.now() - login.startedAt < LOGIN_TTL_MS;
}

function getLocalTokenList() {
    const out = [];
    const ids = listIndexedWeixinAccountIds();
    for (const id of ids.reverse()) {
        try {
            const acct = loadWeixinAccount(id);
            if (acct?.token) out.push(acct.token);
        } catch {
            // unreadable account files are not fatal for listing tokens
        }
        if (out.length >= 10) break;
    }
    return out;
}

async function fetchQrCode(botType) {
    const raw = await apiPostFetch({
        baseUrl: FIXED_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: JSON.stringify({ local_token_list: getLocalTokenList() }),
        label: "fetchQRCode",
    });
    const data = JSON.parse(raw);
    if (!data?.qrcode || !data?.qrcode_img_content) {
        throw new Error("获取二维码失败：服务器返回不完整");
    }
    return data;
}

async function pollQrStatus(baseUrl, qrcode, verifyCode) {
    try {
        const raw = await apiGetFetch({
            baseUrl,
            endpoint:
                `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}` +
                (verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""),
            timeoutMs: 35_000,
            label: "pollQRStatus",
        });
        return JSON.parse(raw);
    } catch {
        // network hiccup / long-poll timeout: keep waiting like the CLI does
        return { status: "wait" };
    }
}

export class WeixinLoginController extends TypertRemoteService {
    static inject = ["typert"];

    constructor(ctx, options = {}) {
        super(ctx, "weixinLoginController", { namespace: "weixin" });
        this.botType = options.botType ?? DEFAULT_BOT_TYPE;
        /**
         * Called after a login writes a new credential, so the host can start
         * (or restart) the inbound loop without waiting for a reload. Assigned
         * by the plugin's listen effect; undefined in the CLI and in tests.
         *
         * A PLAIN property, deliberately not a `#private` field: the gateway
         * calls a Remote method on the traced Proxy it reads back from the
         * Cordis context, and a Proxy does not forward private-field identity.
         * @type {(() => void) | undefined}
         */
        this.onAccountBound = undefined;
        /**
         * Set by the plugin's setup once the reminder scheduler exists; the
         * journal/reminders card methods read through it. Undefined in the
         * CLI and in tests — the methods below must answer honestly when it
         * is missing instead of pretending the feature is broken.
         */
        this.remindersProvider = undefined;
        /** SubscriptionScheduler, injected at setup; packs import schedules through it. */
        this.subscriptionScheduler = undefined;
        /** Optional hook the plugin sets so the card can say where a pack went. */
        this.packWriter = undefined;
        /** Set by the plugin's setup: the live outbox. */
        this.outboxFlush = undefined;
        this.outboxDropItem = undefined;
    }

    /** Start (or resume) a QR login; returns {qrcodeUrl, qrDataUrl, sessionKey, status}. */
    async startLogin() {
        const existing = [...logins.values()].find((l) => isFresh(l) && l.qrcodeUrl);
        if (existing) {
            return {
                qrcodeUrl: existing.qrcodeUrl,
                qrDataUrl: existing.qrDataUrl,
                sessionKey: existing.sessionKey,
                status: "wait",
            };
        }
        const data = await fetchQrCode(this.botType);
        const sessionKey = randomUUID();
        const link = data.qrcode_img_content;
        // Best-effort QR image; the clickable link is always a usable fallback.
        const qrDataUrlValue = await qrDataUrl(link).catch(() => undefined);
        logins.set(sessionKey, {
            sessionKey,
            qrcode: data.qrcode,
            qrcodeUrl: link,
            qrDataUrl: qrDataUrlValue,
            startedAt: Date.now(),
            refreshCount: 0,
            pendingVerifyCode: null,
            baseUrl: FIXED_BASE_URL,
        });
        logger.info(
            `weixin login: QR issued session=${redactToken(sessionKey)} qrcode=${redactToken(data.qrcode)} linkLen=${link.length}`,
        );
        return { qrcodeUrl: link, qrDataUrl: qrDataUrlValue, sessionKey, status: "wait" };
    }

    /**
     * One poll step. The server long-polls (about 30s) before it answers, so the
     * card calls this again only once the previous call has returned; it must not
     * be driven from a fixed interval, or the requests stack up.
     */
    async poll(sessionKey) {
        const login = logins.get(sessionKey);
        if (!login) throw new RemoteError("no_login", "没有进行中的登录，请重新扫码", {});
        const status = await pollQrStatus(login.baseUrl, login.qrcode, login.pendingVerifyCode);
        // The login flow used to leave no trace at all, which made a scan that
        // went nowhere impossible to diagnose after the fact.
        logger.debug(
            `weixin login: polled status=${status?.status ?? "(none)"} session=${redactToken(sessionKey)} scanned=${Boolean(status?.ilink_user_id)}`,
        );
        switch (status.status) {
            case "wait":
                return { status: "wait" };
            case "scaned":
                if (login.pendingVerifyCode) login.pendingVerifyCode = null;
                return { status: "scaned" };
            case "need_verifycode":
                return {
                    status: "need_verifycode",
                    message:
                        login.pendingVerifyCode != null
                            ? "验证码不匹配，请输入手机上显示的最新数字"
                            : "请输入手机微信上显示的验证码数字",
                };
            case "expired":
            case "verify_code_blocked": {
                if (status.status === "verify_code_blocked") login.pendingVerifyCode = null;
                login.refreshCount += 1;
                if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
                    logins.delete(sessionKey);
                    return { status: "failed", message: "二维码多次失效，请重新开始登录" };
                }
                const fresh = await fetchQrCode(this.botType);
                login.qrcode = fresh.qrcode;
                login.qrcodeUrl = fresh.qrcode_img_content;
                login.qrDataUrl = await qrDataUrl(fresh.qrcode_img_content).catch(() => undefined);
                login.startedAt = Date.now();
                return { status: "refreshed", qrcodeUrl: login.qrcodeUrl, qrDataUrl: login.qrDataUrl };
            }
            case "binded_redirect": {
                // The server still has this bot bound to this install, so it
                // refuses to hand out a new credential. The vendored CLI reads
                // that as an idempotent success ("已连接过此 OpenClaw"), which is
                // only true when this host still holds the token; after a log out
                // the token is gone and the bot cannot be unbound from here, so
                // the honest answer is a distinct outcome the card can explain.
                logins.delete(sessionKey);
                logger.info(
                    `weixin login: server refused a new credential (binded_redirect) session=${redactToken(sessionKey)} localAccounts=${listIndexedWeixinAccountIds().length}`,
                );
                return {
                    status: "alreadyBound",
                    message:
                        "服务器仍认为该机器人绑定在本机，但本地凭证已被退出登录删除。请先在手机微信里解除该机器人的绑定，然后重新扫码。",
                };
            }
            case "scaned_but_redirect":
                if (status.redirect_host) login.baseUrl = `https://${status.redirect_host}`;
                return { status: "scaned" };
            case "confirmed": {
                logins.delete(sessionKey);
                if (!status.ilink_bot_id) {
                    return { status: "failed", message: "服务器未返回账号 ID，登录未完成" };
                }
                saveWeixinAccount(status.ilink_bot_id, {
                    token: status.bot_token,
                    baseUrl: status.baseurl,
                    userId: status.ilink_user_id,
                });
                registerWeixinAccountId(status.ilink_bot_id);
                logger.info(
                    `weixin login: confirmed account=${status.ilink_bot_id} user=${redactToken(status.ilink_user_id)} token=${redactToken(status.bot_token)}`,
                );
                // A completed login writes a usable credential, so any expiry
                // recorded from an earlier session no longer applies.
                this.clearSessionExpired();
                // The loop that is running belongs to the credential that was
                // on disk when it started — which is the one this login just
                // replaced, or nothing at all on a fresh install. Tell the host
                // to bring it up for the credential that now exists: without
                // this the operator binds successfully and WeChat still says it
                // cannot reach openclaw until the next reload.
                try {
                    // The bound account travels with the callback: the host keeps
                    // one transport per account, and only the one whose credential
                    // just changed may be re-armed. Calling it bare would force
                    // the host to guess which account to bring up.
                    this.onAccountBound?.(status.ilink_bot_id);
                } catch (error) {
                    logger.warn(`weixin login: onAccountBound failed: ${String(error)}`);
                }
                return {
                    status: "confirmed",
                    accountId: status.ilink_bot_id,
                    userId: status.ilink_user_id,
                };
            }
            default:
                return { status: "wait" };
        }
    }

    /** Submit the verify code shown on the phone for the next poll to use. */
    async submitVerifyCode(sessionKey, code) {
        const login = logins.get(sessionKey);
        if (!login) throw new RemoteError("no_login", "没有进行中的登录，请重新扫码", {});
        login.pendingVerifyCode = String(code ?? "").trim();
        return { accepted: true };
    }

    /** Drop an in-flight login (user closed the page / pressed cancel). */
    async cancel(sessionKey) {
        logins.delete(sessionKey);
        return { cancelled: true };
    }

    /**
     * Forget a bound account: delete its saved credentials and drop it from the
     * index, so the card returns to "not logged in".
     *
     * Only the credential is removed. Session history and the operator's own
     * settings (allowlist, model directory) live elsewhere and are deliberately
     * kept — logging out is "stop using this account", not "erase the setup".
     *
     * There is no server-side revocation to call: the token is a session, and
     * dropping it locally is what makes the plugin stop using it. A bot the
     * server no longer serves cannot be unbound from here either — this only
     * stops *this* host from trying.
     *
     * The poll loop keeps the credentials it started with until it restarts, so
     * a logout takes full effect on the next reload; the card says so.
     */
    async logout(accountId) {
        const wanted = String(accountId ?? "").trim();
        const ids = wanted ? [wanted] : listIndexedWeixinAccountIds();
        if (ids.length === 0) {
            return { removed: [], reloadRequired: false };
        }
        const removed = [];
        for (const id of ids) {
            // Only touch accounts we actually hold: a caller must not be able to
            // name an arbitrary path, and a typo should not report success.
            const acct = loadWeixinAccount(id);
            if (!acct?.token) continue;
            clearWeixinAccount(id);
            unregisterWeixinAccountId(id);
            removed.push(id);
        }
        // Any in-flight QR session belongs to the account that just went away.
        logins.clear();
        this.sessionExpired = false;
        return { removed, reloadRequired: removed.length > 0 };
    }

    /** Account status for the settings card: which account is bound, state dir. */
    async status() {
        const ids = listIndexedWeixinAccountIds();
        const accounts = [];
        for (const id of ids) {
            try {
                const acct = loadWeixinAccount(id);
                if (acct?.token) {
                    // Registry side-table data: label/paused/lastSeenAt live
                    // outside the credential on purpose (see account-registry.js).
                    // A missing entry means "never touched" — defaults, not an error.
                    const entry = readRegistry()[id] ?? {};
                    // The EFFECTIVE allowlist for this account (account override
                    // over the global config), so the card shows what actually
                    // rules this account rather than one layer of it.
                    const effective = allowlistForAccount(id, readSavedConfig());
                    accounts.push({
                        accountId: id,
                        userId: acct.userId ?? null,
                        label: typeof entry.label === "string" ? entry.label : null,
                        paused: isAccountPaused(id),
                        lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null,
                        allowedSenders: effective.allowedSenders,
                        allowedChats: effective.allowedChats,
                    });
                }
            } catch {
                // skip unreadable entries
            }
        }
        // An expired session is the one failure a saved token cannot reveal: the
        // file is present and complete, but the server refuses it, so inbound
        // messaging stops while the card still shows "bound". The transport
        // records the refusal here so the card can say "log in again".
        return {
            accounts,
            stateDir: stateDir(),
            pendingLogin: logins.size > 0,
            sessionExpired: this.sessionExpired === true,
        };
    }

    /**
     * Pause one account's inbound loop without logging it out.
     *
     * Pausing is "stop listening on purpose": the credential stays, so resuming
     * needs no re-scan. The host's next bring-up pass (this call re-arms the
     * host immediately via `onAccountControlChange`) skips paused accounts.
     */
    /** Pending reminders for the settings card, soonest first. */
    async reminders() {
        if (this.remindersProvider === undefined) return { entries: [], available: false };
        const entries = this.remindersProvider.list().map((r) => ({
            id: r.id,
            accountId: r.accountId,
            conversationId: r.conversationId,
            fireAt: r.fireAt,
            text: r.text,
        }));
        return { entries, available: true };
    }

    /** Cancel one pending reminder from the settings card. */
    /** The donate QR as a data URL for the About tab; null when the asset is missing. */
    donateQr() {
        return { qrDataUrl: donateQrDataUrl() };
    }

    async remindCancel(id) {
        if (this.remindersProvider === undefined) return { removed: false, error: "\u8c03\u5ea6\u5668\u4e0d\u53ef\u7528" };
        const removed = this.remindersProvider.cancel(String(id));
        return removed ? { removed: true } : { removed: false, error: "\u6ca1\u6709\u8fd9\u4e2a\u7f16\u53f7" };
    }

    // ── Persona + memory: the 个性化 tab's backend ─────────────────────────
    // All methods read/write the same on-disk stores the WeChat-side /mode
    // and /remember commands use, so card edits and chat edits always agree.

    /** Everything the 个性化 tab renders for one account. */
    async personaOverview(options) {
        const opts = options ?? {};
        const account = typeof opts.accountId === "string" && opts.accountId.trim() !== "" ? opts.accountId.trim() : "";
        const root = stateDir();
        const warn = (m) => logger.warn(m);
        const modes = readPersonaStore(root, { warn });
        const globalDefault = readGlobalDefaultMode(root, { warn });
        return {
            modes: modes.map((m) => ({ id: m.id, name: m.name, prompt: m.prompt, builtin: m.builtin === true })),
            globalDefault,
            accountDefault: account === "" ? "" : readAccountDefaultMode(root, account, { warn }),
            overrides: listActiveOverrides(root, { warn }),
            memory: account === "" ? null : (() => {
                const store = readGlobalMemory(root, account, { warn });
                return {
                profile: store.profile,
                digest: store.digest,
                digestAt: store.digestAt,
                events: store.events.map((event, i) => ({ index: i + 1, ...event })),
                facts: store.facts.map((f, i) => ({ index: i + 1, text: f.text, at: f.at, weight: f.weight })),
                conversations: listConvMemories(root, account, { warn }).map((conv) => {
                    // Which persona this line is in, and how she is doing right
                    // now: the card shows both per conversation, so "why is she
                    // so short today" has an answer you can read.
                    const mode = resolveMode(modes, activeModeFor(root, account, conv.conversationId, globalDefault === "" ? DEFAULT_MODE_ID : globalDefault, { warn }));
                    const life = readOrInferLifeState(root, account, { bond: conv.bond, persist: false, warn });
                    return {
                        ...conv,
                        bondLine: bondLine(conv.bond),
                        modeId: mode.id,
                        modeName: mode.name,
                        life: { mood: life.mood, activity: life.activity, energy: life.energy },
                        lifeLine: lifeSummary(life),
                    };
                }),
                }
            })(),
        };
    }

    /**
     * Create or update a custom mode. Builtins are configuration the code
     * ships with — the card may not edit them (and cannot delete them), so a
     * persona can always be switched back to something known-good.
     */
    /**
     * A persona pack: the custom modes this install has, in a shape another
     * install can import. F34 exists because a good custom mode took effort to
     * write and the only way out of the app was a screenshot.
     */
    async personaExport() {
        const root = stateDir();
        const modes = readPersonaStore(root, { warn: (m) => logger.warn(m) });
        const customs = modes.filter((mode) => mode.builtin !== true).map((mode) => ({ name: mode.name, prompt: mode.prompt }));
        return { pack: { format: "dsh-weixin-persona-pack", version: 1, modes: customs }, count: customs.length };
    }

    /**
     * Import a pack. Modes are added, never merged or overwritten: an import that
     * silently replaced an existing mode would be the worst kind of edit. The cap
     * is the same one the card enforces, and every refused entry is reported.
     */
    async personaImport(options) {
        const opts = options ?? {};
        const root = stateDir();
        const warn = (m) => logger.warn(m);
        let parsed = opts.pack;
        if (typeof parsed === "string") {
            try {
                parsed = JSON.parse(parsed);
            } catch (error) {
                throw new RemoteError("that is not JSON");
            }
        }
        if (parsed === null || typeof parsed !== "object" || parsed.format !== "dsh-weixin-persona-pack") {
            throw new RemoteError("not a persona pack");
        }
        const incoming = Array.isArray(parsed.modes) ? parsed.modes : [];
        if (incoming.length === 0) throw new RemoteError("the pack has no modes");
        const modes = readPersonaStore(root, { warn });
        let added = 0;
        const skipped = [];
        for (const entry of incoming) {
            const name = typeof entry?.name === "string" ? entry.name.trim() : "";
            const prompt = typeof entry?.prompt === "string" ? entry.prompt : "";
            if (name === "" || prompt.trim() === "") {
                skipped.push({ name, reason: "empty-name-or-prompt" });
                continue;
            }
            const customs = modes.filter((mode) => mode.builtin !== true).length;
            if (customs >= MAX_CUSTOM_MODES) {
                skipped.push({ name, reason: "cap" });
                continue;
            }
            if (modes.some((mode) => mode.name === name)) {
                skipped.push({ name, reason: "duplicate-name" });
                continue;
            }
            const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mode"}-${Date.now().toString(36)}-${added}`;
            modes.push({ id, name, prompt, builtin: false });
            added += 1;
        }
        if (added > 0) writePersonaStore(root, modes, { warn });
        return { added, skipped };
    }

    async personaModeSave(options) {
        const opts = options ?? {};
        const root = stateDir();
        const warn = (m) => logger.warn(m);
        const modes = readPersonaStore(root, { warn });
        const name = typeof opts.name === "string" ? opts.name.trim() : "";
        const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
        if (name === "") throw new RemoteError("mode name is required");
        const id = typeof opts.id === "string" ? opts.id.trim() : "";
        if (id === "") {
            const customs = modes.filter((m) => m.builtin !== true).length;
            if (customs >= MAX_CUSTOM_MODES) throw new RemoteError(`\u81ea\u5b9a\u4e49\u6a21\u5f0f\u6700\u591a ${MAX_CUSTOM_MODES} \u4e2a`);
            // Fresh ids: derived from nothing the user controls is safest, but
            // the card shows the id nowhere — a slug of the name is fine and
            // stays stable across edits.
            const freshId = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mode"}-${Date.now().toString(36)}`;
            if (modes.some((m) => m.id === freshId)) throw new RemoteError("mode id collision, retry");
            modes.push({ id: freshId, name, prompt, builtin: false });
        } else {
            const existing = modes.find((m) => m.id === id);
            if (existing === undefined) throw new RemoteError("\u6ca1\u6709\u8fd9\u4e2a\u6a21\u5f0f");
            if (existing.builtin === true) throw new RemoteError("\u5185\u7f6e\u6a21\u5f0f\u4e0d\u80fd\u4fee\u6539");
            existing.name = name;
            existing.prompt = prompt;
        }
        writePersonaStore(root, modes, { warn });
        return { ok: true };
    }

    /** Remove a CUSTOM mode; builtin refuses. Overrides pointing at it fall back to the default at read time (resolveMode). */
    async personaModeRemove(modeId) {
        const id = String(modeId ?? "").trim();
        const root = stateDir();
        const warn = (m) => logger.warn(m);
        const modes = readPersonaStore(root, { warn });
        const existing = modes.find((m) => m.id === id);
        if (existing === undefined) throw new RemoteError("\u6ca1\u6709\u8fd9\u4e2a\u6a21\u5f0f");
        if (existing.builtin === true) throw new RemoteError("\u5185\u7f6e\u6a21\u5f0f\u4e0d\u80fd\u5220\u9664");
        writePersonaStore(root, modes.filter((m) => m.id !== id), { warn });
        return { ok: true };
    }

    /** The account-wide default mode; '' clears (the schema `personaDefaultMode` rules again). */
    async personaDefaultSet(modeId) {
        const id = String(modeId ?? "").trim();
        const root = stateDir();
        if (id !== "") {
            const modes = readPersonaStore(root, { warn: (m) => logger.warn(m) });
            if (modes.some((m) => m.id === id) === false) throw new RemoteError("\u6ca1\u6709\u8fd9\u4e2a\u6a21\u5f0f");
        }
        writeGlobalDefaultMode(root, id, { warn: (m) => logger.warn(m) });
        return { ok: true, globalDefault: id };
    }

    /**
     * 账号级默认人设: ONE account's default mode. An empty modeId clears it so
     * the account falls back to the file-wide default. Resolution order is
     * conversation override > account default > global default > schema.
     */
    async personaAccountDefaultSet(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        if (accountId === "") throw new RemoteError("accountId is required");
        const id = String(opts.modeId ?? "").trim();
        const root = stateDir();
        if (id !== "") {
            const modes = readPersonaStore(root, { warn: (m) => logger.warn(m) });
            if (modes.some((m) => m.id === id) === false) throw new RemoteError("\u6ca1\u6709\u8fd9\u4e2a\u6a21\u5f0f");
        }
        writeAccountDefaultMode(root, accountId, id, { warn: (m) => logger.warn(m) });
        return { ok: true, accountDefault: id };
    }

    /** Drop one conversation's override so it follows the default again. */
    async personaOverrideClear(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const conversationId = String(opts.conversationId ?? "").trim();
        if (accountId === "" || conversationId === "") throw new RemoteError("accountId and conversationId are required");
        clearActiveMode(stateDir(), accountId, conversationId, { warn: (m) => logger.warn(m) });
        return { ok: true };
    }

    /** Same store /remember writes: numbered like /memory shows them. */
    async memoryFactAdd(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const text = typeof opts.text === "string" ? opts.text : "";
        if (accountId === "") throw new RemoteError("accountId is required");
        const result = addGlobalFact(stateDir(), accountId, text, { warn: (m) => logger.warn(m) });
        if (result.added === true) return { ok: true };
        return { ok: false, reason: result.reason };
    }

    /** Index is 1-based, matching what /memory and this card print. */
    async memoryFactRemove(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const index = Number(opts.index);
        if (accountId === "") throw new RemoteError("accountId is required");
        if (Number.isInteger(index) === false) throw new RemoteError("index is required");
        const removed = removeGlobalFact(stateDir(), accountId, index, { warn: (m) => logger.warn(m) });
        return { removed: removed.removed === true, text: removed.removed === true ? removed.text : undefined };
    }

    /** Wipe one conversation's summary/facts (the journal keeps flowing). */
    async memoryConvClear(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const conversationId = String(opts.conversationId ?? "").trim();
        if (accountId === "" || conversationId === "") throw new RemoteError("accountId and conversationId are required");
        clearConvMemory(stateDir(), accountId, conversationId, { warn: (m) => logger.warn(m) });
        return { ok: true };
    }

    /** Edit the 人物档案 (addressing, schedule, likes, dislikes, dates). */
    async memoryProfileSave(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        if (accountId === "") throw new RemoteError("accountId is required");
        const patch = opts.patch !== null && typeof opts.patch === "object" ? opts.patch : {};
        const saved = saveProfile(stateDir(), accountId, patch, { warn: (m) => logger.warn(m) });
        return { ok: saved.ok === true, profile: saved.profile };
    }

    /** Add one 事件与待办 entry; `when` is a local YYYY-MM-DD or empty. */
    async memoryEventAdd(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        if (accountId === "") throw new RemoteError("accountId is required");
        const result = addEvent(stateDir(), accountId, { text: opts.text, when: opts.when }, { warn: (m) => logger.warn(m) });
        if (result.added === true) return { ok: true };
        return { ok: false, reason: result.reason };
    }

    /** Index is 1-based, matching what /memory and this card print. */
    async memoryEventDone(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const index = Number(opts.index);
        if (accountId === "") throw new RemoteError("accountId is required");
        if (Number.isInteger(index) === false) throw new RemoteError("index is required");
        const done = completeEvent(stateDir(), accountId, index, { warn: (m) => logger.warn(m) });
        return { done: done.done === true, text: done.done === true ? done.text : undefined };
    }

    /** Index is 1-based, matching what /memory and this card print. */
    async memoryEventRemove(options) {
        const opts = options ?? {};
        const accountId = String(opts.accountId ?? "").trim();
        const index = Number(opts.index);
        if (accountId === "") throw new RemoteError("accountId is required");
        if (Number.isInteger(index) === false) throw new RemoteError("index is required");
        const removed = removeEvent(stateDir(), accountId, index, { warn: (m) => logger.warn(m) });
        return { removed: removed.removed === true, text: removed.removed === true ? removed.text : undefined };
    }

    /**
     * The account a pack belongs to: the saved one, else the only bound account.
     * A pack is per-account because subscriptions are; modes are shared and travel
     * regardless.
     */
    activeAccountId() {
        const saved = readSavedConfig();
        if (typeof saved.accountId === "string" && saved.accountId !== "") return saved.accountId;
        const ids = Object.keys(readRegistry());
        return ids.length === 1 ? ids[0] : "";
    }

    /** Message journal for the settings card: newest first, optional account filter. */
    /** Message journal for the settings card: newest first, optional account filter. */
    async journal(options) {
        const opts = options ?? {};
        const limitRaw = Number(opts.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : DEFAULT_JOURNAL_LIMIT;
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        return { entries: readJournal(stateDir(), { limit, accountId }) };
    }

    /**
     * Render the journal (optionally one account, last `days` days) as a
     * Markdown document for the settings card's one-click export. The card
     * downloads the text itself — no file has to travel through the plugin.
     */
    /** ⑦ Who the bot has met in group chats, and what it wrote down about them. */
    async contacts(options) {
        const { listContacts } = await import("./message/contacts.js");
        const accountId = typeof options?.accountId === "string" && options.accountId !== "" ? options.accountId : this.activeAccountId();
        if (accountId === "") return { contacts: [], accountId: "" };
        return { accountId, contacts: listContacts(stateDir(), accountId).map((entry) => ({
            contactId: entry.contactId,
            call: entry.profile?.call ?? "",
            profile: entry.profile,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
        })) };
    }

    /**
     * Write one down. Same shape as the owner's profile, stored per sender, and it
     * only ever affects group chats — a 1:1 chat has no need for a name card.
     */
    async contactSave(options) {
        const { saveContact } = await import("./message/contacts.js");
        const accountId = typeof options?.accountId === "string" && options.accountId !== "" ? options.accountId : this.activeAccountId();
        const contactId = String(options?.contactId ?? "");
        if (accountId === "") throw new RemoteError("no-account", "还没有绑定微信账号", {});
        if (contactId === "") throw new RemoteError("bad_contact", "缺少联系人 id", {});
        let profile = options?.profile;
        if (typeof profile === "string") {
            try {
                profile = JSON.parse(profile);
            } catch {
                throw new RemoteError("bad_contact", "档案不是合法的 JSON", {});
            }
        }
        const result = saveContact(stateDir(), accountId, contactId, { call: options?.call, profile });
        if (result.ok !== true) throw new RemoteError("bad_contact", `没写进去：${result.reason}`, {});
        return { ok: true, contact: result.contact };
    }

    /**
     * Export a shareable template: persona modes, behaviour knobs, subscriptions.
     *
     * Memory, credentials, allowlists and the journal are deliberately absent — a
     * pack is a starting point somebody can hand to a friend, not a copy of a life.
     */
    async packExport(options) {
        const { exportPack } = await import("./packs.js");
        const accountId = this.activeAccountId();
        const saved = readSavedConfig();
        const pack = exportPack(stateDir(), accountId, {
            config: saved,
            name: typeof options?.name === "string" ? options.name : "",
        });
        return { pack, json: JSON.stringify(pack, null, 2), accountId };
    }

    /**
     * Import one. Additive by construction: modes are added, subscriptions are
     * scheduled on the importing account, and nothing already present is replaced.
     */
    async packImport(options) {
        const { importPack } = await import("./packs.js");
        const accountId = this.activeAccountId();
        if (accountId === "") throw new RemoteError("no-account", "还没有绑定微信账号", {});
        const scheduler = this.subscriptionScheduler;
        const result = importPack(stateDir(), accountId, options?.json ?? options?.pack, {
            scheduleSubscription: (plan) => {
                if (scheduler === undefined) return { ok: false, reason: "not-wired" };
                const scheduled = scheduler.schedule({ ...plan, accountId, conversationId: plan.conversationId ?? accountId });
                return scheduled?.error === undefined ? { ok: true } : { ok: false, reason: scheduled.error };
            },
        });
        if (result.ok !== true) throw new RemoteError("bad_pack", `这份模板读不了：${result.error}`, {});
        return result;
    }

    async journalExport(options) {
        const opts = options ?? {};
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        const daysRaw = Number(opts.days);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 365) : 30;
        const entries = readJournalRange(stateDir(), { accountId, days });
        const markdown = renderChatMarkdown(entries, { title: accountId ? `聊天记录 · ${accountId}` : "聊天记录" });
        return { count: entries.length, chars: markdown.length, markdown };
    }

    /**
     * 统计页签: in/out counts, a daily series, the 24-hour distribution and the
     * busiest conversations — computed from the journal on every read, so it
     * can never disagree with the journal tab next to it.
     */
    /**
     * How much room the state directory is taking, and how long each class is
     * kept. The card shows it under 「统计」 so an operator can tell a year of
     * history from a week without opening a terminal.
     */
    /**
     * Undelivered text held by the outbox. A reply that could not be sent is
     * kept on disk rather than lost; the card lists it so the operator can retry
     * or drop it instead of wondering whether the bot answered.
     */
    outbox() {
        const store = readOutbox(stateDir());
        return {
            items: store.items.map((item) => ({
                id: item.id,
                accountId: item.accountId,
                conversationId: item.conversationId,
                text: item.text,
                createdAt: item.createdAt,
                attempts: item.attempts,
                lastError: item.lastError,
            })),
        };
    }

    /** Ask the plugin to retry everything now. */
    async outboxRetry() {
        const flush = this.outboxFlush;
        if (typeof flush !== "function") return { ok: false, reason: "outbox-not-wired" };
        const result = await flush({ force: true });
        return { ok: true, ...result };
    }

    /** Drop one queued item by id. */
    outboxDrop({ id }) {
        const drop = this.outboxDropItem;
        if (typeof drop !== "function") return { ok: false, reason: "outbox-not-wired" };
        return { ok: drop(id) };
    }

    async storage() {
        const live = readSavedConfig();
        return {
            usage: directoryUsage(stateDir()),
            retention: {
                journalDays: Number(live.retentionJournalDays ?? DEFAULT_RETENTION.journalDays),
                auditDays: Number(live.retentionAuditDays ?? DEFAULT_RETENTION.auditDays),
                mediaDays: Number(live.retentionMediaDays ?? DEFAULT_RETENTION.mediaDays),
                exportsDays: Number(live.retentionExportsDays ?? DEFAULT_RETENTION.exportsDays),
                logsDays: Number(live.retentionLogsDays ?? DEFAULT_RETENTION.logsDays),
            },
        };
    }

    /**
     * Process-lifetime counters plus the live queue depth, for the card's stats
     * tab. A restart resets them, which the snapshot says out loud (`startedAt`,
     * `uptimeMs`) so nobody reads a counter as a lifetime total.
     */
    async metrics() {
        const snapshot = typeof this.metricsSnapshot === "function" ? this.metricsSnapshot() : undefined;
        if (snapshot !== undefined) return snapshot;
        return { startedAt: 0, uptimeMs: 0, counters: {}, gauges: {}, pendingOutbox: 0 };
    }

    async stats(options) {
        const opts = options ?? {};
        const daysRaw = Number(opts.days);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 90) : 14;
        const accountId = typeof opts.accountId === "string" && opts.accountId !== "" ? opts.accountId : undefined;
        const result = computeStats(stateDir(), { days, accountId });

        // 提示词构成与健康度：构成来自运行时记录（进程内、最近一个回合），
        // 健康度来自四件我们真的知道的事。两者都可能在重启后为空/降级，
        // 所以卡片必须能画出「还没有记录」而不是编一个数字。
        const live = readSavedConfig();
        const compositionAccount =
            accountId ?? (typeof live.accountId === "string" && live.accountId !== "" ? live.accountId : "");
        const composition = readPromptComposition(compositionAccount);

        const pending = readOutbox(stateDir()).items.length;
        let connected = false;
        try {
            const status = await this.status();
            connected = Array.isArray(status?.accounts) && status.accounts.some((account) => account?.accountId);
        } catch {
            connected = false;
        }
        const budget = readBudget(stateDir());
        const health = buildHealth({
            connected,
            outboxPending: pending,
            budgetUsed: budget.used,
            budgetLimit: Number(live.backgroundDailyLimit ?? 0),
            retention: {
                journalDays: live.retentionJournalDays,
                auditDays: live.retentionAuditDays,
                mediaDays: live.retentionMediaDays,
            },
        });

        return { ...result, composition, health };
    }

    async pause(accountId) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        setAccountPaused(id, true, (m) => logger.warn(m));
        this.onAccountControlChange?.(id);
        return { accountId: id, paused: true };
    }

    /** Undo `pause`: the account is served again from the next pass on. */
    async resume(accountId) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        setAccountPaused(id, false, (m) => logger.warn(m));
        this.onAccountControlChange?.(id);
        return { accountId: id, paused: false };
    }

    /**
     * Rename an account on the card. The raw id is server-assigned and
     * meaningless to an operator; the label is what the card shows instead.
     */
    async label(accountId, text) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        setAccountLabel(id, typeof text === "string" ? text : "", (m) => logger.warn(m));
        return { accountId: id };
    }

    /**
     * Set one account's sender allowlist override.
     *
     * Empty senders clear the override (the global config rules again) — an
     * account-level deny-all would strand the account with no path back, so
     * operators who want silence pause the account instead. Setting values
     * takes effect on the account's NEXT message (the handler resolves the
     * list per bring-up); no reload needed.
     */
    async allowlist(accountId, senders, chats) {
        const id = String(accountId ?? "").trim();
        if (!id) throw new RemoteError("account id is required");
        // The card sends one comma/newline-separated string per list (its
        // codec layer only has string codecs); arrays are accepted too.
        const split = (value) => (Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/));
        setAccountAllowlist(id, split(senders), split(chats), (m) => logger.warn(m));
        // The inbound handler reads the allowlist once per bring-up, so saving
        // alone would leave the running loop ruling with the old list. Re-arm
        // now — with the dedup guard forced — so the change acts on the very
        // next message, like pause/resume does.
        this.onAccountControlChange?.(id);
        return { accountId: id };
    }

    /**
     * Note that the server refused the saved session.
     *
     * Called by the host when the poll loop sees `errcode: -14`. A fresh login
     * clears it, because the account is then writable again.
     */
    markSessionExpired() {
        this.sessionExpired = true;
    }

    /** Clear the flag: a completed login means the session is valid again. */
    clearSessionExpired() {
        this.sessionExpired = false;
    }

    /**
     * Session lines across every Weixin conversation, for the settings card.
     *
     * Read fresh from disk on every call rather than from a cached copy: the
     * card is opened rarely, `/new` and `/use` are typed in WeChat between
     * openings, and a stale list would make the card disagree with what the
     * user just did on their phone. A read failure yields an empty list rather
     * than an error, so a corrupt index degrades the card instead of breaking
     * the settings page.
     *
     * @returns {Promise<{conversations: Array<{conversationId: string, active: string, lines: Array<{sessionId: string, title: string|null, createdAt: string|null}>}>}>}
     */
    async sessions() {
        let store = {};
        try {
            store = new SessionLines({ warn: () => {} }).store ?? {};
        } catch {
            // An unreadable index must not take the settings page down.
        }
        // The card must be able to tell accounts apart, so resolve each store
        // key's account prefix back to a label. Keys are either
        // `<accountSlug>:<conversationId>` (scoped) or a bare conversationId
        // (pre-multi-account history). Matching by slug, not by prefix string,
        // keeps the mapping honest even if an account id contains a colon.
        const registry = readRegistry();
        const accountBySlug = new Map(
            Object.keys(registry).map((id) => [
                conversationSlug(id),
                { id, label: typeof registry[id]?.label === "string" ? registry[id].label : null },
            ]),
        );
        const conversations = [];
        for (const [conversationId, entry] of Object.entries(store)) {
            const lines = Array.isArray(entry?.lines) ? entry.lines : [];
            if (lines.length === 0) continue;
            const sep = conversationId.indexOf(":");
            const account = sep > 0 ? accountBySlug.get(conversationId.slice(0, sep)) ?? null : null;
            conversations.push({
                conversationId,
                // Both null for a pre-multi-account bare key; the card shows no
                // account chip for those.
                accountId: account?.id ?? null,
                accountLabel: account?.label ?? null,
                active: typeof entry.active === "string" ? entry.active : lines[0].sessionId,
                lines: lines.map((line) => ({
                    sessionId: String(line.sessionId ?? ""),
                    // The card shows its own placeholder for an unnamed line;
                    // null keeps "no title yet" distinct from an empty title.
                    title: typeof line.title === "string" && line.title !== "" ? line.title : null,
                    createdAt: typeof line.createdAt === "string" ? line.createdAt : null,
                })),
            });
        }
        // Most recently used conversation first, so the one the operator is
        // actually talking in is at the top of the card.
        conversations.sort((a, b) => lastUsedAt(store[b.conversationId]) - lastUsedAt(store[a.conversationId]));
        return { conversations };
    }

    /**
     * Point a conversation at one of its session lines.
     *
     * Mirrors the `/use <n>` command so the operator can switch from the card
     * without typing in WeChat. The write goes through the same store the
     * inbound handler reads, so the next message follows the switch without a
     * reload.
     *
     * @param {string} conversationId
     * @param {number} index 1-based position in the conversation's line list
     * @returns {Promise<{switched: true, sessionId: string} | {switched: false, error: string}>}
     */
    async useSession(conversationId, index) {
        const lines = new SessionLines({ warn: () => {} });
        const sessionId = lines.use(String(conversationId ?? ""), Number(index));
        if (sessionId === undefined) {
            // Not `{ok:false}`: the client's `unwrap()` treats any object with an
            // `ok` key as a carrier envelope and would strip this to `undefined`.
            return { switched: false, error: `no session line at position ${index}` };
        }
        return { switched: true, sessionId };
    }

    /**
     * Remove one session line from a conversation, mirroring the card's
     * delete button. Same store the inbound handler reads, so the removal is
     * live without a reload; removing the last line removes the whole
     * conversation entry (the next message re-creates a line — see
     * SessionLines.remove).
     *
     * @param {string} conversationId
     * @param {number} index 1-based position as shown by /list and the card
     * @returns {Promise<{removed: true} | {removed: false, error: string}>}
     */
    async removeSession(conversationId, index) {
        const lines = new SessionLines({ warn: () => {} });
        const active = lines.remove(String(conversationId ?? ""), Number(index));
        if (active === undefined) {
            // Same envelope rule as useSession: no `ok` key on the failure shape.
            return { removed: false, error: `cannot remove session line at position ${index}` };
        }
        return { removed: true };
    }
}

/** Latest `lastUsedAt` in a line entry, for sorting conversations. */
function lastUsedAt(entry) {
    let newest = 0;
    for (const line of Array.isArray(entry?.lines) ? entry.lines : []) {
        const parsed = Date.parse(line?.lastUsedAt ?? line?.createdAt ?? "");
        if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
    }
    return newest;
}

export function purgeStaleLogins() {
    for (const [key, login] of logins) {
        if (!isFresh(login)) logins.delete(key);
    }
}

remoteMethods(WeixinLoginController, ["startLogin", "poll", "submitVerifyCode", "cancel", "status", "logout", "sessions", "useSession", "removeSession", "pause", "resume", "label", "allowlist", "journal", "journalExport", "stats", "storage", "metrics", "outbox", "outboxRetry", "outboxDrop", "reminders", "remindCancel", "donateQr", "personaOverview", "personaExport", "personaImport", "contacts", "contactSave", "packExport", "packImport", "personaModeSave", "personaModeRemove", "personaDefaultSet", "personaAccountDefaultSet", "personaOverrideClear", "memoryFactAdd", "memoryFactRemove", "memoryConvClear", "memoryProfileSave", "memoryEventAdd", "memoryEventDone", "memoryEventRemove"]);
