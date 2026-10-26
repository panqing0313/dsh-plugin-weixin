/**
 * 免打扰时段 (quiet hours): a daily window during which TIMED sends — /remind
 * reminders and /subscribe proactive messages — do not go out. A slot that
 * lands inside the window is pushed to the window's end instead of being sent
 * (or dropped): the user asked for the message, but not for the 3 a.m. buzz.
 * Replies to inbound messages are never gated: the user is obviously awake.
 */

/**
 * Parse a strict `HH:mm` clock string into minutes since midnight.
 * @param {string} value
 * @returns {number | null} minutes 0..1439, or null when malformed
 */
export function parseClockHHmm(value) {
    if (typeof value !== 'string') return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (m === null) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
}

/**
 * How long from `now` until the quiet window ends.
 *
 * Rules:
 * - disabled unless `quietHoursEnabled === true`, both clocks parse, and
 *   start !== end (start === end is treated as "not configured", because a
 *   window that is always quiet would silently swallow every timed send);
 * - a window that crosses midnight (start > end, the common 23:00–07:00)
 *   covers `[start, 24:00) ∪ [00:00, end)`;
 * - a same-day window (start < end, e.g. a lunch nap 13:00–15:00) covers
 *   `[start, end)`.
 *
 * @param {number} nowMs
 * @param {{ quietHoursEnabled?: boolean, quietHoursStart?: string, quietHoursEnd?: string }} config
 * @returns {number} milliseconds until the window ends; 0 when not quiet
 */
export function quietDelay(nowMs, config) {
    if (config?.quietHoursEnabled !== true) return 0
    const start = parseClockHHmm(config.quietHoursStart)
    const end = parseClockHHmm(config.quietHoursEnd)
    if (start === null || end === null || start === end) return 0
    const d = new Date(nowMs)
    const minute = d.getHours() * 60 + d.getMinutes()
    let endMinutes = end
    let quiet = false
    if (start > end) {
        // Overnight window.
        quiet = minute >= start || minute < end
    } else {
        quiet = minute >= start && minute < end
    }
    if (!quiet) return 0
    let deltaMinutes = endMinutes - minute
    if (deltaMinutes <= 0) deltaMinutes += 1440
    // Round UP to the next full minute past the boundary: firing exactly at
    // :00 collides with the minute the clock reads the same, and a sub-second
    // race would put the send still inside the window.
    const msIntoMinute = nowMs % 60_000
    return deltaMinutes * 60_000 - msIntoMinute + 60_000
}
