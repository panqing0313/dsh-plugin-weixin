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
