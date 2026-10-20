// ConfigController — the settings page's view of every configurable option.
//
// The plugin's options live in two places: the composition's Config schema (a
// profile YAML patch or the bundle row) and a JSON overlay at
// `<state>/config.json`. Before this service existed, the card could only edit
// the handful of ASR fields it happened to know about, so every other option --
// the sender allowlist, the message-length cap, the busy-message policy, the
// media size limits -- was reachable only by hand-editing JSON. This service
// turns the whole schema into something a form can render and write back.
//
// The field list below is the single source of truth for the UI. It is
// deliberately data, not code: the card renders whatever it is handed, so
// adding an option here is enough to make it editable, and the labels live next
// to the validation that reads them.
import fs from "node:fs";
import path from "node:path";
import { TypertRemoteService, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { stateDir, readSavedConfig, configFile } from "./state.js";
import { remoteMethods } from "./typert-js.js";
import { DEFAULT_MAX_MEDIA_BYTES } from "./media/outbound.js";
import { DEFAULT_MAX_INBOUND_MEDIA_BYTES } from "./media/inbound.js";
import { DEFAULT_ASR_TIMEOUT_MS } from "./media/asr.js";

/** Shape declarations the card understands. `number` carries min/max/step. */
const T = {
  boolean: "boolean",
  string: "string",
  text: "text", // multi-line string
  number: "number",
  stringList: "stringList", // one entry per line
  enum: "enum",
};

/**
 * Every configurable option, grouped for display.
 *
 * `path` is the address inside the config object, which is also the address the
 * saved overlay uses. `default` mirrors the schema in `src/index.js`; it is
 * repeated here rather than imported because the schema's `.default()` sits
 * behind schemastery's own wrapper, and a form that cannot say "this value is
 * the default" cannot offer a reset.
 */
export const FIELDS = [
  {
    group: "基本",
    groupEn: "Basics",
    fields: [
      {
        path: "enabled",
        type: T.boolean,
        default: true,
        label: "启用插件",
        labelEn: "Enabled",
        hint: "关闭后不再启动微信长轮询，消息不会被接收。",
        hintEn: "When off, the WeChat long-poll does not start and no message is received.",
      },
      {
        path: "accountId",
        type: T.string,
        default: "",
        label: "使用的账号",
        labelEn: "Account",
        hint: "留空表示使用唯一已保存的账号。",
        hintEn: "Empty means the only saved account.",
      },
      {
        path: "cwd",
        type: T.string,
        default: "",
        label: "工作目录",
        labelEn: "Working directory",
        hint: "Agent 操作的目录；留空继承会话默认值。",
        hintEn: "Directory the agent operates in; empty inherits the session default.",
      },
      {
        path: "sourceContext",
        type: T.boolean,
        default: false,
        label: "告知消息来源",
        labelEn: "Include source context",
        hint: "在提示词前加上来源信息，让 Agent 知道消息来自微信以及发送者是谁。",
        hintEn: "Prepend a source block so the agent knows the message came from WeChat and who sent it.",
      },
      {
        path: "messageJournal",
        type: T.boolean,
        default: true,
        label: "记录消息流水",
        labelEn: "Record a message journal",
        hint: "把最近的收发消息记到本地流水（消息流水页签展示），只存最近条目，方便确认账号活着。",
        hintEn: "Keep a local journal of recent in/out traffic (shown on the Journal tab) so you can confirm accounts are alive without reading logs.",
      },
      {
        path: "readLinks",
        type: T.boolean,
        default: true,
        label: "读取消息中的链接",
        labelEn: "Read links in messages",
        hint: "消息里含 http(s) 链接时自动抓取网页正文给 Agent 参考；打不开的链接只报一行原因，不影响消息本身。",
        hintEn: "Fetch the readable text of http(s) links in a message for the agent; a failed link is reported as one line, never as a failed message.",
      },
    ],
  },
  {
    group: "权限",
    groupEn: "Access",
    fields: [
      {
        path: "allowedSenders",
        type: T.stringList,
        default: [],
        label: "允许的发送者",
        labelEn: "Allowed senders",
        hint: "每行一个微信用户 id。留空表示拒绝所有人（这是安全的默认值）。",
        hintEn: "One WeChat user id per line. Empty denies everyone, which is the safe default.",
        emptyMeansAll: false,
      },
      {
        path: "allowedChats",
        type: T.stringList,
        default: [],
        label: "允许的会话",
        labelEn: "Allowed conversations",
        hint: "每行一个会话 id，可选。留空表示允许来自上述发送者的任何会话。",
        hintEn: "One conversation id per line, optional. Empty allows any conversation from an allowed sender.",
        emptyMeansAll: true,
      },
    ],
  },
  {
    group: "消息",
    groupEn: "Messages",
    fields: [
      {
        path: "markdownMode",
        type: T.enum,
        default: "strip",
        options: [
          { value: "strip", label: "过滤不支持的语法", labelEn: "Strip unsupported syntax" },
          { value: "off", label: "原样发送", labelEn: "Send verbatim" },
        ],
        label: "Markdown 处理",
        labelEn: "Markdown",
        hint: "微信不渲染 Markdown；过滤后表格等语法会转成纯文本。",
        hintEn: "WeChat does not render Markdown; stripping converts tables and the like to plain text.",
      },
      {
        path: "maxMessageLength",
        type: T.number,
        default: 1500,
        min: 100,
        max: 100_000,
        step: 100,
        unit: "字符",
        unitEn: "characters",
        label: "单条消息上限",
        labelEn: "Max message length",
        hint: "超过就拆成多条发送。",
        hintEn: "Longer replies are split into several messages.",
      },
      {
        path: "busyMessageMode",
        type: T.enum,
        default: "queue",
        options: [
          { value: "queue", label: "排队，作为下一轮", labelEn: "Queue as the next turn" },
          { value: "steer", label: "插入正在进行的回复", labelEn: "Steer the running turn" },
        ],
        label: "忙碌时的处理",
        labelEn: "When busy",
        hint: "回复尚未写完时收到新消息的处理方式。发送 /steer 指令始终是插入。",
        hintEn: "What happens to a message arriving mid-reply. Sending /steer always injects.",
      },
      {
        path: "typingIndicator",
        type: T.boolean,
        default: true,
        label: "显示「正在输入」",
        labelEn: "Typing indicator",
        hint: "需要服务端返回 typing ticket；没有时自动跳过。",
        hintEn: "Needs a typing ticket from the server; skipped when unavailable.",
      },
      {
        path: "progressAfterMs",
        type: T.number,
        default: 45_000,
        min: 0,
        max: 3_600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "进度提示延迟",
        labelEn: "Progress note after",
        hint: "等待这么久还没回复就先发一条进度提示；0 表示关闭。",
        hintEn: "Send one progress note after this long with no reply; 0 disables it.",
      },
      {
        path: "progressEveryMs",
        type: T.number,
        default: 60_000,
        min: 0,
        max: 3_600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "进度更新间隔",
        labelEn: "Progress update interval",
        hint: "工具变化后最多隔这么久再报一次；相同状态不会重复发送。",
        hintEn: "Re-report changed tools at most this often; an unchanged state is never repeated.",
      },
      {
        path: "maxTurnWaitMs",
        type: T.number,
        default: 1_200_000,
        min: 10_000,
        max: 86_400_000,
        step: 10_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "单轮最长等待",
        labelEn: "Max turn wait",
        hint: "超过这个时间就放弃等待本轮回复。",
        hintEn: "Give up waiting for a turn after this long.",
      },
    ],
  },
  {
    group: "媒体",
    groupEn: "Media",
    fields: [
      {
        path: "mediaEnabled",
        type: T.boolean,
        default: true,
        label: "发送附件",
        labelEn: "Send attachments",
        hint: "把 Agent 回复里引用的本地文件作为图片/视频/文件发出去。",
        hintEn: "Send local files the agent references as images, videos or file attachments.",
      },
      {
        path: "autoSendFiles",
        type: T.boolean,
        default: true,
        label: "产出文件自动送达",
        labelEn: "Auto-send produced files",
        hint: "Agent 在回合中写进工作目录的文件（截图、转换的文档等）即使回复里没有提到，也直接发到微信。",
        hintEn: "Files the agent wrote into its working directory during a turn (screenshots, converted documents) are sent even when the reply never references them.",
      },
      {
        path: "maxMediaBytes",
        type: T.number,
        default: DEFAULT_MAX_MEDIA_BYTES,
        min: 1024,
        max: 2 * 1024 * 1024 * 1024,
        step: 1024 * 1024,
        unit: "字节",
        unitEn: "bytes",
        label: "出站附件上限",
        labelEn: "Max outbound size",
        hint: "超过就不上传。默认 100 MB。",
        hintEn: "Larger files are not uploaded. Defaults to 100 MB.",
      },
      {
        path: "maxInboundMediaBytes",
        type: T.number,
        default: DEFAULT_MAX_INBOUND_MEDIA_BYTES,
        min: 1024,
        max: 2 * 1024 * 1024 * 1024,
        step: 1024 * 1024,
        unit: "字节",
        unitEn: "bytes",
        label: "入站附件上限",
        labelEn: "Max inbound size",
        hint: "超过就不下载。",
        hintEn: "Larger attachments are not downloaded.",
      },
      {
        path: "cdnBaseUrl",
        type: T.string,
        default: "",
        label: "CDN 地址",
        labelEn: "CDN base URL",
        hint: "留空表示由已保存的账号记录提供，再退回官方默认值。",
        hintEn: "Empty lets the saved account record supply it, then the upstream default.",
      },
    ],
  },
  {
    group: "语音识别",
    groupEn: "Voice transcription",
    fields: [
      {
        path: "asr.enabled",
        type: T.boolean,
        default: true,
        label: "转写语音消息",
        labelEn: "Transcribe voice messages",
        hint: "关闭后语音只作为文件交付，不做转写。",
        hintEn: "When off, voice notes are delivered as files only.",
      },
      {
        path: "asr.command",
        type: T.string,
        default: "",
        label: "转写命令",
        labelEn: "Bridge command",
        hint: "逐行 JSON 协议的可执行文件。留空表示禁用转写。",
        hintEn: "Executable of a line-oriented JSON bridge. Empty disables transcription.",
      },
      {
        path: "asr.args",
        type: T.stringList,
        default: [],
        label: "命令参数",
        labelEn: "Bridge arguments",
        hint: "每行一个参数。",
        hintEn: "One argument per line.",
      },
      {
        path: "asr.model",
        type: T.string,
        default: "",
        label: "模型",
        labelEn: "Model",
        hint: "Hugging Face 仓库 id 或本地模型目录的绝对路径；留空使用桥的默认值。",
        hintEn: "A Hugging Face repo id or an absolute local model directory; empty uses the bridge default.",
      },
      {
        path: "asr.timeoutMs",
        type: T.number,
        default: DEFAULT_ASR_TIMEOUT_MS,
        min: 1_000,
        max: 3_600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "转写超时",
        labelEn: "Transcription timeout",
        hint: "单次转写超过就放弃。",
        hintEn: "Give up on one transcription after this long.",
      },
      {
        path: "asr.env",
        type: T.text,
        default: {},
        label: "环境变量",
        labelEn: "Environment",
        hint: "每行一个 KEY=VALUE，例如 DSH_WEIXIN_ASR_LANGUAGE=zh。",
        hintEn: "One KEY=VALUE per line, e.g. DSH_WEIXIN_ASR_LANGUAGE=zh.",
        format: "env",
      },
      {
        path: "asr.modelDir",
        type: T.string,
        default: "",
        label: "模型目录",
        labelEn: "Model directory",
        hint: "下载和查找语音模型的目录；留空默认 ~/.dsh/weixin/asr-models。",
        hintEn: "Where downloadable voice models are stored and looked up; empty defaults to ~/.dsh/weixin/asr-models.",
      },
      {
        path: "asr.hfEndpoint",
        type: T.string,
        default: "https://hf-mirror.com",
        label: "下载源",
        labelEn: "Download endpoint",
        hint: "模型下载的地址。默认 https://hf-mirror.com，国内可直连；改成 https://huggingface.co 用官网。下载就是一次普通 HTTP 传输，速度完全取决于到这个地址的线路。",
        hintEn: "Where model downloads come from. Defaults to https://hf-mirror.com, reachable from mainland China without a proxy; use https://huggingface.co for the official site. A download is a plain HTTP transfer: exactly as fast as the route to this host.",
      },
      {
        path: "asr.hfProxy",
        type: T.string,
        default: "",
        label: "下载代理",
        labelEn: "Download proxy",
        hint: "例如 http://127.0.0.1:7897，HTTPS 走 CONNECT。留空直连。只有完全连不上下载源时才需要：下载速度就等于代理的速度，不会更快。",
        hintEn: "For example http://127.0.0.1:7897; HTTPS destinations are tunnelled with CONNECT. Empty connects directly. Set this only when the endpoint is unreachable: the download is then exactly as fast as the proxy, and no faster.",
      },
    ],
  },
];

/** Flat field list, for lookups by path. */
const FIELD_BY_PATH = new Map()
for (const group of FIELDS) {
  for (const field of group.fields) FIELD_BY_PATH.set(field.path, field)
}

/** Read `a.b` out of a nested object, without throwing on a missing parent. */
function readPath(object, dotted) {
  const parts = dotted.split(".")
  let cursor = object
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Write `a.b` into a nested object, creating intermediate objects. */
function writePath(object, dotted, value) {
  const parts = dotted.split(".")
  let cursor = object
  for (const part of parts.slice(0, -1)) {
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

/**
 * Coerce one submitted value into what the schema expects.
 *
 * The form sends strings for everything (a text input has no other type), so
 * this is where "1500" becomes the number 1500 and "true" becomes a boolean.
 * A value that cannot be coerced raises a RemoteError naming the field, because
 * silently writing a string where a number belongs would make the plugin fail
 * at message time instead of at save time.
 *
 * @returns {unknown} the value to store, or `undefined` to mean "clear it"
 */
function coerce(field, raw, t) {
  if (field.type === T.boolean) {
    if (typeof raw === 'boolean') return raw
    const text = String(raw ?? '').trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'off' || text === '') return false
    throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：需要一个开关值`, {})
  }
  if (field.type === T.number) {
    const text = String(raw ?? '').trim()
    if (!text) return undefined // empty means "use the default"
    const value = Number(text)
    if (!Number.isFinite(value)) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：需要一个数字，收到「${text}」`, {})
    }
    if (field.min !== undefined && value < field.min) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不能小于 ${field.min}`, {})
    }
    if (field.max !== undefined && value > field.max) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不能大于 ${field.max}`, {})
    }
    return value
  }
  if (field.type === T.stringList) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n')
    return list.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
  }
  if (field.type === T.enum) {
    const text = String(raw ?? '').trim()
    if (!field.options.some((option) => option.value === text)) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不是可选的取值`, {})
    }
    return text
  }
  if (field.type === T.string) {
    const text = String(raw ?? '')
    // An emptied box means "no value of mine", not "the empty string". For a
    // field whose default IS empty (`accountId`, `cwd`, the ASR bridge) storing
    // "" would be indistinguishable from unset in behavior but not in the
    // report: the form would say "saved" where it should say "default". For a
    // field whose default is NOT empty (`asr.hfEndpoint`) an empty box is
    // ambiguous, and clearing the override is the reading that lets an operator
    // get back to the default, so a reset is always available from the form.
    if (text.trim() === '' && field.default === '') return undefined
    return text
  }
  if (field.format === 'env') {
    // Stored as an object, edited as KEY=VALUE lines.
    const result = {}
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n')
    for (const line of list) {
      const text = String(line).trim()
      if (!text || text.startsWith('#')) continue
      const eq = text.indexOf('=')
      if (eq <= 0) {
        throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：每行需要是 KEY=VALUE，收到「${text}」`, {})
      }
      result[text.slice(0, eq).trim()] = text.slice(eq + 1)
    }
    return result
  }
  return String(raw ?? '')
}

/** Render a stored value back into the text the form shows. */
function present(field, value) {
  if (field.format === 'env' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, val]) => `${key}=${val}`)
      .join('\n')
  }
  if (field.type === T.stringList) {
    return Array.isArray(value) ? value.join('\n') : ''
  }
  if (value === undefined || value === null) return ''
  if (field.type === T.boolean) return value === true
  return String(value)
}

/**
 * Which keys this service may write.
 *
 * `maxTurnWaitMs` is absent on purpose: it is a safety bound on how long a turn
 * may run, and lowering it from a form is how an operator silently truncates
 * long replies. It stays in the file for anyone who wants it, and the form
 * reports its effective value without offering an editor.
 */
const READ_ONLY = new Set(['maxTurnWaitMs'])

export class ConfigController extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, "configController", { namespace: "weixinConfig" })
    // The composition's config, so the form can show effective values rather
    // than only what the overlay says. Saved values win for display, since they
    // are what the running plugin actually uses.
    this.config = options.config ?? {}
  }

  /**
   * The whole form: every field, its effective value, and where that came from.
   *
   * `source` matters more than it looks. A value can come from this form, from a
   * profile YAML patch, or from the schema default, and the three behave
   * differently when the overlay is cleared -- an operator who cannot tell them
   * apart will file a bug the first time a reset "does nothing".
   */
  async list() {
    const saved = readSavedConfig()
    const groups = FIELDS.map((group) => ({
      group: group.group,
      groupEn: group.groupEn,
      fields: group.fields.map((field) => {
        const savedValue = readPath(saved, field.path)
        const configValue = readPath(this.config, field.path)
        const hasSaved = savedValue !== undefined
        const hasConfig = configValue !== undefined && configValue !== ''
        const effective = hasSaved ? savedValue : hasConfig ? configValue : field.default
        let source = 'default'
        if (hasSaved) source = 'saved'
        else if (hasConfig) source = 'config'
        return {
          path: field.path,
          type: field.type,
          label: field.label,
          labelEn: field.labelEn,
          hint: field.hint,
          hintEn: field.hintEn,
          value: present(field, effective),
          defaultValue: present(field, field.default),
          source,
          readOnly: READ_ONLY.has(field.path),
          options: field.options ?? undefined,
          min: field.min,
          max: field.max,
          step: field.step,
          unit: field.unit,
          unitEn: field.unitEn,
          // An empty allowlist means "refuse everyone" for senders and "allow
          // all" for chats: opposite meanings, so the card must not render one
          // generic "empty means all" note for both.
          emptyMeansAll: field.emptyMeansAll,
        }
      }),
    }))
    return { groups, configFile: configFile(), stateDir: stateDir() }
  }

  /**
   * Write a batch of edits into the saved overlay.
   *
   * Takes a list rather than one field per call so the form can save a whole
   * section with one write: several round trips would leave the file briefly
   * half-updated, and a failure halfway through would be hard to describe.
   *
   * Every value is validated BEFORE anything is written, so a bad field in the
   * middle of a batch cannot leave the earlier ones applied -- the caller gets
   * one error and the file is untouched.
   */
  async save(entriesJson, lang) {
    const t = (zh, en) => (lang === 'en' ? en : zh)
    // The batch arrives as a JSON string rather than a structured array.
    // The remote wire validates parameters against a declared codec, and the
    // plugin's codec vocabulary (string/number/record/unknown) has no array
    // node -- so an array parameter would be rejected at the gateway before
    // this method ever ran. A JSON string uses the codec that already exists.
    let entries
    try {
      entries = typeof entriesJson === 'string' ? JSON.parse(entriesJson) : entriesJson
    } catch (error) {
      throw new RemoteError('bad_request', t('无法解析要保存的内容', 'Could not parse the values to save'), {})
    }
    if (!Array.isArray(entries)) {
      throw new RemoteError('bad_request', t('缺少要保存的内容', 'Missing the values to save'), {})
    }
    const patch = {}
    for (const entry of entries) {
      const dotted = String(entry?.path ?? '')
      const field = FIELD_BY_PATH.get(dotted)
      if (field === undefined) {
        throw new RemoteError('unknown_field', t(`未知的配置项：${dotted}`, `Unknown option: ${dotted}`), {})
      }
      if (READ_ONLY.has(dotted)) {
        throw new RemoteError('read_only', t(`${t(field.label, field.labelEn)} 不能在界面上修改`, `${t(field.label, field.labelEn)} cannot be edited here`), {})
      }
      const value = coerce(field, entry?.value, t)
      // `undefined` from coerce means "the operator cleared the box": remove the
      // key rather than storing a null, so the schema default applies again.
      if (value === undefined) {
        deletePath(patch, dotted)
        markClear(patch, dotted)
        continue
      }
      writePath(patch, dotted, value)
    }
    const saved = readSavedConfig()
    const next = { ...saved }
    applyPatch(next, patch)
    for (const cleared of clearedPaths(patch)) {
      deletePath(next, cleared)
    }
    writeSavedConfig(next)
    return this.list()
  }

  /** Put one field (or everything) back to the schema default. */
  async reset(pathsJson) {
    // Same wire constraint as `save`: a list travels as a JSON string.
    let paths = pathsJson
    if (typeof pathsJson === 'string') {
      try {
        paths = JSON.parse(pathsJson)
      } catch {
        paths = [pathsJson]
      }
    }
    const list = Array.isArray(paths) ? paths : [paths]
    const saved = readSavedConfig()
    const next = { ...saved }
    for (const dotted of list) {
      const field = FIELD_BY_PATH.get(String(dotted ?? ''))
      if (field === undefined) {
        throw new RemoteError('unknown_field', `未知的配置项：${dotted}`, {})
      }
      deletePath(next, field.path)
    }
    writeSavedConfig(next)
    return this.list()
  }
}

/** Remove `a.b` from an object, pruning a parent left empty by the removal. */
function deletePath(object, dotted) {
  const parts = dotted.split('.')
  const chain = [object]
  let cursor = object
  for (const part of parts.slice(0, -1)) {
    if (cursor === null || typeof cursor !== 'object') return
    cursor = cursor[part]
    chain.push(cursor)
  }
  if (cursor === null || typeof cursor !== 'object') return
  delete cursor[parts.at(-1)]
  // Prune now-empty parents. Without this, clearing `asr.model` and `asr.env`
  // leaves `"asr": {}` behind — harmless to the reader (an empty object merges
  // nothing) but it makes the file look like it still carries settings, and a
  // user comparing the form against the file would think a reset did not work.
  for (let index = chain.length - 1; index > 0; index -= 1) {
    const node = chain[index]
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
    if (Object.keys(node).length === 0) delete chain[index - 1][parts[index - 1]]
  }
}

// A cleared field has to be distinguishable from an absent one inside a single
// batch: both end up with no key, but only the cleared one must DELETE a key
// that already exists in the saved file. The marker travels beside the patch.
const CLEARED = Symbol('cleared')
function markClear(patch, dotted) {
  ;(patch[CLEARED] ??= []).push(dotted)
}
function clearedPaths(patch) {
  return patch[CLEARED] ?? []
}

/** Merge a patch into a target object, one level of nesting deep. */
function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === CLEARED) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const base = target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}
      target[key] = { ...base, ...value }
      continue
    }
    target[key] = value
  }
}

/**
 * Persist the overlay.
 *
 * Written through a temporary file and renamed, so a crash mid-write cannot
 * leave a truncated config.json — which the reader treats as "no settings at
 * all", silently reverting every preference including the sender allowlist.
 */
function writeSavedConfig(config) {
  const file = configFile()
  const dir = path.dirname(file)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // the temporary file is best-effort cleanup
    }
    throw new RemoteError('write_failed', `无法写入 ${file}：${error?.message ?? error}`, {})
  }
}

remoteMethods(ConfigController, ['list', 'save', 'reset'])
