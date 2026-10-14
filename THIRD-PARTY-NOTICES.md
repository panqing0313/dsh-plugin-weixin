# Third-party notices

## @tencent-weixin/openclaw-weixin (vendored)

This project vendors a trimmed copy of the WeChat iLink transport from
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin), npm package
`@tencent-weixin/openclaw-weixin@2.4.10`, under `vendor/openclaw-weixin/`.

**License: MIT.** Upstream license text is kept verbatim at
[vendor/openclaw-weixin/LICENSE](vendor/openclaw-weixin/LICENSE):

> Tencent is pleased to support the open source community by making openclaw-weixin available.
> Copyright (C) 2026 Tencent. All rights reserved.
> openclaw-weixin is licensed under the MIT.

### What was vendored

Compiled ESM JavaScript from the published tarball's `dist/src/`, with `.map` files and
`sourceMappingURL` comments removed:

- `api/api.js`, `api/types.js` — the iLink HTTP transport (`getUpdates`, `sendMessage`,
  `getConfig`, `sendTyping`, `getUploadUrl`, `notifyStart`/`notifyStop`) and uint64-safe JSON parsing.
- `auth/accounts.js`, `auth/login-qr.js`, `auth/pairing.js` — local 0600 account store and QR login.
- `storage/state-dir.js`, `storage/sync-buf.js` — state dir resolution and the long-poll sync buffer.
- `util/logger.js`, `util/redact.js` — logging and secret redaction.
- `util/random.js` — `generateId` / `tempFileName` (used for client ids and temp media names).
- `cdn/aes-ecb.js` — AES-128-ECB encrypt/decrypt and PKCS7-padded ciphertext size.
- `cdn/cdn-url.js` — CDN upload/download URL construction and the `full_url` fallback switch.
- `cdn/pic-decrypt.js` — downloads CDN bytes and AES-128-ECB decrypts them (both `aes_key`
  encodings: base64 of 16 raw bytes for images, base64 of a 32-char hex string for
  file/voice/video).
- `cdn/cdn-upload.js` — `uploadBufferToCdn`: POSTs ciphertext to the CDN, retries server errors
  (3 attempts), aborts immediately on 4xx, returns `x-encrypted-param`.
- `cdn/upload.js` — the high-level upload pipeline (`uploadFileToWeixin` for images,
  `uploadVideoToWeixin`, `uploadFileAttachmentToWeixin`) plus `downloadRemoteImageToTemp`.
- `media/mime.js` — filename → MIME and MIME/URL → extension mapping.
- `media/media-download.js` — `downloadMediaFromItem`: per-item-type download + decrypt + save
  for inbound image / voice / file / video.
- `media/silk-transcode.js` — SILK → WAV transcode via the optional `silk-wasm` dependency;
  returns `null` (caller keeps the raw SILK) when `silk-wasm` is not installed. `silk-wasm`
  is NOT vendored and NOT a dependency — see below.
- `messaging/markdown-filter.js` — `StreamingMarkdownFilter`, the character-level state machine
  that turns streamed Markdown into WeChat-readable plain text.
- `messaging/send-media.js` — `sendWeixinMediaFile`, which routes a local file by MIME to
  video / image / file upload + send.
- `messaging/send.js` — `sendMessageWeixin`, `sendMessageItemWeixin` and the media senders
  (`sendImageMessageWeixin`, `sendVideoMessageWeixin`, `sendFileMessageWeixin`). Vendored
  because `messaging/send-media.js` imports it.
- `messaging/partial-quote.js` — `resolvePartialQuote`, needed by `messaging/inbound.js`
  (see "What was changed", item 4).
- `messaging/quote-store.js` — the outbound/inbound quote cache, kept because
  `auth/accounts.js` imports `deleteQuoteCacheForAccount` and `messaging/send.js` imports
  `getQuoteStore`.

Slash commands, the progress/notice senders, the OpenClaw channel plugin wrapper and the
monitor/dispatch layer are NOT vendored. `messaging/inbound.js` is also NOT vendored — the one
helper `messaging/send.js` needs from it is reproduced in the shim (see "What was changed",
item 4).

### What was changed

The only modifications are mechanical de-coupling from the OpenClaw host and one import-site
rewrite, so the vendored code runs under DSH. Every vendored file in `cdn/`, `media/` and
`messaging/` is otherwise byte-identical to the published `dist/src/` build:

1. Three imports from `openclaw/plugin-sdk/*` were rewritten to
   `vendor/openclaw-weixin/openclaw-shim.js`:
   - `normalizeAccountId` (from `account-id`) → trim + lowercase.
   - `mutateConfigFile` (from `config-mutation`) → async no-op. DSH configuration lives in
     `cordis.patch.yml`, not in an OpenClaw config file, so there is nothing to write back.
   - `resolvePreferredOpenClawTmpDir` (from `temp-path`) → `process.env.DSH_WEIXIN_LOG_DIR`
     or `~/.dsh/weixin/logs`, so logs land under DSH's state dir.
2. A minimal `vendor/openclaw-weixin/package.json` was added. It is load-bearing, not
   cosmetic: `api.js` reads `pkg.ilink_appid` for the `iLink-App-Id` header and
   `pkg.version` for `iLink-App-ClientVersion` via `buildClientVersion()`.
3. Credential location is redirected at runtime by `src/state.js` (sets
   `OPENCLAW_STATE_DIR`), so accounts are stored under `~/.dsh/weixin/` instead of
   `~/.openclaw/`.
4. One *package-internal* import was rewritten to the same shim:
   `messaging/send.js` imported `getMediaLabel` from `messaging/inbound.js`, and
   `inbound.js` is not vendored. It is not vendorable in isolation — its transitive
   closure is `util/logger.js`, `util/random.js`, `api/types.js`, `storage/state-dir.js`,
   `messaging/partial-quote.js`, `messaging/quote-store.js`, plus it exports the whole
   inbound `MsgContext` / quote-resolution layer that nothing vendored uses. So
   `messaging/send.js` now imports `getMediaLabel` from
   `vendor/openclaw-weixin/openclaw-shim.js`, which reproduces the function verbatim.
   `messaging/partial-quote.js` is vendored alongside it for when the inbound layer is
   wired up. This is a change of *import site only* for one four-case label function; it
   touches no protocol, crypto or authorization logic.

No protocol, crypto or authorization logic was altered.

### Optional runtime dependency: silk-wasm

`media/silk-transcode.js` transcodes inbound voice messages from SILK to WAV. Upstream
loads `silk-wasm@^3.7.1` (a devDependency there) through a lazily evaluated dynamic
`import("silk-wasm")`, and returns `null` when the import fails. That import is left
byte-for-byte as upstream ships it — no shim, no rewriting:

- The specifier is dynamic, so nothing fails at module load time.
- With `silk-wasm` absent, `silkToWav` logs a warning and returns `null`, and
  `media/media-download.js` saves the raw SILK buffer instead (labelled `audio/silk`).
  Inbound voice therefore still works, just without a WAV container.
- Installing `silk-wasm` into this project enables WAV output with no code change.

`silk-wasm` is a normal npm dependency, not vendored.

## qrcode-terminal

`qrcode-terminal@0.12.0` (MIT) — used only by `bin/login.js` to render the login QR code
in the terminal. It is a normal npm dependency, not vendored.
