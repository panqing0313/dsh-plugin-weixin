/**
 * Local type vocabulary for the Weixin/iLink channel.
 *
 * These are structural mirrors, not imports: DSH ships the plugin-facing
 * `@deepseek-ai/*` packages only inside the app bundle, and dsh-weixin must stay
 * loadable without them (its tests run in plain Node). Each type is documented
 * with the module it mirrors so the shapes can be re-checked after an upgrade.
 */

/**
 * A message arriving from Weixin, normalized out of an iLink `WeixinMessage`.
 * @typedef {Object} InboundMessage
 * @property {string} id             Stable message id (iLink `message_id`, kept as a
 *                                   string: the transport quotes uint64 ids before
 *                                   JSON.parse to avoid float precision loss).
 * @property {string} senderId       `from_user_id`.
 * @property {string} conversationId Peer id used to route replies — `from_user_id`
 *                                   for a direct message, `group_id` when present.
 * @property {'text'|'image'|'file'|'voice'|'video'|'unsupported'} type
 * @property {string} [text]         Decoded text for `type: 'text'`.
 * @property {string} contextToken   Echoed on the reply (iLink `context_token`);
 *                                   without it the send is rejected or misrouted.
 * @property {number} [timestamp]    `create_time_ms` when present.
 */

/**
 * A reply bound for Weixin.
 *
 * `text` is the agent's raw Markdown; conversion to WeChat-readable plain text
 * happens on the way out ({@link module:dsh-weixin/message/markdown}), so this
 * shape deliberately stays format-agnostic.
 * @typedef {Object} OutboundMessage
 * @property {string} conversationId Peer id to send to (becomes `msg.to_user_id`).
 * @property {'text'} type
 * @property {string} text
 * @property {string} [contextToken] Echo of the inbound `context_token`.
 * @property {string} [replyTo]      Inbound message id, for local correlation only.
 */

/**
 * A local file to send back to Weixin as an attachment.
 *
 * The media counterpart of {@link OutboundMessage}, and the only shape the
 * transport's `sendMedia` accepts. It carries no MIME type and no upload
 * metadata on purpose: the kind (image / video / file) is derived from the
 * file's own extension at send time, so a caller cannot claim a `.sh` is an
 * image.
 *
 * @typedef {Object} OutboundMedia
 * @property {string} filePath        Absolute path of an existing local file.
 * @property {string} conversationId  Peer id to send to (`msg.to_user_id`).
 * @property {string} [contextToken]  Echo of the inbound `context_token`; iLink
 *                                    routes the reply by it, media included.
 * @property {string} [cdnBaseUrl]    Weixin CDN root; unset uses the upstream default.
 * @property {string} [caption]       Optional text sent as its own item first.
 */

/**
 * Markdown handling for outbound replies.
 * - `strip`: filter unsupported syntax through the vendored upstream filter.
 * - `off`:   send the reply verbatim (debugging / A-B comparison).
 * @typedef {'strip'|'off'} MarkdownMode
 */

/**
 * @typedef {Object} WeixinAccount
 * @property {string} accountId
 * @property {string} baseUrl
 * @property {string} [token]
 * @property {string} [userId]
 * @property {boolean} configured
 */

/**
 * Outcome of one transcription request against the ASR bridge.
 *
 * Never a rejection: every failure mode the bridge can present (missing
 * executable, crash mid-request, timeout, a well-formed `{ok:false}`, a
 * malformed line) is folded into `ok:false` plus a `code`, so the inbound
 * handler can always degrade to "here is the audio file" instead of losing the
 * message. `text` is `''` when the model genuinely recognised nothing — that is
 * a success, and callers must report it as such rather than inventing content.
 *
 * Mirrors the return of {@link module:dsh-weixin/media/asr.transcribeVoice}.
 *
 * @typedef {Object} TranscriptionResult
 * @property {boolean} ok
 * @property {string} [text]    Trimmed transcript; only when `ok` is true.
 * @property {string} [reason]  Human-readable failure, for the agent's note.
 * @property {'not-configured'|'spawn-failed'|'bridge-error'|'timeout'|'exited'|
 *           'closed'|'bad-response'|'unexpected'} [code]
 */

/**
 * A voice note after download, optional SILK→WAV transcoding and optional
 * transcription.
 *
 * The three stages degrade independently on purpose, so the caller can tell
 * "we could not decode it" apart from "we decoded it but could not understand
 * it": `transcoded:false` means the audio is still SILK (no `silk-wasm`), while
 * `transcriptError` means the audio was playable but the bridge failed.
 * `transcript` and `transcriptError` are mutually exclusive, and both are absent
 * when ASR is not configured at all.
 *
 * Mirrors what `downloadInboundVoice` returns from
 * {@link module:dsh-weixin/media/inbound}.
 *
 * @typedef {Object} DownloadedVoice
 * @property {true} ok
 * @property {string} path               Absolute path of the stored file.
 * @property {string} [silkPath]         Original SILK, kept when transcoding ran.
 * @property {boolean} [transcoded]      True only for a real decoded WAV.
 * @property {string} [transcript]       User's words; `''` means "nothing heard".
 * @property {string} [transcriptError]  Why transcription failed, if it did.
 * @property {string} [transcriptCode]   Machine-readable counterpart of the above.
 */

export {}
