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
} from "../vendor/openclaw-weixin/auth/accounts.js";
import { stateDir } from "./state.js";
import { remoteMethods } from "./typert-js.js";

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

    /** Start (or resume) a QR login; returns {qrcodeUrl, sessionKey, status}. */
    async startLogin() {
        const existing = [...logins.values()].find((l) => isFresh(l) && l.qrcodeUrl);
        if (existing) {
            return { qrcodeUrl: existing.qrcodeUrl, sessionKey: existing.sessionKey, status: "wait" };
        }
        const data = await fetchQrCode(this.botType);
        const sessionKey = randomUUID();
        logins.set(sessionKey, {
            sessionKey,
            qrcode: data.qrcode,
            qrcodeUrl: data.qrcode_img_content,
            startedAt: Date.now(),
            refreshCount: 0,
            pendingVerifyCode: null,
            baseUrl: FIXED_BASE_URL,
        });
        return { qrcodeUrl: data.qrcode_img_content, sessionKey, status: "wait" };
    }

    /** One poll step; UI calls this ~every second while the QR page is open. */
    async poll(sessionKey) {
        const login = logins.get(sessionKey);
        if (!login) throw new RemoteError("no_login", "没有进行中的登录，请重新扫码", {});
        const status = await pollQrStatus(login.baseUrl, login.qrcode, login.pendingVerifyCode);
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
                login.startedAt = Date.now();
                return { status: "refreshed", qrcodeUrl: login.qrcodeUrl };
            }
            case "binded_redirect":
                logins.delete(sessionKey);
                return { status: "failed", message: "该账号已连接过，请先在手机上解除绑定" };
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
        return { accounts, stateDir: stateDir(), pendingLogin: logins.size > 0 };
    }
}

export function purgeStaleLogins() {
    for (const [key, login] of logins) {
        if (!isFresh(login)) logins.delete(key);
    }
}

remoteMethods(WeixinLoginController, ["startLogin", "poll", "submitVerifyCode", "cancel", "status"]);
