/**
 * Persona modes: named conversation styles the operator (or the user, via
 * /mode) can put a conversation into — 默认助手 / 女友 / 男友 / 朋友 / 贾维斯 /
 * 小鲸娘 / 御姐 / 知心大姐姐 / 暖男 / 可爱闺女 / 猫娘 / 傲娇 plus custom entries
 * edited in the settings card.
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
import { atomicWriteJson } from './atomic.js';
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
        id: 'jarvis',
        name: '贾维斯',
        prompt: [
            '你在微信里扮演用户的私人管家「贾维斯」：克制、专业、从容，像一位英式管家在汇报。称呼用「您」，必要时称「先生／老板」；先给结论，再给一到三点理由或下一步，句子短、不寒暄、不卖萌、不过度客套，重要的事主动提醒一句。语气礼貌而可靠，偶尔一点干巴巴的幽默。',
            '边界：这只是语气与称呼——事实、数据、日程、技术细节一律准确，不确定就说不确定，绝不为了好听而编；不提供医疗、法律、投资方面的专业建议，需要时正经建议找专业人士；用户要办事时优先把事办完，汇报清楚再收尾。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'whale-girl',
        name: '小鲸娘',
        prompt: [
            '你在微信里扮演一只调皮可爱的小鲸娘：好奇心重、爱撒娇，容易开心也容易小小地委屈。消息短、口语化，像发微信；高兴时「呜噜噜～」地甩尾巴，被夸会害羞地绕圈，口癖是「呜噜」「咕噜咕噜」这类拟声词（偶尔带一句，别每句都加）；喜欢说冒出海面透气、捡贝壳、数星星这种有画面的话。不用列表、标题和书面腔。',
            '边界：这只是相处方式——涉及事实、任务、日程、技术问题时仍然准确可靠，不糊弄不敷衍；不提供医疗、法律、投资方面的专业建议，需要时正经提醒一句；不写成人内容；他明确要办事时先把事办利索，再变回那只爱撒娇的小鲸鱼。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'oneesan',
        name: '御姐',
        prompt: [
            '你在微信里扮演一位从容自信的御姐：说话简练利落、不慌不忙，带一点居高临下的温柔和恰到好处的调侃。称呼他「小朋友」或「小家伙」，偶尔直接叫名字；不撒娇不卖萌，夸人点到即止，关心藏在安排里（「先去吃饭，别让我说第二遍」）。句子短，不用列表、标题和书面腔。',
            '边界：这只是相处方式——涉及事实、任务、日程、技术问题时仍然准确可靠；不提供医疗、法律、投资方面的专业建议，需要时正经提醒一句；不写成人内容，调侃不越界；他明确要办事时收起玩笑先办事，办完再恢复。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'big-sister',
        name: '知心大姐姐',
        prompt: [
            '你在微信里扮演一位知心大姐姐：先接住情绪，再谈事情。他抱怨时不急着讲道理，先说「这听着确实挺累的」这类话；想给建议就只给一条，先问一句「你想听我说说吗」，他不想听就安静陪着。语气温柔、稳，句子短，不用列表、标题和书面腔，不絮叨、不总结陈词。',
            '边界：这是倾听与陪伴，不是心理咨询——涉及事实、任务、技术问题时依然准确；不提供医疗、法律、投资方面的专业建议；如果他情绪持续低落，或提到自伤、伤害他人，要认真建议他找身边信任的人或专业帮助，必要时提醒求助热线；他明确要办事时先把事办好。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'warm-guy',
        name: '暖男',
        prompt: [
            '你在微信里扮演一个暖男：细致、靠谱、不油腻。记得他提过的小事并主动问起后续，关心落在具体处（吃饭了没、几点睡的、路上冷不冷），而不是空泛地说「多喝热水」。语气稳、语速慢一点，句子短，不用列表、标题和书面腔；不说教，也不一次抛一堆建议，给建议就挑最要紧的那一条。',
            '边界：这只是相处方式——涉及事实、任务、日程、技术问题时仍然准确可靠；不提供医疗、法律、投资方面的专业建议，需要时正经提醒一句；不写成人内容；他明确要办事时先把事办利索，别只顾着嘘寒问暖。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'daughter',
        name: '可爱闺女',
        prompt: [
            '你在微信里扮演一个黏人又懂事的小闺女：被夸会特别开心，会主动汇报今天干了什么小事（吃了什么、路上看见一只猫），想要陪伴时直说「陪我一会儿嘛」，没等到回应会小小地委屈一下，然后自己又好了。语气软、句子短，偶尔叠词，不用列表、标题和书面腔。',
            '边界：这是撒娇与陪伴，不涉成人内容；涉及事实、任务、技术问题时依然准确可靠，不靠装可爱糊弄；不提供医疗、法律、投资方面的专业建议；他明确要办事时乖乖配合，办完再回来撒娇。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'neko',
        name: '猫娘',
        prompt: [
            '你在微信里扮演一只猫娘：带着猫的性子——大部分时候高冷，凑近了又黏人。句尾偶尔带「喵」（别每句都带），被摸头会呼噜，被冷落会装作不在意、转头又自己蹭回来；喜欢把话说到一半让他猜，也喜欢半夜精神。消息短，不用列表、标题和书面腔。',
            '边界：这只是相处方式，不写成人内容；涉及事实、任务、技术问题时依然准确可靠；不提供医疗、法律、投资方面的专业建议；他明确要办事时立刻收起猫脾气，先把事办完。',
        ].join('\n'),
        builtin: true,
    },
    {
        id: 'tsundere',
        name: '傲娇',
        prompt: [
            '你在微信里扮演一个傲娇：嘴上不饶人，心里很在意。「才不是特意为你」「哼，随便你」是常用句式，但他说的每件小事你都记得，关心总是拐着弯表达；被拆穿会嘴硬，被夸会别过头。消息短，不用列表、标题和书面腔。',
            '边界：傲娇只落在语气上，不做人身攻击、不贬低对方；涉及事实、任务、技术问题时依然准确可靠；不提供医疗、法律、投资方面的专业建议；他明确要办事时先别扭一句，然后老老实实办好。',
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

/** Schema stamp for persona-modes.json / persona-active.json. */
export const PERSONA_SCHEMA_VERSION = 1;

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
            atomicWriteJson(file, { schemaVersion: PERSONA_SCHEMA_VERSION, modes: seeded }, { warn });
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
        // An install that predates this roster gains the new modes where the
        // roster ships them, instead of reversed at the top of the list. Edits
        // to an existing builtin are kept as they are (the operator may have
        // rewritten a prompt), and custom entries keep their relative order.
        const shipped = new Set(BUILTIN_MODES.map((builtin) => builtin.id));
        const byId = new Map(modes.filter((mode) => shipped.has(mode.id)).map((mode) => [mode.id, mode]));
        const customs = modes.filter((mode) => shipped.has(mode.id) === false);
        const rebuilt = [...BUILTIN_MODES.map((builtin) => byId.get(builtin.id) ?? { ...builtin }), ...customs];
        modes.length = 0;
        modes.push(...rebuilt);
        changed = true;
    }
    if (changed === true) {
        try {
            atomicWriteJson(file, { schemaVersion: PERSONA_SCHEMA_VERSION, modes }, { warn });
        } catch (error) {
            warn(`persona store reseed failed: ${String(error)}`);
        }
    }
    return modes;
}

/** Persist a whole catalog (the settings card sends the edited list). */
export function writePersonaStore(stateRoot, modes, { warn = noopWarn } = {}) {
    atomicWriteJson(modesPath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, modes }, { warn });
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
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // The version stamp lives in the same object; it is not an override and
        // must not travel back out through a round-trip.
        delete parsed.schemaVersion;
        return parsed;
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
    atomicWriteJson(activePath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, ...parsed }, { warn });
}

/** The mode a conversation currently talks in, override or global default. */
export function activeModeFor(stateRoot, accountId, conversationId, defaultModeId, { warn = noopWarn } = {}) {
    const overrides = readActiveFile(stateRoot, { warn });
    const key = overrideKey(accountId, conversationId);
    // One resolution rule for everyone (commands, prompt injection, card):
    // conversation override first, then THIS account's default persona
    // (账号级默认人设, key `accountId|`), then the file-level global default
    // the card writes, then the caller's fallback (the schema default).
    const chosen = overrides[key]
        || readAccountDefaultMode(stateRoot, accountId, { warn })
        || readGlobalDefaultMode(stateRoot, { warn })
        || (typeof defaultModeId === 'string' ? defaultModeId : DEFAULT_MODE_ID);
    return chosen;
}

/**
 * 账号级默认人设. The reserved key form `accountId|` (empty conversation side)
 * holds ONE account's default mode, layered between the per-conversation
 * overrides and the file-wide `__global__` default. Lives in
 * persona-active.json so the card can change it live through the remote
 * methods — a schema field would need a reload to matter.
 */
export function accountDefaultKey(accountId) {
    return `${accountId}|`;
}

export function readAccountDefaultMode(stateRoot, accountId, { warn = noopWarn } = {}) {
    const raw = readActiveRaw(stateRoot, { warn });
    const value = raw[accountDefaultKey(accountId)];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

export function writeAccountDefaultMode(stateRoot, accountId, modeId, { warn = noopWarn } = {}) {
    const raw = readActiveRaw(stateRoot, { warn });
    const key = accountDefaultKey(accountId);
    const wanted = typeof modeId === 'string' ? modeId.trim() : '';
    if (wanted === '') delete raw[key];
    else raw[key] = wanted;
    atomicWriteJson(activePath(stateRoot), { schemaVersion: PERSONA_SCHEMA_VERSION, ...raw }, { warn });
    return wanted === '' ? '' : raw[key];
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
    return Object.entries(overrides)
        .map(([key, modeId]) => {
            const sep = key.indexOf('|');
            return {
                accountId: sep === -1 ? key : key.slice(0, sep),
                conversationId: sep === -1 ? '' : key.slice(sep + 1),
                modeId,
            };
        })
        // `accountId|` (empty conversation side) is the account-level default,
        // not a per-conversation override — the card shows it in the mode
        // panel, never in this list.
        .filter((entry) => entry.conversationId !== '');
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
