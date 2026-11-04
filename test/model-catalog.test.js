// The provider catalogue the card's dropdowns are built from.
//
// Why this file exists at all: the card used to ask people to type a provider
// and a model as free text, and the wrong value only shows up as every turn
// failing with `no configured model`. The host already knows the list. These
// tests pin the subset of YAML we read, and — more importantly — pin that a
// shape we do not read is reported as `partial` rather than silently dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MAX_CATALOG_MODELS, parseSettingsProviders, readModelCatalog, scalarOf, settingsFile } from '../src/model-catalog.js'

const SETTINGS = `llm-pi-ai:
  providers:
    magpie:
      displayName: Magpie
      api: openai-completions
      baseURL: http://127.0.0.1:3425/v1
      models:
        - id: auto/deepseek-v4.1-flash
          name: DeepSeek V4.1 Flash · routing group
          contextWindow: 1048576
          maxTokens: 128000
          input: [text, image]
        - id: "auto/glm-5.3-flash"
          name: 'GLM-5.3-Flash'
          contextWindow: 200000
      streamIdleTimeoutMs: 600000
    magpie-anthropic:
      api: anthropic-messages
      models:
        - id: kiro/claude-sonnet-4.5
          name: claude-sonnet-4.5 · Kiro
other-section:
  providers:
    not-ours:
      models:
        - id: nope
`

test('the catalogue comes out with ids, labels and windows intact', () => {
  const { providers, partial } = parseSettingsProviders(SETTINGS)
  assert.equal(partial, false)
  assert.deepEqual(providers.map((provider) => provider.id), ['magpie', 'magpie-anthropic'])
  assert.equal(providers[0].api, 'openai-completions')
  assert.equal(providers[0].baseUrl, 'http://127.0.0.1:3425/v1')
  assert.deepEqual(providers[0].models[0], {
    id: 'auto/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash · routing group',
    contextWindow: 1048576,
  })
  // Quoted scalars lose their quotes, single quotes are unescaped.
  assert.equal(providers[0].models[1].id, 'auto/glm-5.3-flash')
  assert.equal(providers[0].models[1].name, 'GLM-5.3-Flash')
  // A sibling key at the provider's depth (`streamIdleTimeoutMs`) is not a model.
  assert.equal(providers[0].models.length, 2)
  assert.equal(providers[1].models[0].name, 'claude-sonnet-4.5 · Kiro')
})

test('a second `providers:` block elsewhere in the file is not ours', () => {
  const { providers } = parseSettingsProviders(SETTINGS)
  assert.ok(providers.every((provider) => provider.id !== 'not-ours'))
})

test('a file with no providers section is empty, not an error', () => {
  assert.deepEqual(parseSettingsProviders('llm:\n  apiKey: x\n'), { providers: [], partial: false })
  assert.deepEqual(parseSettingsProviders(''), { providers: [], partial: false })
})

test('a list item we do not understand is reported as partial', () => {
  const text = `llm-pi-ai:
  providers:
    odd:
      models:
        - { id: inline, name: inline }
`
  const { providers, partial } = parseSettingsProviders(text)
  assert.equal(partial, true)
  assert.deepEqual(providers[0].models, [])
})

test('scalars: quotes, comments, plain text', () => {
  assert.equal(scalarOf('openai-completions'), 'openai-completions')
  assert.equal(scalarOf('"a \\"quoted\\" thing"'), 'a "quoted" thing')
  assert.equal(scalarOf("'it''s'"), "it's")
  assert.equal(scalarOf('value # trailing comment'), 'value')
  assert.equal(scalarOf(''), '')
})

test('reading a missing settings file yields an empty catalogue, not a throw', () => {
  const warnings = []
  const catalog = readModelCatalog({ file: path.join(os.tmpdir(), 'definitely-not-here', 'settings.yaml'), warn: (line) => warnings.push(line) })
  assert.deepEqual(catalog.providers, [])
  assert.deepEqual(catalog.models, [])
  assert.equal(catalog.partial, false)
  assert.deepEqual(warnings, [], 'a machine that never ran the host is not worth a warning')
})

test('reading a real file flattens the catalogue with its provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-catalog-'))
  const file = path.join(root, 'settings.yaml')
  fs.writeFileSync(file, SETTINGS)
  const catalog = readModelCatalog({ file })
  assert.equal(catalog.models.length, 3)
  assert.deepEqual(catalog.models[0], {
    provider: 'magpie',
    id: 'auto/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash · routing group',
    contextWindow: 1048576,
  })
  assert.equal(catalog.models.at(-1).provider, 'magpie-anthropic')
})

test('the catalogue is capped so one huge settings file cannot flood the card', () => {
  const rows = Array.from({ length: MAX_CATALOG_MODELS + 5 }, (_, i) => `        - id: m${i}\n          name: M${i}`).join('\n')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-catalog-cap-'))
  const file = path.join(root, 'settings.yaml')
  fs.writeFileSync(file, `llm-pi-ai:\n  providers:\n    big:\n      models:\n${rows}\n`)
  const catalog = readModelCatalog({ file })
  assert.equal(catalog.models.length, MAX_CATALOG_MODELS)
})

test('the default location is the host settings file', () => {
  assert.equal(settingsFile('/home/someone'), path.join('/home/someone', '.dsh', 'settings.yaml'))
})