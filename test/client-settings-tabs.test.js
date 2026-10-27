import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const SRC_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src')
const CLIENT_PATH = path.join(SRC_DIR, 'client.js')
const CARD_PATH = path.join(SRC_DIR, 'client.card.js')

/**
 * The card's sections live in a package-local lazy chunk now. Their bodies are
 * one indentation level deeper than they were in the entry, so the patterns
 * below end with `\n\t+` rather than a fixed number of tabs: the structure is
 * the assertion, the nesting depth is not.
 */
function readCardSource() {
  return fs.readFileSync(CARD_PATH, 'utf8')
}

test('the settings card is a real tablist with the two sections as tabs', () => {
  const client = readCardSource()
  // The card is hoisted to a named function (the settings.section slot reuses
  // the same component), so anchor on the component's own last statement.
  const card = client.match(/function WeixinSettingsCard\(\) \{[\s\S]*?\n\t\t\t\t\tsection\(TABS\[tab\]\?\.label \?\? "", TABS\[tab\]\?\.body\)\);/)
  assert.ok(card, 'WeixinSettingsCard must stay findable')

  // A tablist with role=tab buttons: the structure, not just the look.
  assert.match(card[0], /role: "tablist"/)
  assert.match(card[0], /role: "tab"/)
  assert.match(card[0], /className: "weixin-settings-tabbar"/)
  // Both sections exist as tabs.
  assert.match(card[0], /id: "account"/)
  assert.match(card[0], /id: "voice"/)
  assert.match(card[0], /id: "reminders"/, 'the reminders tab must exist beside the other tabs')
  assert.match(card[0], /createElement\\?\(RemindersSection, \{ ctx, t \}\\?\)/, 'the reminders tab must render its own section')
  assert.match(card[0], /id: "journal"/, 'the journal tab must exist beside the other tabs')
  assert.match(card[0], /createElement\(JournalSection, \{ ctx, t \}\)/, 'the journal tab must render its own section')
  assert.match(card[0], /id: "stats"/, 'the stats tab must exist beside the other tabs')
  assert.match(card[0], /createElement\(StatsSection, \{ ctx, t \}\)/, 'the stats tab must render its own section')
  assert.match(card[0], /id: "persona"/, 'the persona tab must exist beside the other tabs')
  assert.match(card[0], /createElement\(PersonaSection, \{ ctx, t \}\)/, 'the persona tab must render its own section')
  assert.match(card[0], /id: "about"/, 'the About tab must exist beside the other tabs')
  assert.match(card[0], /createElement\(LoginSection, \{ ctx, t \}\)/)
  assert.match(card[0], /createElement\(AsrSection, \{ ctx, t \}\)/)
  assert.match(card[0], /createElement\(AboutSection, \{ ctx, t \}\)/, 'the About tab must render its own section')
  // Keyboard navigation: the bar must respond to arrow keys.
  assert.match(card[0], /onKeyDown: onTabKey/)
  assert.match(card[0], /ArrowRight/)
  assert.match(card[0], /ArrowLeft/)
  // Selection state is announced, not just painted.
  assert.match(card[0], /"aria-selected": index === tab/)
})

test('the ASR panels save through one explicit bar, not on every click', () => {
  const client = readCardSource()

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

test('the card reads the language from the service DSH actually provides', () => {
  // The card used to read `ctx.locale.current.language`, which no DSH exposes:
  // the locale plugin calls `ctx.provide("locale", locale)` with an object whose
  // accessors are getSnapshot()/getLocale()/resolveText()/subscribe(). Reading a
  // shape that does not exist yields `undefined`, which the `?? "zh"` default
  // turned into Chinese -- so an English client got a Chinese card and nothing
  // failed, because "undefined" and "zh" were indistinguishable.
  //
  // Pin BOTH halves: the real accessor must be consulted, and the fallback must
  // not silently convert an unreadable language into Chinese.
  const client = fs.readFileSync(CLIENT_PATH, 'utf8')
  const hook = client.match(/function useLocaleText\(ctx\) \{[\s\S]*?\n\t\t\}/)
  assert.ok(hook, 'useLocaleText must stay findable')
  assert.match(hook[0], /ctx\.locale\?\.getSnapshot\?\.\(\)/, 'must read the real snapshot accessor')
  assert.match(hook[0], /getLocale\?\.\(\)/, 'must tolerate the older accessor name')
  // `current` is a function on some hosts and an object on others; picking up
  // the function itself would stringify it and never match a language.
  assert.match(hook[0], /typeof ctx\.locale\?\.current === "function"/)
  assert.match(hook[0], /startsWith\("zh"\)/, 'the zh test must be explicit')
})
test('the About section never passes a style object as an element type', () => {
  const client = readCardSource()
  const about = client.match(/function AboutSection\(\{ ctx, t \}\) \{[\s\S]*?\n\t\t\}/)
  assert.ok(about, 'AboutSection must stay findable')
  // The white screen: createElement(panelStyle, ...) — the STYLE OBJECT was
  // passed as the element TYPE, which throws "object is not a valid React
  // element type" the moment the tab renders, blanking the whole panel.
  // Every createElement call in the section must start with a string type or
  // a component reference, never with one of the style constants.
  const badCalls = about[0].match(/createElement\((?:panelStyle|panelTitleStyle|hintStyle|versionPill|linkStyle|captionStyle|buttonStyle)\b/g) ?? []
  assert.deepEqual(badCalls, [], 'a style object is not an element type: pass it on the style prop instead')
  assert.match(about[0], /createElement\("div", \{ style: panelStyle \}/, 'the panel rows must carry panelStyle on props')
})
