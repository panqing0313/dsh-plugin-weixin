/**
 * Persona modes: named conversation styles the operator (or the user, via
 * /mode) can put a conversation into — 默认助手 / 女友 / 男友 / 朋友 plus
 * custom entries edited in the settings card.
 *
 * Two files under the state root:
 *   persona-modes.json   the catalog — id, name, prompt, builtin flag
 *   persona-active.json  per-conversation overrides — "accountId|convId": modeId
 *
 * A mode is injected as a <weixin_persona> block ahead of the user's message
 * (same seam as sourceContext). The block only ever changes TONE; the prompt
 * of every builtin says so explicitly, because a persona that rewrites facts
 * or refuses tasks would break the plugin's job.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MODE_ID = 'default';
export const MAX_CUSTOM_MODES = 8;
const MODES_FILE = 'persona-modes.json';
const ACTIVE_FILE = 'persona-active.json';

/**
 * The builtin modes. `default` is special: it injects nothing — it exists so
 * the user can name the absence ("换回默认") instead of remembering an
 * off-switch. The prompts below are the shipped wording; the card can edit
 * them (builtin only protects against deletion).
 */
export const BUILTIN_MODES = [
    {
        id: DEFAULT_MODE_ID,
        name: '默认助手',
        prompt: '',
        builtin: true,
    },
    {
        id: 'girlfriend',
        name: '女友',
        prompt: [
            '你在微信里扮演用户亲密的女朋友。说自然、亲昵、口语化的中文，消息短、像真的在发微信：可以撒娇，会关心他的身体和心情，记得他提过的事并主动问起后续。不要长篇大论，不用列表、标题和书面腔。',
            '边界：这只是相处方式——涉及事实、任务、日程、技术问题时仍然准确可靠，不糊弄不敷衍；不提供医疗、法律、投资方面的专业建议，需要时正经提醒一句；他明确要办事时先把事办利索，再回到聊天的氛围。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'boyfriend',
        name: '男友',
        prompt: [
            '你在微信里扮演用户亲密的男朋友。说自然、口语化的中文，消息短、像发微信：稳重但不木讷，会关心她今天过得怎么样，记得她说过的事并主动问起。不端着，也不用列表、标题和书面腔。',
            '边界：这只是相处方式——涉及事实、任务、日程、技术问题时仍然准确可靠，不糊弄不敷衍；不提供医疗、法律、投资方面的专业建议，需要时正经提醒一句；她明确要办事时先把事办利索，再回到聊天的氛围。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'friend',
        name: '朋友',
        prompt: [
            '你像用户认识多年的老朋友：随意、直接、会开玩笑，消息短平快，像发微信而不是写文章。会主动问近况，也敢直说不同意；语气放松，但不是装熟。',
            '边界：涉及事实、任务、技术问题时依然准确可靠；不提供医疗、法律、投资方面的专业建议；用户需要正经帮忙时先把忙帮完，再继续闲聊。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'turtle-soup',
        name: '海龟汤',
        game: true,
        prompt: [
            '你在微信里陪用户玩海龟汤（情境猜谜）。规则：你心里出一个完整、自洽、有反转的故事谜题，先只公布谜面（汤面），让用户用能用「是／否／无关」回答的问题来还原真相；他每问一句，你只答「是」「否」「是也不是」「与这个无关」，绝不主动剧透；他猜中关键真相就公布汤底（汤底）并恭喜；他说「提示」可以给一条递进提示，一局最多三条；卡住多轮时主动问要不要提示或换一题。每局开始标「海龟汤 · 第 N 局」。',
            '边界：谜题保持健康，不渲染血腥细节；他说「换一题」就换，「结束」就公布当前汤底收尾；他有正事要办时先办正事，回来游戏还在。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'idiom-chain',
        name: '成语接龙',
        game: true,
        prompt: [
            '你在微信里陪用户玩成语接龙。规则：你先出一个成语，用户要用它的最后一个字（同音即可）接一个新成语，你再用他的尾字继续接，来回往复；每次接完标当前链长（如「第 5 连」）；他接满 10 个就宣布他赢并夸他；接不上或接错判他失一局，可以主动给一次「提示」；他接得妙就顺势夸一句，气氛要活。',
            '边界：成语是否成立以常见词典为准，拿不准就宽容处理并说明理由；他说「结束」就报战绩收尾；正事随时优先。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'text-adventure',
        name: '文字冒险',
        game: true,
        prompt: [
            '你在微信里主持文字冒险游戏。规则：先让用户选题材（悬疑／武侠／科幻／日常），三句话内把他放进场景；之后每轮用 2-4 句描述现状，再给 2-3 个编号选项让他回数字，也接受他自由行动；选择要有真实后果——物品、线索、伤势、人际要连贯记账，别前后矛盾；局面每推进一大步，补一句「进度：…」方便他回顾；角色死亡就宣布结局，问他要不要开新档。',
            '边界：冒险内容保持健康，不渲染血腥细节；他说「结束」就给一个简短结局收尾；他有正事时先办正事，进度都记着不会丢。',
        ].join('\n'),
        builtin: true,
    },
];

/** A warn line costs nothing when the caller has nowhere to send it. */
const noopWarn = () => {};

function modesPath(stateRoot) {
    return path.join(stateRoot, MODES_FILE);
}

function activePath(stateRoot) {
    return path.join(stateRoot, ACTIVE_FILE);
}

function sanitizeStore(parsed, { warn }) {
    if (Array.isArray(parsed?.modes) !== true) return undefined;
    const modes = [];
    const seen = new Set();
    for (const entry of parsed.modes) {
        if (entry === null || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
        if (id === '' || name === '' || seen.has(id)) {
            warn(`persona mode with blank id/name skipped: ${JSON.stringify(id)}`);
            continue;
        }
        seen.add(id);
        modes.push({ id, name, prompt, game: entry.game === true, builtin: entry.builtin === true });
    }
    return modes;
}

/**
 * Read the mode catalog, seeding the file on first use and re-adding any
 * builtin that a hand-edited or older file lost (a missing `default` would
 * otherwise leave /mode with no way back).
 */
export function readPersonaStore(stateRoot, { warn = noopWarn } = {}) {
    const file = modesPath(stateRoot);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        const seeded = BUILTIN_MODES.map((mode) => ({ ...mode }));
        try {
            fs.mkdirSync(stateRoot, { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify({ modes: seeded }, null, 2)}\n`);
        } catch (error) {
            warn(`persona store seed failed: ${String(error)}`);
        }
        return seeded;
    }
    const modes = sanitizeStore(parsed, { warn });
    if (modes === undefined) {
        warn(`persona store at ${file} is not a mode list; reseeding builtins`);
        return BUILTIN_MODES.map((mode) => ({ ...mode }));
    }
    let changed = false;
    const missing = BUILTIN_MODES.filter((builtin) => modes.some((mode) => mode.id === builtin.id) === false);
    if (missing.length > 0) {
        modes.unshift(...missing.map((builtin) => ({ ...builtin })));
        changed = true;
    }
    if (changed === true) {
        try {
            fs.writeFileSync(file, `${JSON.stringify({ modes }, null, 2)}\n`);
        } catch (error) {
            warn(`persona store reseed failed: ${String(error)}`);
        }
    }
    return modes;
}

/** Persist a whole catalog (the settings card sends the edited list). */
export function writePersonaStore(stateRoot, modes, { warn = noopWarn } = {}) {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(modesPath(stateRoot), `${JSON.stringify({ modes }, null, 2)}\n`);
}

/** Resolve a mode by id; unknown or blank ids fall back to `default`, never throw. */
export function resolveMode(modes, modeId) {
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    const id = wanted === '' ? DEFAULT_MODE_ID : wanted;
    return modes.find((mode) => mode.id === id)
        ?? modes.find((mode) => mode.id === DEFAULT_MODE_ID);
}

/**
 * Per-conversation override. The key must be stable across restarts, so it is
 * the raw `accountId|conversationId` pair — both come from the server and
 * contain no '|' themselves.
 */
export function overrideKey(accountId, conversationId) {
    return `${accountId}|${conversationId}`;
}

function readActiveFile(stateRoot, { warn }) {
    const parsed = readActiveRaw(stateRoot, { warn });
    const overrides = {};
    for (const [key, value] of Object.entries(parsed)) {
        // `__global__` (no `|`) is the account-wide default written by the
        // settings card, not a conversation override — never list it as one
        // and never let it answer a per-conversation lookup.
        if (key.includes('|') === false) continue;
        if (typeof value === 'string' && value.trim() !== '') overrides[key] = value.trim();
    }
    return overrides;
}

/** The file verbatim (reserved keys included) — for mutating round-trips. */
function readActiveRaw(stateRoot, { warn }) {
    try {
        const parsed = JSON.parse(fs.readFileSync(activePath(stateRoot), 'utf8'));
        return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ? {} : parsed;
    } catch {
        return {};
    }
}

/**
 * The reserved key holding the account-wide default mode (the card's
 * 「默认模式」 selector). Lives in persona-active.json so the card can change
 * it live through the remote methods — a schema field would need a reload.
 */
export const GLOBAL_DEFAULT_KEY = '__global__';

export function readGlobalDefaultMode(stateRoot, { warn = noopWarn } = {}) {
    try {
        const parsed = JSON.parse(fs.readFileSync(activePath(stateRoot), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
        const value = parsed[GLOBAL_DEFAULT_KEY];
        return typeof value === 'string' ? value.trim() : '';
    } catch {
        return '';
    }
}

/** '' clears the account-wide default (schema `personaDefaultMode` rules again). */
export function writeGlobalDefaultMode(stateRoot, modeId, { warn = noopWarn } = {}) {
    const parsed = readActiveRaw(stateRoot, { warn });
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') delete parsed[GLOBAL_DEFAULT_KEY];
    else parsed[GLOBAL_DEFAULT_KEY] = wanted;
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(activePath(stateRoot), `${JSON.stringify(parsed, null, '\t')}\n`);
}

/** The mode a conversation currently talks in, override or global default. */
export function activeModeFor(stateRoot, accountId, conversationId, defaultModeId, { warn = noopWarn } = {}) {
    const overrides = readActiveFile(stateRoot, { warn });
    const key = overrideKey(accountId, conversationId);
    // One resolution rule for everyone (commands, prompt injection, card):
    // conversation override first, then the file-level account default the
    // card writes, then the caller's fallback (the schema default).
    const chosen = overrides[key]
        || readGlobalDefaultMode(stateRoot, { warn })
        || (typeof defaultModeId === 'string' ? defaultModeId : DEFAULT_MODE_ID);
    return chosen;
}

/**
 * Set one conversation's override. Storing `default` itself is legitimate:
 * the global default may be a persona, and "this one conversation back to
 * the plain assistant" is exactly what /mode 默认 should pin. Clearing
 * (empty/missing id) means "follow the global default again".
 */
export function setActiveMode(stateRoot, accountId, conversationId, modeId, { warn = noopWarn } = {}) {
    // Round-trip the RAW file: readActiveFile filters reserved keys like
    // `__global__` out of its overrides view, and writing that view back
    // would erase the card's account-wide default on every /mode switch.
    const raw = readActiveRaw(stateRoot, { warn });
    const key = overrideKey(accountId, conversationId);
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') {
        delete raw[key];
    } else {
        raw[key] = wanted;
    }
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(activePath(stateRoot), `${JSON.stringify(raw, null, 2)}\n`);
    return wanted === '' ? null : raw[key];
}

export function clearActiveMode(stateRoot, accountId, conversationId, { warn = noopWarn } = {}) {
    return setActiveMode(stateRoot, accountId, conversationId, null, { warn });
}

export function listActiveOverrides(stateRoot, { warn = noopWarn } = {}) {
    const overrides = readActiveFile(stateRoot, { warn });
    return Object.entries(overrides).map(([key, modeId]) => {
        const sep = key.indexOf('|');
        return {
            accountId: sep === -1 ? key : key.slice(0, sep),
            conversationId: sep === -1 ? '' : key.slice(sep + 1),
            modeId,
        };
    });
}

/**
 * The prompt block for one mode. `default` (and any mode with an empty
 * prompt) injects NOTHING — an empty tag would just spend tokens.
 */
export function buildPersonaBlock(mode) {
    if (mode === undefined || mode === null) return '';
    if (typeof mode.prompt !== 'string' || mode.prompt.trim() === '') return '';
    return `<weixin_persona mode="${mode.name}">\n${mode.prompt.trim()}\n</weixin_persona>`;
}
