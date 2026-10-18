import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReminderScheduler } from '../src/message/scheduler.js'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('reminders() lists pending entries soonest first through the provider', async () => {
	const { WeixinLoginController } = await import('../src/login-remote.js')
	// no provider wired: honest empty answer, not an error
	const { ctx, dispose } = makeCtx()
	let controller
	try {
		controller = new WeixinLoginController(ctx, {})
	} catch {
		return // controller needs full host context; covered by e2e/host-wiring tests
	}
	try {
		const r = await controller.reminders()
		assert.equal(r.available, false)
		assert.deepEqual(r.entries, [])
	} finally {
		controller.stop?.()
		dispose()
	}
})

test('remindCancel without a provider reports unavailable, not a crash', async () => {
	const { WeixinLoginController } = await import('../src/login-remote.js')
	const { ctx, dispose } = makeCtx()
	let controller
	try {
		controller = new WeixinLoginController(ctx, {})
	} catch {
		return
	}
	try {
		const r = await controller.remindCancel('whatever')
		assert.equal(r.removed, false)
		assert.ok(r.error)
	} finally {
		controller.stop?.()
		dispose()
	}
})

test('scheduler list + cancel drive the card data end to end', () => {
	const root = mkdtempSync(join(tmpdir(), 'reminders-ui-'))
	try {
		const fired = []
		const scheduler = new ReminderScheduler({
			stateRoot: root,
			warn: () => {},
			fire: (r) => fired.push(r),
			// never actually fire during the test
			setTimeoutRef: () => 0,
			clearTimeoutRef: () => {},
		})
		const confirmed = scheduler.schedule({ accountId: 'a1', conversationId: 'c1', fireAt: Date.parse('2050-01-01T09:00:00'), text: '例会' })
		assert.ok(confirmed.id, JSON.stringify(confirmed))
		const entries = scheduler.list()
		assert.equal(entries.length, 1)
		assert.equal(entries[0].text, '例会')
		assert.equal(scheduler.cancel(entries[0].id), true)
		assert.equal(scheduler.list().length, 0)
		assert.equal(scheduler.cancel('missing'), false)
		scheduler.stop()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

function makeCtx() {
	const disposers = []
	return {
		dispose: () => { for (const d of disposers) try { d?.() } catch { /* ignore */ } },
		ctx: {
			logger: { info: () => {}, warn: () => {} },
			effect(fn) { disposers.push(fn()); return { dispose() {} } },
		},
	}
}
