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

/** The CLI to shell out to: env override, else the first one that answers. */
function resolveHfCli() {
    const override = process.env.DSH_WEIXIN_HF_CLI;
    if (override) return override;
    for (const candidate of HF_CLI_CANDIDATES) {
        try {
            // `--help` is cheap and, unlike `version`, exits 0 on both CLIs.
            const probe = spawnSync(candidate, ["--help"], { stdio: "ignore", timeout: 10_000 });
            if (probe.status === 0) return candidate;
        } catch {
            // not on PATH; try the next candidate
        }
    }
    return HF_CLI_CANDIDATES[0];
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
        this.downloads.set(repoId, { status: "running", message: "" });

        const cli = resolveHfCli();
        const args = ["download", repoId, "--local-dir", path.join(this.modelDir, repoId)];
        const child = spawn(cli, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
        });
        let lastError = "";
        child.stderr.on("data", (d) => {
            lastError = `${lastError}${String(d)}`.slice(-4000);
        });
        child.on("error", (err) => {
            this.downloads.set(repoId, {
                status: "failed",
                message: `找不到 ${cli}，请 pip install -U huggingface_hub：${err.message}`,
            });
        });
        child.on("exit", (code) => {
            if (code === 0) {
                this.downloads.set(repoId, { status: "done", message: "" });
            } else {
                const detail = summarizeHfFailure(lastError);
                this.downloads.set(repoId, {
                    status: "failed",
                    message: detail
                        ? `${cli} 下载失败：${detail}`
                        : `${cli} 下载失败（exit ${code}），请检查模型名与网络`,
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
