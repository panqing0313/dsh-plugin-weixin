/**
 * 实时汇报 (issue #10): let the model say one short sentence mid-turn.
 *
 * Until now the only "halfway messages" on WeChat were the plugin's own fixed
 * progress lines (`（thinking… (21s)）`, `（running: bash (12s)）`). The model
 * has no way to say a human sentence while a long task is running — its text
 * only leaves at the end of the turn. This module holds the two policy pieces
 * that make a model-facing `weixin_say` tool safe to expose:
 *
 *   1. {@link shouldAnnounce} decides whether this turn may still say something
 *      (per-turn count cap + minimum gap + not cancelled) — the throttle the
 *      issue asked for, kept pure so it is testable without a bridge;
 *   2. {@link sanitizeRealtimeText} keeps a spoken line short and on one
 *      subject: strip wrapping quotes/backticks, collapse whitespace, drop any
 *      Markdown markers, and hard-cut to the character cap.
 *
 * The ban-scope reality behind the numbers: measured send bans trip at
 * "about twenty messages in a few minutes", so a turn's realtime lines share
 * the same budget as its reply — the cap is deliberately tiny (3 per turn, one
 * every 20s by default), and a turn that has already ended cannot speak.
 *
 * @module dsh-weixin/message/realtime
 */

/** Default maximum realtime lines a single turn may send. */
export const DEFAULT_REALTIME_MAX_PER_TURN = 3
/** Default floor between two realtime lines, in milliseconds. */
export const DEFAULT_REALTIME_INTERVAL_MS = 20_000
/** Default hard cap on one line's characters. */
export const DEFAULT_REALTIME_MAX_CHARS = 120
/** Default minimum spacing between realtime lines, in milliseconds. */
export const DEFAULT_REALTIME_MIN_INTERVAL_MS = DEFAULT_REALTIME_INTERVAL_MS

/**
 * The one sentence the model-facing tool shows for each non-success verdict.
 * Kept here (not in the tool definition) so the same wording is reused by
 * `/diag` and tests without importing the tool wiring.
 * @type {Readonly<Record<string, string>>}
 */
export const REALTIME_REFUSAL_TEXT = Object.freeze({
  off: 'real-time updates are turned off, so this line was not sent.',
  idle: 'the turn has already finished, so this line was not sent — put it in the final reply instead.',
  cancelled: 'the turn was cancelled, so this line was not sent.',
  limit: 'this turn has already sent its quota of mid-turn lines; put the rest in the final reply.',
  interval: 'a line just went out; wait a moment before speaking again (rate limited).',
  empty: 'the line was empty, so nothing was sent.',
  failed: 'the line could not be delivered.',
})

/**
 * Decide whether one more realtime line may go out this turn.
 *
 * @param {{ sent: number, lastAt: number, now: number, maxPerTurn?: number,
 *   minIntervalMs?: number, cancelled?: boolean }} state
 *   `sent` = lines already sent this turn; `lastAt` = when the last one went
 *   (0 when none yet); `now` = the clock to compare against.
 * @returns {{ allowed: boolean, reason?: 'cancelled' | 'limit' | 'interval' }}
 */
export function shouldAnnounce({ sent, lastAt, now, maxPerTurn, minIntervalMs, cancelled = false }) {
  if (cancelled === true) return { allowed: false, reason: 'cancelled' }
  const max = Number.isFinite(maxPerTurn) && maxPerTurn >= 0 ? maxPerTurn : DEFAULT_REALTIME_MAX_PER_TURN
  if (sent >= max) return { allowed: false, reason: 'limit' }
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : DEFAULT_REALTIME_INTERVAL_MS
  // The first line of a turn is never spaced away: `lastAt` is 0, so `now -
  // lastAt` is always >= the interval in any realistic clock and the check
  // passes. A non-zero history enforces the ≥interval gap.
  if (lastAt > 0 && now - lastAt < interval) return { allowed: false, reason: 'interval' }
  return { allowed: true }
}

/**
 * Turn a model-supplied sentence into the plain line WeChat will show.
 *
 * The text is untrusted model output: it may carry Markdown, wrapping quotes
 * the model added ("「…」", `"…"`, `` `…` ``), collapsed newlines, or be far
 * longer than one bubble should be. Predictable output matters more than
 * fidelity here — a mid-turn note is a courtesy, not the answer.
 *
 * @param {unknown} raw
 * @param {{ maxChars?: number }} [options]
 * @returns {string} the line to send, or '' when nothing usable remains
 */
export function sanitizeRealtimeText(raw, { maxChars = DEFAULT_REALTIME_MAX_CHARS } = {}) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_REALTIME_MAX_CHARS
  const capNoEllipsis = Math.max(1, cap - 1)
  let text = typeof raw === 'string' ? raw : String(raw ?? '')
  // Newlines would break one spoken sentence into several bubbles; a realtime
  // note is one thought, so fold every whitespace run into a single space.
  text = text.replace(/\s+/g, ' ').trim()
  // Peel matching wrapping quotes the model tends to add. Repeated because a
  // model occasionally double-wraps (`「"…"」`).
  for (;;) {
    const stripped = stripOnePair(text)
    if (stripped === text) break
    text = stripped
  }
  // Strip the Markdown markers WeChat renders literally. Realtime notes are
  // short by construction, so a blunt marker scrub beats the streaming filter.
  text = text
    .replace(/`+/g, '')
    .replace(/^\s*#{1,6}\s+/g, '')
    .replace(/^\s*[-*+]\s+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:\*\*|__)(.*)(?:\*\*|__)\s*$/, '$1')
    .trim()
  if (text === '') return ''
  if (text.length <= cap) return text
  // Hard cut, then prefer a cut on the last space so a word is not split when
  // the text is in a spaced language. A cut that leaves too little is undone
  // in favour of the plain cap (a CJK line has no spaces to cut on).
  const head = text.slice(0, capNoEllipsis)
  const space = head.lastIndexOf(' ')
  const cut = space > capNoEllipsis * 0.6 ? head.slice(0, space) : head
  return `${cut.trimEnd()}…`
}

/** Strip one matching pair of wrapping quotes/brackets, or return input. */
function stripOnePair(text) {
  if (text.length < 2) return text
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['「', '」'],
    ['“', '”'],
    ['‘', '’'],
    ['《', '》'],
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['【', '】'],
  ]
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      return text.slice(1, -1).trim()
    }
  }
  return text
}
