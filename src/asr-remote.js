// AsrController — settings-page ASR model management.
//
// Lets the user (a) download a whisper model into a configurable directory
// via `huggingface-cli download` (or `hf download` on newer CLIs), and
// (b) see which models are already present locally. The model *path* itself
// is configured through the plugin Config schema (asr.model), so the settings
// form already covers selection; this controller handles the download part.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TypertRemoteService, Remote, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { stateDir } from "./state.js";
import { remoteMethods } from "./typert-js.js";

const DEFAULT_MODEL_DIR = path.join(os.homedir(), ".dsh", "weixin", "asr-models");

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
        this.modelDir = options.modelDir ?? process.env.DSH_WEIXIN_ASR_MODEL_DIR ?? DEFAULT_MODEL_DIR;
        this.downloads = new Map(); // modelId -> {status, message}
    }

    /** Local models already usable (directory with config.json). */
    async listModels() {
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

        const cli = process.env.DSH_WEIXIN_HF_CLI ?? "huggingface-cli";
        const args = ["download", repoId, "--local-dir", path.join(this.modelDir, repoId)];
        const child = spawn(cli, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
        });
        let lastError = "";
        child.stderr.on("data", (d) => {
            lastError = String(d).slice(-400);
        });
        child.on("error", (err) => {
            this.downloads.set(repoId, {
                status: "failed",
                message: `找不到 ${cli}，请先 pip install huggingface_hub：${err.message}`,
            });
        });
        child.on("exit", (code) => {
            if (code === 0) {
                this.downloads.set(repoId, { status: "done", message: "" });
            } else {
                this.downloads.set(repoId, { status: "failed", message: lastError || `exit ${code}` });
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

remoteMethods(AsrController, ["listModels", "downloadModel", "downloadStatus"]);
