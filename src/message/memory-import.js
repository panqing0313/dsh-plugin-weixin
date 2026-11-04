/**
 * 记忆导入：把 `/memory export` 导出的那份 Markdown 读回来。
 *
 * 导出是一份给人看的文档（`renderMemoryMarkdown`），所以导入只能做**保守的
 * 反向解析**：认章节标题、认 `1. 事实` 与 `- 事件` 这两种列表形状，认不出来
 * 的行就跳过并计数，绝不猜。宁可少导一条，也不能把「## 会话记忆」里那段散文
 * 当成长期事实塞进去。
 *
 * 两段式：`parseMemoryMarkdown` 只读文本 → `planMemoryImport` 拿现有记忆比对出
 * 「会新增 / 已存在 / 会被挤掉」，`/import` 先把这份计划回给用户；用户回「是」
 * 才 `applyMemoryImport` 真正落盘。换机器、重装、从旧备份恢复，都走这一条路。
 *
 * 导入不覆盖也不删除：已有的事实一条不动，只补新的；写满上限时明确说「只导进
 * 了前 N 条」，而不是悄悄丢掉剩下的。
 *
 * @module dsh-weixin/message/memory-import
 */

import { addEvent, addGlobalFact, saveProfile, setConvSummary, setDigest } from '../memory.js'

/** 导入计划的待确认队列活多久：十分钟不答就当用户不要了。 */
export const IMPORT_CONFIRM_TTL_MS = 10 * 60_000

const SECTION_ALIASES = {
    digest: ['人物小传', '小传', 'persona digest', 'digest'],
    profile: ['关于你的档案', '档案', 'profile', 'your profile'],
    events: ['事件与待办', '待办', '事件', 'events', 'to-dos'],
    facts: ['长期记忆', '记忆', 'long-term memory', 'facts'],
}

/** Strip list markers and numbering from one line; returns undefined when empty. */
function listItemOf(line) {
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/)
    if (numbered !== null) return numbered[1].trim()
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (bullet !== null) return bullet[1].trim()
    return undefined
}

/** Which known section a heading names, or undefined. */
function sectionOf(heading) {
    const name = heading.trim().toLowerCase()
    for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
        if (aliases.some((alias) => alias.toLowerCase() === name)) return key
    }
    return undefined
}

/**
 * Parse an exported memory document.
 *
 * @param {string} markdown
 * @returns {{
 *   digest: string,
 *   profile: { call?: string, schedule?: string, likes?: string[], dislikes?: string[], dates?: Array<{label: string, date: string}> },
 *   events: Array<{ text: string, when: string }>,
 *   facts: string[],
 *   skipped: number,
 * }}
 */
export function parseMemoryMarkdown(markdown) {
    const result = { digest: '', profile: {}, events: [], facts: [], skipped: 0 }
    const lines = String(markdown ?? '').split(/\r?\n/)
    let section = ''
    const digestLines = []

    for (const line of lines) {
        const heading = line.match(/^\s*##\s+(.+?)\s*$/)
        if (heading !== null) {
            section = sectionOf(heading[1]) ?? ''
            continue
        }
        if (/^\s*#\s+/.test(line)) continue
        if (line.trim() === '') continue
        if (section === '') {
            // Preamble (`- 账号：…`) and unknown sections are ignored on purpose.
            continue
        }

        if (section === 'digest') {
            digestLines.push(line.trim())
            continue
        }

        if (section === 'profile') {
            const item = listItemOf(line)
            if (item === undefined) {
                result.skipped += 1
                continue
            }
            // `- 称呼：阿伟` / `- 喜欢：跑步、咖啡` / `- 重要日期：生日 1990-05-20`
            const field = item.match(/^([^：:]+)[：:]\s*(.*)$/)
            if (field === null) {
                result.skipped += 1
                continue
            }
            const key = field[1].trim()
            const value = field[2].trim()
            if (value === '') continue
            if (key === '称呼' || key.toLowerCase() === 'call') result.profile.call = value
            else if (key === '作息' || key.toLowerCase() === 'schedule') result.profile.schedule = value
            else if (key === '喜欢' || key.toLowerCase() === 'likes') result.profile.likes = splitList(value)
            else if (key === '不喜欢' || key.toLowerCase() === 'dislikes') result.profile.dislikes = splitList(value)
            else if (key === '重要日期' || key.toLowerCase() === 'dates') result.profile.dates = parseDates(value)
            continue
        }

        if (section === 'events') {
            const item = listItemOf(line)
            if (item === undefined) {
                result.skipped += 1
                continue
            }
            // `formatEvents` prints `- [YYYY-MM-DD] 文本` or `- ✅ [date] text`.
            const marked = item.replace(/^[✅·]\s*/, '')
            const dated = marked.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/)
            if (dated !== null) result.events.push({ when: dated[1], text: dated[2].trim() })
            else result.events.push({ when: '', text: marked.trim() })
            continue
        }

        if (section === 'facts') {
            const item = listItemOf(line)
            if (item === undefined) {
                result.skipped += 1
                continue
            }
            // The export prints `1. 我对花生过敏`; a hand-edited file may keep the
            // `（12 天前 · 来自/remember）` suffix, which is not part of the fact.
            const bare = item.replace(/\s*（[^）]*）\s*$/, '').trim()
            if (bare === '' || bare.startsWith('（还没有')) continue
            result.facts.push(bare)
        }
    }

    result.digest = digestLines.join('\n').trim()
    return result
}

function splitList(value) {
    return value.split(/[、,，;；]/).map((part) => part.trim()).filter((part) => part !== '').slice(0, 10)
}

function parseDates(value) {
    const out = []
    // Formats accepted: `生日 1990-05-20`、`生日 05-20`、`生日 → 1990-05-20`.
    for (const part of value.split(/[；;]/)) {
        const match = part.match(/^(.*?)[\s→]*((?:\d{4}-)?\d{2}-\d{2})$/)
        if (match === null) continue
        const label = match[1].trim().replace(/[：:]$/, '')
        const date = match[2].length === 5 ? `0000-${match[2]}` : match[2]
        if (label !== '' && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push({ label, date })
    }
    return out.slice(0, 10)
}

/**
 * Compare a parsed document with what is already stored.
 *
 * @param {{ facts: string[], events: Array<{text: string, when: string}>, digest: string, profile: object }} parsed
 * @param {object} memory  the result of readGlobalMemory
 * @param {{ maxFacts?: number }} [options]
 */
/**
 * Import policies. Exposed as a value so the command, the tests and the docs
 * name the same three behaviours instead of describing them in three places.
 *
 *   - `fill`  (默认) 只补缺：已有事实一条不动，档案只填空的字段。
 *   - `merge` 合并：长期记忆同样只补缺；档案里**空的字段补上、非空的保留本机**，
 *     但会告诉你包里有几个字段不同 —— 想以包为准就用 `replace`。
 *   - `replace` 覆盖：包里的档案直接盖掉本机的；长期记忆仍是**追加**，
 *     因为删记忆只能由人来做（`/forget`、`/undo`），导入从不删东西。
 */
export const IMPORT_POLICIES = Object.freeze(['fill', 'merge', 'replace'])

/** 把「追加/合并/覆盖」这些说法归一成一个策略名；认不出来返回 undefined。 */
export function normalizeImportPolicy(word) {
    const text = String(word ?? '').trim().toLowerCase()
    if (text === '' || text === 'fill' || text === 'append' || text === '追加' || text === '补缺') return 'fill'
    if (text === 'merge' || text === '合并') return 'merge'
    if (text === 'replace' || text === 'overwrite' || text === '覆盖') return 'replace'
    return undefined
}

export function planMemoryImport(parsed, memory, { maxFacts = 30 } = {}) {
    const key = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    const existingFacts = new Set((memory?.facts ?? []).map((fact) => key(fact.text)))
    const newFacts = []
    let duplicates = 0
    for (const fact of parsed.facts) {
        if (existingFacts.has(key(fact))) {
            duplicates += 1
            continue
        }
        if (newFacts.some((entry) => key(entry) === key(fact))) {
            duplicates += 1
            continue
        }
        newFacts.push(fact)
    }
    const room = Math.max(0, maxFacts - (memory?.facts?.length ?? 0))
    const factsToAdd = newFacts.slice(0, room)

    const existingEvents = new Set((memory?.events ?? []).map((event) => `${event.when}|${key(event.text)}`))
    const eventsToAdd = parsed.events.filter((event) => existingEvents.has(`${event.when}|${key(event.text)}`) === false)

    const profileFields = Object.entries(parsed.profile ?? {})
        .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ''))
    const currentProfile = memory?.profile ?? {}
    // `conflictingProfileFields` is what the preview counts as "包里有、本机也有但不一样"。
    // Under `fill` they are left alone; under `merge` they are also left alone but
    // the user is told how many there are; under `replace` they are written.
    const conflictingProfileFields = profileFields.filter(([field, value]) => {
        const current = currentProfile[field]
        if (Array.isArray(value)) return JSON.stringify(current ?? []) !== JSON.stringify(value) && (current ?? []).length > 0
        return current !== undefined && current !== '' && current !== value
    })
    const changedProfileFields = profileFields.filter(([field, value]) => {
        const current = currentProfile[field]
        if (Array.isArray(value)) return JSON.stringify(current ?? []) !== JSON.stringify(value)
        return current !== value
    })

    const conflictingKeys = new Set(conflictingProfileFields.map(([field]) => field))
    const fillProfileFields = changedProfileFields.filter(([field]) => conflictingKeys.has(field) === false)
    // Conversation summaries are handled like facts: they are appended where
    // missing and never overwrite whatever this machine already remembers.
    const existingConversations = new Set(Object.keys(memory?.conversations ?? {}))
    const conversationsToAdd = (parsed.conversations ?? []).filter((conv) => existingConversations.has(conv.conversationId) === false)

    return {
        facts: factsToAdd,
        droppedFacts: newFacts.length - factsToAdd.length,
        duplicateFacts: duplicates,
        events: eventsToAdd,
        conversations: conversationsToAdd,
        conflictingProfileFields: conflictingProfileFields.map(([field, value]) => ({ field, incoming: value, current: currentProfile[field] })),
        fillProfileFields: fillProfileFields.map(([field]) => field),
        profilePatch: Object.fromEntries(changedProfileFields),
        newDigest: parsed.digest !== '' && parsed.digest !== (memory?.digest ?? '') ? parsed.digest : '',
        skipped: parsed.skipped,
        nothingToDo: factsToAdd.length === 0 && eventsToAdd.length === 0
            && changedProfileFields.length === 0 && parsed.digest === '',
    }
}

/**
 * The preview `/import` replies with before touching anything.
 *
 * @param {ReturnType<typeof planMemoryImport>} plan
 * @param {{ source?: string }} [options]
 */
export function formatImportPreview(plan, { source = '粘贴的内容', policy = 'fill' } = {}) {
    const conflicts = Array.isArray(plan.conflictingProfileFields) ? plan.conflictingProfileFields : []
    const policyLine = policy === 'replace'
        ? '策略：覆盖（包里的档案会盖掉本机的）'
        : policy === 'merge'
            ? '策略：合并（本机已有的档案字段保留，包里的补进空字段）'
            : '策略：补缺（本机已有的东西一律不动）'
    if (plan.nothingToDo) {
        const extras = []
        if (plan.duplicateFacts > 0) extras.push(`${plan.duplicateFacts} 条长期记忆已经记过了`)
        if (plan.skipped > 0) extras.push(`${plan.skipped} 行认不出来已跳过`)
        const tail = conflicts.length > 0 && policy !== 'replace'
            ? `；另有 ${conflicts.length} 条档案和本机不一样，${policy === 'merge' ? '想以包为准请用 /import replace' : '用 /import merge 或 replace 才会动'}`
            : ''
        return `这份内容里没有需要新导入的东西${extras.length > 0 || tail !== '' ? `（${[...extras, tail.replace(/^；/, '')].filter(Boolean).join('，')}）` : ''}。`
    }
    const lines = [policyLine, `从${source}里读到：`]
    if (plan.facts.length > 0) lines.push(`- 长期记忆 ${plan.facts.length} 条：${plan.facts.slice(0, 5).join('；')}${plan.facts.length > 5 ? ' …' : ''}`)
    if (plan.events.length > 0) lines.push(`- 事件与待办 ${plan.events.length} 条：${plan.events.slice(0, 3).map((event) => event.text).join('；')}${plan.events.length > 3 ? ' …' : ''}`)
    const profileFields = Object.keys(plan.profilePatch)
    if (profileFields.length > 0) lines.push(`- 档案 ${profileFields.length} 项：${profileFields.join('、')}`)
    if (plan.newDigest !== '') lines.push(`- 人物小传 ${plan.newDigest.length} 字`)
    if (Array.isArray(plan.conversations) && plan.conversations.length > 0) lines.push(`- 会话记忆 ${plan.conversations.length} 段`)
    if (plan.duplicateFacts > 0) lines.push(`（其中 ${plan.duplicateFacts} 条已经记过了，会跳过）`)
    if (conflicts.length > 0) {
        const names = conflicts.slice(0, 4).map((entry) => entry.field).join('、')
        lines.push(policy === 'replace'
            ? `（其中 ${conflicts.length} 条档案会盖掉本机的：${names}${conflicts.length > 4 ? ' …' : ''}）`
            : `（其中 ${conflicts.length} 条档案和本机不一样，这个策略下不动：${names}${conflicts.length > 4 ? ' …' : ''}）`)
    }
    if (plan.skipped > 0) lines.push(`（其中 ${plan.skipped} 行认不出来，会跳过）`)
    if (plan.droppedFacts > 0) lines.push(`（长期记忆放不下，还有 ${plan.droppedFacts} 条这次导不进来）`)
    lines.push('')
    lines.push('确认的话回「是」，我就写进去；回「不用」就什么都不改。')
    return lines.join('\n')
}

/**
 * Apply a plan. Existing facts and events are never removed; a fact is only
 * written when it is new, and the import origin is recorded so `/memory` can
 * tell where it came from.
 *
 * @param {{ stateRoot: string, accountId: string, plan: ReturnType<typeof planMemoryImport>, warn?: Function, now?: number, maxFacts?: number, maxChars?: number }} input
 */
export function applyMemoryImport({ stateRoot, accountId, plan, warn = () => {}, now = Date.now(), maxFacts = 30, maxChars = 1500, policy = 'fill' }) {
    const written = { facts: 0, events: 0, profile: 0, digest: false, conversations: 0 }
    const failures = []

    // Which profile fields this policy is allowed to write. Under `fill` and
    // `merge` a field this machine already has is left alone; `replace` writes
    // the pack's values over it. The long-term facts are appended under every
    // policy — deleting memory stays a human decision.
    const fillOnly = Array.isArray(plan.fillProfileFields) ? new Set(plan.fillProfileFields) : null
    const profilePatchOk = Object.fromEntries(
        Object.entries(plan.profilePatch ?? {}).filter(([field]) => policy === 'replace' || fillOnly === null || fillOnly.has(field)),
    )

    for (const fact of plan.facts) {
        const result = addGlobalFact(stateRoot, accountId, fact, {
            warn,
            now,
            maxFacts,
            maxChars,
            origin: '/import',
        })
        if (result.added === true) written.facts += 1
        else failures.push(`「${fact}」：${describeAddFailure(result.reason)}`)
    }

    for (const event of plan.events) {
        const result = addEvent(stateRoot, accountId, { text: event.text, when: event.when }, { warn, now })
        if (result.added === true) written.events += 1
        else if (result.reason !== 'duplicate') failures.push(`「${event.text}」：${describeAddFailure(result.reason)}`)
    }

    if (Object.keys(profilePatchOk).length > 0) {
        const result = saveProfile(stateRoot, accountId, profilePatchOk, { warn })
        if (result.ok === true) written.profile = Object.keys(profilePatchOk).length
        else failures.push('档案写入失败')
    }

    // Conversation summaries are appended where this machine has none. A summary
    // is a compressed paragraph, not an instruction — the incoming one cannot
    // overwrite a live conversation's memory.
    for (const conv of Array.isArray(plan.conversations) ? plan.conversations : []) {
        try {
            setConvSummary(stateRoot, accountId, conv.conversationId, conv.summary, { warn })
            written.conversations += 1
        } catch {
            failures.push(`会话记忆「${conv.conversationId}」写入失败`)
        }
    }

    if (plan.newDigest !== '') {
        const ok = writeDigest(stateRoot, accountId, plan.newDigest, { warn, now })
        written.digest = ok
        if (ok !== true) failures.push('人物小传写入失败')
    }

    return { ...written, failures }
}

function describeAddFailure(reason) {
    if (reason === 'cap') return '记忆放不下了'
    if (reason === 'duplicate') return '已经记过了'
    if (reason === 'empty') return '内容是空的'
    return '写入失败'
}

/**
 * The digest is the one field `/import` writes through a dedicated setter:
 * `memory.js` normally lets only the background summarizer produce one, but a
 * persona paragraph restored from a backup is exactly what /import is for.
 */
function writeDigest(stateRoot, accountId, digest, { warn, now }) {
    return setDigest(stateRoot, accountId, digest, { warn, now })
}