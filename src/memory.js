/**
 * Conversation memory: what the bot should keep knowing across turns.
 *
 * Two scopes, both files under <stateRoot>/memory/:
 *   global — per ACCOUNT (the user is the same person in every chat):
 *            global-<account>.json, a capped list of one-line facts the user
 *            fixed with /remember ("我对花生过敏").
 *   conv   — per CONVERSATION: conv-<account>-<conv>.json, a rolling summary
 *            (P2 keeps it fresh) plus a recent-message window folded in from
 *            the journal at build time, so the persona has context a fresh
 *            session line no longer carries.
 *
 * Injection happens at the same seam as sourceContext, right before the user
 * text. Everything here degrades to "no block" — memory must never break a
 * reply, which is why every reader catches and every writer warns instead of
 * throwing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJournal } from './message/journal.js';

export const DEFAULT_MEMORY_GLOBAL_MAX_FACTS = 30;
export const DEFAULT_MEMORY_GLOBAL_MAX_CHARS = 1500;
export const DEFAULT_MEMORY_CONV_MAX_CHARS = 1200;
export const DEFAULT_MEMORY_RECENT_TURNS = 5;
export const DEFAULT_MEMORY_RECENT_TEXT_CHARS = 160;
const MEMORY_DIR = 'memory';

const noopWarn = () => {};

/** Filenames come from server ids (@im.bot, @im.wechat); keep them tame. */
function safeName(raw) {
    const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9@._-]/g, '_');
    return cleaned.slice(0, 120) || 'unknown';
}

function globalMemoryPath(stateRoot, accountId) {
    return path.join(stateRoot, MEMORY_DIR, `global-${safeName(accountId)}.json`);
}

function convMemoryPath(stateRoot, accountId, conversationId) {
    return path.join(stateRoot, MEMORY_DIR, `conv-${safeName(accountId)}-${safeName(conversationId)}.json`);
}

function readJsonSafe(file, fallback, warn, label) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ? fallback : parsed;
    } catch (error) {
        if (error?.code !== 'ENOENT') warn(`${label} read failed: ${String(error)}`);
        return fallback;
    }
}

function writeJsonSafe(file, value, warn, label) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
        return true;
    } catch (error) {
        warn(`${label} write failed: ${String(error)}`);
        return false;
    }
}

function sanitizeFacts(raw) {
    if (Array.isArray(raw) !== true) return [];
    const facts = [];
    for (const entry of raw) {
        const text = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' ? entry.text : undefined);
        if (typeof text !== 'string' || text.trim() === '') continue;
        const at = entry !== null && typeof entry === 'object' && typeof entry.at === 'number' ? entry.at : 0;
        facts.push({ text: text.trim(), at });
    }
    return facts;
}

/** The account-level fact list: [{text, at}], oldest first. */
export function readGlobalMemory(stateRoot, accountId, { warn = noopWarn } = {}) {
    const parsed = readJsonSafe(globalMemoryPath(stateRoot, accountId), {}, warn, 'global memory');
    return { facts: sanitizeFacts(parsed.facts) };
}

/**
 * Store one fact. Returns { added: true } or { added: false, reason } where
 * reason is 'duplicate' (same text, ignoring case/whitespace) or 'cap' — a
 * full memory REFUSES instead of silently forgetting the oldest fact, because
 * the user treats these as reliable ("别给我的过敏原挤掉").
 */
export function addGlobalFact(stateRoot, accountId, text, {
    warn = noopWarn,
    now = Date.now(),
    maxFacts = DEFAULT_MEMORY_GLOBAL_MAX_FACTS,
    maxChars = DEFAULT_MEMORY_GLOBAL_MAX_CHARS,
} = {}) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return { added: false, reason: 'empty' };
    const memory = readGlobalMemory(stateRoot, accountId, { warn });
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (memory.facts.some((fact) => fact.text.toLowerCase().replace(/\s+/g, ' ') === key)) {
        return { added: false, reason: 'duplicate' };
    }
    if (memory.facts.length >= maxFacts) return { added: false, reason: 'cap' };
    if (memory.facts.reduce((sum, fact) => sum + fact.text.length, 0) + trimmed.length > maxChars) {
        return { added: false, reason: 'cap' };
    }
    memory.facts.push({ text: trimmed, at: now });
    return writeJsonSafe(globalMemoryPath(stateRoot, accountId), memory, warn, 'global memory')
        ? { added: true }
        : { added: false, reason: 'write-failed' };
}

/** Remove by 1-based index (the numbering /forget and /memory show). */
export function removeGlobalFact(stateRoot, accountId, index, { warn = noopWarn } = {}) {
    const memory = readGlobalMemory(stateRoot, accountId, { warn });
    const position = Number(index);
    if (Number.isInteger(position) === false || position < 1 || position > memory.facts.length) {
        return { removed: false, reason: 'no-such-index' };
    }
    const [fact] = memory.facts.splice(position - 1, 1);
    return writeJsonSafe(globalMemoryPath(stateRoot, accountId), memory, warn, 'global memory')
        ? { removed: true, text: fact.text }
        : { removed: false, reason: 'write-failed' };
}

/** The conversation-level store: rolling summary + durable per-chat facts. */
export function readConvMemory(stateRoot, accountId, conversationId, { warn = noopWarn } = {}) {
    const parsed = readJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), {}, warn, 'conversation memory');
    return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        facts: sanitizeFacts(parsed.facts),
        updatedTurn: typeof parsed.updatedTurn === 'number' ? parsed.updatedTurn : 0,
    };
}

/** Used by the P2 summarizer; truncated so one bad run cannot bloat the block. */
export function setConvSummary(stateRoot, accountId, conversationId, summary, {
    warn = noopWarn,
    maxChars = DEFAULT_MEMORY_CONV_MAX_CHARS,
} = {}) {
    const text = String(summary ?? '').trim().slice(0, maxChars);
    const memory = readConvMemory(stateRoot, accountId, conversationId, { warn });
    memory.summary = text;
    // The card lists memories by the id INSIDE the file (the safeName'd
    // filename is lossy), so every write stamps it.
    memory.conversationId = conversationId;
    return writeJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), memory, warn, 'conversation memory');
}

export function setConvTurn(stateRoot, accountId, conversationId, turn, { warn = noopWarn } = {}) {
    const memory = readConvMemory(stateRoot, accountId, conversationId, { warn });
    memory.updatedTurn = Number.isFinite(turn) ? Math.floor(turn) : memory.updatedTurn;
    memory.conversationId = conversationId;
    return writeJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), memory, warn, 'conversation memory');
}

export function clearConvMemory(stateRoot, accountId, conversationId, { warn = noopWarn } = {}) {
    return writeJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), { summary: '', facts: [], updatedTurn: 0 }, warn, 'conversation memory');
}

/**
 * Every stored conversation memory for one account, for the settings card.
 * The authoritative conversationId is the one INSIDE the file (safeName in
 * the filename is lossy); files predating the field surface with a null id
 * and the card just hides their clear button.
 */
export function listConvMemories(stateRoot, accountId, { warn = noopWarn } = {}) {
    const dir = path.join(stateRoot, MEMORY_DIR);
    let files = [];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const prefix = `conv-${safeName(accountId)}-`;
    const entries = [];
    for (const file of files) {
        if (file.startsWith(`${prefix}`) === false || file.endsWith('.json') === false) continue;
        const parsed = readJsonSafe(path.join(dir, file), {}, warn, 'conversation memory');
        const hasAny = (typeof parsed.summary === 'string' && parsed.summary.trim() !== '')
            || sanitizeFacts(parsed.facts).length > 0;
        if (hasAny === false) continue;
        entries.push({
            conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            updatedTurn: typeof parsed.updatedTurn === 'number' ? parsed.updatedTurn : 0,
            factCount: sanitizeFacts(parsed.facts).length,
        });
    }
    return entries;
}

/**
 * The recent-message window, folded in from the journal at build time (not
 * stored): the last `turns` in/out pairs, texts clamped so a pasted log
 * cannot eat the whole block.
 */
export function readRecentWindow(stateRoot, accountId, conversationId, {
    warn = noopWarn,
    turns = DEFAULT_MEMORY_RECENT_TURNS,
    textChars = DEFAULT_MEMORY_RECENT_TEXT_CHARS,
} = {}) {
    const wanted = Math.max(1, Math.floor(turns)) * 2;
    const entries = readJournal(stateRoot, { limit: wanted + 20, accountId, conversationId })
        .filter((entry) => typeof entry.text === 'string' && entry.text.trim() !== '')
        .slice(0, wanted);
    return entries.reverse().map((entry) => ({
        dir: entry.dir === 'out' ? 'out' : 'in',
        text: entry.text.trim().slice(0, Math.max(1, Math.floor(textChars))),
    }));
}

/**
 * The injected block. Sections with nothing to say are omitted; a memory
 * with nothing at all injects nothing, so turning memory on costs zero
 * tokens until there is something to remember.
 */
export function buildMemoryBlock({ global, conv, recent } = {}) {
    const sections = [];
    const globalFacts = global?.facts ?? [];
    if (globalFacts.length > 0) {
        sections.push(['【长期记忆 · 关于用户】', ...globalFacts.map((fact) => `- ${fact.text}`)].join('\n'));
    }
    if (conv !== undefined) {
        const lines = [];
        if (typeof conv.summary === 'string' && conv.summary.trim() !== '') lines.push(`摘要：${conv.summary.trim()}`);
        if (conv.facts.length > 0) lines.push(...conv.facts.map((fact) => `- ${fact.text}`));
        if (lines.length > 0) sections.push(['【本会话记忆】', ...lines].join('\n'));
    }
    if (Array.isArray(recent) && recent.length > 0) {
        const lines = recent.map((entry) => `${entry.dir === 'out' ? '助手' : '用户'}：${entry.text}`);
        sections.push(['【最近消息】', ...lines].join('\n'));
    }
    if (sections.length === 0) return '';
    return `<weixin_memory>\n${sections.join('\n\n')}\n</weixin_memory>`;
}
