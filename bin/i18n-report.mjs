#!/usr/bin/env node
/**
 * How much of the chat-facing text is still not in the catalogue (C33).
 *
 * Deliberately a report, not a gate: the catalogue covers command help and the
 * notices the bot sends on its own, and the rest of the strings live inside
 * large functions where a key would be more indirection than it is worth. The
 * number is here so the debt is visible and shrinking, and so nobody has to
 * guess how much is left.
 *
 * `--fail-over <n>` turns it into a gate once a team decides the number.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = ['src', 'bin']
const CJK = /[\u4e00-\u9fff]/
/** Lines that are allowed to hold Chinese without being catalogue material. */
const EXEMPT = [
    /^\s*(\/\*\*|\*|\/\/)/, // comments document the code in the team's language
    /^\s*`/, // template literal continuation of a comment-ish block
    /^\s*import /,
]

const thresholdArg = process.argv.find((entry) => entry.startsWith('--fail-over'))
const failOver = thresholdArg === undefined ? undefined : Number(thresholdArg.split('=')[1] ?? process.argv[process.argv.indexOf(thresholdArg) + 1])

/** Every .js file under the source directories. */
function walk(dir) {
    const found = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stats = statSync(full)
        if (stats.isDirectory()) {
            if (entry === 'node_modules' || entry === 'vendor' || entry.startsWith('.')) continue
            found.push(...walk(full))
        } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
            found.push(full)
        }
    }
    return found
}

const rows = []
for (const sourceDir of SOURCES) {
    for (const file of walk(join(ROOT, sourceDir))) {
        const lines = readFileSync(file, 'utf8').split('\n')
        let count = 0
        for (const line of lines) {
            if (CJK.test(line) === false) continue
            if (EXEMPT.some((pattern) => pattern.test(line))) continue
            count += 1
        }
        if (count > 0) rows.push({ file: relative(ROOT, file), lines: count })
    }
}

rows.sort((left, right) => right.lines - left.lines)
const total = rows.reduce((sum, row) => sum + row.lines, 0)
console.log(`chat-facing lines still outside the catalogue: ${total}`)
for (const row of rows.slice(0, 15)) console.log(`  ${String(row.lines).padStart(4)}  ${row.file}`)
console.log('\ncatalogue: src/i18n.js (help.* for command help, notice.* for what the bot says on its own)')
if (failOver !== undefined && Number.isFinite(failOver) && total > failOver) {
    console.error(`✗ ${total} > ${failOver} (--fail-over)`)
    process.exit(1)
}
