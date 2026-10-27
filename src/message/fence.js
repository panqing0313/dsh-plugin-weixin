// One rule for prompt blocks, and one place that enforces it.
//
// The plugin prepends several tagged blocks to a user turn: `<weixin_persona>`,
// `<weixin_memory>`, `<weixin_recall>`, `<weixin_life>`, `<weixin_style>`,
// `<weixin_source>`. The model is told those tags are instructions. The user text
// is appended after them — and nothing stopped a message from containing
// `</weixin_memory>` or a fake `<weixin_persona mode="女友">` of its own. That is
// prompt injection with the plugin's own vocabulary, which is the cheapest kind to
// pull off and the hardest to notice.
//
// The fix is not a smarter prompt. It is: user-controlled text never contains our
// tag syntax by the time it reaches the model. We do that by neutralising the
// opening `<` of any `weixin_` tag (and the `<` of anything that tries to close
// one), so the text still reads naturally to a human but can no longer be parsed
// as a block boundary.
const TAG_START = /<\s*\/?\s*weixin_/gi
const ESCAPED = '&lt;'

/**
 * Neutralise tag syntax in untrusted text.
 *
 * Idempotent, and safe on text that has no tags (the common case: one regex test).
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeTags(text) {
  if (typeof text !== 'string' || text === '') return text
  if (TAG_START.test(text) !== true) return text
  TAG_START.lastIndex = 0
  return text.replace(TAG_START, (match) => `${ESCAPED}${match.slice(1)}`)
}

/** The tag names the plugin owns. Exported so tests can assert coverage. */
export const PLUGIN_TAGS = Object.freeze([
  'weixin_persona',
  'weixin_memory',
  'weixin_recall',
  'weixin_life',
  'weixin_style',
  'weixin_source',
  'weixin_dislikes',
])
