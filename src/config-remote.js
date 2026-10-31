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
        path: "toolAudit",
        type: T.boolean,
        default: true,
        label: "记录工具审计",
        labelEn: "Record a tool audit log",
        hint: "把 agent 每跑一个工具（工具名、截断后的参数、哪个账号/会话/发送者触发、结果是否报错）追加到本地 audit 目录，按天一个 JSONL 文件。想事后查“是谁让它删了那个目录”就靠它。",
        hintEn: "Append one JSONL line per tool run (name, truncated arguments, which account/conversation/sender caused it, whether the result errored) to a per-day file under the local audit directory. This is what answers “who told it to delete that directory” after the fact.",
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
        path: "sendIntervalMs",
        type: T.number,
        default: 1200,
        min: 1,
        max: 60_000,
        step: 100,
        unit: "毫秒",
        unitEn: "ms",
        label: "发送最小间隔",
        labelEn: "Send interval",
        hint: "两条外发消息之间的最小间隔。调低会让长回复更快，但更接近触发账号发信封禁的阈值（实测几分钟内约二十条）。",
        hintEn: "Floor between two outbound sends. Lower is faster for a chunked reply but closer to the measured send-ban threshold (about twenty messages in a few minutes).",
      },
      {
        path: "sendCooldownMs",
        type: T.number,
        default: 30_000,
        min: 1,
        max: 600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "失败后的冷却",
        labelEn: "Cooldown after failures",
        hint: "连续三次发送失败后暂停外发这么久。对正在拒绝的服务端反复重试会把临时拒绝升级成封禁。",
        hintEn: "Stop sending this long after three consecutive failures; retrying a rejecting server is what escalates a temporary rejection into a ban.",
      },
      {
        path: "voiceOutbound",
        type: T.boolean,
        default: false,
        label: "语音发送",
        labelEn: "Voice messages",
        hint: "音频附件（wav/mp3/m4a/ogg/flac/silk 等）按微信语音发出而不是文件。实测 iLink 服务端会接受机器人语音（ret=0）但不投递（2026-06 与 2026-10-26 两次实测），打开后附件可能无声消失，故默认关闭；发送被拒时仍会自动降级为文件。",
        hintEn: "Audio attachments (wav/mp3/m4a/ogg/flac/silk, ...) go out as Weixin voice bubbles instead of files. Measured twice (2026-06, 2026-10-26): the iLink server ACCEPTS a bot voice_item (ret=0) without delivering it, so on-by-default can silently swallow an attachment; a rejected voice send still falls back to a file.",
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
        default: 20_000,
        min: 0,
        max: 3_600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "进度提示延迟",
        labelEn: "Progress note after",
        hint: "只是「在想」时，等这么久还没回复就先发一条进度提示；0 表示关闭。",
        hintEn: "When the turn is only thinking, send one progress note after this long; 0 disables it.",
      },
      {
        path: "progressToolAfterMs",
        type: T.number,
        default: 8_000,
        min: 0,
        max: 3_600_000,
        step: 1_000,
        unit: "毫秒",
        unitEn: "ms",
        label: "跑工具时的提示延迟",
        labelEn: "Progress note while a tool runs",
        hint: "有工具真的在跑（bash、读文件等）时，这么快就发第一条进度提示 —— 用户看得见它在忙，不必等满「进度提示延迟」。0 表示不提前。",
        hintEn: "When a tool is actually running, report after this long instead of waiting for the quiet fallback. 0 disables the early note.",
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
    group: "个性化与记忆",
      groupEn: "Persona & memory",
      fields: [
        {
          path: "personaDefaultMode",
          type: T.string,
          default: "default",
          label: "默认模式",
          labelEn: "Default mode",
          hint: "新会话使用的对话模式 id（默认助手/女友/男友/朋友或自定义）。设置页「个性化」页签可以在线切换，这里的值只是兜底。",
          hintEn: "Mode id new conversations start with (default/girlfriend/boyfriend/friend or a custom one). The Persona tab switches it live; this value is only the fallback.",
        },
        {
          path: "memoryEnabled",
          type: T.boolean,
          default: true,
          label: "记忆",
          labelEn: "Memory",
          hint: "把长期记忆（/remember）、会话摘要和最近消息窗口注入提示词，让回复更懂上下文。",
          hintEn: "Inject long-term facts (/remember), conversation summaries and the recent-message window into prompts.",
        },
        {
          path: "memorySummaryTurns",
          type: T.number,
          default: 10,
          min: 1,
          max: 100,
          step: 1,
          unit: "回合",
          unitEn: "turns",
          label: "会话摘要频率",
          labelEn: "Summary cadence",
          hint: "每这么多回合在后台自动总结一次会话（发送不占用回复）。",
          hintEn: "Summarize the conversation in the background every this many turns (never sends outbound).",
        },
        {
          path: "memoryGlobalMaxFacts",
          type: T.number,
          default: 30,
          min: 1,
          max: 500,
          step: 1,
          unit: "条",
          unitEn: "facts",
          label: "长期记忆上限",
          labelEn: "Long-term memory cap",
          hint: "存满后 /remember 会拒绝新条目而不是挤掉旧的。",
          hintEn: "When full, /remember refuses new facts instead of dropping the oldest.",
        },
        {
          path: "memoryConvMaxChars",
          type: T.number,
          default: 1200,
          min: 100,
          max: 20000,
          step: 100,
          unit: "字符",
          unitEn: "chars",
          label: "会话摘要上限",
          labelEn: "Summary cap",
          hint: "单条会话摘要的最长字符数，超出截断。",
          hintEn: "A conversation summary is clamped to this many characters.",
        },
      {
        path: "memoryGlobalMaxTokens",
        type: T.number,
        default: 0,
        min: 0,
        max: 20000,
        unit: "token",
        unitEn: "tokens",
        label: "记忆块 token 上限",
        labelEn: "Memory block token cap",
        hint: "0 表示只按字符算。中文一个字约一个 token，英文四个字符约一个。换到窗口小的模型时用它压住。",
        hintEn: "0 counts characters only. One Chinese character is about one token, four latin characters about one; set this when the routed model has a tight window.",
      },
        {
          path: "chatProvider",
          type: T.string,
          default: "",
          label: "主对话 provider",
          labelEn: "Chat provider",
          hint: "主对话用哪个 provider；留空沿用 DSH 当前会话模型。和下一项一起填才生效。",
          hintEn: "Provider for the conversation. Empty keeps the session's own model; both halves must be set.",
        },
        {
          path: "chatModel",
          type: T.string,
          default: "",
          label: "主对话 model",
          labelEn: "Chat model",
          hint: "主对话的模型名，例如 glm-5.3-flash。",
          hintEn: "Model for the conversation, e.g. glm-5.3-flash.",
        },
        {
          path: "sideProvider",
          type: T.string,
          default: "",
          label: "后台任务 provider",
          labelEn: "Background provider",
          hint: "/summary、定时订阅到点、主动开口这些侧会话用它；留空先回落到记忆模型，再回落到会话模型。",
          hintEn: "Used by side sessions: /summary, subscription fires, proactive lines. Empty falls back to the memory model, then to the session.",
        },
        {
          path: "sideModel",
          type: T.string,
          default: "",
          label: "后台任务 model",
          labelEn: "Background model",
          hint: "侧会话的模型名；便宜的模型放这里，把贵的那条线路留给对话。",
          hintEn: "Model for side sessions; a cheap model here keeps the expensive route for talking.",
        },
        {
          path: "proactiveProvider",
          type: T.string,
          default: "",
          label: "主动开口 provider",
          labelEn: "Proactive provider",
          hint: "只给主动开口用；留空回落到后台任务路由。开口很短，适合最便宜的模型。",
          hintEn: "Only for proactive lines; empty falls back to the background route. Short prompts suit the cheapest model.",
        },
        {
          path: "proactiveModel",
          type: T.string,
          default: "",
          label: "主动开口 model",
          labelEn: "Proactive model",
          hint: "和上一项一起填才生效。",
          hintEn: "Both halves must be set.",
        },
        {
          path: "reportProvider",
          type: T.string,
          default: "",
          label: "日报 provider",
          labelEn: "Report provider",
          hint: "只给日报与记忆核对用；留空回落到后台任务路由。",
          hintEn: "Only for digests and reviews; empty falls back to the background route.",
        },
        {
          path: "reportModel",
          type: T.string,
          default: "",
          label: "日报 model",
          labelEn: "Report model",
          hint: "和上一项一起填才生效。",
          hintEn: "Both halves must be set.",
        },
        {
          path: "memoryProvider",
          type: T.string,
          default: "",
          label: "记忆模型 provider",
          labelEn: "Memory provider",
          hint: "摘要、抽取和整理用的模型 provider（如 zai）。留空则沿用当前会话的模型。",
          hintEn: "Provider used for summaries, extraction and consolidation. Empty follows the conversation model.",
        },
        {
          path: "memoryModel",
          type: T.string,
          default: "",
          label: "记忆模型 model",
          labelEn: "Memory model",
          hint: "和 provider 一起填才生效。用一个便宜的模型，后台记忆就不会占用贵的那条线路。",
          hintEn: "Only used together with the provider. A cheaper model keeps background memory work off the expensive route.",
        },
        {
          path: "memoryRecentTurns",
          type: T.number,
          default: 5,
          min: 0,
          max: 20,
          step: 1,
          unit: "回合",
          unitEn: "turns",
          label: "冷启动最近消息",
          labelEn: "Cold-start window",
          hint: "新会话线（首条消息、/new、/mode 切换）注入多少条最近消息帮你接上上下文；已接上的会话不再重复注入，0 表示关闭。",
          hintEn: "How many recent messages to repeat when a session line is cold (first message, /new, /mode switch). Resumed lines skip the window; 0 disables it.",
        },
      ],
    },
    {
      group: "陪聊节奏",
      groupEn: "Companion pacing",
      fields: [
        {
          path: "humanPacing",
          type: T.boolean,
          default: true,
          label: "陪聊节奏",
          labelEn: "Companion pacing",
          hint: "角色模式（女友/男友/朋友/贾维斯/小游戏）回复时先停一下再发，并把一段话拆成两三条气泡；「默认助手」模式永远不受影响。",
          hintEn: "In a companion mode the reply waits a beat and arrives as two or three bubbles. The stock assistant is never paced.",
        },
        {
          path: "replyDelayMaxMs",
          type: T.number,
          default: 2400,
          min: 0,
          max: 10000,
          step: 100,
          unit: "毫秒",
          unitEn: "ms",
          label: "首条最多停顿",
          labelEn: "Longest first pause",
          hint: "角色模式回复前最多停顿多久；实际停顿按回复长度抖动，累了会更慢。0 表示不停顿。",
          hintEn: "Longest pause before the first bubble in a companion chat; 0 disables the pause.",
        },
        {
          path: "bubbleSplitMax",
          type: T.number,
          default: 3,
          min: 1,
          max: 5,
          step: 1,
          unit: "条",
          unitEn: "bubbles",
          label: "最多拆几条",
          labelEn: "Max bubbles",
          hint: "一条回复最多拆成几条气泡；1 表示不拆，整段一次发出。",
          hintEn: "How many bubbles one reply may be split into; 1 sends it whole.",
        },
        {
          path: "bubbleGapMs",
          type: T.number,
          default: 700,
          min: 0,
          max: 5000,
          step: 50,
          unit: "毫秒",
          unitEn: "ms",
          label: "气泡之间停顿",
          labelEn: "Gap between bubbles",
          hint: "两条气泡之间的停顿，实际值在 0.7–1.3 倍之间抖动。",
          hintEn: "Pause between two bubbles; the real value jitters between 0.7x and 1.3x.",
        },
        {
          path: "lifeState",
          type: T.boolean,
          default: true,
          label: "生活状态",
          labelEn: "Life state",
          hint: "按时间、距上次聊天多久、今天聊了多少，自动推断角色此刻的心情与精力并注入提示词；「默认助手」模式不注入。",
          hintEn: "Infer the character's mood and energy from the clock and today's chat history, and fold it into the prompt. The stock assistant never gets it.",
        },
        {
          path: "locale",
          type: T.string,
          default: "zh",
          label: "语言",
          labelEn: "Language",
          hint: "zh 或 en；日志始终英文。",
          hintEn: "zh or en. Logs stay English either way.",
        },
        {
          path: "toolNotices",
          type: T.boolean,
          default: true,
          label: "危险工具提醒",
          labelEn: "Dangerous tool notices",
          hint: "Agent 要写文件、删文件或跑命令时，先在微信里告诉你一声，并说明 /cancel 能停掉后面的步骤。插件无法在工具执行前拦截，正在跑的这一步可能已经执行了。",
          hintEn: "Warn in WeChat when the agent reaches for write, delete or command tools, and say that /cancel stops the rest. The plugin cannot veto the call in flight; it may already have run.",
        },
        {
          path: "stickerEnabled",
          type: T.boolean,
          default: true,
          label: "表情图片",
          labelEn: "Sticker images",
          hint: "角色模式下模型可以写 [表情:开心] 换成一张表情图发出（图片气泡；微信协议没有贴纸类型，所以不是可点开的原生表情包）。关掉则连这个标记也不教给模型。",
          hintEn: "In a companion mode the model may write [表情:开心] and the plugin sends the matching image bubble (the protocol has no sticker item). Off means the model is not taught the marker at all.",
        },
      ],
    },
    {
      group: "主动开口",
      groupEn: "Speaks first",
      fields: [
        {
          path: "proactiveEnabled",
          type: T.boolean,
          default: false,
          label: "主动开口",
          labelEn: "Speaks first",
          hint: "角色模式下，对方一段时间没说话时由它先发一条消息（只在时段内、有最短间隔、没被回应会退避、每天有上限）。默认关闭；「默认助手」模式永远不主动。",
          hintEn: "In a companion mode the bot may start the conversation when the user has been quiet. Off by default; the stock assistant never speaks first.",
        },
        {
          path: "proactiveMinGapMinutes",
          type: T.number,
          default: 180,
          min: 10,
          max: 2880,
          step: 10,
          unit: "分钟",
          unitEn: "min",
          label: "最短间隔",
          labelEn: "Minimum gap",
          hint: "距对方最后一条消息至少这么久才会主动开口；也是没被回应时退避的基数（每次翻倍，最多一天）。",
          hintEn: "Wait at least this long after the user's last message; the backoff base when the message goes unanswered (doubles each time, capped at a day).",
        },
        {
          path: "proactiveMaxPerDay",
          type: T.number,
          default: 3,
          min: 1,
          max: 24,
          step: 1,
          unit: "条",
          unitEn: "msgs",
          label: "每天最多",
          labelEn: "Max per day",
          hint: "每个账号每天最多主动发几条。",
          hintEn: "Most proactive messages per account per day.",
        },
        {
          path: "proactiveWindowStart",
          type: T.string,
          default: "09:00",
          label: "时段开始",
          labelEn: "Window start",
          hint: "HH:mm，窗外（含夜里）一律不发。",
          hintEn: "HH:mm — nothing is sent outside this window, nights included.",
        },
        {
          path: "proactiveWindowEnd",
          type: T.string,
          default: "23:00",
          label: "时段结束",
          labelEn: "Window end",
          hint: "HH:mm，必须晚于开始时间；填反了会回落到默认的 09:00–23:00。",
          hintEn: "HH:mm, later than the start; an inverted window falls back to 09:00–23:00.",
        },
      ],
    },
    {
      group: "本地回忆",
      groupEn: "Local recall",
      fields: [
        {
          path: "memoryRecall",
          type: T.boolean,
          default: true,
          label: "本地回忆检索",
          labelEn: "Local recall",
          hint: "消息提到「上次/之前」这类旧事时，在本地消息流水里检索原文并折进提示词；闲聊命中不到就不花 token。",
          hintEn: "When a message refers back to something, search the local journal and fold the matching original lines into the prompt. Small talk costs nothing.",
        },
        {
          path: "memoryRecallDays",
          type: T.number,
          default: 180,
          min: 7,
          max: 3650,
          step: 1,
          unit: "天",
          unitEn: "days",
          label: "回忆检索范围",
          labelEn: "Recall window",
          hint: "本地检索往回找多少天；更早的流水仍然留在磁盘上，只是不进索引。",
          hintEn: "How many days back the local recall index reaches. Older journal files stay on disk.",
        },
        {
          path: "memoryRecallHits",
          type: T.number,
          default: 3,
          min: 1,
          max: 8,
          step: 1,
          unit: "条",
          unitEn: "hits",
          label: "回忆条数",
          labelEn: "Recall hits",
          hint: "一次最多注入几条命中原文（每条截 140 字）。",
          hintEn: "How many matching original messages to inject at most.",
        },
      ],
    },
    {
      group: "限流",
      groupEn: "Pacing",
      fields: [
        { path: "senderRatePerMinute", type: T.number, default: 20, min: 0, max: 600, step: 1, unit: "条/分钟", unitEn: "msgs/min", label: "每人每分钟上限", labelEn: "Per-sender limit", hint: "超过时回一句「慢一点」并写审计；0 表示不限", hintEn: "0 disables the limit" },
        { path: "maxQueuedPerConversation", type: T.number, default: 6, min: 0, max: 100, step: 1, unit: "条", unitEn: "msgs", label: "单会话排队上限", labelEn: "Per-conversation queue", hint: "超过的新消息直接拒收；0 表示不限", hintEn: "0 means unbounded" },
      ],
    },
    {
      group: "汇报",
      groupEn: "Reports",
      fields: [
        { path: "digestEnabled", type: T.boolean, default: true, label: "每天发日报", labelEn: "Daily digest", hint: "到点发一条当天简报（聊了什么、还有哪些待办）；只报流水里的真实数字，不编内容", hintEn: "One message a day: what was talked about and what is still open, from the journal only" },
        { path: "digestWhen", type: T.text, default: "每天 21:00", label: "日报时间", labelEn: "Digest time", hint: "形如「每天 21:00」或「每周五 18:30」；看不懂就当天不发", hintEn: "e.g. 每天 21:00 / 每周五 18:30" },
        { path: "memoryReviewEnabled", type: T.boolean, default: true, label: "每周核对记忆", labelEn: "Weekly memory review", hint: "把记着的事编号列出来问一句「还准吗」，你回 /remember 旧 → 新 或 /forget 编号 纠正", hintEn: "Lists what it remembers and asks if it is still right" },
        { path: "memoryReviewWhen", type: T.text, default: "每周日 20:00", label: "核对时间", labelEn: "Review time", hint: "形如「每周日 20:00」", hintEn: "e.g. 每周日 20:00" },
        { path: "dateReminderEnabled", type: T.boolean, default: true, label: "重要日子当天提醒", labelEn: "Date reminders", hint: "记忆里的生日/纪念日、写死日期的待办，到点发一条短消息；不跑模型", hintEn: "Birthdays, anniversaries and dated to-dos: one short line on the day, no model call" },
        { path: "dateReminderWhen", type: T.text, default: "09:00", label: "提醒时间", labelEn: "Reminder time", hint: "HH:MM（本地时区），只在这一天第一次到点后发一次", hintEn: "HH:MM local; sent once, on the first check after that time" },
      ],
    },
    {
      group: "预演",
      groupEn: "Dry run",
      fields: [
        { path: "dryRun", type: T.boolean, default: false, label: "预演模式", labelEn: "Dry run", hint: "让它先说计划再动手，你回「执行」才真正执行；这不是强制拦截——插件拦不住工具调用", hintEn: "The model plans first and waits for 执行; it is a prompt-level agreement, not a veto" },
      ],
    },
    {
      group: "指标",
      groupEn: "Metrics",
      fields: [
        { path: "metricsExport", type: T.boolean, default: true, label: "写出指标文件", labelEn: "Write metrics files", hint: "每 30 秒写 metrics.json / metrics.prom；npm run metrics 读它，重启后计数归零", hintEn: "Counters reset on restart; read them with npm run metrics" },
      ],
    },
    {
      group: "备份",
      groupEn: "Backups",
      fields: [
        {
          path: "backupEnabled",
          type: T.boolean,
          default: true,
          label: "每天自动备份",
          labelEn: "Daily backup",
          hint: "备份记忆、人设、订阅、流水与账号；放在状态目录的 backups/ 下（含账号 token，别外传）。也可以手动跑 npm run backup create。",
          hintEn: "Copies memory, personas, subscriptions, journal and accounts into <state>/backups. Contains account tokens — keep it local. Manual: npm run backup create.",
        },
        {
          path: "backupKeep",
          type: T.number,
          default: 3,
          min: 1,
          max: 60,
          step: 1,
          unit: "份",
          unitEn: "copies",
          label: "保留份数",
          labelEn: "Copies to keep",
          hint: "更旧的自动备份会被删除（pre-restore 手动恢复副本永远不会被删）。",
          hintEn: "Older automatic backups are removed; pre-restore copies are never pruned.",
        },
      ],
    },
    {
      group: "通知桥",
      groupEn: "Notify bridge",
      fields: [
        {
          path: "notifyEnabled",
          type: T.boolean,
          default: false,
          label: "本地通知桥",
          labelEn: "Local notify bridge",
          hint: "开启后，向 http://127.0.0.1:47832/notify 带 token POST 一句话，就会发到你的微信。适合构建完成、备份、cron 这类提醒；不经过模型，不花 token。token 首次启动自动生成，在状态目录的 notify.json。",
          hintEn: "POST one line with the token to http://127.0.0.1:47832/notify and it lands in WeChat. No model, no tokens. The token is generated on first start into <state>/notify.json.",
        },
        {
          path: "notifyPort",
          type: T.number,
          default: 47832,
          min: 1,
          max: 65535,
          step: 1,
          label: "端口",
          labelEn: "Port",
          hint: "只绑 127.0.0.1；改端口后脚本里的 URL 也要跟着改。",
          hintEn: "Binds 127.0.0.1 only. Scripts must use the same port.",
        },
        {
          path: "notifyToken",
          type: T.string,
          default: "",
          label: "token（留空自动生成）",
          labelEn: "Token (blank = generated)",
          hint: "脚本调用时带的令牌；留空则首次启动自动生成到状态目录的 notify.json（0600）。别把它贴到公开的地方。",
          hintEn: "The bearer token scripts send. Blank generates one into <state>/notify.json (0600) on first start. Do not paste it anywhere public.",
        },
      ],
    },
    {
      group: "离开模式",
      groupEn: "Away mode",
      fields: [
        {
          path: "awayAutoReply",
          type: T.string,
          default: "",
          label: "自动回复",
          labelEn: "Auto-reply",
          hint: "离开模式下每个会话每 30 分钟最多回一句；留空用「我现在不在，看到会回你～（大概 HH:mm 回来）」。窗口内消息不经过模型。",
          hintEn: "Away mode answers at most once per 30 minutes per chat. Blank uses the built-in line with your return time. Messages never reach the model.",
        },
      ],
    },
    {
      group: "保留策略",
      groupEn: "Retention",
      fields: [
        { path: "retentionJournalDays", type: T.number, default: 180, min: 0, max: 3650, step: 1, unit: "天", unitEn: "days", label: "消息流水保留", labelEn: "Journal retention", hint: "0 表示永不清理", hintEn: "0 keeps it forever" },
        { path: "retentionAuditDays", type: T.number, default: 90, min: 0, max: 3650, step: 1, unit: "天", unitEn: "days", label: "审计保留", labelEn: "Audit retention", hint: "0 表示永不清理", hintEn: "0 keeps it forever" },
        { path: "retentionMediaDays", type: T.number, default: 30, min: 0, max: 3650, step: 1, unit: "天", unitEn: "days", label: "媒体保留", labelEn: "Media retention", hint: "收到的图片/文件/语音", hintEn: "inbound images, files and voice" },
        { path: "retentionExportsDays", type: T.number, default: 60, min: 0, max: 3650, step: 1, unit: "天", unitEn: "days", label: "导出保留", labelEn: "Export retention", hint: "/export 生成的 Markdown", hintEn: "markdown written by /export" },
        { path: "retentionLogsDays", type: T.number, default: 30, min: 0, max: 3650, step: 1, unit: "天", unitEn: "days", label: "日志保留", labelEn: "Log retention", hint: "vendor 每日日志", hintEn: "the vendor's daily log" },
      ],
    },
    {
      group: "视频",
      groupEn: "Video",
      fields: [
        { path: "videoFrames", type: T.boolean, default: true, label: "视频抽帧", labelEn: "Sample video frames", hint: "模型读不了视频，用 ffmpeg 抽三帧静图给它看；没装 ffmpeg 或解码失败时只影响那一条视频", hintEn: "The model cannot read video; ffmpeg stills let it look" },
      ],
    },
    {
      group: "文档理解",
      groupEn: "Documents",
      fields: [
        { path: "documentExtract", type: T.boolean, default: true, label: "读取文档正文", labelEn: "Read document text", hint: "docx / txt / md / csv / json 发进来时把正文拼进这一回合的提示，而不是只告诉模型文件存在哪；pdf 需要可选依赖 pdfjs-dist（没装就只给路径）", hintEn: "Put the text of docx/txt/md/csv/json into the turn instead of only its path; PDF needs the optional pdfjs-dist package (without it you only get the path)" },
        { path: "documentTextChars", type: T.number, default: 4000, label: "最多读多少字", labelEn: "Characters per document", hint: "超出的部分截断并注明；一份长合同不必整份塞进上下文", hintEn: "Longer documents are cut with a note; a long contract need not fill the context" },
        { path: "ocrEnabled", type: T.boolean, default: false, label: "识别图片文字", labelEn: "OCR images", hint: "调用外部命令识别图片；插件不内置识别引擎，默认关闭", hintEn: "Runs an external OCR command; no engine is bundled, off by default" },
        { path: "ocrCommand", type: T.text, default: "", label: "OCR 命令", labelEn: "OCR command", hint: "可执行文件的绝对路径，参数是图片路径，stdout 是文字；建议写个 wrapper 接 tesseract 或云 OCR", hintEn: "Absolute path to an executable; image path as its only argument, text on stdout" },
        { path: "ocrTimeoutMs", type: T.number, default: 20000, label: "OCR 超时（毫秒）", labelEn: "OCR timeout (ms)", hint: "超时就杀掉子进程，按「没有文字」处理", hintEn: "Killed after this many ms and treated as no text" },
        { path: "ocrMaxChars", type: T.number, default: 2000, label: "OCR 最多多少字", labelEn: "OCR characters", hint: "每张图最多保留多少字", hintEn: "Characters kept per image" },
      ],
    },
    {
      group: "富内容",
      groupEn: "Rich replies",
      fields: [
        { path: "richContent", type: T.boolean, default: true, label: "富内容", labelEn: "Rich replies", hint: "长代码块改发文件（缩进、语言、行数都在），Markdown 表格转成对齐文本；关掉则一切按纯文本压平", hintEn: "Long code blocks ship as files and tables become aligned text" },
        { path: "codeFileThreshold", type: T.number, default: 1200, min: 200, max: 20000, step: 100, unit: "字", unitEn: "chars", label: "代码块改发文件的阈值", labelEn: "Code block file threshold", hint: "更短的代码块留在气泡里", hintEn: "Shorter blocks stay in the bubble" },
      ],
    },
    {
      group: "群聊",
      groupEn: "Group chats",
      fields: [
        { path: "groupChatEnabled", type: T.boolean, default: false, label: "参加群聊", labelEn: "Answer in groups", hint: "默认关闭：对每条群消息都答的机器人，在真群里就是刷屏；私聊不受影响", hintEn: "Off by default: a bot that answers every group message is spam" },
        { path: "groupReplyWhen", type: T.text, default: "mention", label: "什么时候回", labelEn: "When to answer", hint: "mention 只答被叫到的时候（按首行里的机器人名字匹配）；all 每条都答", hintEn: "mention = only when addressed by name; all = every message" },
        { path: "groupShareMemory", type: T.boolean, default: false, label: "群里也用记忆", labelEn: "Memory in groups", hint: "开启后长期记忆、回忆片段与亲密度行进群回复；默认关闭，那些块是主人的私事", hintEn: "Off by default: those blocks hold the owner's private facts" },
      ],
    },
    {
      group: "静音时段",
    groupEn: "Quiet hours",
    fields: [
      {
        path: "quietHoursEnabled",
        type: T.boolean,
        default: false,
        label: "启用免打扰时段",
        labelEn: "Enable quiet hours",
        hint: "开启后，落在时段内的定时发送（/remind 提醒与 /subscribe 订阅）推迟到时段结束发出；回复消息不受影响。",
        hintEn: "Timed sends (reminders, subscriptions) landing inside the window are pushed to its end; replies are never gated.",
      },
      {
        path: "quietHoursStart",
        type: T.string,
        default: "23:00",
        label: "免打扰开始",
        labelEn: "Quiet from",
        hint: "HH:mm（24 小时制）。",
        hintEn: "HH:mm (24-hour clock).",
      },
      {
        path: "quietHoursEnd",
        type: T.string,
        default: "07:00",
        label: "免打扰结束",
        labelEn: "Quiet until",
        hint: "HH:mm；与开始时间相同视为未配置。",
        hintEn: "HH:mm; equal to the start means not configured.",
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
