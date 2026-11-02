import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ONBOARDING_STEPS,
  buildOnboardingChecklist,
  describeNextStep,
  describeOnboardingProgress,
} from '../src/onboarding.js'

test('a brand new install is not complete, and says which step to do first', () => {
  const checklist = buildOnboardingChecklist()
  assert.equal(checklist.complete, false)
  assert.equal(checklist.total, ONBOARDING_STEPS.length)
  assert.equal(checklist.done, 0)
  const account = checklist.steps.find((step) => step.id === 'account')
  assert.equal(account.state, 'todo')
  assert.equal(account.action, 'login')
  // The allowlist cannot be decided before an account exists.
  assert.equal(checklist.steps.find((step) => step.id === 'allowlist').state, 'blocked')
  assert.match(describeNextStep(checklist), /登录一个微信账号/)
})

test('after login the next required step is the allowlist, not the optional ones', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'bot1@im.bot', allowedSenders: [] }],
    accountCount: 1,
    hostVersion: '0.2.1-rc.5',
    hostTested: true,
  })
  assert.equal(checklist.steps.find((step) => step.id === 'account').state, 'done')
  assert.equal(checklist.steps.find((step) => step.id === 'allowlist').state, 'todo')
  assert.equal(checklist.complete, false)
  assert.match(describeNextStep(checklist), /谁能让它干活/)
})

test('an allowlisted, tested host is complete even when the optional steps are untouched', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'bot1@im.bot', allowedSenders: [] }],
    accountCount: 1,
    hostVersion: '0.2.1-rc.5',
    hostTested: true,
    allowedSenders: ['wxid_abc'],
  })
  assert.equal(checklist.complete, true)
  // Optional steps are notes, never todos: nobody should be nagged into backups.
  for (const id of ['persona', 'proactive', 'knowledge', 'backup']) {
    assert.equal(checklist.steps.find((step) => step.id === id).state, 'note', id)
  }
  assert.equal(describeOnboardingProgress(checklist, (zh) => zh), '已经可以用了')
})

test('an allowlist set only per account still counts as allowlisted', () => {
  const checklist = buildOnboardingChecklist({
    accounts: [{ accountId: 'bot1@im.bot', allowedSenders: ['wxid_account_level'] }],
    accountCount: 1,
    hostVersion: '0.2.1-rc.5',
    hostTested: true,
    allowedSenders: [],
  })
  assert.equal(checklist.steps.find((step) => step.id === 'allowlist').state, 'done')
  assert.equal(checklist.complete, true)
})

test('an untested host is a caution, an unknown one is only a note', () => {
  // Neither is something the operator can fix from inside this app — the host
  // version is the host's business. Both are rendered as · with a reason, never
  // as an unfinished step that would block the "you are ready" verdict.
  const untested = buildOnboardingChecklist({ hostVersion: '9.9.9', hostTested: false })
  assert.equal(untested.steps.find((step) => step.id === 'host').state, 'note')
  assert.match(untested.steps.find((step) => step.id === 'host').detail, /9\.9\.9/)

  const unknown = buildOnboardingChecklist({ hostVersion: null })
  assert.equal(unknown.steps.find((step) => step.id === 'host').state, 'note')
})

test('the progress line counts only real todos, and the English strings are there too', () => {
  const checklist = buildOnboardingChecklist({ accounts: [{ accountId: 'a' }], accountCount: 1 })
  assert.match(describeOnboardingProgress(checklist), /还差 1 步/)
  assert.match(describeOnboardingProgress(checklist, (_zh, en) => en), /1 step\(s\) left/)
  for (const step of checklist.steps) {
    assert.equal(typeof step.titleEn, 'string')
    assert.equal(typeof step.detailEn, 'string')
    assert.equal(typeof step.why, 'string')
    assert.equal(typeof step.whyEn, 'string')
  }
})

test('the knowledge step reports the count and respects the switch', () => {
  const withFiles = buildOnboardingChecklist({ knowledgeFiles: 3, knowledgeEnabled: true })
  assert.match(withFiles.steps.find((step) => step.id === 'knowledge').detail, /3 份文件/)
  assert.equal(withFiles.steps.find((step) => step.id === 'knowledge').state, 'done')

  const off = buildOnboardingChecklist({ knowledgeFiles: 0, knowledgeEnabled: false })
  assert.match(off.steps.find((step) => step.id === 'knowledge').detail, /知识库是关的/)
})

test('every step carries the id, state, action and why a card needs to render it', () => {
  const checklist = buildOnboardingChecklist()
  assert.deepEqual(checklist.steps.map((step) => step.id), [...ONBOARDING_STEPS])
  for (const step of checklist.steps) {
    assert.ok(['done', 'todo', 'blocked', 'note'].includes(step.state), `${step.id}: ${step.state}`)
    assert.ok(step.action === null || typeof step.action === 'string')
    assert.notEqual(step.why, '', `${step.id} needs a reason`)
  }
})
