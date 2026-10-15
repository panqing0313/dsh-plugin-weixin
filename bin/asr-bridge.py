#!/usr/bin/env python3
"""ASR bridge for dsh-plugin-weixin: turn WAV files into text.

The plugin spawns this script once, keeps it alive, and speaks a trivial
line protocol (see `src/media/asr.js`):

  stdin : {"wav": "/abs/path/file.wav"}\n
  stdout: {"ok": true, "text": "..."}\n   or   {"ok": false, "error": "..."}\n

Non-JSON lines on stdout are tolerated by the plugin (treated as diagnostics),
but this script keeps them on stderr anyway to leave stdout pure.

Engine: `mlx-whisper` when it is importable (the usual setup on Apple silicon —
Apple's GPU stack is much faster there), otherwise `faster-whisper`
(CTranslate2), which is one `pip install` away on Linux, macOS and Windows and
runs on CPU. The model is cached under `$DSH_WEIXIN_ASR_MODEL_DIR` (default
`~/.dsh/weixin/asr-models`), so the plugin's own directory stays clean. Progress
goes to stderr — the first transcription warms the model, later ones answer in a
few hundred milliseconds.

Model downloads honour `HF_ENDPOINT` (set it to `https://hf-mirror.com` where
huggingface.co is unreachable); `HF_HUB_DISABLE_XET=1` is set by default because
the Xet/CAS transport fails behind that mirror.

Wire the plugin to it (`~/.dsh/weixin/config.json`):

    {
      "asr": {
        "enabled": true,
        "command": "python3",
        "args": ["bin/asr-bridge.py"],
        "env": { "DSH_WEIXIN_ASR_LANGUAGE": "zh" }
      }
    }

A relative `args` path resolves against the plugin package directory, so this
line works unchanged wherever the plugin was installed.

Environment knobs (all optional):
  DSH_WEIXIN_ASR_MODEL       whisper size (tiny|base|small|medium|large-v3), or a
                             model root directory — the plugin's settings UI writes
                             the directory here, while a hand-written config writes
                             the size. An existing directory wins. (default: small)
  DSH_WEIXIN_ASR_LANGUAGE    ISO code forced as the spoken language (default: auto-detect)
  DSH_WEIXIN_ASR_MODEL_DIR   where models live (default ~/.dsh/weixin/asr-models)
  DSH_WEIXIN_ASR_MODEL_PATH  an explicit model directory or repo id (wins over both above)
  HF_ENDPOINT                set to https://hf-mirror.com where huggingface.co is slow/blocked
"""

from __future__ import annotations

import json
import os
import sys
import traceback


# Pinning the script matters: whisper transcribes Mandarin into traditional
# characters when nothing biases it, which reads as a bug to a mainland user.
# The sentence is deliberately generic so it biases style, not content.
DEFAULT_ZH_PROMPT = "以下是普通话的句子。"


# A failed decode can raise with an entire ffmpeg banner attached (hundreds of
# lines of build configuration, with no newline control over the caller). The
# error travels into a chat message, so it is cut to its first line and capped.
MAX_ERROR_CHARS = 300


def log(message: str) -> None:
    """Diagnostics on stderr only — stdout is protocol."""
    print(message, file=sys.stderr, flush=True)


def short_error(error: object) -> str:
    """One readable line for an error that will be shown to a user."""
    text = str(error).strip()
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if len(first) > MAX_ERROR_CHARS:
        first = first[:MAX_ERROR_CHARS].rstrip() + "…"
    return first or "unknown error"


def model_root() -> str:
    root = os.environ.get("DSH_WEIXIN_ASR_MODEL_DIR")
    if root and root.strip():
        return os.path.expanduser(root.strip())
    return os.path.expanduser("~/.dsh/weixin/asr-models")


def resolve_model(engine: str) -> tuple[str, str | None]:
    """Pick the checkpoint this bridge should run: `(source, language)`.

    `source` is a local directory when one exists (loaded as-is, no network),
    otherwise a model name the engine resolves and downloads itself.

    A local directory is preferred because loading from disk skips the
    `huggingface_hub` metadata probe — exactly the step that fails behind some
    mirrors (a HEAD request to the CDN redirect dies with an SSL EOF while a
    plain GET succeeds). The plugin's settings UI downloads repos into
    `model_root()` through whichever mirror the operator configured, so the
    normal path is: download once in the UI, then load offline from here.

    The candidate list is per-engine because the two formats are not
    interchangeable: faster-whisper reads CTranslate2 weights (`model.bin`),
    mlx reads `weights.npz`. Handing the CTranslate2 directory to mlx fails at
    transcription time with "expected str, bytes or os.PathLike object, not
    NoneType" — so the engine is chosen first and only its own layouts are
    considered.

    Only a directory that exists and carries a `config.json` counts; a bare
    name falls through to the engine's own downloader.
    """
    language = os.environ.get("DSH_WEIXIN_ASR_LANGUAGE", "").strip() or None

    explicit = os.environ.get("DSH_WEIXIN_ASR_MODEL_PATH", "").strip()
    if explicit:
        return os.path.expanduser(explicit), language

    root = model_root()
    # `DSH_WEIXIN_ASR_MODEL` is overloaded on purpose, because both spellings
    # are natural and the plugin's own settings UI emits the second one: it
    # names a *size* ("small") when configured by hand, and the *model root
    # directory* when written by `resolveAsrSettings` (which points it at the
    # directory the operator chose in the UI). A value that is an existing
    # directory is therefore treated as the root, not as a size — otherwise the
    # bridge would look for a checkpoint directly inside the root and fail with
    # "No such file or directory: <root>/config.json".
    configured = os.environ.get("DSH_WEIXIN_ASR_MODEL", "").strip()
    if configured != "" and os.path.isdir(os.path.expanduser(configured)):
        root = os.path.expanduser(configured)
        configured = ""
    name = configured or "small"
    if engine == "mlx":
        # `mlx-community/whisper-small-mlx` is what the plugin's UI downloads;
        # the plain "whisper-small-mlx" spelling covers a manual fetch.
        candidates = (
            os.path.join(root, f"mlx-community__whisper-{name}-mlx"),
            os.path.join(root, f"whisper-{name}-mlx"),
        )
    else:
        candidates = (
            os.path.join(root, name),
            os.path.join(root, f"faster-whisper-{name}"),
            os.path.join(root, f"Systran__faster-whisper-{name}"),
        )
    for candidate in candidates:
        if os.path.isfile(os.path.join(candidate, "config.json")):
            return candidate, language
    # Nothing downloaded yet: let the engine fetch it itself, which only works
    # when the Hub (or HF_ENDPOINT) is reachable.
    return name, language


def load_mlx():
    """Return `(engine, source)` for mlx-whisper, or raise.

    mlx takes the repo id or directory at call time, so nothing is loaded here
    — `import` itself is the capability check.
    """
    # mlx-whisper drives tqdm over the audio frames; its progress bars are
    # carriage-return noise that the plugin would log line by line.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    with quiet_native_stdout():
        import mlx_whisper

    source, language = resolve_model("mlx")
    # The module and the chosen checkpoint travel together: mlx takes both at
    # call time, unlike faster-whisper which binds the weights at construction.
    return ("mlx", (mlx_whisper, source)), source, language


def load_faster():
    """Return `(engine, source)` for faster-whisper, or raise."""
    with quiet_native_stdout():
        from faster_whisper import WhisperModel

    source, language = resolve_model("faster")
    # Xet/CAS is the transport that fails behind hf-mirror; the plain HTTP
    # resolver works, so force it off before the engine reads the variable.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.makedirs(model_root(), exist_ok=True)
    # The guard wraps construction too, not just the import: that is when the
    # native library is actually loaded and the banner is emitted.
    with quiet_native_stdout():
        model = WhisperModel(source, device="cpu", compute_type="int8", download_root=model_root())
    return ("faster", (None, model)), source, language


def quiet_native_stdout():
    """Send C-level stdout to stderr while an engine is imported and built.

    Intel's oneMKL prints a deprecation banner from native code on fd 1 when
    the CTranslate2 library loads — at model construction, not at import. That
    is not Python's `sys.stdout`, so it cannot be intercepted in-process: the
    only reliable fix is to point fd 1 at fd 2 for that window, then restore
    it. Without this the banner lands on the protocol stream, where the plugin
    would log it as an unrecognised line (harmless, but noisy).
    """
    import contextlib

    @contextlib.contextmanager
    def redirect():
        saved = os.dup(1)
        try:
            os.dup2(2, 1)
            yield
        finally:
            os.dup2(saved, 1)
            os.close(saved)

    return redirect()


def load_model():
    # Engines are imported lazily so a broken install produces a per-request
    # JSON error the plugin can show, instead of killing the bridge before it
    # ever speaks. mlx-whisper comes first: on Apple silicon it uses the GPU and
    # is markedly faster, and it is simply absent everywhere else.
    failures = []
    for name, loader in (("mlx-whisper", load_mlx), ("faster-whisper", load_faster)):
        try:
            engine, source, language = loader()
        except Exception as error:  # noqa: BLE001 - the text goes to the operator
            failures.append(f"{name}: {short_error(error)}")
            continue
        log(f"asr-bridge: using {name} with {source!r}")
        return (engine, language), None
    return None, (
        "no usable ASR engine. Install one of them — "
        "`pip install mlx-whisper` on Apple silicon, or `pip install faster-whisper` "
        "anywhere — or point asr.command at your own bridge. Tried: " + "; ".join(failures)
    )


def silence_tqdm() -> None:
    """Disable tqdm's progress bars process-wide.

    Two separate switches are needed: the HF variable covers the Hub's own
    bars, and monkey-patching covers mlx-whisper's frame loop, which builds a
    tqdm object directly. Both write to stderr, where the plugin dutifully logs
    every carriage-return update as a line.
    """
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TQDM_DISABLE", "1")
    try:
        import tqdm

        class _SilentBar:
            """A tqdm stand-in that swallows updates.

            It must support the context-manager protocol and `update()`, since
            mlx-whisper wraps its frame loop in `with tqdm.tqdm(...)`. Returning
            a plain `None` from the patch fails there with "'NoneType' object
            does not support the context manager protocol".
            """

            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self) -> "_SilentBar":
                return self

            def __exit__(self, *exc_info) -> bool:
                return False

            def update(self, *args, **kwargs) -> None:
                pass

            def close(self) -> None:
                pass

        tqdm.tqdm = _SilentBar  # type: ignore[assignment]
    except Exception:  # noqa: BLE001 - cosmetic only, never fatal
        pass


def _is_silence(result: dict) -> bool:
    """True when every segment is marked as containing no speech.

    Whisper reports a `no_speech_prob` per segment. When the whole clip is
    non-speech, the transcript is a hallucination rather than a transcription,
    and an empty answer is strictly better: the plugin turns it into "could not
    make anything out" instead of passing invented words to the agent.
    """
    segments = result.get("segments") or []
    if not segments:
        return False
    return all(float(segment.get("no_speech_prob", 0.0)) >= 0.6 for segment in segments)


def transcribe(engine, language: str | None, wav: str, prompt: str | None) -> tuple[bool, str]:
    """Transcribe one WAV file. Returns `(ok, text_or_error)`.

    The two engines disagree on nearly every argument name, so each gets its
    own call. Both return text that is empty for silence, which is a real
    answer the plugin reports as "could not make anything out" — never guessed
    at.

    `prompt` is passed as the engine's initial prompt. Beyond biasing
    vocabulary, this is how a Mandarin transcript comes back in *simplified*
    characters: whisper otherwise drifts into traditional ones for zh, and the
    sample sentence in `DEFAULT_ZH_PROMPT` pins the script without constraining
    what can be said.
    """
    if not os.path.isfile(wav):
        return False, f"no such file: {wav}"
    kind, engine_payload = engine
    if kind == "mlx":
        # mlx_whisper.transcribe's first positional argument is the AUDIO; the
        # model is selected by `path_or_hf_repo`. Swapping those two produces
        # "expected str, bytes or os.PathLike object, not NoneType", which is
        # how this was found. `language` is not a named parameter — it travels
        # through **decode_options like the other decode settings.
        model, repo = engine_payload
        result = model.transcribe(
            wav,
            path_or_hf_repo=repo,
            language=language,
            initial_prompt=prompt,
            verbose=False,
            # mlx-whisper has no vad_filter, so a clip with no speech in it
            # invites the decoder to invent something — a pure tone produced
            # "字幕by索兰娅" (a subtitle credit) during testing. `no_speech`
            # tokens let it decline instead, which is the honest answer and
            # matches what the faster-whisper path does with `vad_filter`.
            no_speech_threshold=0.6,
            condition_on_previous_text=False,
        )
        if _is_silence(result):
            return True, ""
        return True, str(result.get("text", "")).strip()
    _kind, faster_model = engine_payload
    segments, _info = faster_model.transcribe(wav, language=language, initial_prompt=prompt, vad_filter=True)
    return True, "".join(segment.text for segment in segments).strip()


def main() -> int:
    silence_tqdm()
    log(f"asr-bridge: ready (pid {os.getpid()}, models in {model_root()})")
    engine = None
    language = None
    prompt = os.environ.get("DSH_WEIXIN_ASR_PROMPT", DEFAULT_ZH_PROMPT).strip() or None
    loaded = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"ok": False, "error": f"not JSON: {error}"}), flush=True)
            continue
        wav = request.get("wav")
        if not isinstance(wav, str) or wav == "":
            print(json.dumps({"ok": False, "error": "request needs a non-empty \"wav\" path"}), flush=True)
            continue
        if not loaded:
            log("asr-bridge: loading the model (first request; this can take a while)…")
            loaded_pair, error = load_model()
            if error is not None:
                print(json.dumps({"ok": False, "error": error}), flush=True)
                continue
            engine, language = loaded_pair
            loaded = True
            log("asr-bridge: model loaded")
        try:
            ok, text = transcribe(engine, language, wav, prompt)
        except Exception as error:  # noqa: BLE001 - one bad file must not kill the bridge
            log(traceback.format_exc(limit=3))
            print(json.dumps({"ok": False, "error": f"transcription failed: {short_error(error)}"}), flush=True)
            continue
        # `ok == False` means the text is the *reason* it failed (a missing
        # file, say), not a transcript. Sending it as `text` would hand the
        # agent "no such file: /tmp/x.wav" as if the user had said it.
        if not ok:
            print(json.dumps({"ok": False, "error": text}), flush=True)
            continue
        print(json.dumps({"ok": True, "text": text}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
