// AsrController — settings-page ASR model management.
//
// Lets the user (a) download a whisper model into a configurable directory
// via the Hugging Face CLI, and
// (b) see which models are already present locally. The model *path* itself
// is configured through the plugin Config schema (asr.model), so the settings
// form already covers selection; this controller handles the download part.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { connect as tlsConnect } from "node:tls";
import { TypertRemoteService, Remote, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { stateDir } from "./state.js";
import { remoteMethods } from "./typert-js.js";

const DEFAULT_MODEL_DIR = path.join(os.homedir(), ".dsh", "weixin", "asr-models");

/**
 * The endpoint a plain HTTP download uses when the operator names none.
 *
 * The `hf` CLI is not used for downloads any more, and this is why: on
 * huggingface_hub 1.17.0 it requests huggingface.co for repo metadata even when
 * HF_ENDPOINT points elsewhere, and on 2.2.0 it stalls at 3/4 files with the
 * large weight file never starting. The mirror itself is fine -- it serves the
 * same weights at 16 MB/s -- so the CLI, not the network, was the obstacle.
 *
 * 0 means "download directly". "auto" resolves to this. An operator behind a
 * blocked network sets hfEndpoint to https://hf-mirror.com (or leaves "auto"),
 * and one who needs the official site or a corporate mirror sets it explicitly.
 */
const DEFAULT_ENDPOINT = "https://hf-mirror.com";

const ASR_CONFIG_FILE = "asr-config.json";

/**
 * Validate an optional Hugging Face endpoint.
 *
 * The value is handed to a child process as HF_ENDPOINT, so it must be an
 * absolute http(s) URL — anything else would either be ignored by the CLI or
 * misread as a local path, and a silent typo here looks exactly like the slow
 * download the operator was trying to fix.
 */
/** Whether a proxy URL is usable by the CLI's HTTP stack. */
export function normalizeProxy(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return undefined;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new RemoteError("bad_proxy", `代理地址必须是完整 URL，例如 http://127.0.0.1:7897`, {});
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RemoteError("bad_proxy", `代理只支持 http/https，收到 ${url.protocol}`, {});
    }
    return raw;
}

/**
 * Issue one GET, optionally through an HTTP proxy, and resolve with the
 * response stream.
 *
 * Node's `fetch` is deliberately not used: it ignores the proxy environment
 * variables and undici's ProxyAgent is not importable from inside the packaged
 * app. Since the whole point of `hfProxy` is a network where direct access
 * fails, a proxy that silently does not apply is worse than none -- the
 * operator sees a configured field and waits. `http`/`https` are built in and
 * let the CONNECT tunnel be explicit.
 *
 * `redirects` is bounded: a mirror that redirects in a loop must fail rather
 * than spin.
 */
function httpGet(url, { proxy, signal, headers = {}, redirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const secure = target.protocol === "https:";
        const onError = (err) => reject(err);
        if (signal?.aborted) return reject(new Error("aborted"));

        const send = (socket, nodeModule) => {
            const req = nodeModule.request(
                {
                    ...(socket ? { createConnection: () => socket } : {}),
                    host: target.hostname,
                    port: target.port || (secure ? 443 : 80),
                    path: `${target.pathname}${target.search}`,
                    method: "GET",
                    headers: { host: target.host, accept: "*/*", ...headers },
                    signal,
                },
                (res) => {
                    const status = res.statusCode ?? 0;
                    const location = res.headers.location;
                    if (status >= 300 && status < 400 && location) {
                        res.resume();
                        if (redirects <= 0) {
                            reject(new Error(`重定向次数过多：${url}`));
                            return;
                        }
                        const next = new URL(location, url).toString();
                        httpGet(next, { proxy, signal, headers, redirects: redirects - 1 }).then(resolve, reject);
                        return;
                    }
                    resolve({ status, headers: res.headers, body: res });
                },
            );
            req.on("error", onError);
            req.end();
        };

        if (!proxy) {
            send(null, secure ? https : http);
            return;
        }

        // HTTPS through a proxy requires a CONNECT tunnel; a proxy will not
        // forward a TLS stream as a plain absolute-URI request.
        const proxyUrl = new URL(proxy);
        const connect = http.request({
            host: proxyUrl.hostname,
            port: proxyUrl.port || 80,
            method: "CONNECT",
            path: `${target.hostname}:${target.port || (secure ? 443 : 80)}`,
            headers: { host: `${target.hostname}:${target.port || (secure ? 443 : 80)}` },
            signal,
        });
        connect.on("connect", (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`代理拒绝连接（CONNECT ${res.statusCode}）`));
                return;
            }
            if (!secure) {
                send(socket, http);
                return;
            }
            // The tunnel socket must be handed to `http.request`, NOT
            // `https.request`: the latter would wrap an already-TLS socket in a
            // second TLS layer, and the handshake dies with "disconnected
            // before secure TLS connection was established".
            const tls = tlsConnect({ socket, servername: target.hostname }, () => send(tls, http));
            tls.on("error", onError);
        });
        connect.on("error", onError);
        connect.end();
    });
}

/**
 * List the files in a repo snapshot, so each can be fetched individually.
 * The CLI's own manifest handling is what stalls; a plain file list is enough.
 */
export async function listRepoFiles(endpoint, repoId, { proxy, signal } = {}) {
    const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const res = await httpGet(`${base}/api/models/${repoId}`, {
        proxy,
        signal,
        headers: { accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300) {
        res.body.resume();
        throw new RemoteError("repo_unavailable", `无法读取模型信息（HTTP ${res.status}）`, {});
    }
    const chunks = [];
    for await (const chunk of res.body) chunks.push(chunk);
    let body;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new RemoteError("repo_unavailable", "模型信息不是合法 JSON", {});
    }
    const files = (body?.siblings ?? []).map((s) => s?.rfilename).filter((n) => typeof n === "string" && n);
    if (files.length === 0) throw new RemoteError("repo_empty", "该模型没有任何文件", {});
    return files;
}

/**
 * Download one file, reporting byte progress as it arrives.
 *
 * Streams rather than buffering: the weights are the whole point and they are
 * tens of megabytes.
 */
export async function downloadFile(endpoint, repoId, file, dest, onProgress, { proxy, signal } = {}) {
    const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const parts = String(file).split("/").map(encodeURIComponent).join("/");
    const url = `${base}/${repoId}/resolve/main/${parts}`;
    const res = await httpGet(url, { proxy, signal });
    if (res.status < 200 || res.status >= 300) {
        res.body.resume();
        throw new RemoteError("file_unavailable", `${file} 下载失败（HTTP ${res.status}）`, {});
    }
    const total = Number(res.headers["content-length"] ?? 0) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const handle = await fs.promises.open(dest, "w");
    let written = 0;
    try {
        for await (const chunk of res.body) {
            await handle.write(chunk);
            written += chunk.length;
            onProgress?.(written, total);
        }
    } finally {
        await handle.close();
    }
    return written;
}

/** Normalise a Hugging Face endpoint the CLI can talk to. */
export function normalizeEndpoint(value) {
    const raw = String(value ?? "").trim().replace(/\/+$/, "");
    if (!raw) return undefined;
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new RemoteError("bad_endpoint", `镜像地址必须是完整 URL，例如 https://hf-mirror.com`, {});
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RemoteError("bad_endpoint", `镜像地址必须是 http/https，收到 ${url.protocol}`, {});
    }
    return raw;
}

// The download deliberately does NOT shell out to the Hugging Face CLI.
// Measured on this machine: huggingface_hub 1.17.0 requests huggingface.co
// for repo metadata even when HF_ENDPOINT points at a mirror, and 2.2.0
// stalls with the weight file never starting -- while the mirror serves the
// same bytes at 1.6 MB/s over plain HTTP. The CLI was the obstacle.

/** Best-effort persistence of the runtime-chosen model dir under stateDir(). */
async function persistModelDir(dir) {
    try {
        const file = path.join(stateDir(), ASR_CONFIG_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ modelDir: dir }, null, 2));
    } catch {
        // persistence is a convenience; the in-memory value still applies
    }
}

/** Read a previously persisted model dir, if any. */
function readPersistedModelDir() {
    try {
        const file = path.join(stateDir(), ASR_CONFIG_FILE);
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof raw?.modelDir === "string" && raw.modelDir.trim()) {
            return raw.modelDir.trim();
        }
    } catch {
        // no persisted value
    }
    return undefined;
}

/**
 * Remember the download route, so a choice made in the card survives a restart.
 *
 * This is deliberately the SAME file `setModelDir` writes: it is one small
 * settings document, and two writers to two files would let one clobber the
 * other's keys. Read-modify-write is safe here because the only writer is the
 * settings card, one call at a time.
 */
async function persistDownloadSettings({ endpoint, proxy }) {
    try {
        const file = path.join(stateDir(), ASR_CONFIG_FILE);
        let current = {};
        try {
            current = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
        } catch {
            current = {};
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({ ...current, hfEndpoint: endpoint, hfProxy: proxy ?? "" }, null, 2),
            { mode: 0o600 },
        );
    } catch {
        // persistence is a convenience; the in-memory value still applies
    }
}

/** Read a previously persisted download route, if any. */
function readPersistedDownloadSettings() {
    try {
        const file = path.join(stateDir(), ASR_CONFIG_FILE);
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
            endpoint: typeof raw?.hfEndpoint === "string" && raw.hfEndpoint.trim() ? raw.hfEndpoint.trim() : undefined,
            proxy: typeof raw?.hfProxy === "string" ? raw.hfProxy.trim() : undefined,
        };
    } catch {
        return {};
    }
}

function listModels(dir) {
    const out = [];
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const modelDir = path.join(dir, ent.name);
        // a downloaded HF repo snapshot has config.json + model weights
        const hasConfig = fs.existsSync(path.join(modelDir, "config.json"));
        if (!hasConfig) continue;
        let bytes = 0;
        try {
            for (const f of fs.readdirSync(modelDir)) {
                try {
                    bytes += fs.statSync(path.join(modelDir, f)).size;
                } catch {
                    // ignore files that vanish mid-scan
                }
            }
        } catch {
            // ignore unreadable dirs
        }
        out.push({ name: ent.name, path: modelDir, sizeBytes: bytes });
    }
    return out;
}

export class AsrController extends TypertRemoteService {
    static inject = ["typert"];

    /** In-flight downloads, by repo, so each can be cancelled on its own. */
    #abort;

    constructor(ctx, options = {}) {
        // Validate BEFORE super(), and before anything else can fail. A bad
        // proxy or endpoint throws here; after super() the same throw would be
        // reported by the caller as "ASR service unavailable" with the real
        // reason buried in a string, or masked entirely by a later error. The
        // operator then sees a missing feature, not a typo in their config.
        // The saved route fills in only what the caller left unset: an explicit
        // config value is the live decision, and a stale saved file must not
        // quietly override the operator's YAML.
        const saved = readPersistedDownloadSettings();
        const hfEndpoint = normalizeEndpoint(
            options.hfEndpoint ?? process.env.DSH_WEIXIN_HF_ENDPOINT ?? saved.endpoint,
        );
        const hfProxy = normalizeProxy(options.hfProxy ?? process.env.DSH_WEIXIN_HF_PROXY ?? saved.proxy);
        super(ctx, "asrController", { namespace: "weixinAsr" });
        this.modelDir =
            options.modelDir ?? process.env.DSH_WEIXIN_ASR_MODEL_DIR ?? readPersistedModelDir() ?? DEFAULT_MODEL_DIR;
        // Resolve the default HERE rather than leaving undefined for each call
        // site to interpret. `getDownloadSettings` has to name the endpoint it
        // is reporting, and the card labels the radio group by comparing that
        // value -- an undefined endpoint would be classified "custom" and the
        // card would claim a route the host never chose.
        this.hfEndpoint = hfEndpoint ?? DEFAULT_ENDPOINT;
        this.hfProxy = hfProxy;
        this.downloads = new Map(); // modelId -> {status, message}
        this.#abort = new Map(); // modelId -> AbortController, so a download can stop
    }

    /** Local models already usable (directory with config.json). */
    async listModels() {
        return { modelDir: this.modelDir, models: listModels(this.modelDir) };
    }

    /**
     * Change the model directory at runtime. Persisted so a restart keeps it:
     * the plugin's config file is updated (best-effort) and the value is also
     * remembered for the current session. Returns the resolved directory.
     */
    async setModelDir(dir) {
        const target = String(dir ?? "").trim();
        if (!target || target.includes("\0")) {
            throw new RemoteError("bad_dir", "目录不能为空", {});
        }
        const resolved = path.resolve(target);
        try {
            fs.mkdirSync(resolved, { recursive: true });
        } catch (err) {
            throw new RemoteError("bad_dir", `无法创建目录：${err?.message ?? err}`, {});
        }
        this.modelDir = resolved;
        await persistModelDir(resolved);
        return { modelDir: this.modelDir, models: listModels(this.modelDir) };
    }

    /**
     * Download a model repo (e.g. "mlx-community/whisper-small-mlx") into the
     * model dir. Fire-and-track: returns immediately, progress surfaces via
     * downloadStatus(). Fetches over plain HTTP: no CLI and no Python needed.
     */
    async downloadModel(repo) {
        const repoId = String(repo ?? "").trim();
        if (!repoId || repoId.includes("..") || repoId.startsWith("/")) {
            throw new RemoteError("bad_repo", "模型名形如 mlx-community/whisper-small-mlx", {});
        }
        if (this.downloads.get(repoId)?.status === "running") {
            return { started: false, message: "该模型已在下载中" };
        }
        fs.mkdirSync(this.modelDir, { recursive: true });
        // `startedAt` lets the card show elapsed time without inventing a rate
        // from a percentage it cannot date.
        const target = path.join(this.modelDir, repoId);
        this.downloads.set(repoId, { status: "running", message: "", percent: 0, startedAt: Date.now() });

        // Deliberately NOT the `hf` CLI. On 1.17.0 it requests huggingface.co
        // for metadata even with HF_ENDPOINT set; on 2.2.0 it stalls with the
        // weight file never starting. The mirror serves the same bytes at
        // 16 MB/s, so the CLI was the obstacle, not the network.
        const controller = new AbortController();
        this.#abort.set(repoId, controller);
        void this.#runHttpDownload(repoId, target, controller.signal);
        return { started: true, message: `开始下载 ${repoId}` };
    }

    /** Drive one HTTP download to completion, folding progress into `downloads`. */
    async #runHttpDownload(repoId, target, signal) {
        const startedAt = this.downloads.get(repoId)?.startedAt ?? Date.now();
        try {
            const files = await listRepoFiles(this.hfEndpoint, repoId, { proxy: this.hfProxy, signal });
            // Nothing is "done" until the weights are: a config.json alone is
            // not a usable model, and reporting success on it would leave the
            // operator with a directory the runtime cannot load.
            let index = 0;
            for (const file of files) {
                index += 1;
                this.downloads.set(repoId, {
                    status: "running",
                    message: "",
                    percent: Math.round(((index - 1) / files.length) * 100),
                    files: `${index}/${files.length}`,
                    file,
                    startedAt,
                });
                await downloadFile(
                    this.hfEndpoint,
                    repoId,
                    file,
                    path.join(target, file),
                    (written, total) => {
                        const within = total > 0 ? written / total : 0;
                        const rec = this.downloads.get(repoId);
                        if (!rec || rec.status !== "running") return;
                        this.downloads.set(repoId, {
                            ...rec,
                            percent: Math.min(99, Math.round(((index - 1 + within) / files.length) * 100)),
                            bytes: written,
                            bytesTotal: total,
                        });
                    },
                    { proxy: this.hfProxy, signal },
                );
            }
            this.downloads.set(repoId, {
                status: "done",
                message: "",
                percent: 100,
                files: `${files.length}/${files.length}`,
                elapsedMs: Date.now() - startedAt,
            });
        } catch (error) {
            if (signal.aborted) {
                this.downloads.set(repoId, { status: "idle", message: "已取消" });
                return;
            }
            const detail = error?.message ?? String(error);
            this.downloads.set(repoId, {
                status: "failed",
                message: `${repoId} 下载失败：${detail}。若本机无法直连，请在插件配置里填写 hfProxy，或换一个可用的 hfEndpoint。`,
            });
        } finally {
            this.#abort.delete(repoId);
        }
    }

    /** Poll download progress from the UI. */
    async downloadStatus(repo) {
        const rec = this.downloads.get(String(repo ?? ""));
        if (!rec) return { status: "idle" };
        return rec;
    }

    /**
     * Report where this instance downloads from, so the card can show the
     * current choice rather than an empty box the operator has to guess at.
     *
     * `source` is the UI's own vocabulary ("mirror" | "official" | "custom"),
     * derived rather than stored: the endpoint is the single source of truth,
     * and a second field could disagree with it. `canBrowse` says whether the
     * network needs a proxy at all, which is what lets the card default to
     * "direct" instead of asking a question most operators cannot answer.
     */
    async getDownloadSettings() {
        return {
            endpoint: this.hfEndpoint ?? DEFAULT_ENDPOINT,
            proxy: this.hfProxy ?? "",
            source: sourceForEndpoint(this.hfEndpoint ?? DEFAULT_ENDPOINT),
        };
    }

    /**
     * Change the download endpoint and/or the proxy.
     *
     * Both are validated here rather than in the card: a bad endpoint must fail
     * before it is written, and the same normalisation that guards the
     * constructor guards the runtime change, so a value that loads is a value
     * that can be set.
     *
     * A download already running is NOT restarted. It keeps the route it
     * started with, and the new setting applies to the next one -- silently
     * re-pointing a transfer mid-flight would leave the operator unable to say
     * which route produced which file.
     */
    async setDownloadSettings(endpoint, proxy) {
        // Positional, one argument per declared descriptor parameter: the
        // gateway resolves each parameter by its `wire` field and appends it in
        // order -- `descriptor.parameters.map(...)` then
        // `implementation(...args)`. Taking a single object here would make
        // `endpoint` the whole object and `proxy` silently undefined.
        //
        // "absent" and "empty" are different requests and must not be
        // collapsed: `undefined` means "leave it", while an empty string means
        // "clear it". Treating absent as empty wiped the proxy whenever the
        // source changed, and a wiped proxy on a blocked network is a download
        // that never starts.
        if (endpoint !== undefined && endpoint !== null) {
            this.hfEndpoint = normalizeEndpoint(endpoint) ?? DEFAULT_ENDPOINT;
        }
        if (proxy !== undefined && proxy !== null) {
            this.hfProxy = normalizeProxy(proxy) ?? "";
        }
        await persistDownloadSettings({ endpoint: this.hfEndpoint, proxy: this.hfProxy });
        return this.getDownloadSettings();
    }
}

/** The known endpoints, so the card can label the current one honestly. */
export const MIRROR_ENDPOINT = DEFAULT_ENDPOINT;
export const OFFICIAL_ENDPOINT = "https://huggingface.co";

/**
 * Classify an endpoint for the UI.
 * @param {string} endpoint
 * @returns {"mirror" | "official" | "custom"}
 */
export function sourceForEndpoint(endpoint) {
    const value = String(endpoint ?? "").replace(/\/+$/, "");
    if (value === MIRROR_ENDPOINT) return "mirror";
    if (value === OFFICIAL_ENDPOINT) return "official";
    return "custom";
}

export function defaultModelDir() {
    return DEFAULT_MODEL_DIR;
}

// referenced so bundlers do not treat stateDir as side-effect-only import
void stateDir;

remoteMethods(AsrController, [
    "listModels",
    "setModelDir",
    "downloadModel",
    "downloadStatus",
    "getDownloadSettings",
    "setDownloadSettings",
]);
