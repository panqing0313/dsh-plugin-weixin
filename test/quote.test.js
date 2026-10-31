import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_QUOTE_CHARS, parseQuote, quoteBlock } from '../src/message/quote.js'
import { normalizeInbound } from '../src/transport/ilink.js'

const quoted = { type: 1, displayname: '小王', content: '下午三点开会', svrid: '1' }

test('a refermsg nested in appmsg is read, with sender and text', () => {
  // The outer appmsg title names the card being sent, not the quoted message;
  // only refermsg's own title belongs in the quote.
  const quote = parseQuote([{ type: 49, appmsg: { title: '群公告', refermsg: quoted } }])
  assert.deepEqual(quote, { text: '下午三点开会', sender: '小王' })
})

test('a refermsg directly on the item, or under quote, is read too', () => {
  assert.deepEqual(parseQuote([{ type: 1, refermsg: quoted }]), { text: '下午三点开会', sender: '小王' })
  assert.deepEqual(parseQuote([{ type: 1, quote: { refermsg: quoted } }]), { text: '下午三点开会', sender: '小王' })
})

test('a quoted link card keeps its title and falls back to des', () => {
  const quote = parseQuote([{ type: 49, appmsg: { refermsg: { title: '一篇文章', des: '摘要', displayname: '公众号' } } }])
  assert.deepEqual(quote, { title: '一篇文章', text: '摘要', sender: '公众号' })
})

test('no quote shape means no quote', () => {
  assert.equal(parseQuote([]), undefined)
  assert.equal(parseQuote([{ type: 1, text_item: { text: 'hi' } }]), undefined)
  assert.equal(parseQuote([{ type: 49, appmsg: { title: '卡片' } }]), undefined)
})

test('quoted text is redacted and clipped', () => {
  const token = 'sk-' + 'a'.repeat(40)
  const quote = parseQuote([{ type: 1, refermsg: { content: `看这个 ${token}` } }])
  assert.equal(quote.text.includes(token), false)
  // Not 'xxxx…': a long run of the same character reads as a secret to
  // redactSecrets and would be masked before the length check.
  const long = parseQuote([{ type: 1, refermsg: { content: '字'.repeat(MAX_QUOTE_CHARS + 50) } }])
  assert.equal(long.text.length, MAX_QUOTE_CHARS + 1)
  assert.ok(long.text.endsWith('…'))
})

test('the block names the sender and keeps the title on its own line', () => {
  assert.equal(quoteBlock({ text: '好的' }), '【引用】\n好的')
  assert.equal(quoteBlock({ text: '好的', sender: '小王' }), '【引用 小王】\n好的')
  assert.equal(quoteBlock({ title: '公告', text: '好的', sender: '小王' }), '【引用 小王】\n公告\n好的')
})

test('normalizeInbound carries the quote, even with no text of its own', () => {
  const message = normalizeInbound({
    message_id: 'm1',
    from_user_id: 'wxid_a',
    message_state: 2,
    item_list: [{ type: 1, refermsg: quoted }],
  })
  assert.equal(message.type, 'text')
  assert.equal(message.text, '')
  assert.deepEqual(message.quote, { text: '下午三点开会', sender: '小王' })
})

test('normalizeInbound keeps the quote next to a caption and next to media', () => {
  const caption = normalizeInbound({
    message_id: 'm2',
    from_user_id: 'wxid_a',
    message_state: 2,
    item_list: [
      { type: 1, text_item: { text: '你看这句' }, refermsg: quoted },
    ],
  })
  assert.equal(caption.text, '你看这句')
  assert.equal(caption.quote.text, '下午三点开会')

  const media = normalizeInbound({
    message_id: 'm3',
    from_user_id: 'wxid_a',
    message_state: 2,
    item_list: [
      { type: 2, image_item: { media: { full_url: 'https://x/y.jpg' } }, refermsg: quoted },
    ],
  })
  assert.equal(media.type, 'image')
  assert.equal(media.quote.text, '下午三点开会')
})

test('an item we cannot render still reaches the model through its quote', () => {
  const message = normalizeInbound({
    message_id: 'm4',
    from_user_id: 'wxid_a',
    message_state: 2,
    item_list: [{ type: 77, refermsg: quoted }],
  })
  // A quote is content: the handler can answer "他说的那句" even though the
  // outer item type is unknown, so this is text rather than a notice.
  assert.equal(message.type, 'text')
  assert.equal(message.unsupported, undefined)
  assert.equal(message.quote.text, '下午三点开会')
})
