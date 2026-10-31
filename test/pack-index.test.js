import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_INDEX_ENTRIES, fetchPackJson, normalizePackIndex } from '../src/message/pack-index.js'

test('the index is normalized: https only, capped, and it says why entries were skipped', () => {
    const warnings = []
    const { packs } = normalizePackIndex(JSON.stringify({
        packs: [
            { name: '温柔女友', url: 'https://example.com/gf.json', description: 'd' },
            { name: 'no-url' },
            { name: 'http', url: 'http://example.com/x.json' },
            { url: 'https://example.com/nn.json' },
            { name: 'ok2', url: 'https://example.com/ok2.json', version: 2 },
        ],
    }), { warn: (line) => warnings.push(line) })
    assert.deepEqual(packs.map((pack) => pack.name), ['温柔女友', 'ok2'])
    assert.equal(packs[1].version, 2)
    assert.equal(packs[0].description, 'd')
    assert.equal(warnings.length, 3, 'each skipped entry explains itself')
    assert.deepEqual(normalizePackIndex('not json').packs, [])
    assert.deepEqual(normalizePackIndex(JSON.stringify({ nope: 1 })).packs, [])
})

test('the index caps at fifty entries', () => {
    const packs = Array.from({ length: MAX_INDEX_ENTRIES + 10 }, (_, i) => ({ name: `p${i}`, url: `https://example.com/${i}.json` }))
    const { packs: normalized } = normalizePackIndex(JSON.stringify({ packs }))
    assert.equal(normalized.length, MAX_INDEX_ENTRIES)
})

test('fetchPackJson enforces https and a size ceiling', async () => {
    await assert.rejects(() => fetchPackJson('http://example.com/p.json'), /https/)
    const big = 'x'.repeat(300 * 1024)
    await assert.rejects(
        () => fetchPackJson('https://example.com/p.json', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => big }) }),
        /256KB/,
    )
    const text = await fetchPackJson('https://example.com/p.json', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"packs":[]}' }) })
    assert.equal(text, '{"packs":[]}')
    await assert.rejects(
        () => fetchPackJson('https://example.com/p.json', { fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) }),
        /404/,
    )
})
