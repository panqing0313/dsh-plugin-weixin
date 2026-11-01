/**
 * 记忆过期自检。
 *
 * 长期记忆只增不减：半年后里面躺着一堆「我在做 A 项目」「我住在杭州」，而人
 * 已经在做 B、也搬了家。没有过期提醒的话，机器人会一本正经地拿旧事实推理，
 * 而且用户根本不知道哪些话已经过时了 —— 它看起来只是「记性变差了」。
 *
 * `/memory stale` 列出「很久没被确认过」的那几条；日报里再给一行数字。两者
 * 用的是同一个口径：**最后一次被写入或改口的时间**（`updatedAt`），超过
 * `memoryStaleDays`（默认 90 天）就算陈旧。改口会刷新这个时间，因为那次对话
 * 本身就是一次重新确认。
 *
 * 老版本写下的事实没有时间戳：它们不是「过期」，是「不知道多久了」，所以单独
 * 归成一类，不混进过期列表里吓人。
 *
 * @module dsh-weixin/message/memory-stale
 */

/** 少于这么多天就不算陈旧：一周前记的电话号码没什么好核对的。 */
export const MIN_STALE_DAYS = 7
/** 默认口径：三个月没被重新确认过。 */
export const DEFAULT_STALE_DAYS = 90
/** `/memory stale` 一次最多列这么多条，再多就该分批处理了。 */
export const MAX_STALE_LIST = 30

/**
 * Split the facts into 「过期」 and 「没有时间戳」.
 *
 * @param {{ text: string, at?: number, updatedAt?: number }[]} facts
 * @param {{ now?: number, staleDays?: number }} [options]
 * @returns {{ stale: { text: string, days: number, index: number }[], unknown: { text: string, index: number }[], staleDays: number }}
 */
export function staleFacts(facts, { now = Date.now(), staleDays = DEFAULT_STALE_DAYS } = {}) {
    // 非数字才回落默认值；0 或负数当作「用最小窗口」，由下面这行夹住。
    const requested = Number(staleDays)
    const days = Math.max(MIN_STALE_DAYS, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_STALE_DAYS))
    const stale = []
    const unknown = []
    const list = Array.isArray(facts) ? facts : []
    list.forEach((fact, position) => {
        const index = position + 1
        const text = String(fact?.text ?? '')
        if (text === '') return
        const stamp = Number(fact?.updatedAt || fact?.at || 0)
        if (!Number.isFinite(stamp) || stamp <= 0) {
            unknown.push({ text, index })
            return
        }
        const age = Math.max(0, Math.floor((now - stamp) / 86_400_000))
        if (age >= days) stale.push({ text, days: age, index })
    })
    // Oldest first: the fact nobody has touched in a year is the likeliest to be wrong.
    stale.sort((left, right) => right.days - left.days)
    return { stale: stale.slice(0, MAX_STALE_LIST), unknown, staleDays: days }
}

/**
 * The sentence `/memory stale` replies with. Kept separate from the command so
 * the digest line and the command cannot drift apart in wording or threshold.
 *
 * @param {{ stale: { text: string, days: number, index: number }[], unknown: { text: string, index: number }[], staleDays: number }} report
 * @param {{ total?: number }} [options]
 * @returns {string}
 */
export function formatStaleReport(report, { total = 0 } = {}) {
    const { stale, unknown, staleDays } = report
    if (stale.length === 0 && unknown.length === 0) {
        return `没有需要核对的记忆（超过 ${staleDays} 天没确认的一条都没有）。`
    }
    const lines = []
    if (stale.length > 0) {
        lines.push(`超过 ${staleDays} 天没确认过的记忆，共 ${stale.length} 条：`)
        for (const fact of stale) {
            lines.push(`${fact.index}. ${fact.text}（${fact.days} 天没提起了）`)
        }
        lines.push('')
        lines.push('看完之后可以这样处理：用 /remember 重新确认一遍（会刷新时间），或者 /forget <编号> 删掉。')
    }
    if (unknown.length > 0) {
        lines.push(
            stale.length === 0
                ? `有 ${unknown.length} 条记忆不知道是什么时候写的（老版本存下的），要核对的话用 /memory 看全文。`
                : `另外还有 ${unknown.length} 条不知道是什么时候写的（老版本存下的）。`,
        )
    }
    if (total > 0) lines.push(`长期记忆一共 ${total} 条，都在 /memory 里。`)
    return lines.join('\n')
}

/**
 * The one-line hint that rides the daily digest, or an empty string when there
 * is nothing worth saying. Deliberately quiet: a digest that ends with a chore
 * list every single day trains the user to ignore it.
 *
 * @param {{ stale: { text: string, days: number, index: number }[], unknown: unknown[], staleDays: number }} report
 * @returns {string}
 */
export function staleDigestLine(report) {
    if (report.stale.length === 0) return ''
    const names = report.stale.slice(0, 2).map((fact) => fact.text).join('、')
    const more = report.stale.length > 2 ? ` 等 ${report.stale.length} 条` : ''
    return `有 ${report.stale.length} 条记忆超过 ${report.staleDays} 天没提过（${names}${more}），发 /memory stale 可以一起核对`
}