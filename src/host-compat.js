/**
 * What this plugin was built against, and whether the host it is running in still
 * matches.
 *
 * The plugin lives inside a desktop app whose internals are not a stable API: the
 * slot names, the client bundle loader (`__ModuleLoader__`), the `dsh.client` block
 * and the two `@deepseek-ai` packages it imports lazily all come from the app, not
 * from npm. When the app moves, this plugin can break in ways no test on this
 * machine would catch, so it says what it knows instead of pretending otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Host releases this tree has actually been run against. Update when verified.
 *
 * Order is oldest-first; the settings card and `doctor` print the newest one
 * last, so a host that is one release behind reads as "we tested past it".
 */
export const TESTED_HOSTS = Object.freeze(['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'])

/** Where the desktop app records its version on macOS. */
export const DEFAULT_INFO_PLIST = '/Applications/DeepSeek Harness.app/Contents/Info.plist'

/**
 * Read the host version without launching it.
 *
 * Order matters: an explicit override wins (tests and non-macOS installs), then the
 * macOS app bundle. `undefined` means "cannot tell", which is different from
 * "unsupported" and is reported as such.
 *
 * @param {{ env?: object, plistPath?: string }} [options]
 * @returns {string | undefined}
 */
export function detectHostVersion(options = {}) {
  const env = options.env ?? process.env
  const override = env.DSH_HOST_VERSION
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const plistPath = options.plistPath ?? DEFAULT_INFO_PLIST
  try {
    const plist = fs.readFileSync(plistPath, 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match === null ? undefined : match[1].trim()
  } catch {
    return undefined
  }
}

/**
 * Compare the host against the tested list.
 *
 * @param {string | undefined} version
 * @returns {{ status: 'tested' | 'untested' | 'unknown', version?: string, tested: readonly string[] }}
 */
export function hostStatus(version) {
  // A bare word is what a caller says when it could not tell; a version has a
  // digit in it. Without this, `describeHost('unknown')` (the onboarding
  // screen's own wording) would be reported as an untested host called
  // "unknown", which reads like a version number we failed to recognise.
  if (typeof version !== 'string' || version.trim() === '' || !/\d/.test(version)) {
    return { status: 'unknown', tested: TESTED_HOSTS }
  }
  const wanted = version.trim()
  return { status: TESTED_HOSTS.includes(wanted) ? 'tested' : 'untested', version: wanted, tested: TESTED_HOSTS }
}

/** True when the two versions differ only by a `-rc.N`/`-beta.N` style suffix. */
export function isPreRelease(version) {
  return typeof version === 'string' && /-/.test(version)
}

/**
 * One line a human can act on.
 *
 * `version` may be the value from {@link detectHostVersion} — which is
 * `undefined` when the plist cannot be read — or a word like `unknown` from a
 * caller that could not tell. Both must come out as "unknown", and neither may
 * print a raw `undefined` at the user. Anything else is compared verbatim.
 */
export function describeHost(version) {
  const status = hostStatus(version)
  if (status.status === 'unknown') return `host version unknown; this plugin was tested against ${TESTED_HOSTS.join(', ')}`
  if (status.status === 'tested') return `host ${status.version} (tested)`
  return `host ${status.version} is not in the tested list (${TESTED_HOSTS.join(', ')}); if something looks broken, this is the first thing to check`
}

/**
 * Render the compatibility table for the docs, so the page cannot drift.
 *
 * @param {string} pluginVersion  Plugin version the whole table is about.
 * @param {Record<string, string>} [notes]  Host version → what was verified.
 *   Hosts not named here get the generic line, so a new entry cannot silently
 *   claim coverage it does not have.
 */
export function compatibilityMarkdown(pluginVersion, notes = {}) {
  const rows = TESTED_HOSTS.map((host) => {
    const detail = notes[host] ?? '真机验证过：登录、收发、设置卡、侧边栏入口'
    return `| \`${pluginVersion}\` | \`${host}\` | ${detail} |`
  })
  return [
    '| 插件版本 | 宿主版本 | 验证到什么程度 |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}

/** Absolute path of the app bundle's plist, for callers that want to print it. */
export function infoPlistPath(appPath = '/Applications/DeepSeek Harness.app') {
  return path.join(appPath, 'Contents', 'Info.plist')
}
