/**
 * Dangerous-tool notices (C15).
 *
 * The plugin cannot veto a tool call: DSH exposes no approval hook to plugins
 * (`@deepseek-ai/dsh-user-approval` is an app-level package, and dsh-agent has
 * no permission surface), so "approve this in WeChat before it runs" is not
 * something this code can honestly offer.
 *
 * What it can do is fail loudly in the right place: the moment a turn calls a
 * tool that writes, deletes or runs a command, the owner gets a message saying
 * what is about to happen. `/cancel` already aborts a turn mid-flight, so that
 * message is an *interrupt* rather than an approval — the step in flight may
 * already have run, but nothing after it will.
 */

/** Tools that can touch the machine. Matched case-insensitively, namespace stripped. */
export const DANGEROUS_TOOLS = new Set([
    'bash', 'shell', 'exec', 'sh', 'run', 'run_command', 'command',
    'write', 'write_file', 'create_file', 'edit', 'multiedit', 'apply_patch', 'patch',
    'delete', 'delete_file', 'remove', 'rm', 'move', 'move_file', 'rename', 'chmod', 'chown',
    'git', 'npm', 'pnpm', 'yarn', 'pip', 'curl', 'wget',
])

/** Words inside a command that make it worth shouting about. */
const ALARMING = /(\brm\s+-[a-z]*[rf]|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bcurl\b[^|]*\|\s*(bash|sh)\b|\bchmod\s+777\b|--force\b|\bgit\s+push\b|>\s*\/etc\/|:\s*\(\s*\)\s*\{)/i

/** How much of an argument to quote back. Long enough to recognise, short enough for a phone. */
export const NOTICE_ARG_CHARS = 240

/** `ns/tool` and `Tool` all collapse to one key. */
function toolKey(tool) {
    const raw = String(tool ?? '').trim().toLowerCase()
    if (raw === '') return ''
    const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
    return tail.trim()
}

/** Pull the part of the arguments a person would want to see. */
function argumentText(args) {
    if (args === undefined || args === null) return ''
    if (typeof args === 'string') return args
    if (typeof args !== 'object') return String(args)
    for (const key of ['command', 'cmd', 'script', 'file_path', 'filePath', 'path', 'target', 'query', 'url']) {
        const value = args[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    try {
        return JSON.stringify(args)
    } catch {
        return ''
    }
}

function clip(text, maxChars) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

/**
 * Decide whether one tool call deserves the owner's attention.
 *
 * @param {{tool?: string, args?: unknown}} call
 * @returns {{dangerous: boolean, tool: string, detail: string, level: 'high' | 'normal'}}
 */
export function classifyToolCall({ tool, args } = {}) {
    const key = toolKey(tool)
    if (key === '' || DANGEROUS_TOOLS.has(key) === false) {
        return { dangerous: false, tool: key, detail: '', level: 'normal' }
    }
    const detail = clip(argumentText(args), NOTICE_ARG_CHARS)
    return { dangerous: true, tool: key, detail, level: ALARMING.test(detail) ? 'high' : 'normal' }
}

/**
 * The message the owner gets. Deliberately says what is already true — the call
 * has started — instead of pretending to ask permission it cannot enforce.
 *
 * @param {{tool: string, detail: string, level: 'high' | 'normal'}} call
 */
export function noticeText({ tool, detail, level }) {
    const head = level === 'high' ? '⚠️ 这一步看着有风险' : '🔧 要用工具了'
    const lines = [head, `\`${tool}\`${detail === '' ? '' : `：${detail}`}`, '要停就发 /cancel —— 正在跑的这一步可能已经执行，但后面的步骤不会再继续。']
    return lines.join('\n')
}
