// AsrController — settings-page ASR model management.
//
// Lets the user (a) download a whisper model into a configurable directory
// via the Hugging Face CLI, and
// (b) see which models are already present locally. The model *path* itself
// is configured through the plugin Config schema (asr.model), so the settings
// form already covers selection; this controller handles the download part.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TypertRemoteService, Remote, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { stateDir } from "./state.js";
import { remoteMethods } from "./typert-js.js";

const DEFAULT_MODEL_DIR = path.join(os.homedir(), ".dsh", "weixin", "asr-models");

const ASR_CONFIG_FILE = "asr-config.json";

// Hugging Face renamed its CLI: `huggingface-cli` is deprecated and, on
// huggingface_hub >= 1.0, is a stub that exits 1 with nothing but a "no longer
// works, use hf instead" banner. Prefer `hf` and fall back, because plenty of
// installs still have only the old entry point (and it still works below 1.0).
const HF_CLI_CANDIDATES = ["hf", "huggingface-cli"];

/**
 * Windows resolves a bare name through PATHEXT, and what `pip` installs there
 * is a `.cmd` shim rather than the extensionless script POSIX gets. Node's
 * `spawn` only applies PATHEXT for a bare name; given an explicit `.cmd` path
 * it refuses to execute it without a shell (`EINVAL`), because it will not
 * silently reinterpret a program as a shell command. Probing the bare name
 * first covers the PATH case; the suffixes matter when an operator points
 * DSH_WEIXIN_HF_CLI at an install directory instead of relying on PATH.
 */
const WIN_CLI_SUFFIXES = [".cmd", ".exe", ".bat"];

/** Expand ONE candidate into the concrete names worth probing, in order. */
function cliCandidates(candidate) {
    if (process.platform !== "win32" || path.extname(candidate) !== "") return [candidate];
    return [candidate, ...WIN_CLI_SUFFIXES.map((suffix) => `${candidate}${suffix}`)];
}

/** Run one candidate, reporting whether it is a usable program. */
function cliAnswers(command) {
    try {
        const probe = spawnSync(command, ["--help"], { stdio: "ignore", timeout: 10_000 });
        return probe.status === 0;
    } catch {
        return false;
    }
}

/**
 * The CLI to shell out to, and whether it needs a shell to run.
 *
 * A `.cmd`/`.bat` shim is a shell script, so Node must be told to interpret it —
 * `shell: true` on spawn, `shell` on spawnSync. Without that the download fails
 * with EINVAL on a machine where the CLI is installed and works from a prompt.
 * The reported `command` is what the operator would type, not the resolved
 * `.cmd` path, so a failure message stays recognizable.
 */
function resolveHfCli() {
    const override = process.env.DSH_WEIXIN_HF_CLI;
    if (override) {
        // An explicit choice is authoritative: do not silently substitute a
        // different program, but do flag that it needs a shell.
        return { command: override, shell: needsShell(override) };
    }
    for (const bare of HF_CLI_CANDIDATES) {
        for (const command of cliCandidates(bare)) {
            // `--help` is cheap and, unlike `version`, exits 0 on both CLIs.
            if (cliAnswers(command)) return { command, shell: needsShell(command) };
        }
    }
    return { command: HF_CLI_CANDIDATES[0], shell: false };
}

/** Whether running this program requires letting a shell interpret it. */
function needsShell(command) {
    return /\.(cmd|bat)$/i.test(command);
}

// The old CLI's deprecation banner is pure noise, and so is the progress bar:
// neither is a reason a download failed, and pasting an example list and a wall
// of carriage-return updates into a settings card explains nothing. Keep only
// lines that look like an actual diagnosis.
const HF_NOISE = /^\s*(hint:|warning:|examples?:|\s*hf )/i;

function summarizeHfFailure(stderr) {
    const lines = String(stderr)
        .split(/\r?\n|\r/)
        .map((line) => line.trim())
        .filter(Boolean)
        // Progress bars re-draw on one line and arrive as many fragments.
        .filter((line) => !/^\d+%|[\u2588\u2589\u2591\u2588]|\d+\.\d+[kMG]?B\/s/.test(line))
        .filter((line) => !HF_NOISE.test(line));
    return lines.slice(-3).join(" ").slice(0, 400);
}

// tqdm redraws its bar on one line, so the stream arrives as
//   "\rFetching 4 files:  25%|██▌  | 1/4 [00:01<00:05, 1.84s/it]"
// fragments. The last two numbers are a rate and are NOT a percentage; the
// download percentage is the FIRST `N%` on the line, which is also the only
// value that means anything while several files are still queued.
// tqdm prints "<desc>:  25%|<bar>| 1/4 [elapsed<remaining, rate]". The
// percentage therefore follows a description and a colon; anchoring it to the
// start of the line matched nothing. The trailing rate (`1.84s/it`,
// `95.3MB/s`) is NOT a percentage, so take the first `N%` before the bar.
const TQDM_PERCENT = /(?:^|[\s:])(\d{1,3})%\s*\|/;
// "1/4" — how many files are finished, useful before any percentage appears.
const TQDM_COUNT = /\|\s*(\d+)\/(\d+)\s*\[/;

/** Whether a chunk is only a progress redraw, carrying no diagnostic value. */
export function isProgressOnly(chunk) {
    const lines = String(chunk)
        .split(/\r|\n/)
        .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
        .filter(Boolean);
    if (lines.length === 0) return true;
    return lines.every((line) => TQDM_PERCENT.test(line) || HF_NOISE.test(line));
}

/**
 * Pull one progress reading out of a raw stderr chunk, or null when the chunk
 * holds nothing but banners and retries.
 *
 * @param {string} chunk
 * @returns {{percent: number, files?: {done: number, total: number}}|null}
 */
export function parseHfProgress(chunk) {
    const text = String(chunk);
    // A chunk can carry several redraws; the last one is the current state.
    const segments = text.split(/\r|\n/).filter((line) => line.trim() !== "");
    for (let i = segments.length - 1; i >= 0; i -= 1) {
        const line = segments[i];
        const percent = TQDM_PERCENT.exec(line.replace(/\u001b\[[0-9;]*m/g, ""));
        if (!percent) continue;
        const value = Number(percent[1]);
        if (!Number.isFinite(value) || value < 0 || value > 100) continue;
        const count = TQDM_COUNT.exec(line);
        const reading = { percent: value };
        if (count) {
            const done = Number(count[1]);
            const total = Number(count[2]);
            if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
                reading.files = { done, total };
            }
        }
        return reading;
    }
    return null;
}

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

    constructor(ctx, options = {}) {
        super(ctx, "asrController", { namespace: "weixinAsr" });
        this.modelDir =
            options.modelDir ?? process.env.DSH_WEIXIN_ASR_MODEL_DIR ?? readPersistedModelDir() ?? DEFAULT_MODEL_DIR;
        this.downloads = new Map(); // modelId -> {status, message}
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
     * downloadStatus(). Requires `huggingface-cli`/`hf` or `pip install huggingface_hub`.
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
        this.downloads.set(repoId, { status: "running", message: "", percent: 0, startedAt: Date.now() });

        const cli = resolveHfCli();
        const args = ["download", repoId, "--local-dir", path.join(this.modelDir, repoId)];
        if (cli.shell) args.unshift(cli.command);
        const child = spawn(cli.command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
            // A .cmd/.bat shim is a shell script; Node refuses to run one
            // without a shell, which is EINVAL on an install that works fine
            // from a prompt. POSIX never takes this path.
            ...(cli.shell ? { shell: true } : {}),
        });
        let lastError = "";
        child.stderr.on("data", (d) => {
            const chunk = String(d);
            // Keep the tail for diagnostics, but never let a progress redraw
            // displace a real error: the previous version accumulated raw
            // stderr and a long download could push the cause out of the
            // window entirely.
            if (!isProgressOnly(chunk)) lastError = `${lastError}${chunk}`.slice(-4000);
            const reading = parseHfProgress(chunk);
            if (!reading) return;
            const rec = this.downloads.get(repoId);
            if (!rec || rec.status !== "running") return;
            // Fold the reading forward so a later chunk that carries only a
            // percentage cannot erase a known file count.
            rec.percent = reading.percent;
            if (reading.files) rec.files = reading.files;
        });
        child.on("error", (err) => {
            this.downloads.set(repoId, {
                status: "failed",
                message: `找不到 ${cli.command}，请 pip install -U huggingface_hub：${err.message}`,
            });
        });
        child.on("exit", (code) => {
            if (code === 0) {
                const rec = this.downloads.get(repoId) ?? {};
                this.downloads.set(repoId, {
                    status: "done",
                    message: "",
                    percent: 100,
                    files: rec.files,
                    elapsedMs: Date.now() - (rec.startedAt ?? Date.now()),
                });
            } else {
                const detail = summarizeHfFailure(lastError);
                this.downloads.set(repoId, {
                    status: "failed",
                    message: detail
                        ? `${cli.command} 下载失败：${detail}`
                        : `${cli.command} 下载失败（exit ${code}），请检查模型名与网络`,
                });
            }
        });
        return { started: true, message: `开始下载 ${repoId}` };
    }

    /** Poll download progress from the UI. */
    async downloadStatus(repo) {
        const rec = this.downloads.get(String(repo ?? ""));
        if (!rec) return { status: "idle" };
        return rec;
    }
}

export function defaultModelDir() {
    return DEFAULT_MODEL_DIR;
}

// referenced so bundlers do not treat stateDir as side-effect-only import
void stateDir;

remoteMethods(AsrController, ["listModels", "setModelDir", "downloadModel", "downloadStatus"]);
