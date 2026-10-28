import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_LIST,
  MAX_ITEMS,
  addItem,
  completeItem,
  createListCommands,
  formatList,
  listItems,
  removeItem,
} from '../src/message/lists.js'
import { parseSessionCommand } from '../src/sessions.js'

function stateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-lists-'))
}

test('/todo is a session command with an optional argument', () => {
  assert.deepEqual(parseSessionCommand('/todo'), { command: 'todo', arg: '' })
  assert.deepEqual(parseSessionCommand('/todo add 买牛奶'), { command: 'todo', arg: 'add 买牛奶' })
  assert.deepEqual(parseSessionCommand('/待办 rm 2'), { command: 'todo', arg: 'rm 2' })
  assert.equal(parseSessionCommand('/todolist'), undefined)
})

test('items are added in order and the list survives a fresh read', () => {
  const root = stateRoot()
  addItem(root, 'bot1', { text: '买牛奶', at: 1000 })
  addItem(root, 'bot1', { text: '取快递', at: 2000 })

  const items = listItems(root, 'bot1')
  assert.deepEqual(items.map((item) => item.text), ['买牛奶', '取快递'])
  assert.equal(items[0].done, false)
  assert.match(formatList(DEFAULT_LIST, items), /2\/2 条未完成/)
})

test('every chat of one bot sees the same list; another bot does not', () => {
  const root = stateRoot()
  addItem(root, 'bot1', { text: '周末买菜', by: 'group-a', at: 1000 })

  // The store is keyed by account, not conversation: a second chat reads it.
  assert.equal(listItems(root, 'bot1').length, 1)
  assert.equal(listItems(root, 'bot2').length, 0)
  assert.match(formatList(DEFAULT_LIST, listItems(root, 'bot1')), /周末买菜/)
})

test('done marks the numbered item and reports what is left', () => {
  const root = stateRoot()
  addItem(root, 'bot1', { text: '买牛奶', at: 1000 })
  addItem(root, 'bot1', { text: '取快递', at: 2000 })

  const result = completeItem(root, 'bot1', { index: 2, at: 3000 })
  assert.equal(result.ok, true)
  assert.equal(result.remaining, 1)
  assert.equal(listItems(root, 'bot1')[1].done, true)
  assert.equal(listItems(root, 'bot1')[1].doneAt, 3000)

  const again = completeItem(root, 'bot1', { index: 2 })
  assert.equal(again.reason, 'already')
  const missing = completeItem(root, 'bot1', { index: 9 })
  assert.equal(missing.reason, 'range')
})

test('rm removes only the numbered item', () => {
  const root = stateRoot()
  addItem(root, 'bot1', { text: 'a', at: 1000 })
  addItem(root, 'bot1', { text: 'b', at: 2000 })
  addItem(root, 'bot1', { text: 'c', at: 3000 })

  assert.equal(removeItem(root, 'bot1', { index: 2 }).item.text, 'b')
  assert.deepEqual(listItems(root, 'bot1').map((item) => item.text), ['a', 'c'])
  assert.equal(removeItem(root, 'bot1', { index: 5 }).reason, 'range')
})

test('an empty item is refused instead of becoming a blank line', () => {
  const root = stateRoot()
  assert.equal(addItem(root, 'bot1', { text: '   ' }).reason, 'empty')
  assert.equal(listItems(root, 'bot1').length, 0)
})

test('the list is capped and says so instead of dropping old items', () => {
  const root = stateRoot()
  for (let i = 0; i < MAX_ITEMS; i += 1) {
    assert.equal(addItem(root, 'bot1', { text: `第 ${i} 条`, at: 1000 + i }).ok, true)
  }
  const full = addItem(root, 'bot1', { text: '再来一条', at: 9000 })
  assert.equal(full.reason, 'full')
  assert.equal(listItems(root, 'bot1').length, MAX_ITEMS)
  assert.equal(listItems(root, 'bot1')[0].text, '第 0 条')
})

test('the commands cover add, show, done and rm', () => {
  const root = stateRoot()
  const commands = createListCommands({ stateRoot: root, accountId: 'bot1', now: () => 5000 })

  assert.match(commands.todo(''), /还是空的/)
  assert.match(commands.todo('add 买牛奶'), /加好了（第 1 条）/)
  assert.match(commands.todo('取快递'), /第 2 条/, 'a bare line adds without the verb')
  assert.match(commands.todo(''), /2\/2 条未完成/)
  assert.match(commands.todo(''), /1\. ⬜ 买牛奶/)
  assert.match(commands.todo('done 1'), /完成：买牛奶（还剩 1 条）/)
  assert.match(commands.todo(''), /1\/2 条未完成/)
  assert.match(commands.todo('rm 2'), /删掉了：取快递/)
  assert.match(commands.todo('done 9'), /没有这个序号/)
})

test('help names /todo so it is discoverable', async () => {
  const { buildCommandsHelp } = await import('../src/sessions.js')
  assert.match(buildCommandsHelp(), /\/todo/)
})
