import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens } from '../src/tokens.js'

test('a Chinese character costs about a token, English about a quarter', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens('hello'), 2, 'five latin characters round up to two tokens')
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.ok(estimateTokens('这是一句中文') > estimateTokens('a b c d e'))
})

test('mixed text adds the two halves instead of measuring one alphabet', () => {
  const mixed = estimateTokens('好的 ok')
  assert.equal(mixed, 2 + Math.ceil(3 / 4), 'CJK counted per character, latin per four characters')
})

test('the estimate ignores shapes that are not text', () => {
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(''), 0)
})
