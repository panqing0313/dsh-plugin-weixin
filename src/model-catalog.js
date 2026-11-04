/**
 * What models the host这台机器 actually has.
 *
 * The card used to ask the operator to type a provider and a model into two
 * free-text boxes. The values people type there are almost never wrong in an
 * obvious way — `magpie` instead of `magpie-responses`, a model id missing its
 * group prefix — and the only symptom is every turn failing with
 * `no configured model`. The host already knows the answer; it keeps the
 * catalogue in `~/.dsh/settings.yaml` under `llm-pi-ai.providers`.
 *
 * We read that file rather than resolving the host's own service because the
 * catalogue is a *configuration* fact: it is the same list the settings UI
 * shows, it needs no agent to exist, and it can be read from a card that is
 * mounted before any conversation starts.
 *
 * ## Why a hand-written reader
 *
 * `settings.yaml` is YAML, and this package ships three dependencies. Pulling in
 * a parser to read four keys would be the largest thing in the tarball. The
 * subset we need is tiny and unambiguous:
 *
 *     llm-pi-ai:
 *       providers:
 *         <provider>:
 *           models:
 *             - id: <id>          # may be quoted
 *               name: <label>
 *               contextWindow: 123
 *
 * So the reader tracks **indentation levels** rather than parsing YAML: a
 * provider is a key at the `providers` children's indent, a model is an
 * `- id:` line at the `models` children's indent. Anything else is ignored.
 * When the file switches to flow style, block scalars, or anchors this returns
 * whatever it could read and says so via `partial` — never a wrong answer
 * presented as a complete one.
 *
 * @module dsh-weixin/model-catalog
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SETTINGS_FILE_NAME = 'settings.yaml'
/** How many providers the card can show before it needs a warning about size. */
export const MAX_CATALOG_MODELS = 400

/** Where the host keeps its settings; overridable for tests and odd installs. */
export function settingsFile(home = os.homedir()) {
  return path.join(home, '.dsh', SETTINGS_FILE_NAME)
}

function indentOf(line) {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].length
}

/** YAML scalar → string, for the shapes that show up in this file. */
export function scalarOf(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const inner = text.slice(1, -1)
    return text.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
  }
  // strip a trailing " # comment"
  const hash = text.search(/\s#/)
  return (hash === -1 ? text : text.slice(0, hash)).trim()
}

/**
 * Pull the provider catalogue out of a settings.yaml body.
 *
 * @param {string} text
 * @returns {{ providers: Array<{ id: string, api?: string, baseUrl?: string, models: Array<{ id: string, name: string, contextWindow?: number }> }>, partial: boolean }}
 */
export function parseSettingsProviders(text) {
  const lines = String(text ?? '').split('\n')
  const providers = []
  let partial = false

  // Find `providers:` under `llm-pi-ai:` — the host has one settings file and
  // exactly one such block, but reading the indent keeps us honest if it moves.
  let providersIndent = -1
  let providersLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*providers:\s*(#.*)?$/.test(lines[i])) {
      providersIndent = indentOf(lines[i])
      providersLine = i
      break
    }
  }
  if (providersIndent === -1) return { providers, partial }

  let current = undefined
  let providerIndent = -1
  let modelIndent = -1
  let modelListIndent = -1
  let currentModel = undefined

  // Start *below* the `providers:` line: it is itself shallower than its
  // children, so a loop that begins at line 0 breaks out before it ever looks.
  for (let i = providersLine + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const indent = indentOf(raw)
    if (indent <= providersIndent) break // left the providers block

    const field = /^\s*([A-Za-z0-9][\w.-]*):\s*(.+)$/.exec(raw)

    // Inside the model list, before any `- id:` line: `- id:` opens a model and
    // every deeper key (`name:`, `contextWindow:`) describes it. Keep that check
    // ABOVE the provider-vs-model gate: the gate's answer for a model's own
    // `name:` line is "this is a provider field", which reads the id again and
    // throws the label away.
    if (/^\s*-\s+/.test(raw)) {
      const itemMatch = /^\s*-\s+id:\s*(.+)$/.exec(raw)
      if (itemMatch === null) {
        // A list item that does not start with `id:` means the file uses a shape
        // we do not read. Say so instead of silently reporting fewer models.
        partial = true
        currentModel = undefined
        continue
      }
      currentModel = { id: scalarOf(itemMatch[1]), name: '' }
      if (currentModel.id !== '') current.models?.push(currentModel)
      else currentModel = undefined
      continue
    }

    if (currentModel !== undefined && indent > (modelIndent === -1 ? -1 : modelIndent)) {
      const inner = field
      if (inner !== null) {
        if (inner[1] === 'name') currentModel.name = scalarOf(inner[2])
        if (inner[1] === 'contextWindow') {
          const size = Number(scalarOf(inner[2]))
          if (Number.isFinite(size) && size > 0) currentModel.contextWindow = size
        }
      }
      continue
    }

    // A provider key is a bare mapping key one level in. Which level that is
    // depends on the file, so the first such key fixes it for the rest — every
    // provider in a `providers:` block sits at the same depth.
    const providerMatch = /^\s*([A-Za-z0-9][\w.-]*):\s*(#.*)?$/.exec(raw)
    if (providerMatch !== null && (providerIndent === -1 || indent === providerIndent)) {
      if (providerIndent === -1) providerIndent = indent
      current = { id: providerMatch[1], models: [] }
      providers.push(current)
      modelIndent = -1
      modelListIndent = -1
      currentModel = undefined
      continue
    }

    if (/^\s*models:\s*(#.*)?$/.test(raw)) {
      modelIndent = indent
      modelListIndent = indent
      currentModel = undefined
      continue
    }

    if (current === undefined) continue

    // Provider-level plain scalars (api, baseURL, …) live shallower than `models`,
    // and so does the indented block that opens `models:`.
    if (indent !== modelIndent + 2 || modelListIndent === -1) {
      const field = /^\s*([A-Za-z0-9][\w.-]*):\s*(.+)$/.exec(raw)
      if (field !== null) {
        const value = scalarOf(field[2])
        if (field[1] === 'api') current.api = value
        if (field[1] === 'baseURL' || field[1] === 'baseUrl') current.baseUrl = value
        if (modelListIndent === -1 && field[1] === 'models') modelListIndent = indent
        if (value.startsWith('|') || value.startsWith('>')) partial = true
      }
      continue
    }
  }

  for (const provider of providers) {
    for (const model of provider.models) if (model.name === '') model.name = model.id
  }
  return { providers, partial }
}

/**
 * Read the catalogue off disk.
 *
 * A missing file is not an error worth showing at startup — a machine where the
 * host has never run has no catalogue, and the card simply keeps its text boxes.
 *
 * @param {{ file?: string, warn?: (line: string) => void }} [options]
 */
export function readModelCatalog({ file = settingsFile(), warn } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn?.(`could not read ${file}: ${error?.message ?? error}`)
    return { file, providers: [], models: [], partial: false }
  }
  const { providers, partial } = parseSettingsProviders(text)
  const models = []
  for (const provider of providers) {
    for (const model of provider.models) {
      models.push({ provider: provider.id, id: model.id, name: model.name, contextWindow: model.contextWindow })
      if (models.length >= MAX_CATALOG_MODELS) break
    }
    if (models.length >= MAX_CATALOG_MODELS) break
  }
  return { file, providers, models, partial }
}