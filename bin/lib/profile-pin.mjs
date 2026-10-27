/**
 * Pin a DSH profile's plugin dependency to a published version.
 *
 * Why this exists as a shared module (C35): a `bin/install.mjs` copy lives in
 * `profile/node_modules/dsh-plugin-weixin` and is **replaced by the profile's own
 * `pnpm install` on the next app start**, because the profile's package.json
 * still declares the previously published range. Every manual install therefore
 * survived exactly until the next restart — that is how a shipped sidebar panel
 * appeared to vanish. The durable fix is not copying harder: it is pointing the
 * profile's dependency at the version being installed and refreshing the lock.
 *
 * `bin/release.mjs` needs the same logic, so it lives here rather than twice.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const PKG_NAME = 'dsh-plugin-weixin'

/** The pnpm the app itself uses, so the lockfile matches what the app resolves. */
export const BUNDLED_PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'

/**
 * Rewrite `"dsh-plugin-weixin": "^x.y.z"` to `"^nextVersion"`, textually.
 *
 * Textual on purpose: a JSON round-trip would reformat the operator's whole
 * package.json (key order, indentation), and that diff is noise in a file this
 * plugin does not own. A non-caret spec (a `file:` tarball, a workspace link)
 * is left alone and reported, because guessing what the operator meant is worse
 * than telling them.
 *
 * @param {string} raw package.json text
 * @param {string} nextVersion version to point at
 * @returns {{from: string, to: string, text: string} | null} null when nothing to do
 */
export function pinProfileSpec(raw, nextVersion) {
    let pkg
    try {
        pkg = JSON.parse(raw)
    } catch {
        return null
    }
    const declared = pkg?.dependencies?.[PKG_NAME]
    if (typeof declared !== 'string' || !declared.startsWith('^')) return null
    const wanted = `^${nextVersion}`
    if (declared === wanted) return null
    const pattern = new RegExp(`("${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*)"\\^[^"]*"`)
    if (!pattern.test(raw)) return null
    return { from: declared, to: wanted, text: raw.replace(pattern, `$1"${wanted}"`) }
}

/**
 * Pin a profile and refresh its lockfile.
 *
 * @param {object} options
 * @param {string} options.profile profile name (`desktop` by default in DSH)
 * @param {string} options.version version to pin
 * @param {(line: string) => void} [options.ok]
 * @param {(line: string) => void} [options.warn]
 * @param {(line: string) => void} [options.note]
 * @param {string} [options.dshHome] override for tests
 * @param {typeof spawnSync} [options.spawn] override for tests
 * @param {string} [options.nodePath] node binary used to run the bundled pnpm
 * @returns {{pinned: boolean, reason?: string}}
 */
export function pinProfileDependency({
    profile,
    version,
    ok = () => {},
    warn = () => {},
    note = () => {},
    dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    spawn = spawnSync,
    nodePath = process.execPath,
} = {}) {
    const pkgPath = path.join(dshHome, 'profiles', profile, 'package.json')
    if (!fs.existsSync(pkgPath)) {
        warn(`no ${pkgPath} — the profile cannot be pinned, only copied`)
        return { pinned: false, reason: 'no-profile-package' }
    }
    const patch = pinProfileSpec(fs.readFileSync(pkgPath, 'utf8'), version)
    if (patch === null) {
        ok('profile dependency already points at this version (or is pinned by hand)')
        return { pinned: false, reason: 'already-pinned' }
    }
    fs.writeFileSync(pkgPath, patch.text)
    ok(`profile dependency ${patch.from} → ${patch.to}`)
    const args = ['install', '--prefer-offline']
    const cwd = path.dirname(pkgPath)
    const refreshed = fs.existsSync(BUNDLED_PNPM)
        ? spawn(nodePath, [BUNDLED_PNPM, ...args], { cwd, encoding: 'utf8' })
        : spawn('pnpm', args, { cwd, encoding: 'utf8' })
    if (refreshed.status !== 0) {
        warn('could not refresh the profile lockfile — run pnpm install in the profile by hand')
        note(String(refreshed.stderr ?? '').trim().split('\n').slice(-2).join('\n'))
        return { pinned: true, reason: 'lock-not-refreshed' }
    }
    ok('profile lockfile refreshed — the app will not roll back on restart')
    return { pinned: true }
}
