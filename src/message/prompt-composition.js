/**
 * 提示词构成：每个回合实际拼进 prompt 的每一段，各占多少字符。
 *
 * 为什么在运行时记、而不是事后按配置重算：构成取决于**这一条消息** ——
 * 有没有引用、有没有链接正文、群成员名片、往事检索命中、预演块 —— 用配置
 * 反推只能给出一个「典型回合」，那不是事实。
 *
 * 所以每次拼完 prompt，就把各段长度记在这里（进程内、按账号、只留最近一条）。
 * 设置卡「统计」页签读它画构成条。字符不是 token；token 由 estimateTokens
 * 粗估，两者在界面上必须分开说。
 *
 * 限制：进程内存储，重启后为空（卡片会显示「还没有记录」而不是编一个）。
 *
 * @module dsh-weixin/message/prompt-composition
 */

/** 最多保留几个账号的最近一条（一般只有一两个账号）。 */
const ACCOUNT_LIMIT = 8

/** accountId → { at, total, sections: Array<{ key, chars }> } */
const records = new Map()

/**
 * @param {string} accountId
 * @param {Array<{ key: string, chars: number }>} sections
 * @param {{ at?: number, total?: number }} [meta]
 */
export function recordPromptComposition(accountId, sections, { at = Date.now(), total } = {}) {
    const clean = []
    for (const section of Array.isArray(sections) ? sections : []) {
        if (section === null || typeof section !== 'object') continue
        const chars = Number(section.chars)
        if (!Number.isFinite(chars) || chars <= 0) continue
        clean.push({ key: String(section.key ?? ''), chars: Math.round(chars) })
    }
    const key = String(accountId ?? '')
    records.delete(key)
    records.set(key, {
        at,
        total: Math.max(0, Math.round(Number(total) || 0)),
        sections: clean,
    })
    while (records.size > ACCOUNT_LIMIT) records.delete(records.keys().next().value)
}

/**
 * @param {string} accountId
 * @returns {{ at: number, total: number, sections: Array<{ key: string, chars: number }> } | null}
 */
export function readPromptComposition(accountId) {
    return records.get(String(accountId ?? '')) ?? null
}

/** Tests use this; nothing in production needs to drop the record. */
export function clearPromptComposition() {
    records.clear()
}

/**
 * 段落的中文/英文名。卡片按 key 取名字；未知 key 原样显示。
 */
export const COMPOSITION_LABELS = Object.freeze({
    persona: ['人设', 'Persona'],
    style: ['语气与节奏', 'Style'],
    life: ['生活状态', 'Life state'],
    contact: ['群成员名片', 'Member card'],
    memory: ['记忆', 'Memory'],
    recall: ['往事检索', 'Recall'],
    dryRun: ['预演约定', 'Dry run'],
    source: ['来源说明', 'Source'],
    message: ['这条消息与附件', 'Message & attachments'],
})
