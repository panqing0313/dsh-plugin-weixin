import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseClockHHmm, quietDelay } from '../src/message/quiet-hours.js'
import { ReminderScheduler } from '../src/message/scheduler.js'
import { SubscriptionScheduler, parseSubscriptionWhen } from '../src/message/subscriptions.js'

/** Local wall-clock helpers: the quiet window is a LOCAL time concept. */
/**
 * A clock time on TODAY's date. A fixed calendar day would make these tests
 * pass only on the day they were written: the subscription case below compares
 * against "today 23:30".
 */
const at = (h, m, s = 0) => {
  const d = new Date()
  d.setHours(h, m, s, 0)
  return d.getTime()
}
const overnight = { quietHoursEnabled: true, quietHoursStart: '23:00', quietHoursEnd: '07:00' }

/** A quiet gate that defers exactly one trigger, then reports not-quiet. */
const onceQuiet = (ms) => {
    let used = false
    return () => {
        if (used) return 0
        used = true
        return ms
    }
}
const lunchNap = { quietHoursEnabled: true, quietHoursStart: '13:00', quietHoursEnd: '15:00' }

test('parseClockHHmm is strict', () => {
    assert.equal(parseClockHHmm('23:00'), 23 * 60)
    assert.equal(parseClockHHmm('0:07'), 7)
    assert.equal(parseClockHHmm('24:00'), null)
    assert.equal(parseClockHHmm('7:60'), null)
    assert.equal(parseClockHHmm('早上七点'), null)
    assert.equal(parseClockHHmm(''), null)
    assert.equal(parseClockHHmm(undefined), null)
})

test('quietDelay: overnight window 23:00–07:00', () => {
    // 23:30 → 7.5h later lands a minute past 07:00.
    const late = quietDelay(at(23, 30), overnight)
    assert.ok(late > 7 * 3600_000 && late <= 7.6 * 3600_000, String(late))
    // Inside the morning tail.
    const early = quietDelay(at(6, 0), overnight)
    assert.ok(early > 3600_000 && early <= 1.1 * 3600_000, String(early))
    // Outside the window.
    assert.equal(quietDelay(at(8, 0), overnight), 0)
    assert.equal(quietDelay(at(12, 0), overnight), 0)
    assert.equal(quietDelay(at(22, 59), overnight), 0)
    assert.equal(quietDelay(at(23, 0), overnight) > 0, true, 'the start minute itself is quiet')
})

test('quietDelay: same-day window and disabled forms', () => {
    assert.ok(quietDelay(at(14, 0), lunchNap) > 0 && quietDelay(at(14, 0), lunchNap) <= 1.1 * 3600_000)
    assert.equal(quietDelay(at(12, 0), lunchNap), 0)
    assert.equal(quietDelay(at(15, 0), lunchNap), 0, 'the end minute is already free')
    // Disabled shapes.
    assert.equal(quietDelay(at(23, 30), { quietHoursEnabled: false, quietHoursStart: '23:00', quietHoursEnd: '07:00' }), 0)
    assert.equal(quietDelay(at(23, 30), { quietHoursEnabled: true, quietHoursStart: '07:00', quietHoursEnd: '07:00' }), 0, 'start === end is not configured')
    assert.equal(quietDelay(at(23, 30), { quietHoursEnabled: true, quietHoursStart: 'garbage', quietHoursEnd: '07:00' }), 0)
    assert.equal(quietDelay(at(23, 30), {}), 0)
})

test('ReminderScheduler defers a slot inside the quiet window, keeps it in the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-quiet-r-'))
    try {
        const fired = []
        const timers = []
        let nowSeq = 0
        const setTimeoutRef = (ms, cb) => { timers.push({ ms, cb, id: nowSeq++ }); return nowSeq }
        const clearTimeoutRef = () => {}
        const scheduler = new ReminderScheduler({
            stateRoot: root,
            fire: (r) => fired.push(r),
            setTimeoutRef,
            clearTimeoutRef,
            // A defer-by-one-hour gate that quiets ONCE (like a real window:
            // after the push the moment is no longer inside it). The window
            // math itself is unit-tested above; here the contract is
            // "quiet ⇒ re-armed at the end, then sent".
            quiet: onceQuiet(3_600_000),
        })
        scheduler.schedule({ accountId: 'bot1', conversationId: 'c1', text: '晚安提醒', fireAt: at(23, 30) })
        const timer = timers.at(-1)
        timer.cb()
        // The item is still in the store (restart-safe), re-armed for the end.
        const onDisk = JSON.parse(readFileSync(join(root, 'reminders.json'), 'utf8'))
        assert.equal(onDisk.items.length, 1)
        const quietEnd = Date.now() + 3_600_000
        assert.ok(Math.abs(onDisk.items[0].fireAt - quietEnd) < 60_000, `fireAt=${new Date(onDisk.items[0].fireAt).toISOString()}`)
        const reArmed = timers.at(-1)
        assert.ok(reArmed !== timer, 'a new timer was armed')
        assert.ok(reArmed.ms > 59 * 60_000 && reArmed.ms <= 3_600_000)
        reArmed.cb()
        await new Promise((r) => setImmediate(r))
        assert.equal(fired.length, 1, 'fires when the window ends')
        assert.equal(fired[0].text, '晚安提醒')
        assert.equal(JSON.parse(readFileSync(join(root, 'reminders.json'), 'utf8')).items.length, 0)
        rmSync(root, { recursive: true, force: true })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('ReminderScheduler sends immediately outside the window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-quiet-r2-'))
    try {
        const fired = []
        const timers = []
        const setTimeoutRef = (ms, cb) => { timers.push({ ms, cb }); return timers.length }
        const scheduler = new ReminderScheduler({
            stateRoot: root,
            fire: (r) => fired.push(r),
            setTimeoutRef,
            clearTimeoutRef: () => {},
            quiet: () => 0,
        })
        scheduler.schedule({ accountId: 'bot1', conversationId: 'c1', text: '白天提醒', fireAt: at(10, 0) })
        timers.at(-1).cb()
        await new Promise((r) => setImmediate(r))
        assert.equal(fired.length, 1)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('SubscriptionScheduler defers without consuming the slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-weixin-quiet-s-'))
    try {
        const fired = []
        const timers = []
        const setTimeoutRef = (ms, cb) => { timers.push({ ms, cb }); return timers.length }
        const scheduler = new SubscriptionScheduler({
            stateRoot: root,
            fire: (item) => fired.push(item),
            setTimeoutRef,
            clearTimeoutRef: () => {},
            quiet: onceQuiet(3_600_000),
        })
        const planned = parseSubscriptionWhen('每天 23:30', new Date(at(12, 0)))
        assert.ok(planned.ok, JSON.stringify(planned))
        const result = scheduler.schedule({ accountId: 'bot1', conversationId: 'c1', prompt: '晚安', when: planned })
        assert.ok(!result.error, JSON.stringify(result))
        // Trigger the 23:30 slot.
        timers.at(-1).cb()
        await new Promise((r) => setImmediate(r))
        assert.equal(fired.length, 0, 'nothing sent while quiet')
        // The item survived, re-armed for the window end — the daily slot was
        // NOT consumed into tomorrow.
        const onDisk = JSON.parse(readFileSync(join(root, 'subscriptions.json'), 'utf8'))
        assert.equal(onDisk.items.length, 1)
        assert.ok(Math.abs(onDisk.items[0].fireAt - (Date.now() + 3_600_000)) < 60_000, new Date(onDisk.items[0].fireAt).toISOString())
        // At the window end the send happens, then the slot advances to the
        // NEXT regular occurrence.
        timers.at(-1).cb()
        await new Promise((r) => setImmediate(r))
        assert.equal(fired.length, 1)
        assert.equal(fired[0].prompt, '晚安')
        const after = JSON.parse(readFileSync(join(root, 'subscriptions.json'), 'utf8'))
        // The deferred trigger happened at "window end" = now+1h (still before
        // tonight's slot), so the next regular occurrence is today 23:30.
        assert.equal(after.items[0].fireAt, at(23, 30), 'today 23:30 again')
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
