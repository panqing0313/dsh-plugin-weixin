/**
 * Message catalogue (C33).
 *
 * Chat-facing text used to be Chinese literals scattered through index.js,
 * sessions.js and client.js — fine while there was one language, and an
 * obstacle to every change afterwards: no way to see the whole vocabulary, no
 * way to add a second language, and no way to notice when a notice was written
 * in only one of the two places it appears.
 *
 * This module is the vocabulary. `t(key, params)` resolves against the operator's
 * locale, falls back to Chinese (the historical default) when a translation is
 * missing, and interpolates `{name}` placeholders. Keys are namespaced by the
 * surface that speaks them: `help.*` for command help, `notice.*` for what the
 * bot says on its own, `error.*` for refusals.
 *
 * Scope is deliberately the user-visible strings, not every log line: log text is
 * for the operator reading files and stays English, which is what it already is.
 */

/** Locales we ship. Chinese is the default because the first users were. */
export const LOCALES = Object.freeze(['zh', 'en'])
export const DEFAULT_LOCALE = 'zh'

/**
 * The catalogue itself. Every entry must have both languages — a test enforces
 * it, so a key cannot be added in one language only.
 */
export const CATALOG = Object.freeze({
    // --- command help -------------------------------------------------------
    'help.header': { zh: '会话指令（发 /help 或 /帮助 可再看一遍）：', en: 'Session commands (send /help to see this again):' },
    'help.new': { zh: '/new 开一条新会话（当前这条会保留，之后可以切回来）', en: '/new start a new session (this one is kept, you can switch back)' },
    'help.list': { zh: '/list 查看这个微信会话下的所有会话', en: '/list list every session under this WeChat conversation' },
    'help.use': { zh: '/use <序号> 切换到第几条', en: '/use <n> switch to session number n' },
    'help.clear': { zh: '/clear 清空当前会话并重新开始（当前这条从列表里移除，不再占地方）', en: '/clear clear this session and start over (it is removed from the list)' },
    'help.cancel': { zh: '/cancel 取消正在跑的那个回合（长任务卡住时用；已经排队的消息仍会继续）', en: '/cancel stop the running turn (for stuck long tasks; queued messages still run)' },
    'help.status': { zh: '/status 查看当前账号和会话的状态（白名单、会话线等）', en: '/status show the account and session state (allowlist, session lines, ...)' },
    'help.remind': { zh: '/remind <时间> <内容> 定时提醒：10m / 2h / 14:30 / 2026-10-19 09:00 / 明天 9:00 / 3小时后 / 每天 9:00 / 工作日 8:30 / 每周一 10点', en: '/remind <when> <text> timed reminder: 10m / 2h / 14:30 / 2026-10-19 09:00 / tomorrow 9:00 / in 3 hours / daily 9:00 / weekdays 8:30 / Mondays 10:00' },
    'help.remindlist': { zh: '/remindlist 查看这个账号还没发出的提醒', en: '/remindlist list reminders this account has not sent yet' },
    'help.remindcancel': { zh: '/remindcancel <编号> 取消一条还没发出的提醒（编号来自 /remindlist）', en: '/remindcancel <n> cancel a pending reminder (number from /remindlist)' },
    'help.subscribe': { zh: '/subscribe <时间> <主题> 定时主动消息：每天/每周X HH:mm，或一次性时间；到点我会主动给你发一条', en: '/subscribe <when> <topic> scheduled message from me: daily/weekly HH:mm, or a one-off time' },
    'help.subscribelist': { zh: '/subscribelist 查看这个账号的定时主动消息', en: '/subscribelist list this account’s scheduled messages' },
    'help.subscribecancel': { zh: '/subscribecancel <编号> 取消一条定时主动消息（编号来自 /subscribelist）', en: '/subscribecancel <n> cancel a scheduled message (number from /subscribelist)' },
    'help.mode': { zh: '/mode [名称] 查看或切换对话模式（如 女友/男友/朋友；切换会开一条新会话线）', en: '/mode [name] show or switch the conversation mode (e.g. girlfriend/boyfriend/friend; switching opens a new session line)' },
    'help.remember': { zh: '/remember <内容> 让我长期记住一件事（跨会话、跨重启生效）', en: '/remember <text> remember something for good (across sessions and restarts)' },
    'help.forget': { zh: '/forget [编号或关键词] 忘掉一条长期记忆（编号来自 /memory）', en: '/forget [n or keyword] forget one long-term memory (numbers from /memory)' },
    'help.memory': { zh: '/memory 查看记住的内容和这段会话的记忆', en: '/memory show what is remembered, and this conversation’s memory' },
    'help.recall': { zh: '/recall <关键词> 在本地消息流水里翻原文（如 /recall 报错），不经过模型、不花 token', en: '/recall <keyword> search the local transcript for the original text — no model, no tokens' },
    'help.summary': { zh: '/summary 总结这段会话：聊到哪了、定了什么、还有什么待办', en: '/summary summarise this session: what we discussed, what we decided, what is left' },
    'help.export': { zh: '/export [天数] 导出最近 N 天（默认 30）的聊天记录', en: '/export [days] export the last N days (default 30) of this chat' },
    'help.away': { zh: '/away <时间> [说明] 开启离开模式：这段时间不回消息（不花 token），每个会话自动回一句；回来发 /back 看汇总', en: '/away <when> [note] turn on away mode: no agent replies (no tokens), one auto-answer per chat; /back for the summary' },
    'help.back': { zh: '/back 结束离开模式，并看这段时间谁找过你', en: '/back end away mode and see who asked while you were out' },
    'help.diag': { zh: '/diag 一条不花模型的自检：连接、模式、开关、待发提醒、主动开口额度、今天流水', en: '/diag a model-free self-check: connection, mode, switches, pending reminders, proactive quota, today\'s traffic' },
    'help.outbox': { zh: '/outbox 看待重发的消息，retry 立即重试，drop <id> 丢弃一条', en: '/outbox shows undelivered messages; retry resends now; drop <id> discards one' },
    'help.quiet': { zh: '/quiet 2h 临时静默（不主动开口、不自动回复、提醒顺延），/quiet off 恢复', en: '/quiet 2h pauses proactive lines, auto-replies and timed sends; /quiet off resumes' },
    'help.snooze': { zh: '/snooze 10m 把最近一条提醒往后推；/remind skip 跳过重复提醒的下一次', en: '/snooze 10m pushes the next reminder back; /remind skip skips one occurrence of a repeating reminder' },
    'help.todo': { zh: '/todo [add 内容|done 序号|rm 序号] 共享清单：同一个机器人的群和私聊看到同一份', en: '/todo [add text|done n|rm n] a shared list: every chat of this bot sees the same one' },
    'help.later': { zh: '/later https://… 稍后读：存链接并取回标题，/later 随时看，/later done 2 标记读完', en: '/later https://… read-later: store a link with its title; /later to list, /later done 2 when read' },
    'help.send': { zh: '/send 路径 把本机文件发到当前会话（只允许工作目录、状态目录与 mediaDirs 里的文件）', en: '/send path send a local file here (only files under the workspace, state dir or mediaDirs)' },

    // --- notices the bot sends on its own -----------------------------------
    'notice.unsupported': { zh: '（暂不支持这条消息：{kind}）', en: '(this kind of message is not supported yet: {kind})' },
    'notice.rateLimited': { zh: '（你发得有点快，我先缓一下～{seconds} 秒后再来）', en: '(you are sending a bit fast — give me {seconds} seconds)' },
    'notice.dangerHigh': { zh: '⚠️ 这一步看着有风险', en: '⚠️ this step looks risky' },
    'notice.dangerNormal': { zh: '🔧 要用工具了', en: '🔧 about to use a tool' },
    'notice.dangerBody': { zh: '{tool}{detail}', en: '{tool}{detail}' },
    'notice.dangerFooter': {
        zh: '要停就发 /cancel —— 正在跑的这一步可能已经执行，但后面的步骤不会再继续。',
        en: 'send /cancel to stop — the step in flight may already have run, but nothing after it will.',
    },
})

/**
 * Coerce whatever the config says into a locale we have. Unknown values mean
 * Chinese: every existing deployment was Chinese before this existed.
 *
 * @param {unknown} value
 * @returns {'zh' | 'en'}
 */
export function resolveLocale(value) {
    const raw = String(value ?? '').trim().toLowerCase()
    return raw === 'en' ? 'en' : DEFAULT_LOCALE
}

/**
 * Look one message up, falling back to Chinese and then to the key itself, so a
 * missing translation shows something recognisable instead of `undefined`.
 *
 * @param {string} key
 * @param {'zh' | 'en'} locale
 */
function lookup(key, locale) {
    const entry = CATALOG[key]
    if (entry === undefined) return key
    const wanted = entry[locale]
    if (typeof wanted === 'string' && wanted !== '') return wanted
    return entry[DEFAULT_LOCALE] ?? key
}

/**
 * Fill `{name}` placeholders. An absent parameter is left as `{name}` rather
 * than replaced with 'undefined' — a visible placeholder is a bug report, a
 * silent 'undefined' is a mystery.
 *
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 */
export function interpolate(template, params = {}) {
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
}

/**
 * A translator bound to a locale or a getter (the plugin's config is live, so a
 * getter keeps the card's change effective for the very next message).
 *
 * @param {'zh' | 'en' | (() => unknown)} locale
 */
export function createTranslator(locale) {
    const read = () => resolveLocale(typeof locale === 'function' ? locale() : locale)
    return {
        locale: read,
        t(key, params) {
            return interpolate(lookup(key, read()), params)
        },
    }
}

/** Convenience for module-level strings that are not live-configurable. */
export function translate(key, params, locale = DEFAULT_LOCALE) {
    return interpolate(lookup(key, resolveLocale(locale)), params)
}

/** Every key in the catalogue, sorted — for the coverage test and the report. */
export function catalogKeys() {
    return Object.keys(CATALOG).sort()
}
