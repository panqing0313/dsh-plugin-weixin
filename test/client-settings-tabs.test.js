import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const CLIENT_PATH = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src', 'client.js')

test('the settings card is a real tablist with the two sections as tabs', () => {
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')
  const card = client.match(/function WeixinSettingsCard\(\) \{[\s\S]*?\n\t\t\t\t\t\},\n\t\t\t\t\)\);/)
  assert.ok(card, 'WeixinSettingsCard must stay findable')

  // A tablist with role=tab buttons: the structure, not just the look.
  assert.match(card[0], /role: "tablist"/)
  assert.match(card[0], /role: "tab"/)
  assert.match(card[0], /className: "weixin-settings-tabbar"/)
  // Both sections exist as tabs.
  assert.match(card[0], /id: "account"/)
  assert.match(card[0], /id: "voice"/)
  assert.match(card[0], /createElement\(LoginSection, \{ ctx, t \}\)/)
  assert.match(card[0], /createElement\(AsrSection, \{ ctx, t \}\)/)
  // Keyboard navigation: the bar must respond to arrow keys.
  assert.match(card[0], /onKeyDown: onTabKey/)
  assert.match(card[0], /ArrowRight/)
  assert.match(card[0], /ArrowLeft/)
  // Selection state is announced, not just painted.
  assert.match(card[0], /"aria-selected": index === tab/)
})

test('the ASR panels save through one explicit bar, not on every click', () => {
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')

  // chooseSource only stages; it must no longer call setDownloadSettings.
  const choose = client.match(/const chooseSource = \(id\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(choose, 'chooseSource must stay a findable handler')
  assert.match(choose[0], /setSource\(id\)/, 'a click stages the choice')
  assert.doesNotMatch(choose[0], /setDownloadSettings/, 'a click must not write')
  assert.doesNotMatch(choose[0], /savingSource/, 'staging needs no saving guard')

  // One bulk writer exists and is the only writer of the pair.
  const bulk = client.match(/const saveDownloadSettings = async \(\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(bulk, 'the staged bar must have its save handler')
  // Discard re-reads the host truth instead of guessing.
  const discard = client.match(/const discardDownloadSettings = async \(\) => \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(discard, 'the staged bar must have a reset handler')
  assert.match(discard[0], /getDownloadSettings/, 'reset must re-read, not revert to a guess')

  // The bar is rendered between the panels.
  assert.match(client, /#region pending download-settings bar/)
  assert.match(client, /onClick: saveDownloadSettings/)
  assert.match(client, /onClick: discardDownloadSettings/)
})
