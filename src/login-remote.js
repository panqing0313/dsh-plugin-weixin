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
import { remoteMethods } from "./typert-js.js";
import { qrDataUrl } from "./qr-png.js";

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
                    accounts.push({ accountId: id, userId: acct.userId ?? null });
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
}

export function purgeStaleLogins() {
    for (const [key, login] of logins) {
        if (!isFresh(login)) logins.delete(key);
    }
}

remoteMethods(WeixinLoginController, ["startLogin", "poll", "submitVerifyCode", "cancel", "status", "logout"]);
