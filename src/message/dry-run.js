/**
 * A preview mode: say what you are about to do, then do it when told to.
 *
 * This is not enforcement. The plugin has no hook that runs before a tool call and
 * can veto it (see tool-guard.js for the same limit, measured), so a real approval
 * gate is impossible from inside a plugin. What *is* possible is a prompt-level
 * agreement: in dry-run the model is told to plan out loud and stop, and the
 * conversation continues when the person says "执行". That works because the model
 * follows the instruction — and it fails the day the model ignores it, which is why
 * `toolGuard`'s notices still exist alongside it.
 *
 * Keep the grammar small and predictable: a fixed set of go-ahead words, matched on
 * the whole message, because "执行" inside a longer sentence is usually about
 * something else.
 */
export const DRY_RUN_SCHEMA_VERSION = 1

/** Whole-message replies that lift the gate for one turn. */
export const GO_AHEAD_PHRASES = Object.freeze([
  '执行', '执行吧', '执行。', '执行！', '开始', '开始吧', '动手', '动手吧', '可以', '可以了',
  '好的', '好', '行', 'go', 'ok', 'okay', 'yes', 'run', 'do it',
])

/** True when the message itself is the permission. */
export function isGoAhead(text) {
  const normalized = String(text ?? '').trim().toLowerCase().replace(/[。！!.～~]+$/g, '')
  return GO_AHEAD_PHRASES.includes(normalized)
}

/**
 * The block that makes a turn a rehearsal.
 *
 * Three instructions, in the order the model needs them: what to do instead of
 * acting, how to ask, and what "done" looks like. The escape hatch is explicit so a
 * planning turn cannot become a dead end.
 */
export function buildDryRunBlock({ accountLabel = '' } = {}) {
  return [
    '<weixin_dry_run>',
    '现在处于「预演模式」：这一轮不要真的调用任何工具、不要改文件、不要发命令。',
    '请只做三件事：',
    '1. 用一两句话说明你打算做什么；',
    '2. 列出要执行的具体动作（要跑的命令、要改的文件、要查的东西），逐条，最多五条；',
    '3. 结尾问一句「要我执行吗？」。',
    '对方回复「执行」之后再真正动手；如果对方改了主意，就按新的说法重新计划。',
    '这只是预演，不是审批：说得比做得多没有意义，计划要具体到能照着做。',
    '</weixin_dry_run>',
  ].join('\n')
}

/** One line for the log, so a dry-run turn is visible after the fact. */
export function describeDryRun() {
  return 'dry-run: planning only, tools withheld'
}
