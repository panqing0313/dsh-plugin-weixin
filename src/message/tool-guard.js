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

import { translate } from '../i18n.js'

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

/**
 * 工具名 → 「我正要干什么」那句话的目录键。按动作归类，不是按工具名逐个翻译，
 * 这样二十多个别名落到十来句人话里，补一句新工具也只是加一行。
 */
export const TOOL_ACTION_KEYS = Object.freeze({
    bash: 'notice.doing.bash', shell: 'notice.doing.bash', exec: 'notice.doing.bash',
    sh: 'notice.doing.bash', run: 'notice.doing.bash', run_command: 'notice.doing.bash',
    command: 'notice.doing.bash',
    write: 'notice.doing.write', write_file: 'notice.doing.write', create_file: 'notice.doing.write',
    edit: 'notice.doing.edit', multiedit: 'notice.doing.edit',
    patch: 'notice.doing.patch', apply_patch: 'notice.doing.patch',
    delete: 'notice.doing.delete', delete_file: 'notice.doing.delete', remove: 'notice.doing.delete',
    rm: 'notice.doing.delete',
    move: 'notice.doing.move', move_file: 'notice.doing.move', rename: 'notice.doing.move',
    chmod: 'notice.doing.chmod',
    chown: 'notice.doing.chown',
    git: 'notice.doing.git',
    npm: 'notice.doing.pkg', pnpm: 'notice.doing.pkg', yarn: 'notice.doing.pkg', pip: 'notice.doing.pkg',
    curl: 'notice.doing.net', wget: 'notice.doing.net',
})

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
 * 按工具解释一句「它要干什么」，说给人听，而不是报一个工具名。
 *
 * 实测的难看之处：一条提醒长成 `🔧 要用工具了 / \`bash\`：{"command":"head -c …`——
 * 手机上一整段 JSON，读不出动作、也读不出对象。这里只做确定性的判定（不调模型），
 * 拼出一句完整的口语；拼不出来就返回空串，由调用方回落到通用说法。
 *
 * @param {{tool: string, detail: string}} call
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @returns {string}
 */
function actionLine({ tool, detail }, t) {
    const target = detail === '' ? '' : `「${detail}」`
    const key = TOOL_ACTION_KEYS[tool]
    if (key === undefined) return detail === '' ? '' : t('notice.doing.generic', { target })
    // 一个参数都没有（`write` 没带路径）就别硬凑半句话，交给通用说法。
    if (detail === '') return ''
    return t(key, { target })
}

/**
 * The message the owner gets. Deliberately says what is already true — the call
 * has started — instead of pretending to ask permission it cannot enforce.
 *
 * @param {{tool: string, detail: string, level: 'high' | 'normal'}} call
 */
export function noticeText({ tool, detail, level }, locale = 'zh') {
    const t = (key, params) => translate(key, params, locale)
    const head = t(level === 'high' ? 'notice.dangerHigh' : 'notice.dangerNormal')
    const action = actionLine({ tool, detail }, t)
    const body = t('notice.doing.sentence', {
        action: action === '' ? t('notice.doing.something') : action,
    })
    const footer = t('notice.dangerFooter')
    return [head, body, footer].join('\n')
}
