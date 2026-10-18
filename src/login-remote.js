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
import { stateDir } from "./state.js";
import { allowlistForAccount, isAccountPaused, readRegistry, setAccountAllowlist, setAccountLabel, setAccountPaused } from "./account-registry.js";
import { readSavedConfig } from "./state.js";
import { remoteMethods } from "./typert-js.js";
import { qrDataUrl } from "./qr-png.js";
import { SessionLines, conversationSlug } from "./sessions.js";

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

remoteMethods(WeixinLoginController, ["startLogin", "poll", "submitVerifyCode", "cancel", "status", "logout", "sessions", "useSession", "removeSession", "pause", "resume", "label", "allowlist"]);
