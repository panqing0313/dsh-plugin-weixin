/**
 * The plugin's display name lives in three places, and they must agree.
 *
 * The sidebar row and the Settings nav entry render `label` thunks from
 * `src/client.js`; the Plugin Manager and the settings section draw their
 * headings from `locale/<lang>.json`'s `meta.title`. Renaming the plugin in one
 * place and not the others leaves the Hub calling it "WeChat" while the sidebar
 * says "微信BOT" — this test pins the intended name in all three.
 *
 * @module dsh-weixin/test/display-name
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

test('the sidebar and settings labels both say 微信BOT', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8')
  const labels = source.match(/label: \(\) => t\([^)]*\)/g) ?? []
  assert.equal(labels.length, 2, 'sidebar.panellist and settings.section each carry a label thunk')
  for (const label of labels) {
    assert.match(label, /微信BOT/, `${label} must name the plugin 微信BOT in Chinese`)
    assert.match(label, /WeChat BOT/, `${label} must name the plugin WeChat BOT in English`)
  }
  assert.doesNotMatch(source, /t\("WeChat", "微信"\)/, 'the old name is gone')
})

test('the hub metadata says the same name in both locales', () => {
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  assert.equal(en.meta.title, 'WeChat BOT')
  assert.equal(zh.meta.title, '微信BOT')
  for (const locale of [en, zh]) {
    assert.equal(typeof locale.meta.description, 'string')
    assert.ok(locale.meta.description.length > 20, 'the description says what the plugin does')
  }
})

test('the locale files ship with the package', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.ok(pkg.files.includes('locale'), '`files` must carry locale/ or npm drops it')
})
