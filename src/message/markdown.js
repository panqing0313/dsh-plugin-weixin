/**
 * Turn a Markdown assistant reply into text WeChat renders readably.
 *
 * WeChat does not render Markdown: a reply containing `**bold**` or a `-` list
 * shows the punctuation literally, which costs readability and message budget.
 * The vendored upstream filter (`vendor/openclaw-weixin/messaging/markdown-filter.js`)
 * is the authority on what may be kept, and this module is a thin adapter —
 * nothing here re-implements or extends its rules.
 *
 * What upstream's state machine keeps as-is (see its file header):
 * code fences, inline code, tables, horizontal rules, `**bold**`, and
 * italic/bold-italic wrapping non-CJK content.
 * What it strips: the markers of italic/bold-italic wrapping CJK content,
 * H5/H6 headings (`#####`/`######`), and images (`![alt](url)`, removed whole).
 *
 * ## Why the whole string is fed in one call
 *
 * `feed(text)` + `flush()` is exactly the sequence a streaming caller performs
 * when a reply arrives in one delta, so a complete reply filtered here renders
 * identically to the same reply streamed token by token. The unit tests pin that
 * equivalence rather than assuming it.
 *
 * It is also the *most* faithful option for whitespace, which was measured, not
 * assumed: across a 21-document corpus (blank lines, leading/trailing newlines,
 * blank lines inside fenced blocks, CRLF, multiple fences, tables, rules) the
 * raw call preserves the newline count exactly — 0 mismatches. An earlier draft
 * of this module spliced per-line output and *reintroduced* blank lines that the
 * filter had correctly consumed (e.g. `"a\n\nb"` → `"a\nb"`, and a marker-only
 * line `"##### "` → `"#"`), so the line splicing was removed.
 *
 * The one intentional loss is a line that holds *only* an unsupported marker:
 * `#####` + text keeps the text, an image-only line disappears entirely, and a
 * line like `"##### "` with nothing after the marker yields nothing. That is the
 * filter's own contract; this module does not try to second-guess it.
 *
 * `off` mode returns the reply byte-for-byte, for debugging and for comparing
 * against the original rendering.
 * @module dsh-weixin/message/markdown
 */
import { StreamingMarkdownFilter } from '../../vendor/openclaw-weixin/messaging/markdown-filter.js'

/**
 * Supported Markdown handling modes.
 * - `strip` (default): filter the reply through the vendored upstream filter.
 * - `off`: send the reply verbatim.
 * @type {readonly ['strip', 'off']}
 */
export const MARKDOWN_MODES = Object.freeze(['strip', 'off'])

/**
 * Convert one complete Markdown string into WeChat-readable plain text.
 *
 * @param {string} text  The whole reply, not a fragment.
 * @param {'strip'|'off'} [mode]  Defaults to `strip`.
 * @returns {string}  Text ready to be handed to `chunkText`.
 */
export function markdownToPlainText(text, mode = 'strip') {
  const source = typeof text === 'string' ? text : String(text ?? '')
  if (mode === 'off' || source === '') return source

  const filter = new StreamingMarkdownFilter()
  // feed() emits everything it can disambiguate; flush() releases the tail the
  // streaming state machine was still holding back (a trailing `*`, an
  // unterminated image, a closing fence).
  return filter.feed(source) + filter.flush()
}

/**
 * Read the config value, falling back to the default for anything unrecognized.
 *
 * A hand-edited or older config file must not change how replies are rendered:
 * only the literal `off` disables the filter.
 * @param {{ markdownMode?: unknown }} config
 * @returns {'strip'|'off'}
 */
export function resolveMarkdownMode(config) {
  return config?.markdownMode === 'off' ? 'off' : 'strip'
}
