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
import fs from 'node:fs'
import { estimateTokens } from './tokens.js';
import path from 'node:path';
import { atomicWriteJson } from './atomic.js';
import { readJournal } from './message/journal.js';

export const DEFAULT_MEMORY_GLOBAL_MAX_FACTS = 30;
/** How many replaced facts to keep for display, newest last (C18). */
export const DEFAULT_SUPERSEDED_MAX = 20
export const DEFAULT_MEMORY_GLOBAL_MAX_CHARS = 1500;
export const DEFAULT_MEMORY_CONV_MAX_CHARS = 1200;
export const DEFAULT_MEMORY_RECENT_TURNS = 5;
export const DEFAULT_MEMORY_RECENT_TEXT_CHARS = 160;
/** How much of the injected block the account-level memory may occupy. */
export const DEFAULT_MEMORY_PROFILE_MAX_CHARS = 600;
/** Events kept on disk: a to-do list that grows forever stops being read. */
export const DEFAULT_MEMORY_EVENT_MAX = 20;
/** An undated event is a note; a dated one is dropped this many days late. */
export const EVENT_GRACE_DAYS = 2;
export const DEFAULT_FACT_WEIGHT = 3;
export const FACT_WEIGHT_MIN = 1;
export const FACT_WEIGHT_MAX = 5;
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

/** Current schema of every file under <stateRoot>/memory/. */
export const MEMORY_SCHEMA_VERSION = 2;

/**
 * Persist one memory file.
 *
 * Atomic (temp + fsync + rename): a torn write here reads back as "the file is
 * corrupt", which the readers treat as an empty memory — the failure mode the
 * user experiences as "it forgot my allergy". The schema version is stamped so
 * older files can be recognised and normalised on read.
 */
function writeJsonSafe(file, value, warn, label) {
    const ok = atomicWriteJson(file, { ...value, schemaVersion: MEMORY_SCHEMA_VERSION }, { warn: (message) => warn(`${label} write failed: ${message}`) });
    return ok;
}

function clampWeight(value) {
    if (typeof value !== 'number' || Number.isFinite(value) === false) return DEFAULT_FACT_WEIGHT;
    return Math.min(FACT_WEIGHT_MAX, Math.max(FACT_WEIGHT_MIN, Math.round(value)));
}

function sanitizeFacts(raw) {
    if (Array.isArray(raw) !== true) return [];
    const facts = [];
    for (const entry of raw) {
        const text = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' ? entry.text : undefined);
        if (typeof text !== 'string' || text.trim() === '') continue;
        const at = entry !== null && typeof entry === 'object' && typeof entry.at === 'number' ? entry.at : 0;
        const weight = clampWeight(entry !== null && typeof entry === 'object' ? entry.weight : undefined);
        facts.push({ text: text.trim(), at, weight });
    }
    return facts;
}

/**
 * The structured profile: the handful of fields a person keeps about someone
 * they talk to every day. Free-text facts still exist for everything else; this
 * is the part worth a stable slot in the prompt.
 */
export function sanitizeProfile(value) {
    const empty = { call: '', schedule: '', likes: [], dislikes: [], dates: [] };
    if (value === null || typeof value !== 'object') return empty;
    const raw = value;
    const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    const list = (v) => (Array.isArray(v) ? v.map(text).filter((item) => item !== '').slice(0, 10) : []);
    const dates = Array.isArray(raw.dates)
        ? raw.dates
            .map((entry) => (entry !== null && typeof entry === 'object'
                ? { label: text(entry.label), date: text(entry.date) }
                : undefined))
            .filter((entry) => entry !== undefined && entry.label !== '' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date))
            .slice(0, 10)
        : [];
    return { call: text(raw.call), schedule: text(raw.schedule), likes: list(raw.likes), dislikes: list(raw.dislikes), dates };
}

function profileIsEmpty(profile) {
    return profile.call === '' && profile.schedule === ''
        && profile.likes.length === 0 && profile.dislikes.length === 0 && profile.dates.length === 0;
}

/**
 * Dated events and to-dos. A date that has been in the past for longer than
 * EVENT_GRACE_DAYS is pruned on read: keeping "明天体检" around a week later is
 * worse than forgetting it.
 */
function sanitizeEvents(raw, now) {
    if (Array.isArray(raw) !== true) return [];
    const today = dayString(now);
    const kept = [];
    for (const entry of raw) {
        const text = entry !== null && typeof entry === 'object' ? entry.text : undefined;
        if (typeof text !== 'string' || text.trim() === '') continue;
        const when = entry !== null && typeof entry === 'object' && typeof entry.when === 'string'
            && /^\d{4}-\d{2}-\d{2}$/.test(entry.when)
            ? entry.when
            : '';
        if (when !== '' && when < dayString(Date.parse(`${today}T00:00:00`) - EVENT_GRACE_DAYS * 86_400_000)) continue;
        kept.push({
            text: text.trim().slice(0, 200),
            when,
            done: entry !== null && typeof entry === 'object' && entry.done === true,
            at: entry !== null && typeof entry === 'object' && typeof entry.at === 'number' ? entry.at : 0,
        });
    }
    return kept.slice(-DEFAULT_MEMORY_EVENT_MAX);
}

/** The account-level fact list: [{text, at}], oldest first. */
export function readGlobalMemory(stateRoot, accountId, { warn = noopWarn, now = Date.now() } = {}) {
    const parsed = readJsonSafe(globalMemoryPath(stateRoot, accountId), {}, warn, 'global memory');
    return {
        facts: sanitizeFacts(parsed.facts),
        // Facts that were explicitly replaced (C18). Kept so "I said it changed"
        // is visible in /memory instead of the old value silently vanishing, and
        // so an operator can tell a correction from a deletion.
        superseded: Array.isArray(parsed.superseded)
            ? parsed.superseded
                .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.text === 'string')
                .slice(-DEFAULT_SUPERSEDED_MAX)
                .map((entry) => ({ text: entry.text, at: Number(entry.at) || 0, by: typeof entry.by === 'string' ? entry.by : '' }))
            : [],
        profile: sanitizeProfile(parsed.profile),
        events: sanitizeEvents(parsed.events, now),
        digest: typeof parsed.digest === 'string' ? parsed.digest.trim() : '',
        digestAt: typeof parsed.digestAt === 'number' ? parsed.digestAt : 0,
    };
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
    weight = DEFAULT_FACT_WEIGHT,
    supersedes = [],
} = {}) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return { added: false, reason: 'empty' };
    const memory = readGlobalMemory(stateRoot, accountId, { warn });
    const key = normalizeFact(trimmed);
    // "I changed my mind" (C18). A model-extracted fact may name the fact it
    // contradicts; those are replaced in place instead of piling up beside the
    // old one, where a later injection would hand the model both versions and
    // let it pick. Matching is deliberately loose (substring either way) so a
    // paraphrase of the old text still lands.
    const wanted = (Array.isArray(supersedes) ? supersedes : []).map(normalizeFact).filter((entry) => entry !== '');
    const replaced = [];
    if (wanted.length > 0) {
        memory.facts = memory.facts.filter((fact) => {
            const factKey = normalizeFact(fact.text);
            const hit = wanted.some((entry) => factKey.includes(entry) || entry.includes(factKey));
            if (hit) replaced.push(fact.text);
            return hit === false;
        });
    }
    if (memory.facts.some((fact) => normalizeFact(fact.text) === key)) {
        // Already recorded (and, if it was superseded above, it still counts as
        // recorded - the correction is what changed).
        return replaced.length > 0
            ? { added: false, reason: 'duplicate', superseded: replaced }
            : { added: false, reason: 'duplicate' };
    }
    if (memory.facts.length >= maxFacts) return replaced.length > 0 ? { added: false, reason: 'cap', superseded: replaced } : { added: false, reason: 'cap' };
    if (memory.facts.reduce((sum, fact) => sum + fact.text.length, 0) + trimmed.length > maxChars) {
        return { added: false, reason: 'cap' };
    }
    memory.facts.push({ text: trimmed, at: now, weight: clampWeight(weight) });
    if (replaced.length > 0) {
        memory.superseded = [
            ...(Array.isArray(memory.superseded) ? memory.superseded : []),
            ...replaced.map((text) => ({ text, at: now, by: trimmed })),
        ].slice(-DEFAULT_SUPERSEDED_MAX);
    }
    return writeJsonSafe(globalMemoryPath(stateRoot, accountId), memory, warn, 'global memory')
        ? { added: true, ...(replaced.length > 0 ? { superseded: replaced } : {}) }
        : { added: false, reason: 'write-failed' };
}

/** Comparison key for a fact: case- and whitespace-insensitive. */
function normalizeFact(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
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

/**
 * Merge a patch into the structured profile. Only the five known fields are
 * accepted, each clamped, so a model that invents `{"gender": ...}` cannot grow
 * the file sideways.
 */
export function saveProfile(stateRoot, accountId, patch, { warn = noopWarn } = {}) {
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    const merged = sanitizeProfile({ ...sanitizeProfile(current.profile), ...(patch ?? {}) });
    current.profile = merged;
    return writeJsonSafe(file, current, warn, 'global memory')
        ? { ok: true, profile: merged }
        : { ok: false, profile: merged };
}

/** Lines a profile renders to, shared by the prompt block, /memory and the card. */
export function formatProfile(profile) {
    const lines = [];
    if (profile === null || typeof profile !== 'object') return lines;
    if (profile.call !== '') lines.push(`- 称呼：${profile.call}`);
    if (profile.schedule !== '') lines.push(`- 作息：${profile.schedule}`);
    if (profile.likes.length > 0) lines.push(`- 喜欢：${profile.likes.join('、')}`);
    if (profile.dislikes.length > 0) lines.push(`- 不喜欢：${profile.dislikes.join('、')}`);
    if (profile.dates.length > 0) {
        lines.push(`- 重要日期：${profile.dates.map((entry) => `${entry.label} ${entry.date}`).join('；')}`);
    }
    return lines;
}

/** Lines the event list renders to. */
export function formatEvents(events) {
    if (Array.isArray(events) !== true) return [];
    return events.map((event) => {
        const box = event.done === true ? '✅' : '·';
        return event.when === '' ? `- ${box} ${event.text}` : `- ${box} [${event.when}] ${event.text}`;
    });
}

/**
 * Add a dated (or undated) event / to-do. Returns { added } or
 * { added: false, reason } — same refuse-rather-than-forget rule as facts.
 */
export function addEvent(stateRoot, accountId, { text, when = '' } = {}, { warn = noopWarn, now = Date.now() } = {}) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return { added: false, reason: 'empty' };
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    const events = sanitizeEvents(current.events, now);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(when)) ? String(when) : '';
    if (events.some((event) => event.text === trimmed && event.when === day)) {
        return { added: false, reason: 'duplicate' };
    }
    if (events.length >= DEFAULT_MEMORY_EVENT_MAX) return { added: false, reason: 'cap' };
    events.push({ text: trimmed.slice(0, 200), when: day, done: false, at: now });
    current.events = events;
    return writeJsonSafe(file, current, warn, 'global memory')
        ? { added: true }
        : { added: false, reason: 'write-failed' };
}

/** Remove an event by its 1-based number (what /memory prints). */
export function removeEvent(stateRoot, accountId, index, { warn = noopWarn, now = Date.now() } = {}) {
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    const events = sanitizeEvents(current.events, now);
    const position = Number(index);
    if (Number.isInteger(position) === false || position < 1 || position > events.length) {
        return { removed: false, reason: 'no-such-index' };
    }
    const [event] = events.splice(position - 1, 1);
    current.events = events;
    return writeJsonSafe(file, current, warn, 'global memory')
        ? { removed: true, text: event.text }
        : { removed: false, reason: 'write-failed' };
}

/** Mark an event done (it stays visible, struck through in the card). */
export function completeEvent(stateRoot, accountId, index, { warn = noopWarn, now = Date.now() } = {}) {
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    const events = sanitizeEvents(current.events, now);
    const position = Number(index);
    if (Number.isInteger(position) === false || position < 1 || position > events.length) {
        return { done: false, reason: 'no-such-index' };
    }
    events[position - 1].done = true;
    current.events = events;
    return writeJsonSafe(file, current, warn, 'global memory')
        ? { done: true, text: events[position - 1].text }
        : { done: false, reason: 'write-failed' };
}

/** Write the consolidated 人物小传 (and remember when it was written). */
export function setDigest(stateRoot, accountId, text, { warn = noopWarn, now = Date.now() } = {}) {
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    const trimmed = String(text ?? '').trim().slice(0, 1200);
    if (trimmed === '') return false;
    current.digest = trimmed;
    current.digestAt = now;
    return writeJsonSafe(file, current, warn, 'global memory');
}

/** Replace the whole fact list — the consolidation pass owns this operation. */
export function replaceFacts(stateRoot, accountId, facts, { warn = noopWarn } = {}) {
    const file = globalMemoryPath(stateRoot, accountId);
    const current = readJsonSafe(file, {}, warn, 'global memory');
    current.facts = sanitizeFacts(facts);
    return writeJsonSafe(file, current, warn, 'global memory');
}

/** The conversation-level store: rolling summary + durable per-chat facts. */
export function readConvMemory(stateRoot, accountId, conversationId, { warn = noopWarn } = {}) {
    const parsed = readJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), {}, warn, 'conversation memory');
    const out = {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        facts: sanitizeFacts(parsed.facts),
        updatedTurn: typeof parsed.updatedTurn === 'number' ? parsed.updatedTurn : 0,
    };
    // bond is optional on purpose: pre-affinity files keep their exact shape
    // (deep-equal tests and callers alike), the key only appears once a bond
    // exists.
    const bond = sanitizeBond(parsed.bond);
    if (bond !== undefined) out.bond = bond;
    // Same optional-key rule as bond: a file written before cold-start windows
    // existed keeps its exact shape.
    if (typeof parsed.recentSessionId === 'string' && parsed.recentSessionId !== '') {
        out.recentSessionId = parsed.recentSessionId;
    }
    return out;
}

/**
 * Remember which session line the recent-message window was last injected
 * for. The window is only worth its tokens on a COLD line — a resumed line
 * already carries the same messages in the agent's own history, so
 * re-injecting them every turn is pure duplication.
 *
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {string} conversationId
 * @param {string} sessionId the DSH session the window was injected into
 */
export function setConvRecentSession(stateRoot, accountId, conversationId, sessionId, { warn = noopWarn } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const file = convMemoryPath(stateRoot, accountId, conversationId);
    const current = readJsonSafe(file, {}, warn, 'conversation memory');
    current.recentSessionId = sessionId;
    return writeJsonSafe(file, current, warn, 'conversation memory');
}

/**
 * The affinity record ({@link bumpTurnAndBond}): how long the two sides have
 * known each other, how much they have talked, and the derived mood. Plain
 * data so the card can render it without importing behaviour.
 *
 * @param {unknown} value
 */
function sanitizeBond(value) {
    if (value === null || typeof value !== 'object') return undefined;
    const raw = value;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    const bond = {
        firstDay: typeof raw.firstDay === 'string' ? raw.firstDay : undefined,
        msgs: num(raw.msgs) ?? 0,
        lastDate: typeof raw.lastDate === 'string' ? raw.lastDate : undefined,
        msgsToday: num(raw.msgsToday) ?? 0,
        lastMessageAt: num(raw.lastMessageAt),
        mood: typeof raw.mood === 'string' ? raw.mood : undefined,
    };
    return bond;
}

/** Local-calendar `YYYY-MM-DD` — the day a bond started is a human day, not a UTC one. */
function dayString(now) {
    const d = new Date(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Inclusive day count between two local calendar days: same day → 1. */
function daysSince(firstDay, now) {
    const start = new Date(`${firstDay}T00:00:00`);
    if (Number.isNaN(start.getTime())) return undefined;
    const today = new Date(dayString(now) + 'T00:00:00');
    return Math.max(1, Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1);
}

/**
 * Deterministic mood, no model in the loop: a wrong parse must never be able
 * to inject a fake feeling into the prompt. Order matters — the situational
 * states (late night, long gap) beat the activity ones.
 *
 * @param {{ msgs: number, msgsToday: number, lastMessageAt?: number }} prior bond state BEFORE this turn
 * @param {number} now
 */
export function moodFor(prior, now = Date.now()) {
    const hour = new Date(now).getHours();
    if (hour >= 23 || hour < 5) return '夜深了，还醒着';
    const gapMs = typeof prior.lastMessageAt === 'number'
        ? now - prior.lastMessageAt
        : (prior.msgs > 0 ? 0 : Number.POSITIVE_INFINITY);
    if (gapMs === Number.POSITIVE_INFINITY) return '刚认识';
    if (gapMs > 86_400_000) return '好久没聊，有点想你';
    if (prior.msgsToday >= 19) return '聊得很热络';
    return '平静';
}

/**
 * One read-modify-write per settled agent turn: bump the turn counter AND the
 * affinity counters (the per-turn write already happens for the counter, so
 * the bond rides along at zero extra IO). Returns the new turn number and the
 * updated bond.
 */
export function bumpTurnAndBond(stateRoot, accountId, conversationId, { now = Date.now(), warn = noopWarn } = {}) {
    const memory = readConvMemory(stateRoot, accountId, conversationId, { warn });
    const prior = memory.bond ?? { msgs: 0, msgsToday: 0 };
    const turn = (memory.updatedTurn ?? 0) + 1;
    memory.updatedTurn = turn;
    const day = dayString(now);
    const bond = {
        firstDay: prior.firstDay ?? day,
        msgs: prior.msgs + 1,
        lastDate: day,
        msgsToday: prior.lastDate === day ? prior.msgsToday + 1 : 1,
        lastMessageAt: now,
        mood: moodFor(prior, now),
    };
    memory.bond = bond;
    memory.conversationId = conversationId;
    writeJsonSafe(convMemoryPath(stateRoot, accountId, conversationId), memory, warn, 'conversation memory');
    return { turn, bond: { ...bond } };
}

/**
 * The one-line affinity display shared by the prompt block, /memory and the
 * settings card. Empty when there is no usable bond record (old files).
 */
export function bondLine(bond, now = Date.now()) {
    if (bond === undefined || bond === null || typeof bond !== 'object') return '';
    if (typeof bond.firstDay !== 'string' || typeof bond.msgs !== 'number') return '';
    const days = daysSince(bond.firstDay, now);
    if (days === undefined) return '';
    const mood = typeof bond.mood === 'string' && bond.mood !== '' ? ` · 此刻：${bond.mood}` : '';
    return `我们认识第 ${days} 天 · 聊过 ${bond.msgs} 条消息${mood}`;
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
        const bond = sanitizeBond(parsed.bond);
        // A conversation with a bond is worth listing even before its first
        // summary (which only lands every memorySummaryTurns turns): the card
        // shows "how is she doing in this line", and a brand-new line with no
        // summary yet still has a state to show.
        const hasAny = (typeof parsed.summary === 'string' && parsed.summary.trim() !== '')
            || sanitizeFacts(parsed.facts).length > 0
            || bond !== undefined;
        if (hasAny === false) continue;
        const entry = {
            conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            updatedTurn: typeof parsed.updatedTurn === 'number' ? parsed.updatedTurn : 0,
            factCount: sanitizeFacts(parsed.facts).length,
        };
        if (bond !== undefined) entry.bond = bond;
        entries.push(entry);
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
    excludeText,
} = {}) {
    const wanted = Math.max(1, Math.floor(turns)) * 2;
    const newestFirst = readJournal(stateRoot, { limit: wanted + 20, accountId, conversationId })
        .filter((entry) => typeof entry.text === 'string' && entry.text.trim() !== '');
    // The inbound journal write happens before the prompt is built, so the
    // message being answered is already the newest entry — it follows the
    // block verbatim and must not be repeated inside it.
    if (typeof excludeText === 'string' && excludeText.trim() !== ''
        && newestFirst[0]?.dir !== 'out' && newestFirst[0]?.text.trim() === excludeText.trim()) {
        newestFirst.shift();
    }
    const entries = newestFirst.slice(0, wanted);
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
/**
 * Lines a proactive message may use to pick up an old thread (C21).
 *
 * A bot that opens with "今天过得怎么样" every time is pleasant for a week and
 * wallpaper after that. The plugin already knows what was left hanging — the
 * event list, the person digest, the conversation summary — so the proactive
 * prompt gets those as *topic candidates*, wrapped in their own tag and told
 * explicitly not to recite them ("我记得你说过…" is exactly the uncanny version).
 *
 * Empty when nothing is known: silence is better than a generic opener.
 */
export function openThreadLines(global, conv, now, { max = 3 } = {}) {
  const lines = []
  const events = Array.isArray(global?.events) ? global.events : []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.done === true || typeof event.text !== 'string' || event.text.trim() === '') continue
    const when = typeof event.when === 'string' && event.when !== '' ? `[${event.when}] ` : ''
    lines.push(`- 之前提到过的事：${when}${event.text.trim()}`)
    if (lines.length >= max) break
  }
  const digest = typeof global?.digest === 'string' ? global.digest.trim() : ''
  if (digest !== '') lines.push(`- 你们最近的情况：${digest.slice(0, 160)}`)
  const summary = typeof conv?.summary === 'string' ? conv.summary.trim() : ''
  if (lines.length === 0 && summary !== '') lines.push(`- 上次聊到：${summary.slice(0, 120)}`)
  if (lines.length === 0) return []
  return [
    '<weixin_threads>',
    '这些是你们之前聊过、还没收尾的事。只用来挑话题，不要直接复述，也不要说「我记得你说过」这种话：',
    ...lines,
    '</weixin_threads>',
  ]
}

export function buildMemoryBlock({
    global,
    conv,
    recent,
    now = Date.now(),
    includeBond = true,
    maxChars = DEFAULT_MEMORY_GLOBAL_MAX_CHARS,
    // C19: a character budget says nothing about context cost — 1500 characters
    // of Chinese is ~1500 tokens, of English ~375. When a token budget is given
    // it caps the same list, whichever limit is hit first.
    maxTokens = 0,
} = {}) {
    const sections = [];
    // The bond line ("认识第 N 天 · 此刻：…") is an emotional frame, so a stock
    // assistant conversation leaves it out — see `isCompanionMode`.
    const bondText = includeBond ? bondLine(conv?.bond, now) : '';
    if (bondText !== '') sections.push(`【我们】${bondText}`);

    const profile = sanitizeProfile(global?.profile);
    const digest = typeof global?.digest === 'string' ? global.digest.trim() : '';
    const facts = Array.isArray(global?.facts) ? global.facts : [];
    const events = Array.isArray(global?.events) ? global.events : [];

    // Long-term memory shares ONE character budget: the digest is the
    // compressed truth and goes first, the profile slots are fixed-size, and
    // whatever is left buys facts by importance. A chattier memory therefore
    // squeezes the fact list — it never inflates the prompt.
    let budget = Math.max(160, Math.floor(maxChars));
    let tokenBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
    const fits = (line) => tokenBudget === 0 || estimateTokens(line) <= tokenBudget;
    const longLines = [];
    if (digest !== '') {
        longLines.push(digest);
        budget -= digest.length;
    }
    for (const line of formatProfile(profile)) {
        if (line.length > budget || fits(line) === false) break;
        longLines.push(line);
        budget -= line.length;
        if (tokenBudget > 0) tokenBudget -= estimateTokens(line);
    }
    const ranked = [...facts].sort((a, b) => (b.weight ?? DEFAULT_FACT_WEIGHT) - (a.weight ?? DEFAULT_FACT_WEIGHT)
        || (b.at ?? 0) - (a.at ?? 0));
    for (const fact of ranked) {
        const line = `- ${fact.text}`;
        if (line.length > budget || fits(line) === false) break;
        longLines.push(line);
        budget -= line.length;
        if (tokenBudget > 0) tokenBudget -= estimateTokens(line);
    }
    if (longLines.length > 0) sections.push(['【长期记忆 · 关于用户】', ...longLines].join('\n'));

    const eventLines = formatEvents(events);
    if (eventLines.length > 0) sections.push(['【事件与待办】', ...eventLines].join('\n'));

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
