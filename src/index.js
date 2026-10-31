/**
 * dsh-weixin — a DSH channel plugin that turns Weixin (personal WeChat, via the
 * iLink Bot API) into a remote control surface for a DSH agent.
 *
 * Contract: a Cordis plugin module exports `name`, `inject` (required services)
 * and `apply(ctx, config)`. Everything registered through `ctx.on` / `ctx.effect`
 * is undone automatically when the plugin unloads, so `apply` only has to wire
 * the pipeline and hand back a disposer.
 *
 * The pipeline, in order, for every inbound Weixin message:
 *   allowlist → dedupe → agent session → markdown filter → chunked reply.
 *
 * Two deliberate safety properties:
 *  - The allowlist is deny-by-default. WeChat text is not an authorization
 *    credential, so a plugin with no allowlist drives nothing at all.
 *  - Credentials live only in a local file under ~/.dsh (0600). This plugin
 *    never accepts a password, and the QR login prints the code locally.
 * @module dsh-weixin
 */
import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { configureWeixinStateDir, accountsDir, ensureSessionsDir, withSavedConfig } from './state.js'
import { quietDelay } from './message/quiet-hours.js'
import { DEFAULT_RETENTION, SWEEP_INTERVAL_MS, describeSweep, directoryUsage, sweepRetention } from './message/retention.js'
import { DEFAULT_KEEP, createBackup } from './backup.js'
import { DEFAULT_DIGEST_WHEN, DEFAULT_REVIEW_WHEN, ReportScheduler, buildDigestPrompt, buildReviewPrompt, describeReport, pickConversation } from './message/reports.js'
import { HEARTBEAT_MS, acquireInstanceLock, heartbeatInstanceLock, releaseInstanceLock } from './instance-lock.js'
import { createOutbox } from './message/outbox.js'
import { configureOutbound, sendChunked, sendProducedFiles, sleep } from './outbound.js'
import { channelFor } from './channel.js'
import { HOOK_POINTS, createHooks } from './hooks.js'
import { createMetrics, writeMetricsSnapshot } from './metrics.js'
import { ensureSecretModes, redactSecrets } from './credentials.js'
import { neutralizeTags } from './message/fence.js'
import { quoteBlock } from './message/quote.js'
import { readScope, scopedConfig } from './config-scope.js'
import { DEFAULT_MAX_QUEUE, DEFAULT_PER_MINUTE, createSenderLimiter } from './message/sender-limit.js'
import { isAllowedSender, denialReason } from './security/allowlist.js'
import { ILinkTransport } from './transport/ilink.js'
import { AgentBridge } from './agent-bridge.js'
import { chunkText } from './message/chunker.js'
import { appendJournal } from './message/journal.js'
import { appendToolAudit } from './message/audit.js'
import { DEFAULT_SEND_INTERVAL_MS, DEFAULT_COOLDOWN_MS } from './message/rate-limit.js'

/**
 * Module-level outbound journal sink, wired once in setup (see sendChunked).
 * `sendChunked` is a module-level function with no apply scope, so the wiring
 * has to cross scopes exactly once — null before setup means "not recording".
 */
let journalOutboundRef = null

/** The durable outbox for undelivered text; set once the plugin's setup runs. */
let hooks
/** Counters the settings card reads (src/metrics.js); process lifetime only. */
let metrics
let metricsTimer
/** ④ One audit line per unfamiliar shape per conversation, not one per message. */
const unknownItemSeen = new Set()
let outbox
import { MessageDeduper } from './message/dedupe.js'
import { markdownToPlainText, resolveMarkdownMode } from './message/markdown.js'
import { extractUrls, fetchLinkText, describeLinkResults } from './message/links.js'
import { ReminderScheduler, parseWhen } from './message/scheduler.js'
import { createAwayCommands, readAway, noteMissed, buildAwayReply, awaySummary, clearAway } from './message/away.js'
import { datesOnThisDay, buildDateReminderText, dateReminderDue, markDateReminderSent } from './message/dates.js'
import { createListCommands } from './message/lists.js'
import { createReadingCommands } from './message/reading.js'
import { createSendCommands } from './message/send-file.js'
import { SubscriptionScheduler, formatStamp } from './message/subscriptions.js'
import { allowedMediaDirs, deliverOutboundMedia, DEFAULT_MAX_MEDIA_BYTES, listProducedFiles } from './media/outbound.js'
import { AsrBridge, DEFAULT_ASR_TIMEOUT_MS, resolveAsrSettings } from './media/asr.js'
import { DEFAULT_DOCUMENT_CHARS, extractDocumentTextAsync } from './media/document.js'
import { resolveOcrSettings, extractImageText } from './media/ocr.js'
import { WeixinLoginController } from './login-remote.js'
import { AsrController } from './asr-remote.js'
import { ConfigController } from './config-remote.js'
import { isAccountPaused, touchAccount, allowlistForAccount, readRegistry, enrolFirstContact } from './account-registry.js'
// `/cancel` is the one message the transport must be able to deliver while a
// turn is still running; the predicate lives beside the parser so the two
// cannot drift apart.
import { isInterruptCommand } from './sessions.js'
// Persona modes + conversation memory: the prompt seam and the /mode,
// /remember, /forget, /memory handlers both need the same store.
import {
  buildPersonaBlock,
  readPersonaStore,
  resolveMode,
  activeModeFor,
  setActiveMode,
  DEFAULT_MODE_ID,
} from './persona.js'
import {
  buildMemoryBlock,
  readGlobalMemory,
  readConvMemory,
  readRecentWindow,
  addGlobalFact,
  removeGlobalFact,
  bondLine,
  formatEvents,
  formatProfile,
  listConvMemories,
  setConvRecentSession,
  openThreadLines,
} from './memory.js'
import { queryRecall, shouldRecall, buildRecallBlock, formatRecallHits } from './message/recall.js'
import { planCompanionReply, buildHumanStyleBlock, isCompanionMode } from './message/human-pace.js'
import { groupReplyPolicy, groupSharesMemory, isGroupMessage } from './message/groups.js'
import { classifyToolCall, noticeText } from './message/tool-guard.js'
import { createTranslator, resolveLocale } from './i18n.js'
import { routeFor, sideRouteFor } from './model-route.js'
import { readOrInferLifeState, lifeBlock } from './message/life-state.js'
import { readJournalRange, renderChatMarkdown, writeChatExport } from './message/chat-export.js'
import { createNotifyServer, DEFAULT_NOTIFY_PORT, ensureNotifyToken } from './notify.js'
import { buildContactBlock, listContacts, readContact, saveContact, touchContact } from './message/contacts.js'
import { describeAffinity, readAffinityHistory, recordAffinitySnapshot } from './message/affinity-history.js'
import { buildDryRunBlock, describeDryRun, isGoAhead } from './message/dry-run.js'
import { describeUnknownItems, firstSighting } from './message/unknown-items.js'
import { statePaths } from './state-layout.js'
import { createMemorySummarizer } from './memory-summarizer.js'
import { ProactiveScheduler } from './message/proactive.js'
import { MAX_STICKERS_PER_REPLY, stickerPath, takeStickers } from './message/stickers.js'
// The vendored logger is the only channel guaranteed to land on disk at INFO:
// ctx.logger can drop levels depending on the host's exporter config, and a
// refusal that leaves no trace turns an allowlist mismatch into "the bot just
// ignores me" with nothing to grep afterwards.
import { logger as vendorLogger } from '../vendor/openclaw-weixin/util/logger.js'
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  downloadInboundMedia,
  downloadInboundVoice,
  describeInboundMedia,
  describeMediaFailures,
} from './media/inbound.js'

export const name = 'dsh-weixin'

/**
 * Directory this file was loaded from — the plugin package root (one level
 * above `src/`), in the repository, in a profile install, and in an npm install
 * alike. The shipped ASR bridge lives at `<root>/bin/asr-bridge.py`, and the
 * operator is invited to point `asr.args` at that path; using this as the
 * child's cwd makes a *relative* bridge path work too, regardless of the
 * directory the DSH host happened to be started in.
 */
const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `agents` is required: without it there is no session to drive, so the plugin
 * would load and then silently do nothing. Everything else (settings, sessions,
 * the workspace registry) is optional and read through `ctx.get`, because a
 * missing grouping service must cost the GUI group label — not the ability to
 * reply.
 */
export const inject = ['agents']

/**
 * Every deploy-varying value is a config field rather than a constant, and an
 * invalid value fails load loudly instead of being clamped at runtime.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the Weixin long-poll loop when the plugin loads.'),
  accountId: z.string().default('').description('Weixin account id to use; empty means the only saved account.'),
  cwd: z.string().default('').description('Working directory the agent operates in; empty inherits the session default.'),
  allowedSenders: z.array(z.string()).default([]).description('Weixin user ids allowed to drive the agent. Empty denies everyone.'),
  allowedChats: z.array(z.string()).default([]).description('Optional conversation allowlist. Empty allows any conversation from an allowed sender.'),
  maxMessageLength: z.number().default(1500).description('Maximum characters per outbound Weixin message.'),
  sendIntervalMs: z.number().min(1).default(DEFAULT_SEND_INTERVAL_MS).description('Minimum interval between two outbound Weixin sends, in milliseconds. Raising it costs latency on a chunked reply; lowering it moves closer to the measured send-ban threshold (about twenty messages in a few minutes).'),
  sendCooldownMs: z.number().min(1).default(DEFAULT_COOLDOWN_MS).description('How long to stop sending after three consecutive send failures, in milliseconds. Hammering a rejecting server is what turns a temporary rejection into an account ban.'),
  voiceOutbound: z.boolean().default(false).description(
    'Send audio attachments (wav, mp3, m4a, ogg, flac, silk, ...) as Weixin voice messages instead of file attachments. wav and silk are transcoded in-process; the rest need ffmpeg on PATH. A voice send that FAILS falls back to the plain file path — but the iLink server currently ACCEPTS a bot voice_item (ret=0) without ever delivering it (measured 2026-06 and again 2026-10-26 with a fresh token; upload and send both succeed), so with this on an audio attachment can silently vanish. Off by default until the server actually delivers bot voice.',
  ),
  messageJournal: z.boolean().default(true).description('Record recent inbound and outbound messages (message journal, shown on the settings card).'),
  personaDefaultMode: z.string().default(DEFAULT_MODE_ID).description(
    'The conversation style used when a Weixin chat has not picked one with /mode. Built-in modes: default (plain assistant), girlfriend 女友, boyfriend 男友, friend 朋友; custom modes are edited on the settings card\'s 个性化 tab. An unknown id here quietly falls back to default.',
  ),
  memoryEnabled: z.boolean().default(true).description(
    'Inject a <weixin_memory> block into every prompt: global facts saved with /remember, the conversation\'s rolling summary (refreshed automatically every memorySummaryTurns turns), and the last few messages of this chat. /memory shows what is stored, /forget deletes. Turning this off stops the injection AND the /remember /forget commands.',
  ),
  memorySummaryTurns: z.number().min(1).default(10).description(
    'How often (in agent turns per conversation) the background summarizer rewrites the conversation summary. The summarizer runs as a hidden side turn after a real turn finishes; it never sends anything to WeChat. 1 disables nothing — set memoryEnabled false for that.',
  ),
  memoryGlobalMaxFacts: z.number().min(1).default(30).description('How many global /remember facts to keep per account. Full refuses new facts instead of silently dropping the oldest — delete some with /forget.'),
  memoryConvMaxChars: z.number().min(1).default(1200).description('Character budget for the conversation summary in the injected memory block.'),
  memoryGlobalMaxTokens: z.number().min(0).default(0).description('Optional cap on the long-term memory block measured in estimated tokens (0 = count characters only). One Chinese character is about one token, four latin characters about one; set this when routing to a model with a tight window.'),
  // C20: the conversation gets the good model; background work (summaries,
  // proactive lines, subscription fires) can be pointed at a cheaper route
  // without touching the chat. Empty means "whatever the session uses".
  chatProvider: z.string().default('').description('主对话模型 provider：留空沿用 DSH 当前会话模型。只填 provider 或只填 model 都不生效。'),
  chatModel: z.string().default('').description('主对话模型 model：和 chatProvider 一起填才生效。'),
  sideProvider: z.string().default('').description('后台任务模型 provider：/summary、/subscribe 到点、主动开口这类侧会话用它；留空则回落到记忆模型，再回落到会话模型。'),
  sideModel: z.string().default('').description('后台任务模型 model：和 sideProvider 一起填才生效。'),
  documentExtract: z.boolean().default(true).description('Extract the text of an inbound document (docx/txt/md/csv/json) into the turn, instead of only telling the model where it was saved. PDF needs the optional pdfjs-dist package; without it a PDF is only described by its path.'),
  ocrEnabled: z.boolean().default(false).description('Run an external OCR command on inbound images and put the text into the turn. Off by default: the plugin ships no OCR engine.'),
  ocrCommand: z.string().default('').description('Absolute path to an OCR executable. It is called with the image path as its only argument; stdout must be the text. A small wrapper script is the intended way to adapt tesseract or a cloud CLI.'),
  ocrTimeoutMs: z.number().default(20000).description('Kill the OCR command after this many milliseconds.'),
  ocrMaxChars: z.number().default(2000).description('Keep at most this many characters of OCR text per image.'),
  documentTextChars: z.number().min(200).max(20000).default(4000).description('How many characters of an inbound document to put into the prompt; the rest is cut with a note.'),
  proactiveProvider: z.string().default('').description('主动开口 provider：只给「主动开口」用，留空回落到后台任务路由。'),
  proactiveModel: z.string().default('').description('主动开口 model：和 proactiveProvider 一起填才生效。'),
  reportProvider: z.string().default('').description('日报/记忆核对 provider：只给定时报告用，留空回落到后台任务路由。'),
  reportModel: z.string().default('').description('日报/记忆核对 model：和 reportProvider 一起填才生效。'),
  memoryProvider: z.string().default('').description('Provider for the memory model (summaries, fact extraction and consolidation). Empty follows the conversation model — the summaries then cost exactly what a normal turn costs.'),
  memoryModel: z.string().default('').description('Model id for the memory model. Only used together with memoryProvider; a cheaper model here keeps background memory work off the expensive route.'),
  memoryRecentTurns: z.number().min(0).default(5).description(
    'How many recent user/assistant messages, at most, the memory block repeats back to the model. Only used when a conversation line is COLD (a brand new session: first message, /new, /mode switch, or a line whose session no longer holds the history) — a resumed line already carries those messages in its own history, so repeating them every turn would spend tokens on nothing. 0 turns the window off entirely.',
  ),
  memoryRecall: z.boolean().default(true).description(
    'Search the local message journal for the current message and inject the matching original lines as a <weixin_recall> block. Only fires when the message looks like it refers back to something (上次/之前/那天…) or scores high enough — small talk matches nothing and costs zero tokens. /recall queries by hand without spending any.',
  ),
  memoryRecallDays: z.number().min(7).max(3650).default(180).description('How many days back the local recall index reaches. Older day files leave the index (the journal itself is still on disk).'),
  memoryRecallHits: z.number().min(1).max(8).default(3).description('How many matching original messages to inject at most, each truncated to 140 characters.'),
  humanPacing: z.boolean().default(true).description(
    '陪聊节奏：角色模式（女友/男友/朋友/贾维斯/小游戏等）回复时先停顿一下再发，并把一段话拆成两三条气泡；「默认助手」模式永远不受影响。',
  ),
  replyDelayMaxMs: z.number().min(0).max(10000).default(2400).description('角色模式回复前最多停顿多久（毫秒），0 表示不停顿；实际停顿按回复长度抖动，累了会更慢。'),
  bubbleSplitMax: z.number().min(1).max(5).default(3).description('角色模式一条回复最多拆成几条气泡；1 表示不拆。'),
  bubbleGapMs: z.number().min(0).max(5000).default(700).description('角色模式两条气泡之间的停顿（毫秒），实际值会在 0.7–1.3 倍之间抖动。'),
  lifeState: z.boolean().default(true).description(
    '生活状态：按时间、距上次聊天多久、今天聊了多少，自动推断角色此刻的心情/在做什么/精力，注入到提示词里；「默认助手」模式不注入。',
  ),
  stickerEnabled: z.boolean().default(true).description(
    '表情图片：角色模式下模型可以在回复里写 [表情:开心]，插件发一张对应的表情图（图片气泡）。微信协议没有贴纸消息类型，所以只能是图片，不是可点开的原生表情包；关掉则连这个标记也不教给模型。',
  ),
  proactiveEnabled: z.boolean().default(false).description(
    '主动开口：角色模式下，对方一段时间没说话时由它先发一条消息（只在设定的时段内、每条之间有最短间隔、没被回应会退避、每天有上限）。默认关闭——一个工具不该自己找你；「默认助手」模式永远不主动。',
  ),
  proactiveMinGapMinutes: z.number().min(10).max(2880).default(180).description('主动消息的最短间隔（分钟）：距对方最后一条消息至少这么久才会开口，也是没被回应时退避的基数。'),
  proactiveMaxPerDay: z.number().min(1).max(24).default(3).description('每个账号每天最多主动发几条。'),
  proactiveWindowStart: z.string().default('09:00').description('主动消息的时间窗开始，HH:mm；窗外（含夜里）一律不发。'),
  proactiveWindowEnd: z.string().default('23:00').description('主动消息的时间窗结束，HH:mm；必须晚于开始时间。'),
  groupChatEnabled: z.boolean().default(false).description('参加群聊：开启后才会在群里回话。默认关闭——一个对每条群消息都答的机器人，在真群里就是刷屏。私聊不受影响。'),
  groupReplyWhen: z.string().default('mention').description('群里什么时候回：mention 只答被叫到的时候，all 每条都答。iLink 不给 @ 列表，因此按首行里的机器人名字匹配。'),
  groupShareMemory: z.boolean().default(false).description('把长期记忆、回忆片段和亲密度行也注入群回复。默认关闭：那些块里是主人自己的私事。'),
  videoFrames: z.boolean().default(true).description('收到视频时用本机 ffmpeg 抽几帧静图交给模型（模型读不了视频，但能看图）。需要的机器上装了 ffmpeg；抽帧失败只影响那一条视频的内容理解，文件照常保存。'),
  richContent: z.boolean().default(true).description('富内容：长代码块作为文件附件发出、Markdown 表格转成对齐文本。微信只有纯文本气泡，这两处是 Markdown 里最容易在纯文本里变形的东西。'),
  codeFileThreshold: z.number().min(200).max(20000).default(1200).description('代码块超过多少字就改成发文件；更短的留在气泡里（两行代码读起来比附件顺）。'),
  // C15: the plugin cannot veto a tool call (DSH exposes no approval hook to
  // plugins), so it does the honest half: tell the owner when a turn reaches
  // for something that writes, deletes or runs a command, while /cancel can
  // still stop whatever comes next.
  // C33: the catalogue covers user-visible chatter (command help, notices);
  // logs stay English because they are read in files by one operator.
  locale: z.string().default('zh').description('界面与微信里回复的语言：zh（中文，默认）或 en（English）。日志始终英文。'),
  toolNotices: z.boolean().default(true).description('危险工具提醒：Agent 要执行写文件、删文件、跑命令之类的工具时，先在微信里告诉你一声（/cancel 可中止后续步骤）。插件无法在工具执行前拦截，这一步可能已经跑了。'),
  quietHoursEnabled: z.boolean().default(false).description('免打扰时段：到点的定时发送（/remind 提醒和 /subscribe 订阅）若落在时段内，推迟到时段结束时发出。回复消息不受影响。'),
  quietHoursStart: z.string().default('23:00').description('免打扰开始时间，HH:mm（24 小时制）。'),
  quietHoursEnd: z.string().default('07:00').description('免打扰结束时间，HH:mm（24 小时制）；与开始时间相同视为未配置。'),
  senderRatePerMinute: z.number().min(0).default(DEFAULT_PER_MINUTE).description('每个发送者每分钟最多几条消息；0 表示不限。超过时回一句「慢一点」，并写审计。'),
  maxQueuedPerConversation: z.number().min(0).default(DEFAULT_MAX_QUEUE).description('单个会话允许排队等回复的消息条数；0 表示不限制。超过的直接拒收，避免越堆越多。'),
  retentionJournalDays: z.number().min(0).default(180).description('消息流水保留天数；0 表示不清理。设置卡「统计」页签显示磁盘占用。'),
  retentionAuditDays: z.number().min(0).default(90).description('工具审计保留天数；0 表示不清理。'),
  retentionMediaDays: z.number().min(0).default(30).description('收到的图片/文件/语音保留天数；0 表示不清理。'),
  retentionExportsDays: z.number().min(0).default(60).description('/export 导出的 Markdown 保留天数；0 表示不清理。'),
  retentionLogsDays: z.number().min(0).default(30).description('vendor 每日日志保留天数；0 表示不清理。'),
  dryRun: z.boolean().default(false).description('预演模式：让模型先给计划再动手，你回「执行」才真正执行。这不是强制拦截——插件拦不住工具调用，它只是让模型先说后做，所以危险工具提醒仍然同时生效。'),
  metricsExport: z.boolean().default(true).description('每 30 秒把指标写到状态目录的 metrics.json / metrics.prom，方便外部抓取（npm run metrics 读取）。'),
  backupEnabled: z.boolean().default(true).description('每天自动备份一次状态目录（记忆、人设、订阅、流水、账号）；备份在 <状态目录>/backups，含账号 token，别外传。'),
  backupKeep: z.number().min(1).max(60).default(DEFAULT_KEEP).description('保留最近几份自动备份；更旧的会被删掉。'),
  notifyEnabled: z.boolean().default(false).description('本地通知桥：开启后向 http://127.0.0.1:47832/notify POST 一句话就能推到你的微信（构建、备份、cron 用）。只绑回环地址、必须带 token、不经过模型。'),
  notifyPort: z.number().min(1).max(65535).default(DEFAULT_NOTIFY_PORT).description('通知桥监听端口；脚本里的 URL 要跟着改。'),
  notifyToken: z.string().default('').description('通知桥的 token；留空则首次启动自动生成，存在 <状态目录>/notify.json（0600），不要外传。'),
  awayAutoReply: z.string().default('').description('离开模式的自动回复；留空用「我现在不在，看到会回你～（大概 HH:mm 回来）」。'),
  dateReminderEnabled: z.boolean().default(true).description('重要日子的当天提醒：记忆里的生日/纪念日、以及写死日期的待办，到点发一条短消息，不跑模型。'),
  dateReminderWhen: z.string().default('09:00').description('当天提醒的发送时间（HH:MM，本地时区）。'),
  digestEnabled: z.boolean().default(true).description('每天到点发一条当天简报（聊了什么、还有哪些待办）；时间由 digestWhen 决定。'),
  digestWhen: z.string().default(DEFAULT_DIGEST_WHEN).description('日报时间，形如「每天 21:00」或「每周五 18:30」。'),
  memoryReviewEnabled: z.boolean().default(true).description('每周到点发一条记忆核对：「我记住的这些还准吗」，你回 /remember 或 /forget 纠正。'),
  memoryReviewWhen: z.string().default(DEFAULT_REVIEW_WHEN).description('记忆核对时间，形如「每周日 20:00」。'),
  toolAudit: z.boolean().default(true).description(
    'Append one JSONL line per tool the agent runs (tool name, truncated arguments, which Weixin account/conversation/sender caused it, and whether the result carried an error) under <state>/audit/. Off by default nothing would ever answer "who ran that destructive tool yesterday"; a missing directory or a full disk only warns, it never fails a turn.',
  ),
  markdownMode: z
    .union([z.const('strip'), z.const('off')])
    .default('strip')
    .description('How to render the agent Markdown reply for WeChat: "strip" filters unsupported syntax, "off" sends it verbatim.'),
  busyMessageMode: z
    .union([z.const('queue'), z.const('steer')])
    .default('queue')
    .description('What happens to a message that arrives while a reply is still being written: "queue" waits and delivers it as the next turn, "steer" injects it into the running turn. "/steer <instruction>" always injects.'),
  sourceContext: z.boolean().default(false).description('Prepend a <weixin_source …> block to each prompt so the agent knows the message came from WeChat and who sent it.'),
  readLinks: z.boolean().default(true).description('When an inbound message contains http(s) links, fetch each one and fold the readable text into the prompt, so the agent can answer questions about the page. A link that fails to fetch is reported to the agent as one line, never as a failed message.'),
  progressAfterMs: z.number().default(20_000).description('Send the first progress note to the user after this many milliseconds (a turn that is only thinking).'),
  progressToolAfterMs: z.number().min(0).default(8_000).description('Send the first progress note sooner - after this many milliseconds - when a tool is actually running. 0 disables the early note.'),
  progressEveryMs: z.number().default(60_000).description('Re-send a changed progress note at most this often, so tool changes stay visible without repeating an unchanged state.'),
  maxTurnWaitMs: z.number().default(1_200_000).description('Give up waiting for a turn after this many milliseconds.'),
  typingIndicator: z.boolean().default(true).description('Show a typing indicator while the agent works, when a typing ticket is available.'),
  mediaEnabled: z.boolean().default(true).description('Send local files the agent references in its reply as Weixin images/videos/file attachments.'),
  autoSendFiles: z.boolean().default(true).description('Also deliver files the agent wrote into its working directory during a turn, even when the reply text never references them.'),
  maxMediaBytes: z.number().default(DEFAULT_MAX_MEDIA_BYTES).description('Largest referenced file that will be uploaded to the Weixin CDN.'),
  maxInboundMediaBytes: z
    .number()
    .default(DEFAULT_MAX_INBOUND_MEDIA_BYTES)
    .description('Largest attachment this channel will download from the Weixin CDN.'),
  cdnBaseUrl: z
    .string()
    .default('')
    .description(
      'Weixin CDN root for inbound media downloads and outbound uploads. Empty means "not configured here", which lets a saved account record supply it before falling back to the upstream default.',
    ),
  asr: z
    .object({
      enabled: z.boolean().default(true).description('Transcribe inbound voice messages; false keeps them as SILK/WAV files only.'),
      command: z
        .string()
        .default('')
        .description(
          'Executable of a line-oriented ASR bridge (one JSON request per line on stdin, one JSON response per line on stdout). Empty disables transcription.',
        ),
      args: z.array(z.string()).default([]).description('Arguments passed to the ASR bridge executable.'),
      timeoutMs: z.number().default(DEFAULT_ASR_TIMEOUT_MS).description('Give up on one transcription after this many milliseconds.'),
      env: z
        .dict(z.string())
        .default({})
        .description('Extra environment for the ASR bridge, e.g. HF_HOME, DSH_WEIXIN_ASR_MODEL or DSH_WEIXIN_ASR_LANGUAGE.'),
      model: z
        .string()
        .default('')
        .description(
          'Whisper model location for transcription. A Hugging Face repo id (mlx-community/whisper-small-mlx) or an absolute path to a local model directory. Empty lets the ASR bridge default apply.',
        ),
      modelDir: z
        .string()
        .default('')
        .description(
          'Directory where downloadable voice models are stored and looked up. Empty defaults to ~/.dsh/weixin/asr-models.',
        ),
      hfProxy: z
        .string()
        .default('')
        .description(
          'Proxy for the model downloader (e.g. http://127.0.0.1:7897). HTTPS destinations are tunnelled with CONNECT. Leave empty to connect directly, which is what the default mirror needs. Set this only on a network that cannot reach the mirror at all: the download is then exactly as fast as the proxy, and no faster.',
        ),
      hfEndpoint: z
        .string()
        .default('https://hf-mirror.com')
        .description(
          'Endpoint the model downloader fetches from. Defaults to https://hf-mirror.com, which is reachable from mainland China without a proxy and serves weights at high speed. Set it to https://huggingface.co to use the official site, or to a corporate mirror. The download is a plain HTTP transfer: it is exactly as fast as the route to this host, and no faster.',
        ),
    })
    .default({})
    .description('Voice transcription through an external bridge process. Absent or empty command means voice notes are delivered as files.'),
})

/**
 * @param {any} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {

  // Must precede any credential/sync-buffer path resolution in the vendored
  // transport, which reads OPENCLAW_STATE_DIR on every call.
  const stateRoot = configureWeixinStateDir()
  // The account file holds the bot token and is written by the vendored login
  // flow, so its mode is whatever the umask allowed. Fix it here, once per start.
  const secretFix = ensureSecretModes(stateRoot, { warn: (line) => ctx.logger?.warn?.(`dsh-weixin: ${line}`) })
  if (secretFix.tightened.length > 0) {
    ctx.logger?.info?.(`dsh-weixin: tightened permissions on ${secretFix.tightened.length} credential file(s)`)
  }
  // Every log line goes through the redactor: one thrown error that happens to
  // carry the bot token used to put it on disk, because `warn` is where all the
  // failure paths end up (src/credentials.js).
  const log = (line) => ctx.logger?.info?.(`dsh-weixin: ${redactSecrets(String(line))}`)
  const warn = (line) => ctx.logger?.warn?.(`dsh-weixin: ${redactSecrets(String(line))}`)
  const fileLog = vendorLogger.withAccount('dsh-weixin')

  // Settings the operator saved through the UI live beside the credentials, so
  // they survive a reinstall of the package. They fill in what the composition
  // did not set; an explicit value in the profile YAML still wins, because the
  // YAML is the live decision and an overlay must not make it lie.
  config = withSavedConfig(config ?? {})

  const disabled = config.enabled === false
  if (disabled) {
    // Deliberately NOT an early return. The settings card is the only way to
    // turn the plugin back on, and it reads its own options from the
    // ConfigController registered below -- so returning here would leave a
    // disabled plugin with a card that cannot reach the very switch that
    // re-enables it. The controllers register first; only the long-poll loop is
    // skipped.
    log('disabled by configuration; registering the settings services and starting no loop')
  }

  // Settings-page services: QR login orchestration, ASR model management, and
  // the options form. Registered regardless of enabled so a disabled plugin can
  // still be configured and logged in from the UI before being turned on.
  //
  // Kept in a variable because the poll loop reports a refused session back to
  // it (markSessionExpired), which is what lets the card say "log in again"
  // instead of showing a healthy-looking bound account that receives nothing.
  //
  // Constructing a Cordis `Service` IS the registration: the base class calls
  // `ctx.reflect.provide(name, self, ...)` in its own constructor, so the
  // instance is reachable on the context immediately and is disposed with the
  // plugin's fiber. Do NOT also hand it to `ctx.plugin()` — a plugin must be a
  // function or an object with `apply`, and a service instance is neither, so
  // that call throws "invalid plugin, expect function or object with an "apply"
  // method, received object".
  //
  // That throw used to sit inside these try blocks, where it was recorded as
  // "settings login service unavailable" and the controller was set to
  // `undefined`. Nothing looked broken — the poll loop started, the card
  // rendered, a scan wrote a credential — but there was no controller left to
  // hear "the login finished", so the inbound loop never moved to the new
  // credential and WeChat kept reporting that it could not reach openclaw.
  let loginController
  try {
    loginController = new WeixinLoginController(ctx, {})
  } catch (error) {
    warn(`settings login service unavailable: ${String(error)}`)
    loginController = undefined
  }
  // Kept in a variable because the settings UI can change the model directory
  // at runtime (setModelDir); the ASR bridge must use the current value, not
  // the one the process started with.
  let asrController
  try {
    // Same as the login controller above: the Service constructor registers
    // itself, and passing the instance to `ctx.plugin()` throws. That throw used
    // to be swallowed here too, which silently disabled the whole ASR service.
    asrController = new AsrController(ctx, {
      modelDir: config.asr?.modelDir?.trim() || undefined,
      hfEndpoint: config.asr?.hfEndpoint?.trim() || undefined,
      hfProxy: config.asr?.hfProxy?.trim() || undefined,
    })
  } catch (error) {
    warn(`settings ASR service unavailable: ${String(error)}`)
    asrController = undefined
  }
  // The settings form's view of every configurable option. It is handed the
  // *merged* config so the form can show effective values, and it reads the
  // saved overlay itself on every call — so a value written from the form, or
  // by hand while DSH is running, is reflected without a reload.
  let configController
  try {
    configController = new ConfigController(ctx, { config })
  } catch (error) {
    warn(`settings config service unavailable: ${String(error)}`)
    configController = undefined
  }
  // Constructing it IS the registration, so there is nothing else to do with
  // the reference here; it is kept for the effect below, which asserts the
  // service outlived the try block before anything tries to read options.
  if (configController === undefined) warn('the options form will not be available')

  ctx.effect(() => {
    let cancelled = false
    /**
     * One transport per bound account, keyed by accountId. Multi-account is
     * the steady state now: each account owns a long poll, its own deduper and
     * its own backoff, so one account's stall never blocks another's traffic.
     * The map replaces the single `transport` variable that assumed exactly
     * one account could be bound.
     * @type {Map<string, ILinkTransport>}
     */
    const transports = new Map()
    // C15: one notice per tool per conversation per window. A turn that runs
    // ten bash commands is still one turn, and a stuck loop must not become a
    // stream of warnings.
    const noticedTools = new Map()
    /** Same tool, same conversation: stay quiet for ten minutes. */
    const TOOL_NOTICE_WINDOW_MS = 10 * 60_000
    /** @type {AgentBridge | undefined} */
    let bridge
    /** @type {ReturnType<typeof createMemorySummarizer> | undefined} */
    let memorySummarizer
    /** @type {AsrBridge | undefined} */
    let asrBridge
    /** @type {string} */
    let cwd
    let reminderScheduler
    let subscriptionScheduler
    let proactiveScheduler
    let retentionTimer
    let reportScheduler
    let notifyBridge
    let awayTimer
    let dateTimer
    const backupTimers = []
    let lockHeartbeat
    // Declared in apply() scope on purpose: bringUpLoop() builds the gate
    // closure and is a sibling of setup(), not a child of it.
    let senderLimiter
    // C20: declared here (not inside setup) because bringUpAccount, which is a
    // sibling of setup(), hands it to createInboundHandler.
    let sideRoute = () => undefined
    // Serializes loop hand-offs across ALL accounts. A login can complete while
    // a previous hand-off is still tearing a transport down, and two live loops
    // on one credential deliver every inbound message twice — the server hands
    // it to whichever poll arrives first. One chain keeps the whole effect's
    // bring-up/tear-down operations strictly ordered.
    let handoff = Promise.resolve()

    // Working directory, agent bridge and voice bridge do not depend on which
    // account is bound, so they are built once and reused when a re-login swaps
    // the transport underneath them.
    //
    // Startup is async (working directory, account lookup, typing ticket, loop
    // start), but the effect disposer is synchronous-safe: it awaits the startup
    // promise, then tears down whatever got as far as existing.
    const setup = (async () => {
      cwd = await resolveCwd(ctx, config, warn)
      bridge = new AgentBridge({
        ctx,
        cwd,
        progressAfterMs: config.progressAfterMs,
        progressToolAfterMs: config.progressToolAfterMs,
        progressEveryMs: config.progressEveryMs,
        maxWaitMs: config.maxTurnWaitMs,
        log,
        errLog: warn,
        // Tool audit lands on disk, not in the log: the log rotates away, and
        // the question this answers ("who triggered that tool, with what
        // arguments") is asked after the fact. Wired here rather than inside
        // the bridge so the bridge stays testable without a state root.
        ...(config.toolAudit === false
          ? {}
          : { onToolAudit: (entry) => appendToolAudit(stateRoot, entry, { warn }) }),
        // C15: the honest half of "approve tools in WeChat". The plugin cannot
        // veto a call, but it can say so while the turn is still running, and
        // /cancel stops everything after the call in flight. One notice per
        // tool per turn: a turn that runs ten bash commands is still one turn.
        // C20: the conversation's route, re-read per turn so a card edit lands
        // without restarting the plugin.
        chatRoute: () => routeFor('chat', withSavedConfig(config)),
        onToolCall: (entry) => {
          if (withSavedConfig(config).toolNotices === false) return
          const verdict = classifyToolCall({ tool: entry.tool, args: entry.args })
          if (verdict.dangerous === false) return
          const key = `${entry.conversationId}|${entry.sessionId}|${verdict.tool}`
          const seen = noticedTools.get(key)
          const bucket = seen === undefined || Date.now() - seen > TOOL_NOTICE_WINDOW_MS ? 0 : seen
          if (bucket !== 0) return
          noticedTools.set(key, Date.now())
          const liveTransport = transports.get(entry.accountId)
          if (liveTransport === undefined) return
          // Fire and forget: this runs inside the turn's event scan, so a slow
          // send must never hold the turn. The transport falls back to the
          // typing ticket when no context token is at hand.
          void sendChunked(liveTransport, withSavedConfig(config), {
            conversationId: entry.conversationId,
            text: noticeText(verdict, resolveLocale(withSavedConfig(config).locale)),
          }).catch((failure) => warn(`tool notice failed: ${String(failure)}`))
        },
      })

      // The P2 memory summarizer: folds recent turns into conv memory every
      // memorySummaryTurns settled turns. Reads the CURRENT account config per
      // call (the card can flip the knobs live); account-scoped per call.
      // The memory model (optional): background summaries, fact extraction and
      // consolidation run on a cheaper route when one is configured, so a
      // chatty day of persona upkeep cannot spend the conversation's model.
      const memoryRoute = () => routeFor('memory', config)
      // C20: background side sessions (summary, subscriptions, proactive) get
      // their own route; without one they fall back to the memory route, so a
      // single cheap model covers everything that is not the conversation.
      // purpose 明确时优先用该用途自己的路由；否则保持原来的回落链。
      sideRoute = (purpose = 'side') => routeFor(purpose, config) ?? sideRouteFor(config)
      memorySummarizer = createMemorySummarizer({
        bridge,
        stateRoot,
        config: () => config,
        route: memoryRoute,
        logger: { log: (line) => log(line), errLog: (line) => warn(line) },
      })

      // Voice transcription is opt-in and out of tree: with no bridge configured
      // this stays undefined and voice notes are delivered as files, exactly as
      // they were before ASR existed. The process is started lazily by the first
      // voice message (model load costs seconds), so an unused install pays
      // nothing for it.
      const asrSettings = resolveAsrSettings(config, asrController?.modelDir, PLUGIN_ROOT)
      asrBridge =
        asrSettings === undefined ? undefined : new AsrBridge(asrSettings, { log: (line) => log(line), warn: (line) => warn(line) })
      if (asrBridge !== undefined) log(`voice transcription enabled via ${asrSettings.command}`)

      // 免打扰时段: the gate reads the LIVE config at fire time (the card can
      // flip the window mid-flight), reusing withSavedConfig so the saved
      // settings outrank the composition exactly like everywhere else.
      // One writer per state directory. A second DSH window used to overwrite
      // this one's files silently; now it says so once and carries on (the
      // writes are atomic, so the damage is bounded to last-writer-wins).
      // The outbox: a reply that could not be delivered is written to disk and
      // retried, because a reminder nobody receives is worse than one sent late.
      outbox = createOutbox({
        stateRoot,
        transportFor: (accountId) => transports.get(accountId),
        warn,
        log,
      })
      outbox.start()
      const liveLimiter = () => {
        const live = withSavedConfig(config)
        return createSenderLimiter({ perMinute: Number(live.senderRatePerMinute ?? DEFAULT_PER_MINUTE) || 1_000_000 })
      }
      senderLimiter = liveLimiter()
      // The bus is built once per plugin start. Its first subscriber exists to
      // fix a real gap: refusals used to reach only the host logger, never the
      // log file the operator actually reads.
      hooks = createHooks({ warn })
      hooks.on(HOOK_POINTS.inboundRefused, (event) => {
        fileLog.info(`refused ${event.reason} message from ${event.senderId} in ${event.conversationId}`)
      })
      // Numbers, not log lines: every question about behaviour used to need a
      // grep. These four counters answer most of them, and the card reads the
      // snapshot (src/metrics.js keeps it in memory only).
      metrics = createMetrics()
      metrics.observe(hooks, {
        inboundAccepted: 'inbound.accepted',
        inboundRefused: 'inbound.refused',
        outboundSettled: 'outbound.settled',
        turnSettled: 'turn.settled',
      })
      if (loginController !== undefined) {
        loginController.metricsSnapshot = () => ({
          ...metrics.snapshot(),
          pendingOutbox: typeof outbox?.pending === 'function' ? outbox.pending().length : 0,
        })
      }
      if (loginController !== undefined) {
        loginController.subscriptionScheduler = subscriptionScheduler
        loginController.outboxFlush = (options) => outbox.flush(options)
        loginController.outboxDropItem = (id) => outbox.drop(id)
      }
      // The registry lives in memory; this timer is the only thing that makes it
      // readable from outside the process. 30s matches what a local scraper
      // expects, and the two files are tiny. `npm run metrics` is the read side.
      metricsTimer = setInterval(() => {
        if (withSavedConfig(config).metricsExport === false) return
        void writeMetricsSnapshot(stateRoot, {
          ...metrics.snapshot(),
          gauges: { ...metrics.snapshot().gauges, 'outbox.pending': typeof outbox?.pending === 'function' ? outbox.pending().length : 0 },
        }).catch((error) => errLog(`metrics snapshot failed: ${String(error?.message ?? error)}`))
      }, 30_000)
      metricsTimer.unref?.()

      const lock = acquireInstanceLock(stateRoot, { warn })
      if (lock.acquired === false) {
        warn(
          `another DSH instance already writes this Weixin state (pid ${lock.holder.pid}). ` +
            'Both windows will poll the same account and overwrite each other\'s state; close one of them.',
        )
      } else {
        lockHeartbeat = setInterval(() => heartbeatInstanceLock(stateRoot), HEARTBEAT_MS)
        lockHeartbeat.unref?.()
      }

      const quietGate = (now) => quietDelay(now, withSavedConfig(config))

      // Retention: state grows all day; a nightly sweep keeps it bounded. It
      // runs once shortly after start (a laptop is not up at 03:00) and then
      // daily, unref'd so it never holds the host open.
      const retentionConfig = () => {
        const live = withSavedConfig(config)
        return {
          journalDays: Number(live.retentionJournalDays ?? DEFAULT_RETENTION.journalDays),
          auditDays: Number(live.retentionAuditDays ?? DEFAULT_RETENTION.auditDays),
          mediaDays: Number(live.retentionMediaDays ?? DEFAULT_RETENTION.mediaDays),
          exportsDays: Number(live.retentionExportsDays ?? DEFAULT_RETENTION.exportsDays),
          logsDays: Number(live.retentionLogsDays ?? DEFAULT_RETENTION.logsDays),
        }
      }
      const sweep = () => {
        try {
          const result = sweepRetention(stateRoot, { retention: retentionConfig(), warn })
          log(describeSweep(result))
        } catch (error) {
          warn(`retention sweep failed: ${String(error?.message ?? error)}`)
        }
      }
      // Backups: retention deletes old files on purpose, and nothing else keeps
      // a copy. One a day, a few minutes after the sweep so the two never fight
      // over the same files, and never blocking startup.
      const takeBackup = () => {
        try {
          const live = withSavedConfig(config)
          if (live.backupEnabled === false) return
          const result = createBackup(stateRoot, { keep: Number(live.backupKeep ?? DEFAULT_KEEP), warn })
          log(`backup ${result.id}: ${result.files} file(s)`)
        } catch (error) {
          warn(`backup failed: ${String(error?.message ?? error)}`)
        }
      }
      const firstBackup = setTimeout(takeBackup, 5 * 60_000)
      firstBackup.unref?.()
      backupTimers.push(firstBackup)
      backupTimers.push(setInterval(takeBackup, 24 * 60 * 60_000))
      for (const timer of backupTimers) timer.unref?.()

      const firstSweep = setTimeout(sweep, 60_000)
      firstSweep.unref?.()
      retentionTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
      retentionTimer.unref?.()

      // 日报与记忆核对: one clock, two kinds of report. Both write through a side
      // session so they cost the cheap route, and both send exactly one message —
      // a report that spams three bubbles at 21:00 is worse than none.
      reportScheduler = new ReportScheduler({
        config: () => withSavedConfig(config),
        warn,
        fire: async (kind) => {
          const live = withSavedConfig(config)
          const accountId = [...transports.keys()].find((id) => pickConversation(listConvMemories(stateRoot, id)) !== undefined)
          if (accountId === undefined) {
            warn(`${kind} report skipped: no conversation has ever been spoken in`)
            return
          }
          const transport = transports.get(accountId)
          const conversationId = pickConversation(listConvMemories(stateRoot, accountId))
          if (transport === undefined || conversationId === undefined) return
          const now = Date.now()
          const day = formatStamp(now)

          let prompt
          if (kind === 'review') {
            const global = readGlobalMemory(stateRoot, accountId, { warn })
            prompt = buildReviewPrompt({ day, facts: global.facts, profile: global.profile, digest: global.digest })
          } else {
            const entries = readJournalRange(stateRoot, { accountId, conversationId, days: 1, now })
            const total = { in: 0, out: 0, all: entries.length }
            const perConversation = new Map()
            for (const entry of entries) {
              if (entry.dir === 'in') total.in += 1
              else total.out += 1
              const id = entry.conversationId ?? conversationId
              perConversation.set(id, (perConversation.get(id) ?? 0) + 1)
            }
            const conversations = [...perConversation].map(([id, all]) => ({ conversationId: id, all })).sort((a, b) => b.all - a.all)
            const global = readGlobalMemory(stateRoot, accountId, { warn })
            const events = (global.events ?? []).filter((event) => event.done !== true)
            const conv = readConvMemory(stateRoot, accountId, conversationId, { warn })
            prompt = buildDigestPrompt({ day, total, conversations, events, summary: conv.summary })
          }

          const result = await bridge.summarize({ conversationId, accountId, prompt, sessionPrefix: kind === 'review' ? 'wx-rev-' : 'wx-dig-', route: sideRoute('report') })
          const text = typeof result?.text === 'string' ? result.text.trim() : ''
          if (text === '' || text === '（已取消）') {
            log(`${kind} report produced nothing to send`)
            return
          }
          await sendChunked(transport, live, { conversationId, text })
          log(`${describeReport(kind, now)} delivered to ${conversationId}`)
        },
      }).start()

      reminderScheduler = new ReminderScheduler({
        stateRoot,
        warn,
        quiet: quietGate,
        fire: async (reminder) => {
          const transport = transports.get(reminder.accountId)
          if (transport === undefined) {
            warn(`reminder ${reminder.id} has no live transport for ${reminder.accountId}; dropped`)
            return
          }
          await sendChunked(transport, config, {
            conversationId: reminder.conversationId,
            text: `（提醒：${reminder.text}）`,
          })
          log(`reminder ${reminder.id} delivered to ${reminder.conversationId}`)
        },
      })
      if (loginController !== undefined) loginController.remindersProvider = reminderScheduler
      if (config.messageJournal === true) {
        journalOutboundRef = (entry) => appendJournal(stateRoot, { dir: 'out', ...entry }, { warn })
      }
      // Hand the send path its collaborators once, after both exist: the
      // journal sink above (null when journalling is off) and the outbox.
      configureOutbound({ journal: journalOutboundRef, outbox, hooks, warn, snippetsDir: statePaths(stateRoot).snippetsDir.absolute })

      // Scheduled proactive messages (/subscribe): the bot speaks first
      // through its own side session. The prompt re-uses the exact injection
      // blocks the reply path builds — persona mode, memory, the recent
      // window — so a proactive bubble sounds like the same entity the user
      // has been talking to, not a different bot.
      const subscriptionBusy = new Set()
      subscriptionScheduler = new SubscriptionScheduler({
        stateRoot,
        warn,
        quiet: quietGate,
        fire: async (item) => {
          const transport = transports.get(item.accountId)
          if (transport === undefined) {
            warn(`subscription ${item.id} has no live transport for ${item.accountId}; skipped`)
            return
          }
          if (subscriptionBusy.has(item.conversationId)) {
            warn(`subscription ${item.id} skipped: another fire is running for ${item.conversationId}`)
            return
          }
          subscriptionBusy.add(item.conversationId)
          try {
            const now = Date.now()
            const personaBlock = buildPersonaBlock(resolveMode(
              readPersonaStore(stateRoot, { warn }),
              activeModeFor(stateRoot, item.accountId, item.conversationId, config.personaDefaultMode, { warn }),
            ))
            const memoryBlock = config.memoryEnabled === true
              ? buildMemoryBlock({
                  global: readGlobalMemory(stateRoot, item.accountId, { warn }),
                  conv: readConvMemory(stateRoot, item.accountId, item.conversationId, { warn }),
                  recent: readRecentWindow(stateRoot, item.accountId, item.conversationId, {}),
                  now,
                })
              : ''
            const prompt = [
              personaBlock,
              memoryBlock,
              `<weixin_subscription>`,
              `现在是 ${formatStamp(now)}。你之前和对方约定：到这个时间点，就由你主动给对方发一条消息，主题是「${item.prompt}」。`,
              `直接输出这条消息的正文，就像你在微信里自己发起的一条消息。不要复述或解释这个约定本身。`,
              `</weixin_subscription>`,
            ].filter((part) => part !== '').join('\n\n')
            const result = await bridge.summarize({ conversationId: item.conversationId, accountId: item.accountId, prompt, sessionPrefix: 'wx-sub-', route: sideRoute('report') })
            const text = typeof result?.text === 'string' ? result.text.trim() : ''
            if (text === '' || text === '（已取消）') {
              log(`subscription ${item.id} produced nothing to send`)
              return
            }
            await sendChunked(transport, config, { conversationId: item.conversationId, text })
            log(`subscription ${item.id} delivered to ${item.conversationId}`)
          } finally {
            subscriptionBusy.delete(item.conversationId)
          }
        },
      })

      // 主动开口: the bot starts a conversation instead of only answering one.
      // Off by default and companion-only; every gate (time window, minimum
      // gap, backoff after silence, daily cap, per-tick chance) lives in
      // planProactive so the rules are testable without a clock or a disk.
      // Test hook: the e2e suite cannot wait five minutes for the first tick,
      // and a wall-clock schedule plus an idle roll is not something a test can
      // assert on. Only a test run sets this, and then the chance gate is wide
      // open so a single tick always decides.
      const proactiveTestTickMs = Number(process.env.DSH_WEIXIN_PROACTIVE_TICK_MS ?? '')
      const proactiveTestMode = Number.isFinite(proactiveTestTickMs) && proactiveTestTickMs > 0
      proactiveScheduler = new ProactiveScheduler({
        stateRoot,
        warn,
        ...(proactiveTestMode ? { tickMs: Math.max(10, proactiveTestTickMs), tickChance: 1 } : {}),
        config: () => withSavedConfig(config),
        candidates: () => {
          const live = withSavedConfig(config)
          const modes = readPersonaStore(stateRoot, { warn })
          const out = []
          for (const accountId of transports.keys()) {
            for (const conv of listConvMemories(stateRoot, accountId)) {
              if (typeof conv.conversationId !== 'string' || conv.conversationId === '') continue
              const mode = resolveMode(
                modes,
                activeModeFor(stateRoot, accountId, conv.conversationId, live.personaDefaultMode ?? DEFAULT_MODE_ID, { warn }),
              )
              if (!isCompanionMode(mode)) continue
              out.push({
                accountId,
                conversationId: conv.conversationId,
                mode,
                lastInboundAt: Number(conv.bond?.lastMessageAt ?? 0),
              })
            }
          }
          // Most recently active conversation first: that is the one a person
          // would reach for first.
          return out.sort((a, b) => b.lastInboundAt - a.lastInboundAt)
        },
        fire: async (candidate, { now }) => {
          const transport = transports.get(candidate.accountId)
          if (transport === undefined) return ''
          const live = withSavedConfig(config)
          const convMemory = readConvMemory(stateRoot, candidate.accountId, candidate.conversationId, { warn })
          const life = live.lifeState !== false
            ? readOrInferLifeState(stateRoot, candidate.accountId, { now, bond: convMemory.bond, warn })
            : null
          const personaBlock = buildPersonaBlock(candidate.mode)
          const styleBlock = buildHumanStyleBlock({ stickers: live.stickerEnabled !== false, modeId: candidate.mode?.id })
          const lifeBlockText = life === null ? '' : lifeBlock(life)
          const globalMemory = readGlobalMemory(stateRoot, candidate.accountId, { warn })
          const memoryBlock = live.memoryEnabled === true
            ? buildMemoryBlock({
                global: globalMemory,
                maxTokens: Number(live.memoryGlobalMaxTokens ?? 0),
                conv: convMemory,
                recent: readRecentWindow(stateRoot, candidate.accountId, candidate.conversationId, { turns: 3 }),
                now,
              })
            : ''
          const state = proactiveScheduler?.status(candidate.accountId)
          const lastOwn = Array.isArray(state?.recent) && state.recent.length > 0
            ? state.recent[state.recent.length - 1]
            : ''
          const sinceHours = candidate.lastInboundAt > 0
            ? Math.max(1, Math.round(((now - candidate.lastInboundAt) / 3_600_000) * 10) / 10)
            : null
          const prompt = [
            personaBlock,
            styleBlock,
            lifeBlockText,
            memoryBlock,
            '<weixin_proactive>',
            `现在是 ${formatStamp(now)}。${sinceHours === null ? '对方有一阵子没说话了。' : `对方已经 ${sinceHours} 小时没说话了。`}`,
            '你想主动给对方发一条消息——就像你在微信里随手发的一条：可以说说你此刻在做什么，问问对方怎么样了，或者提起之前聊过的一件事。',
            ...openThreadLines(globalMemory, convMemory, now),
            '一两句话，口语，别一次问好几个问题，也别追问对方去哪儿了。',
            '不要说「我主动来找你」「打扰了」这类话，也不要解释你为什么发这条消息。',
            ...(lastOwn === '' ? [] : [`你上一次主动发的是：「${lastOwn}」，这次别重复。`]),
            '</weixin_proactive>',
          ].filter((part) => part !== '').join('\n\n')
          const result = await bridge.summarize({
            conversationId: candidate.conversationId,
            accountId: candidate.accountId,
            prompt,
            sessionPrefix: 'wx-pro-',
            route: sideRoute('proactive'),
          })
          const text = typeof result?.text === 'string' ? result.text.trim() : ''
          if (text === '' || text === '（已取消）') return ''
          const plan = live.stickerEnabled !== false
            ? takeStickers(text, { modeId: candidate.mode?.id })
            : { text, stickers: [] }
          if (live.typingIndicator === true) {
            await transport.setTyping(true, candidate.conversationId).catch(() => {})
            await sleep(1200)
          }
          try {
            await sendChunked(transport, config, { conversationId: candidate.conversationId, text: plan.text })
            for (const stickerId of plan.stickers.slice(0, MAX_STICKERS_PER_REPLY)) {
              await channelFor(transport).sendMedia({
                filePath: stickerPath(stickerId),
                conversationId: candidate.conversationId,
                cdnBaseUrl: transport.cdnBaseUrl,
              }).catch((error) => warn(`proactive sticker ${stickerId} failed: ${String(error)}`))
            }
          } finally {
            if (live.typingIndicator === true) await transport.setTyping(false, candidate.conversationId).catch(() => {})
          }
          log(`proactive message sent to ${candidate.conversationId} (${candidate.mode.name})`)
          fileLog.info(`proactive message sent to ${candidate.conversationId}: ${plan.text.slice(0, 120)}`)
          return plan.text
        },
      })
      proactiveScheduler.start()

      // 本地通知桥: a loopback endpoint so a build, backup or cron job can push
      // one sentence to WeChat without a model turn. Off by default; the token
      // is generated once, stored 0600 under the state root, never logged.
      if (withSavedConfig(config).notifyEnabled === true) {
        const notifyTokenValue = ensureNotifyToken(stateRoot, { configured: String(withSavedConfig(config).notifyToken ?? ''), warn })
        if (notifyTokenValue !== '') {
          notifyBridge = createNotifyServer({
            token: notifyTokenValue,
            port: Number(withSavedConfig(config).notifyPort ?? DEFAULT_NOTIFY_PORT),
            warn,
            send: async (text) => {
              const accountId = [...transports.keys()].find((id) => pickConversation(listConvMemories(stateRoot, id)) !== undefined)
              if (accountId === undefined) throw new Error('no conversation has ever been spoken in')
              const conversationId = pickConversation(listConvMemories(stateRoot, accountId))
              const transport = transports.get(accountId)
              if (transport === undefined || conversationId === undefined) throw new Error('the Weixin transport is not up yet')
              await sendChunked(transport, withSavedConfig(config), { conversationId, text })
            },
          })
          const boundPort = await notifyBridge.listen()
          if (boundPort !== undefined) log(`notify bridge listening on http://127.0.0.1:${boundPort}/notify (token in notify.json under the state root)`)
        }
      }

      // 离开模式到点：把最后一个找过你的会话当收件箱，发一条汇总后关窗。
      // 一分钟的粒度对「离开两小时」足够；到点时不会顺带跑一轮模型。
      awayTimer = setInterval(() => {
        for (const [id, t] of transports) {
          const away = readAway(stateRoot, id, { warn })
          if (away === undefined || away.active) continue
          const last = away.missed[away.missed.length - 1]
          if (last !== undefined) {
            sendChunked(t, withSavedConfig(config), { conversationId: last.conversationId, text: awaySummary(away) })
              .catch((error) => warn(`away summary failed: ${String(error)}`))
          }
          clearAway(stateRoot, id, { warn })
        }
      }, 60_000)
      awayTimer.unref?.()

      // 重要日子的当天提醒：每天到点后检查一次，命中才发；不跑模型。
      // 和 away 一样用分钟级定时器，不依赖文件 mtime，也不写 journal。
      dateTimer = setInterval(() => {
        for (const [id, t] of transports) {
          const live = withSavedConfig(config)
          if (!dateReminderDue(stateRoot, id, { now: Date.now(), at: live.dateReminderWhen, enabled: live.dateReminderEnabled, warn })) continue
          let items = []
          try {
            items = datesOnThisDay(readGlobalMemory(stateRoot, id, { warn }))
          } catch (error) {
            warn(`date reminder read failed for ${id}: ${String(error)}`)
            continue
          }
          if (items.length === 0) continue
          const conversationId = pickConversation(listConvMemories(stateRoot, id))
          if (conversationId === undefined) continue
          sendChunked(t, live, { conversationId, text: buildDateReminderText(items) })
            .then(() => {
              markDateReminderSent(stateRoot, id, { warn })
              fileLog.info(`date reminder sent to ${conversationId}`)
            })
            .catch((error) => warn(`date reminder failed for ${conversationId}: ${String(error)}`))
        }
      }, 60_000)
      dateTimer.unref?.()

    })()

    // Bring the loop up for one account (or every account on disk), replacing a
    // transport that is already running for it. Called for every account when
    // the plugin loads, and again for just the account whose login completed on
    // the settings card: a fresh install has no credential at load time (the
    // operator scans afterwards), and a re-bind replaces the previous token.
    // Without the second call the loop stays down until the next reload — the
    // "the phone says bound, but WeChat says it cannot reach openclaw" symptom.
    //
    // `wantedAccountId` selects the account; undefined means "every account
    // currently saved". One call touching one account must never blink another
    // account's live transport — that is why the map lookup happens per call
    // and why a per-account failure only skips that account.
    const bringUpLoop = async (wantedAccountId, { force = false } = {}) => {
      await setup
      if (cancelled) return

      const accounts = await resolveAccounts(config, wantedAccountId, warn)
      if (accounts.length === 0) {
        // Say so rather than returning in silence. "Loaded, but nothing is
        // listening because no credential is saved yet" is the first thing an
        // operator needs when messages do not arrive, and an unlogged return
        // here is indistinguishable from a loop that started and then hung.
        if (!cancelled) log('no saved Weixin credential yet; nothing is being listened to')
        return
      }

      for (const account of accounts) {
        if (cancelled) return
        try {
          await bringUpAccount(account, { force })
        } catch (error) {
          // One bad credential (corrupt file, unreachable CDN, rejected ticket)
          // must not stop the accounts after it from being served.
          warn(`could not start the loop for ${account.accountId}: ${String(error)}`)
        }
      }
    }

    /**
     * Arm (or re-arm) the long poll for exactly one account.
     *
     * `force` skips the same-credential dedup guard: the handler resolves the
     * account's allowlist once per bring-up, so a settings-card allowlist
     * change must re-arm even though the token is unchanged — otherwise the
     * override sits in the registry while the running handler keeps ruling
     * with the list it read when it came up.
     */
    const bringUpAccount = async (account, { force = false } = {}) => {
      const running = transports.get(account.accountId)
      // Nothing to do when the running loop already holds this credential: a
      // repeat call must not blink the connection, and the first call after a
      // login is the only one that has work to do.
      if (!force && running !== undefined && running.token === account.token) {
        log(`account ${account.accountId} is already being listened to; keeping the running loop`)
        return
      }

      const next = new ILinkTransport({
        accountId: account.accountId,
        // A conversation whose queue is full refuses new messages instead of
        // growing a backlog the user has already forgotten about.
        maxQueuePerConversation: Number(config.maxQueuedPerConversation ?? DEFAULT_MAX_QUEUE),
        baseUrl: account.baseUrl,
        token: account.token,
        // getConfig answers {ret:-2,"ilink_user_id required"} when the id is
        // empty, and the typing ticket it returns doubles as the fallback
        // context token for replies that arrive without one — so the bound
        // operator's id has to travel with the transport.
        userId: account.userId,
        // Explicit configuration wins over the account record, which in turn
        // wins over the upstream default. The schema default is the empty
        // string precisely so "unset" stays distinguishable here: a real
        // default would make this fallback unreachable and silently pin every
        // install to the production CDN root.
        //
        // Whitespace is normalized to "unset" first. `||` treats "   " as
        // truthy, so a YAML `cdnBaseUrl:` with trailing spaces would otherwise
        // win the whole chain, discard a perfectly good account record, and
        // fail later as `Failed to parse URL from    /upload?...`. The account
        // side already trims (vendor .../auth/accounts.js), and so do cwd and
        // accountId above; this keeps the three consistent.
        cdnBaseUrl: config.cdnBaseUrl?.trim() || account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
        // Outbound pacing. Both values are schema-validated (positive numbers),
        // so they can be handed over as-is; the transport falls back to the
        // pacer module's defaults when a caller omits them (tests, bin/ scripts).
        sendIntervalMs: config.sendIntervalMs,
        sendCooldownMs: config.sendCooldownMs,
        // Audio as voice bubbles. Default off: the server accepts a bot
        // voice_item (ret=0) without delivering it, which would swallow the
        // attachment — an operator opts in (schema description has the
        // measurements). The transport still degrades to a file send when a
        // voice upload/send is REJECTED.
        ...(config.voiceOutbound === true ? { voiceOutbound: true } : {}),
        // `/cancel` must reach the bridge while the turn it targets is still
        // running. Every other message is queued in conversation order by the
        // transport; this one skips the queue for the obvious reason.
        bypassQueue: (message) => message?.type === 'text' && isInterruptCommand(message.text),
        // Transport internals (send outcomes, voice fallbacks) go to the host
        // logger AND the weixin log file the operator actually watches. Before
        // 2026-10-26 only the host logger got them, and diagnosing a "did the
        // voice even go out?" question meant finding out no transport line had
        // ever been written anywhere readable.
        log: (line) => {
          log(line)
          fileLog.info(`dsh-weixin: ${line}`)
        },
        errLog: (line) => {
          warn(line)
          fileLog.warn(`dsh-weixin: ${line}`)
        },
        // An expired session stops inbound messaging with no other symptom —
        // the plugin looks healthy and simply never replies. Record it on the
        // login controller so the settings card can say "log in again", and put
        // the same line in the log the operator watches.
        onSessionRejected: (error) => {
          try {
            loginController?.markSessionExpired?.()
          } catch {
            // the card is a convenience; never let it break the loop's report
          }
          warn(
            error.sessionExpired
              ? `Weixin session expired for ${account.accountId}: log in again from Settings (or run bin/login.js), then reload`
              : `Weixin session rejected for ${account.accountId} (${error.message}): log in again, then reload`,
          )
        },
      })
      // The typing ticket doubles as the fallback context token for replies
      // that arrive without one; refreshing it once per loop start is enough.
      await next.refreshConfig()
      if (cancelled) return

      // iLink can redeliver a message after a reconnect; the cache is bounded
      // so a long-running bot does not grow without limit.
      const seen = new MessageDeduper()
      const handler = createInboundHandler({
        config,
        accountId: account.accountId,
        transport: next,
        bridge,
        memorySummarizer,
        asrBridge,
        seen,
        log,
        warn,
        fileLog,
        stateRoot,
        // Resolved once: the allowlist is a property of the deployment, not of
        // the message, and re-resolving per reply would re-stat every directory.
        mediaDirs: allowedMediaDirs({ cwd, stateDir: stateRoot }),
        // The directory produced-file delivery scans after a turn (see
        // sendProducedFiles). The same value the agent bridge registers as the
        // workspace, so "what the agent wrote" is well defined.
        agentCwd: cwd,
        reminderScheduler,
        subscriptionScheduler,
        proactiveScheduler,
        journalInbound: (entry) => appendJournal(stateRoot, { dir: 'in', ...entry }, { warn }),
        senderGate: (senderId) => senderLimiter.check(`${account.accountId}|${senderId}`),
        // C20: side sessions (/\summary, subscriptions, proactive) use the
        // background route; the conversation keeps the chat route.
        sideRoute,
      })

      const previous = transports.get(account.accountId)
      transports.set(account.accountId, next)
      if (previous !== undefined) {
        // Stop before start, never the other way round. The server hands each
        // message to whichever poll asks first, so two live long-polls on one
        // credential split the inbound queue between them instead of
        // duplicating it — half the messages would land on a loop whose reply
        // path is already being torn down.
        await previous.stop().catch((error) => warn(`transport stop failed: ${String(error)}`))
      }
      // The transport already isolates per-message failures, so no extra catch
      // here: an error must not be reported twice or swallowed twice.
      await next.start(handler)
      log(`listening as account ${account.accountId} (state: ${stateRoot})`)
    }

    // One hand-off at a time. A login can complete while the previous hand-off
    // is still tearing its transport down, and interleaving them would leave two
    // loops running or none.
    const startLoop = (wantedAccountId, { force = false } = {}) => {
      const run = handoff.then(
        () => bringUpLoop(wantedAccountId, { force }),
        () => bringUpLoop(wantedAccountId, { force }),
      )
      handoff = run.then(
        () => {},
        () => {},
      )
      return run
    }

    // A completed login writes a credential this loop has not read yet. Coming
    // up now is the whole difference between "scan, then reload DSH" and
    // "scan" — the operator has already been told the phone shows bound, and
    // WeChat is still saying it cannot reach openclaw. Only the account that
    // just bound is (re-)armed: the other accounts' live transports must not
    // blink because somebody logged into a second WeChat bot.
    const onAccountBound = (accountId) => {
      // A disabled plugin must not begin listening even if a scan completes:
      // `enabled` is the operator's switch, and a login is not a re-enabling
      // action. The credential is still saved, so turning the plugin back on
      // picks it up without a second scan.
      if (disabled) {
        log('a login completed while the plugin is disabled; not starting the loop')
        return
      }
      startLoop(accountId).catch((error) => warn(`restart after login failed: ${String(error)}`))
    }
    if (loginController !== undefined) loginController.onAccountBound = onAccountBound

    // Pause/resume from the settings card. Pausing must take effect now, not on
    // the next reload — an operator who pauses an account is usually stopping
    // noise *this minute* — so pause stops that account's transport here; resume
    // brings the loop straight back up. `accountId` travels with the call so one
    // card action never touches another account's live transport.
    const onAccountControlChange = (accountId) => {
      const id = typeof accountId === 'string' ? accountId.trim() : ''
      if (id === '') return
      if (isAccountPaused(id)) {
        const running = transports.get(id)
        if (running === undefined) return
        transports.delete(id)
        running.stop().catch((error) => warn(`pause stop failed for ${id}: ${String(error)}`))
        log(`account ${id} paused; its inbound loop is stopped`)
      } else if (!disabled) {
        // Forced: the resume may also follow an allowlist change (the card's
        // allowlist method lands here), and the handler resolves that list once
        // per bring-up — a same-credential resume must still rebuild it.
        startLoop(id, { force: true }).catch((error) => warn(`resume after unpause failed: ${String(error)}`))
      }
    }
    if (loginController !== undefined) loginController.onAccountControlChange = onAccountControlChange

    const started = disabled ? Promise.resolve() : startLoop()

    return async () => {
      cancelled = true
      reportScheduler?.stop()
      reminderScheduler?.stop()
      subscriptionScheduler?.stop()
      proactiveScheduler?.stop()
      await notifyBridge?.stop()
      if (awayTimer !== undefined) clearInterval(awayTimer)
      if (dateTimer !== undefined) clearInterval(dateTimer)
      if (retentionTimer !== undefined) clearInterval(retentionTimer)
      for (const timer of backupTimers) clearTimeout(timer)
      outbox?.stop()
      if (metricsTimer !== undefined) clearInterval(metricsTimer)
      if (lockHeartbeat !== undefined) clearInterval(lockHeartbeat)
      releaseInstanceLock(stateRoot)
      if (loginController !== undefined && loginController.onAccountBound === onAccountBound) {
        // The controller outlives this effect when the card is left mounted, so
        // the hook is cleared rather than left pointing at a dead loop.
        loginController.onAccountBound = undefined
      }
      if (loginController !== undefined && loginController.onAccountControlChange === onAccountControlChange) {
        loginController.onAccountControlChange = undefined
      }
      await started.catch((error) => warn(`startup failed: ${String(error)}`))
      await handoff.catch(() => {})
      // Every account gets its own stop, and one failure must not skip the
      // rest — a teardown that dies on the first account would leave every
      // later account's long poll running past the plugin unload.
      for (const [id, t] of transports) {
        transports.delete(id)
        await t.stop().catch((error) => warn(`transport stop failed for ${id}: ${String(error)}`))
      }
      // Before the agent bridge: a transcription in flight is failed through the
      // ASR disposer, so the inbound handler stops waiting on it promptly.
      await asrBridge?.dispose().catch((error) => warn(`asr teardown failed: ${String(error)}`))
      await bridge?.dispose().catch((error) => warn(`session teardown failed: ${String(error)}`))
    }
  }, 'dsh-weixin/listen')
}

/**
 * Decide the working directory the agent runs in.
 *
 * The session header's `cwd` is not cosmetic: the prompt assembly reads it back
 * through the `{{cwd}}` variable, so a session created without one fails its
 * first turn outright ("prompt variable {{cwd}} has no value").
 *
 * An empty config therefore means "the Weixin group", not "no cwd": DSH groups
 * sessions by working directory, so defaulting to the deployment's own cwd would
 * mix these conversations into the profile's group. {@link ensureSessionsDir}
 * gives every Weixin conversation one shared home instead.
 *
 * A directory that cannot be created falls back to the process directory, since
 * a usable agent beats a dead turn.
 *
 * @param {any} ctx
 * @param {{ cwd?: string }} config
 * @param {(line: string) => void} warn
 * @returns {Promise<string>}
 */
async function resolveCwd(ctx, config, warn) {
  const configured = config.cwd?.trim()
  if (configured !== undefined && configured !== '') return configured
  try {
    return ensureSessionsDir()
  } catch (error) {
    warn(`could not create the Weixin sessions directory: ${String(error)}`)
  }
  try {
    const fs = ctx.get('fs')
    if (fs?.resolve !== undefined && fs?.processPath !== undefined) {
      return fs.processPath(await fs.resolve('.'))
    }
  } catch (error) {
    warn(`could not resolve the default working directory: ${String(error)}`)
  }
  return process.cwd()
}

/**
 * Load credentials for the accounts this bring-up pass should serve.
 *
 * `wantedAccountId` names one account (a completed login on the card); the
 * wildcard undefined means "every account on disk". The old single-account
 * rule — refuse to serve when several accounts exist but none is configured —
 * is gone: multi-account is the steady state, so every saved credential gets
 * its own loop unless a specific account was asked for.
 *
 * Returns [] (and logs) when nothing usable is saved; never throws for a
 * missing file, so a fresh install logs one actionable line instead of failing
 * plugin load.
 *
 * @param {{ accountId?: string }} config
 * @param {string | undefined} wantedAccountId
 * @param {(line: string) => void} warn
 * @returns {Promise<Array<{accountId: string, baseUrl: string, cdnBaseUrl: string | undefined, token: string, userId: string | undefined}>>}
 */
async function resolveAccounts(config, wantedAccountId, warn) {
  const { DEFAULT_BASE_URL, listWeixinAccountIds, loadWeixinAccount, resolveWeixinAccount } =
    await import('../vendor/openclaw-weixin/auth/accounts.js')

  // A configured account id still wins: the operator asked for exactly that
  // one. wantedAccountId (a just-completed login) narrows the pass to that
  // account too — other accounts' transports must not blink.
  const configured = config.accountId?.trim() || wantedAccountId?.trim() || ''
  const ids = configured !== '' ? [configured] : listWeixinAccountIds({})
  if (ids.length === 0) {
    warn(`no Weixin account is saved (expected under ${accountsDir()}); run the login command first`)
    return []
  }

  const accounts = []
  for (const accountId of ids) {
    const data = loadWeixinAccount(accountId)
    if (data === null || !data.token) {
      warn(`account "${accountId}" has no saved token (expected ${accountsDir()}/${accountId}.json); run the login command`)
      continue
    }

    // A paused account keeps its credentials but gets no loop: pausing is
    // "stop listening on purpose", not "log out". Logged, so an operator who
    // paused an account yesterday can tell deliberate silence from breakage.
    // `warn` because `log` only exists inside apply's closure — this module
    // function has never had it, and a ReferenceError here would be swallowed
    // by the caller's per-account catch as "could not start the loop",
    // disguising a deliberate pause as a broken credential.
    if (isAccountPaused(accountId)) {
      warn(`account "${accountId}" is paused; not starting its loop`)
      continue
    }

    // resolveWeixinAccount applies the upstream defaults and config overrides
    // (baseUrl, cdnBaseUrl, enabled) that the transport expects.
    let resolved
    try {
      resolved = resolveWeixinAccount({ channels: { 'openclaw-weixin': { accounts: { [accountId]: {} } } } }, accountId)
    } catch {
      resolved = undefined
    }
    accounts.push({
      accountId,
      baseUrl: data.baseUrl ?? resolved?.baseUrl ?? DEFAULT_BASE_URL,
      // The record's OWN CDN root, not a default. Deliberately only the saved
      // value: `resolveWeixinAccount` always fills in the upstream production
      // root, so consulting it here would make the caller's chain unable to tell
      // "the account chose this" from "nobody chose anything" — and would make
      // the caller's final fallback unreachable. Empty and whitespace-only values
      // mean "not set", hence `trim() ||` rather than `??`.
      cdnBaseUrl: data.cdnBaseUrl?.trim() || undefined,
      token: data.token,
      userId: data.userId,
    })
  }
  return accounts
}

/**
 * One inbound Weixin message through the whole pipeline.
 *
 * @param {object} params
 * @param {any} params.config
 * @param {ILinkTransport} params.transport
 * @param {AgentBridge} params.bridge
 * @param {AsrBridge} [params.asrBridge]
 * @param {import('./message/dedupe.js').MessageDeduper} params.seen
 * @param {(line: string) => void} params.log
 * @param {(line: string) => void} params.warn
 * @param {string} params.stateRoot  Weixin state root, for the media allowlist.
 * @param {string[]} params.mediaDirs  Directories a reply may reference.
 */
/**
 * Build the opt-in source block prepended to a turn's prompt when
 * `sourceContext` is enabled. Kept on one self-closing tag line so it is
 * cheap to strip by either the model or the operator.
 *
 * @param {{ senderId?: string, conversationId?: string, timestamp?: number, type?: string }} message
 * @returns {string}
 */
export function weixinSourceBlock(message) {
  const fields = [
    'channel="weixin"',
    `senderId="${String(message.senderId ?? '')}"`,
    `conversationId="${String(message.conversationId ?? '')}"`,
    `kind="${String(message.type ?? 'text')}"`,
  ]
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    fields.push(`timestamp="${new Date(message.timestamp).toISOString()}"`)
  }
  return `<weixin_source ${fields.join(' ')} />`
}

function createInboundHandler({ config, accountId, transport, bridge, memorySummarizer, asrBridge, seen, log, warn, fileLog, stateRoot, mediaDirs, agentCwd, reminderScheduler, subscriptionScheduler, proactiveScheduler, journalInbound, senderGate, sideRoute }) {
  // The effective allowlist is per account: an account-level override in the
  // registry narrows (or replaces) the global list.
  // `accountId` is always set here (bringUpAccount passes it), but the
  // fallback keeps the helper's contract honest.
  //
  // Resolved per message, not captured once: `enrolFirstContact` writes the
  // registry, so a snapshot taken when the handler was built still says "no
  // allowlist" — which reset the effective config on the message AFTER the one
  // that enrolled, refusing the very sender who had just been let in until the
  // channel reconnected. The settings card edits the same registry, so a
  // capture would also make its changes wait for a restart.
  const resolveAccountConfig = () => ({ ...config, ...allowlistForAccount(accountId, config) })
  // The handler reads the config for THIS message through this cell so a
  // first-contact enrolment takes effect on the very message that triggered it.
  const effectiveConfig = { current: resolveAccountConfig() }
  // Per-conversation overrides (config-scope.json) sit on top of the account
  // config for exactly one message. Re-read on every message so the card can
  // change a scope without a restart, and rebuilt from the account config so an
  // override never leaks into the next conversation.
  const applyScope = (conversationId) => {
    effectiveConfig.current = scopedConfig(resolveAccountConfig(), readScope(stateRoot, accountId, conversationId, { warn }))
  }
  // Persona + memory command handlers (/mode /remember /forget /memory), one
  // bundle per conversation. Every call re-reads its store: the settings card
  // can edit the mode table or the operator can /forget between two messages,
  // and answering from a cached snapshot would quietly lie. Memory commands
  // honour memoryEnabled being off; /mode does not — the mode table and the
  // memory store are separate features.
  const personaCommands = (conversationId) => {
    const memoryOn = () => effectiveConfig.current.memoryEnabled !== false
    const modeConfig = () => effectiveConfig.current
    // "Is this line a companion?" — the same resolution the prompt build uses,
    // so /status and /memory tell the same story the reply does. The stock
    // assistant gets no affinity line: it has no feelings to report.
    const companionHere = () => {
      const modes = readPersonaStore(stateRoot, { warn })
      const active = resolveMode(modes, activeModeFor(stateRoot, accountId, conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn }))
      return isCompanionMode(active)
    }
    return {
      mode: (arg) => {
        const store = readPersonaStore(stateRoot, { warn })
        const currentId = activeModeFor(stateRoot, accountId, conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn })
        if (arg === undefined || arg === '') {
          const current = resolveMode(store, currentId)
          const render = (m) => `${m.id === currentId ? '→' : '　'}${m.id === DEFAULT_MODE_ID ? '默认助手（不扮演角色）' : m.name} — /mode ${m.name === '' ? m.id : m.name}`
          const roles = store.filter((m) => m.game !== true)
          const games = store.filter((m) => m.game === true)
          return [
            `当前对话模式：${current?.name ?? currentId}。`,
            ...roles.map(render),
            // Games are modes too (a fresh conversation line is a fresh board),
            // but they read better as their own section.
            ...(games.length > 0 ? ['—— 小游戏（玩完 /mode 默认 就退出）——', ...games.map(render)] : []),
          ].join('\n')
        }
        // Users type the display name (女友), not the id (girlfriend) — match
        // either, case-insensitively. The default mode additionally answers to
        // the bare 「默认」, which is what a user says when they mean "no
        // persona" (its display name 默认助手 is clunky to type).
        const wanted = arg.trim().toLowerCase()
        const matches = (m) => m.id.toLowerCase() === wanted
          || m.name.toLowerCase() === wanted
          || (m.id === DEFAULT_MODE_ID && wanted === '默认')
        const match = store.find(matches)
        if (match === undefined) {
          return `没有叫「${arg}」的模式。可用：${store.map((m) => (m.id === DEFAULT_MODE_ID ? '默认' : m.name)).join('、')}`
        }
        if (match.id === currentId) return `已经是「${match.name}」模式了，没有变化。`
        // Pin even `default`: the global default may be a persona, and "this
        // conversation back to the plain assistant" is exactly what /mode 默认
        // should mean here.
        setActiveMode(stateRoot, accountId, conversationId, match.id, { warn })
        // A mode switch opens a fresh session line (the approved behaviour):
        // the previous persona is already in the old transcript, and starting
        // clean is what makes the switch feel real. Same mechanics as /new.
        bridge.lines.create(conversationId, accountId)
        return `${match.id === DEFAULT_MODE_ID ? '已切回默认助手' : `已切换到「${match.name}」`}模式，并开启了一条新会话线。\n（之前的会话保留，/list 可以切回）`
      },
      // /summary: an on-demand look at where the conversation stands. Unlike
      // the background summarizer it replies to the user and never writes the
      // conv file — 「看一眼」 and 「记住」 stay separate concerns.
      summary: async () => {
        const prior = readConvMemory(stateRoot, accountId, conversationId, { warn })
        const recent = readRecentWindow(stateRoot, accountId, conversationId, { turns: 20, textChars: 200 })
        const transcript = recent
          .map((entry) => `${entry.dir === 'in' ? '用户' : '助手'}：${entry.text}`)
          .join('\n')
        if (transcript === '') return '这段会话还没有可总结的消息（消息流水里是空的）。'
        const prompt = [
          '以下是这段微信会话最近的对话记录。',
          ...(String(prior.summary ?? '') !== '' ? [`【已有摘要】\n${prior.summary}`] : []),
          `【最近对话】\n${transcript}`,
          '请总结我们聊到哪了：正在讨论的话题、已经决定的事、还没做完的待办、彼此的约定。',
          '不超过 300 字，直接输出总结本身，不要任何解释或前缀。',
        ].join('\n')
        // C20: the background route is threaded in from setup() — this handler
        // is module-level and cannot see the setup closure.
        const result = await bridge.summarize({ conversationId, accountId, prompt, sessionPrefix: 'wx-sum-', route: sideRoute?.() })
        if (result === undefined) return '当前有对话在跑，等这轮结束再试 /summary。'
        const text = String(result.text ?? '').trim()
        if (text === '' || text === '（已取消）') return '这次没总结出来（侧会话没有返回内容），稍后再试。'
        return text
      },
      // /export: render this conversation's journal as Markdown. Short
      // exports ride the normal reply; long ones land in
      // `<stateRoot>/exports/` and the reply carries the path (the settings
      // card's 消息流水 tab also has a one-click export).
      export: (rawDays) => {
        const days = Math.min(365, Math.max(1, Number(rawDays) || 30))
        const entries = readJournalRange(stateRoot, { accountId, conversationId, days })
        if (entries.length === 0) return `这个会话在最近 ${days} 天没有消息流水。`
        const markdown = renderChatMarkdown(entries, { title: `聊天记录 · ${conversationId} · 最近 ${days} 天` })
        if (markdown.length <= 3000) return markdown
        const file = writeChatExport(stateRoot, accountId, conversationId, markdown)
        return `聊天记录比较长（${entries.length} 条，${markdown.length} 字），已导出成文件：\n${file}\n完整内容也可以在设置卡「消息流水」页签里一键导出。`
      },
      recall: (arg) => {
        const keyword = String(arg ?? '').trim()
        if (keyword === '') return '用法：/recall <关键词>，例如 /recall 报错。会在本地消息流水里翻原文，不经过模型、不花 token。'
        const days = Number(modeConfig().memoryRecallDays ?? 180)
        const limit = 5
        // 先在这段会话里找（最相关），找不到再扩大到整个账号——
        // 用户问「上次说的那个」时，往往记不清是在哪个对话里说的。
        const inConversation = queryRecall(stateRoot, keyword, { accountId, conversationId, days, limit, warn })
        if (inConversation.length > 0) return formatRecallHits(inConversation, { query: keyword })
        const anywhere = queryRecall(stateRoot, keyword, { accountId, days, limit, warn })
        if (anywhere.length === 0) {
          return `本地流水（最近 ${days} 天）里没有找到和「${keyword}」相关的消息。`
        }
        return `这个会话里没有，但账号下其他对话里有：\n${formatRecallHits(anywhere, { query: keyword })}`
      },
      remember: (arg) => {
        if (memoryOn() === false) return '记忆功能当前是关闭的（设置里的「会话记忆」），先打开再用 /remember。'
        if (arg === undefined || String(arg).trim() === '') {
          return '用法：/remember <要记住的内容>，例如 /remember 我对花生过敏\n改口用箭头：/remember 我搬到杭州了 → 我住在杭州'
        }
        // Explicit correction (C18): `旧 → 新` replaces the old fact instead of
        // leaving both for the model to choose from.
        const arrow = String(arg).match(/^(.+?)\s*(?:→|->|=>)\s*(.+)$/)
        const text = arrow === null ? String(arg).trim() : arrow[2].trim()
        const supersedes = arrow === null ? [] : [arrow[1].trim()]
        const result = addGlobalFact(stateRoot, accountId, text, {
          warn,
          maxFacts: modeConfig().memoryGlobalMaxFacts,
          supersedes,
        })
        if (result.added === true) {
          const replaced = Array.isArray(result.superseded) && result.superseded.length > 0
            ? `\n（原来的「${result.superseded.join('」「')}」已作废）`
            : ''
          return `已记住：${text}${replaced}\n（/memory 可以查看全部，/forget <编号> 可以删除）`
        }
        if (result.reason === 'duplicate') return '这条已经记过了，不用再记一遍。'
        if (result.reason === 'cap') return `长期记忆已经存满（${modeConfig().memoryGlobalMaxFacts} 条）。用 /forget 先删掉一些再记。`
        return '没存上，写入记忆文件失败了（详见日志）。'
      },
      forget: (arg) => {
        if (memoryOn() === false) return '记忆功能当前是关闭的。'
        const facts = readGlobalMemory(stateRoot, accountId, { warn }).facts
        if (facts.length === 0) return '长期记忆还是空的，没有可忘掉的。'
        if (arg === undefined || String(arg).trim() === '') {
          return ['长期记忆（/forget <编号> 删除某一条）：', ...facts.map((f, i) => `${i + 1}. ${f.text}`)].join('\n')
        }
        const asIndex = Number(arg)
        if (Number.isInteger(asIndex) === true) {
          const removed = removeGlobalFact(stateRoot, accountId, asIndex, { warn })
          return removed.removed === true ? `已忘掉：${removed.text}` : `没有第 ${asIndex} 条（现在共 ${facts.length} 条）。`
        }
        const keyword = String(arg).toLowerCase()
        const hits = facts.map((f, i) => ({ index: i + 1, text: f.text })).filter((f) => f.text.toLowerCase().includes(keyword))
        if (hits.length === 0) return `没有找到含「${arg}」的记忆。`
        if (hits.length === 1) {
          const removed = removeGlobalFact(stateRoot, accountId, hits[0].index, { warn })
          return removed.removed === true ? `已忘掉：${removed.text}` : '没删掉，写入记忆文件失败了（详见日志）。'
        }
        return ['好几个都带这个词，用编号指明删哪条：', ...hits.map((h) => `${h.index}. ${h.text}`)].join('\n')
      },
      memory: () => {
        if (memoryOn() === false) return '记忆功能当前是关闭的。'
        const store = readGlobalMemory(stateRoot, accountId, { warn })
        const conv = readConvMemory(stateRoot, accountId, conversationId, { warn })
        const recent = readRecentWindow(stateRoot, accountId, conversationId, { warn })
        const parts = []
        const bond = companionHere() ? bondLine(conv.bond) : ''
        if (bond !== '') parts.push(bond)
        if (store.digest !== '') parts.push(`人物小传：${store.digest}`)
        const profileLines = formatProfile(store.profile)
        if (profileLines.length > 0) parts.push(['关于你的档案：', ...profileLines].join('\n'))
        if (store.events.length > 0) parts.push(['事件与待办：', ...formatEvents(store.events)].join('\n'))
        parts.push(store.facts.length === 0
          ? '长期记忆：还没有，用 /remember 教我。'
          : ['长期记忆：', ...store.facts.map((f, i) => `${i + 1}. ${f.text}`)].join('\n'))
        const affinity = describeAffinity(readAffinityHistory(stateRoot, accountId, conversationId, { warn }))
        if (affinity !== '') parts.push(['最近的关系曲线：', affinity].join('\n'))
        if (store.superseded.length > 0) {
          parts.push(['改过的说法：', ...store.superseded.slice(-5).map((entry) => `- ${entry.text} → ${entry.by}`)].join('\n'))
        }
        parts.push(conv.summary !== '' ? `本会话记忆：${conv.summary}` : '本会话记忆：还没有摘要（会自动按回合记一次）。')
        parts.push(`最近消息窗口：${recent.length} 条`)
        return parts.join('\n\n')
      },
      ...createAwayCommands({ stateRoot, accountId, warn, parseWhen }),
      ...createListCommands({ stateRoot, accountId, warn }),
      ...createReadingCommands({ stateRoot, accountId, warn }),
      ...createSendCommands({
        conversationId,
        mediaDirs,
        ...(effectiveConfig.current.maxMediaBytes === undefined ? {} : { maxBytes: effectiveConfig.current.maxMediaBytes }),
        warn,
        sendMedia: (params) => transport.sendMedia(params),
      }),
    }
  }
  return async (message) => {
    // One timestamp for both the journal line and the recall exclusion, so the
    // message being answered can be recognised in the index without matching
    // on text alone.
    // ④ A passive listener for shapes the vendored client does not know: it cannot
    // render a link card, it can only tell us whether the server sends them.
    for (const line of describeUnknownItems(message)) {
      if (firstSighting(unknownItemSeen, line, `${message.conversationId}|${line}`)) {
        fileLog.info(`unfamiliar inbound shape: ${line}`)
        appendToolAudit(stateRoot, { tool: 'weixin/unknown-item', ok: true, summary: line })
      }
    }
    const journaledAt = Date.now()
    // Before anything reads the config for this message: layer the
    // conversation's overrides (if any) onto the account config.
    applyScope(message.conversationId)
    if (config.messageJournal === true && message.type === 'text') {
      journalInbound?.({
        at: journaledAt,
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: message.text,
      })
    }
    // 1. Truly unknown item kinds (TOOL_CALL_*, anything the protocol adds
    //    later) still get one short notice rather than silence. Media kinds are
    //    NOT unsupported — they are normalized into descriptors by the transport
    //    and downloaded below, after authorization.
    if (message.unsupported !== undefined) {
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: createTranslator(effectiveConfig.current.locale).t('notice.unsupported', { kind: message.unsupported }),
        contextToken: message.contextToken,
      })
      return
    }

    // 1a-bis. Group policy (C14). The transport already turns a non-blank
    //        group_id into the conversation id; what was missing is that nothing
    //        downstream knew the difference, so the bot answered every message
    //        in a group chat. Ignored messages are journaled (the turn never
    //        happens) and counted, and they never reach the sender gate.
    const groupDecision = groupReplyPolicy(message, effectiveConfig.current, {
      botNames: [accountId, config.accountLabel ?? '', config.botName ?? ''],
    })
    if (groupDecision.reply === false) {
      hooks?.emit(HOOK_POINTS.inboundRefused, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        reason: groupDecision.reason,
      })
      metrics?.inc('group.ignored', 1, groupDecision.reason)
      log(`group message ignored (${groupDecision.reason}) from ${message.senderId} in ${message.conversationId}`)
      return
    }

    // 1b. Per-sender pacing. The account-wide limiter protects the Weixin
    //     account from a ban; this protects the bot (and the token bill) from
    //     one person sending thirty messages into a running turn. A refused
    //     message is answered once per window — silence would read as a bug.
    const gate = typeof senderGate === 'function' ? senderGate(message.senderId) : undefined;
    if (gate !== undefined && gate.allowed === false) {
      // Observers (file log today, counters later) hear about refusals through
      // the bus instead of every call site growing its own logging.
      hooks?.emit(HOOK_POINTS.inboundRefused, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        reason: 'rate-limit',
      })
      if (gate.shouldWarn === true) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: createTranslator(effectiveConfig.current.locale).t('notice.rateLimited', {
            seconds: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)),
          }),
          contextToken: message.contextToken,
        }).catch(() => {})
        appendToolAudit(stateRoot, {
          at: new Date().toISOString(),
          tool: 'weixin/rate-limit',
          ok: false,
          summary: `sender ${message.senderId} is over the per-minute message limit (${gate.recent} in the last minute)`,
        }, { warn })
      }
      return
    }

    // 2. Authorization first: before dedupe, before a session exists, and —
    //    critically — before any download. An unauthorized sender must not be
    //    able to make this host issue requests to Tencent's CDN, so nothing
    //    below this point may run for a denied message.
    if (!isAllowedSender(effectiveConfig.current, message.senderId, message.conversationId)) {
      // First contact enrolment: at scan time only the bot id is known — the
      // human's WeChat id first appears HERE, on the first inbound message.
      // So the very first sender an account without an allowlist override
      // hears is treated as the person who scanned (whoever scans owns the
      // account), enrolled into that account's own allowlist, and let
      // through. Every later stranger is refused exactly as before.
      let enrolled = false
      if (accountId) {
        const hasOverride = () => {
          const entry = readRegistry()[accountId]
          return (Array.isArray(entry?.allowedSenders) && entry.allowedSenders.length > 0) || Boolean(entry?.firstContactEnrolledAt)
        }
        enrolled = enrolFirstContact(accountId, message.senderId, hasOverride, (line) => {
          log(`${line}`)
          fileLog.info(`dsh-weixin: ${line} (the scanner's first message; add more senders on the card or in the registry)`)
        }, config.allowedSenders)
        if (enrolled) {
          // Re-resolve the effective config so the rest of this message runs
          // under the list that now contains the sender.
          const enrolledConfig = resolveAccountConfig()
          if (isAllowedSender(enrolledConfig, message.senderId, message.conversationId)) {
            effectiveConfig.current = enrolledConfig
          } else {
            // The enrolment did not actually authorize the sender (chat
            // allowlist still denies, say): refuse after all, do not pretend.
            enrolled = false
          }
        }
      }
      if (!enrolled) {
        // Log the refusal to the file logger too, with the full allowlist: the
        // rebind flow generates a fresh sender id per bot, so the most common
        // refusal is a stale allowedSenders entry, and this line is both the
        // diagnosis and the exact value the operator needs to paste into config.
        // Read through `effectiveConfig`, not the raw config: the line must
        // report the list the decision was actually made against.
        fileLog.info(
          `refused message from ${message.senderId} (conversation ${message.conversationId}): ` +
            `${denialReason(effectiveConfig.current, message.senderId, message.conversationId)}; ` +
            `allowedSenders=${JSON.stringify(effectiveConfig.current.allowedSenders ?? [])}`,
        )
        warn(`refused message from ${message.senderId}: ${denialReason(effectiveConfig.current, message.senderId, message.conversationId)}`)
        return
      }
    }

    // 3. Dedupe: iLink can redeliver a message after a reconnect.
    if (!seen.accept(message.id)) {
      log(`skipping duplicate message ${message.id}`)
      fileLog.info(`skipping duplicate message ${message.id} from ${message.senderId}`)
      return
    }

    // 3.5. Last-seen bookkeeping: the card shows "silent since" from this
    // timestamp, so it is written once a message is actually accepted — not on
    // every poll, which would make a busy loop mask a dead inbound path. A
    // registry write failure is a warning, never a dropped message.
    touchAccount(accountId, warn)

    // 4. Session-control commands (`/new`, `/list`, `/use`) are answered by the
    //    plugin itself, before any media download or agent turn. A command must
    //    not cost a model turn: `/list` would otherwise burn context to print a
    //    list the plugin already knows, and `/new` would run in the very session
    //    it is meant to leave. Placed after the allowlist and dedupe so a
    //    refused or replayed message still cannot steer a conversation.
    //    `/status` additionally gets account-level facts read fresh here (the
    //    registry entry may have changed since this handler was built).
    const registryEntry = accountId ? readRegistry()[accountId] : undefined
    // /summary answers asynchronously (a side session); awaiting a plain
    // string is a no-op, so one call site covers both command shapes.
    const commandReply = await bridge.handleCommand(message.conversationId, message.text, accountId, {
      accountId,
      accountLabel: registryEntry?.label ?? null,
      paused: accountId ? isAccountPaused(accountId) : false,
      lastSeenAt: typeof registryEntry?.lastSeenAt === 'string' ? registryEntry.lastSeenAt : undefined,
      allowlist: {
        source: Array.isArray(registryEntry?.allowedSenders) && registryEntry.allowedSenders.length > 0 ? 'account' : 'global',
        senders: effectiveConfig.current.allowedSenders ?? [],
      },
      reminders: reminderScheduler,
      subscription: subscriptionScheduler,
      // Affinity rides /status when memory is on; computed fresh per message
      // like the rest of the status facts (the card can edit between messages).
      // Affinity is an emotional frame, so it rides /status only in a
      // companion conversation — the stock assistant reports facts, not moods.
      bondLine: effectiveConfig.current.memoryEnabled !== false
        && isCompanionMode(resolveMode(readPersonaStore(stateRoot, { warn }), activeModeFor(stateRoot, accountId, message.conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn })))
        ? bondLine(readConvMemory(stateRoot, accountId, message.conversationId, { warn }).bond)
        : '',
      persona: personaCommands(message.conversationId),
      t: createTranslator(effectiveConfig.current.locale).t,
    })
    if (commandReply !== undefined) {
      // ⑨ `/export` 的长记录会写成一个文件；命令回复以前只发正文，文件留在
      //    磁盘上，用户还得去设置卡里找。让命令回复也走一遍出站附件管线：
      //    路径必须落在 mediaDirs 内（exports 就在 stateRoot 下），由同一套
      //    resolveAllowedPath 判定，不是命令自带的特权。
      let replyText = commandReply
      if (/^\/export(?:\s|$)/i.test(message.text.trim())) {
        const withFile = await resolveOutboundReply({
          config: effectiveConfig.current,
          transport,
          mediaDirs,
          conversationId: message.conversationId,
          contextToken: message.contextToken,
          reply: commandReply,
          warn,
          fileLog,
        })
        replyText = withFile.text
      }
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: replyText,
        contextToken: message.contextToken,
      })
      fileLog.info(`answered session command ${JSON.stringify(message.text.trim())} for ${message.conversationId}`)
      return
    }

    // 4.2 离开模式：窗口内的消息在这里就被拦下，不进 agent —— 「不回消息」
    //     如果还走一遍模型，二十句「在吗」就是二十次调用。同一个会话每 30
    //     分钟回一句，免得对方以为被无视；其余记下来等 /back 一次交代。
    const awayNow = readAway(stateRoot, accountId, { warn })
    if (awayNow !== undefined && awayNow.active) {
      const missed = noteMissed(stateRoot, accountId, {
        senderId: message.senderId,
        conversationId: message.conversationId,
        text: message.text,
        at: Date.now(),
        warn,
      })
      if (missed.shouldReply) {
        await sendChunked(transport, effectiveConfig.current, {
          conversationId: message.conversationId,
          text: buildAwayReply(awayNow, { reply: effectiveConfig.current.awayAutoReply }),
          contextToken: message.contextToken,
        })
        fileLog.info(`away auto-reply sent to ${message.conversationId}`)
      }
      return
    }

    // 4.5 Link enrichment: if the message carries URLs, fetch each one and
    //    fold the readable text into the prompt. A failed link NEVER fails the
    //    message — the agent gets a one-line reason instead, and the user's
    //    question still reaches the model. Best-effort by design: a dead host
    //    costs a bounded fetch, not the turn.
    // Untrusted text first, and only it: any `weixin_` tag a user types is
    // neutralised here, before the plugin starts prepending blocks of its own
    // (src/message/fence.js). Later prepends are trusted and never touched.
    // 引用回复：被引用的那句话是别人写的，和用户消息一样先转义再拼进来。
    // 只引用不配文的消息（text 为空）也要能走到模型，否则「引用 + 表情」
    // 这类消息会被当成空消息回一句「没看懂」。
    const quoted = message.quote === undefined ? '' : neutralizeTags(quoteBlock(message.quote))
    const userText = neutralizeTags(message.text)
    const promptParts = () => [quoted, userText].filter((part) => part !== '')
    let prompt = promptParts().join('\n\n')
    const linkUrls = config.readLinks === true ? extractUrls(message.text) : []
    if (linkUrls.length > 0) {
      log(`fetching ${linkUrls.length} link(s) from inbound message ${message.id}`)
      // Concurrent, not serial: three dead hosts used to cost three deadlines
      // in a row before the user got an answer. Each fetch has its own 8s
      // deadline, and the batch has a budget on top so one slow host cannot
      // hold the turn open past it.
      const linkResults = await Promise.all(
        linkUrls.slice(0, 3).map((url) =>
          fetchLinkText(url).catch((error) => ({ ok: false, url, reason: `抓取失败：${String(error?.message ?? error)}` })),
        ),
      )
      const linkBlock = describeLinkResults(linkResults)
      // Fetched page text is as untrusted as the message itself: a page can
      // contain our tag syntax just as easily as a user can.
      if (linkBlock !== undefined) prompt = [...promptParts(), neutralizeTags(linkBlock)].join('\n\n')
    }
    if (Array.isArray(message.media) && message.media.length > 0) {
      // `transport.cdnBaseUrl` is already normalized at construction, so only
      // the config value needs trimming here (see the transport options above).
      const cdnBaseUrl = config.cdnBaseUrl?.trim() || transport.cdnBaseUrl || DEFAULT_CDN_BASE_URL
      const maxInboundMediaBytes = config.maxInboundMediaBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES
      /** @type {Array<Record<string, any>>} */
      const saved = []
      /** @type {Array<{ kind: string, reason: string, code: string }>} */
      const failures = []
      for (const media of message.media) {
        const download = media.kind === 'voice' ? downloadInboundVoice : downloadInboundMedia
        const result = await download({
          media,
          cdnBaseUrl,
          maxBytes: maxInboundMediaBytes,
          bridge: asrBridge,
          extractFrames: effectiveConfig.current.videoFrames !== false,
          warn,
        })
        if (result.ok) {
          log(
            `saved inbound ${result.kind} to ${result.path} (${result.bytes} bytes)` +
              (result.kind === 'voice' ? ` transcoded=${result.transcoded === true} transcribed=${typeof result.transcript === 'string'}` : ''),
          )
          saved.push(result)
        } else {
          warn(`inbound ${media.kind} download failed: ${result.reason}`)
          failures.push({ kind: media.kind, reason: result.reason, code: result.code })
        }
      }
      const parts = []
      if (saved.length > 0) parts.push(describeInboundMedia(saved, message.text))
      // ② A document's text, not only its path: the model can answer "这份合同
      //    第三条写了什么" in the same turn. Anything unrecognised (pdf, images)
      //    falls back to the path-only description above.
      if (effectiveConfig.current.documentExtract !== false) {
        const docs = []
        for (const file of saved) {
          if (file.kind !== 'file' && file.kind !== 'voice') continue
          const extracted = await extractDocumentTextAsync(file.path, {
            maxChars: effectiveConfig.current.documentTextChars ?? DEFAULT_DOCUMENT_CHARS,
          })
          if (extracted.ok) {
            docs.push(`<weixin_document path="${file.path}">
${neutralizeTags(extracted.text)}
</weixin_document>`)
            log(`extracted ${extracted.kind} text from ${file.path} (${extracted.text.length} chars, truncated=${extracted.truncated})`)
          } else if (extracted.reason !== 'unsupported') {
            warn(`document extraction skipped for ${file.path}: ${extracted.reason}`)
          }
        }
        if (docs.length > 0) parts.push(docs.join('\n\n'))
      }
      // ④ 图片里的字：可选的外部 OCR 桥。没配置就完全跳过，图片仍按路径描述；
      //    识别失败只降级成「没有文字」，不让整个回合失败。
      if (effectiveConfig.current.ocrEnabled === true) {
        const ocrSettings = resolveOcrSettings(effectiveConfig.current)
        if (ocrSettings !== undefined) {
          for (const file of saved) {
            if (file.kind !== 'image') continue
            const ocr = await extractImageText(file.path, ocrSettings)
            if (ocr.ok) {
              parts.push(`<weixin_ocr path="${file.path}">
${neutralizeTags(ocr.text)}
</weixin_ocr>`)
              log(`ocr read ${ocr.text.length} chars from ${file.path} (truncated=${ocr.truncated})`)
            } else if (ocr.code !== 'empty') {
              warn(`ocr skipped for ${file.path}: ${ocr.reason}`)
            }
          }
        }
      }
      // A failure with no caption and nothing saved is answered here rather
      // than by the agent: there is no content to reason about, only an error
      // to relay, and waking a full turn (with its model call) to repeat one
      // line back to the user would be a pointless expense and a slow reply.
      // With a caption — or with some attachments saved — the failure is folded
      // into the prompt instead, so the agent can answer the question the user
      // actually asked while mentioning what did not arrive.
      const nothingToReasonAbout = saved.length === 0 && (message.text ?? '') === '' && message.quote === undefined
      if (failures.length > 0 && !nothingToReasonAbout) parts.push(describeMediaFailures(failures))
      if (nothingToReasonAbout) {
        await sendChunked(transport, config, {
          conversationId: message.conversationId,
          text: `（${describeMediaFailures(failures)}）`,
          contextToken: message.contextToken,
        })
        return
      }
      prompt = parts.join('\n\n')
    }

    // Source context: the agent has no other way to know where a message came
    // from. Opt-in, because the block spends tokens on every turn and a
    // single-user deployment rarely needs it.
    if (config.sourceContext === true) {
      prompt = weixinSourceBlock(message) + (prompt === '' ? '' : `\n\n${prompt}`)
    }

    // Persona + memory: the same seam, right before the user's text. Persona
    // (who the assistant is talking as) precedes memory (what it keeps
    // knowing). Both re-read their stores per message — the settings card can
    // switch a mode or /forget can run between two messages. A persona only
    // changes tone; every builtin prompt says so, and the block is skipped
    // entirely for `default` so a stock deployment spends zero extra tokens.
    // Memory injects global facts, the conversation summary, and a recent
    // window folded from the journal, each section omitted when empty.
    const personaModes = readPersonaStore(stateRoot, { warn })
    const activeMode = resolveMode(personaModes, activeModeFor(stateRoot, accountId, message.conversationId, effectiveConfig.current.personaDefaultMode ?? DEFAULT_MODE_ID, { warn }))
    const personaBlock = buildPersonaBlock(activeMode)
    // Everything that makes a character feel alive — the pause before the first
    // bubble, the split into two or three bubbles, the wording rules, the life
    // state — is scoped to a COMPANION. The stock `default` assistant is a
    // tool: it answers instantly, in one message, and never pretends it slept
    // badly.
    const companion = isCompanionMode(activeMode)
    const styleBlock = companion
      ? buildHumanStyleBlock({ stickers: effectiveConfig.current.stickerEnabled !== false, modeId: activeMode?.id })
      : ''
    // The recent-message window is the expensive part of the memory block and
    // it only earns its tokens on a COLD line: a resumed session already has
    // those messages in its own history, and the inbound journal write above
    // puts the message being answered at the top of the window too. So the
    // window is injected once per session line (the id is remembered in the
    // conversation memory file) and the message being answered is excluded.
    const convMemory = readConvMemory(stateRoot, accountId, message.conversationId, { warn })
    // Life state: inferred from the clock, the time since the last message and
    // how much you have been chatting today, then handed to the model as one
    // short block. It is what makes the same persona sound different at 08:00
    // and at 23:40, and it costs about 90 characters.
    const life = companion && effectiveConfig.current.lifeState !== false
      ? readOrInferLifeState(stateRoot, accountId, { now: journaledAt, bond: convMemory.bond, warn })
      : null
    const lifeBlockText = life === null ? '' : lifeBlock(life)
    const recentTurns = Number(effectiveConfig.current.memoryRecentTurns ?? 5)
    const lineSessionId = bridge.lines.active(message.conversationId, accountId)
    const coldLine = convMemory.recentSessionId !== lineSessionId
    const recent = recentTurns > 0 && coldLine
      ? readRecentWindow(stateRoot, accountId, message.conversationId, {
          turns: recentTurns,
          textChars: 120,
          excludeText: message.text,
          warn,
        })
      : []
    // A group shares one conversation key, and the memory blocks hold the
    // owner's own facts — so a group gets an answer, not the dossier.
    const memoryShared = groupSharesMemory(message, effectiveConfig.current)
    // ⑦ In a group, whose message is this? A name card, not a second memory: it
    // holds the call name and what was written down about that person, and it is
    // injected only for the person actually talking.
    let contactBlock = ''
    if (isGroupMessage(message)) {
      const known = readContact(stateRoot, accountId, message.senderId, { warn })
      if (known !== undefined) contactBlock = buildContactBlock(known, { senderId: message.senderId })
      touchContact(stateRoot, accountId, message.senderId, { warn })
    }
    const memoryBlock = effectiveConfig.current.memoryEnabled === true && memoryShared === true
      ? buildMemoryBlock({
          global: readGlobalMemory(stateRoot, accountId, { warn }),
          maxTokens: Number(effectiveConfig.current.memoryGlobalMaxTokens ?? 0),
          conv: convMemory,
          recent,
          includeBond: companion,
        })
      : ''
    // Remember the line even when the window came back empty: the next message
    // on this line is warm, so the window must not be re-read (and re-injected)
    // just because the first one had nothing to show yet.
    if (coldLine && effectiveConfig.current.memoryEnabled === true && memoryShared === true) {
      setConvRecentSession(stateRoot, accountId, message.conversationId, lineSessionId, { warn })
    }
    // Recall: the journal already holds every message, but nothing looked at
    // it, so long-range questions ("上次那个报错") could only be answered from
    // a lossy summary. Search it locally first, and only pay for the block
    // when the search actually hits: small talk finds nothing and costs zero.
    let recallBlock = ''
    if (effectiveConfig.current.memoryRecall !== false && memoryShared === true) {
      const recallHits = queryRecall(stateRoot, message.text, {
        accountId,
        conversationId: message.conversationId,
        days: Number(effectiveConfig.current.memoryRecallDays ?? 180),
        limit: Number(effectiveConfig.current.memoryRecallHits ?? 3),
        excludeAt: journaledAt,
        excludeText: message.text,
        warn,
      })
      if (shouldRecall(message.text, recallHits)) recallBlock = buildRecallBlock(recallHits)
    }
    // Prepend in ONE join so the order stays persona → memory → recall → user
    // text (a per-block prepend loop would silently reverse it).
    // ② 预演模式: a prompt-level agreement, not enforcement. The go-ahead check is
    // the whole mechanism — one turn of planning, one word of permission.
    const dryRunBlock = effectiveConfig.current.dryRun === true && isGoAhead(message.text) === false
      ? buildDryRunBlock({ accountLabel: config.accountLabel ?? '' })
      : ''
    if (dryRunBlock !== '') log(describeDryRun())
    const blocks = [personaBlock, styleBlock, lifeBlockText, contactBlock, memoryBlock, recallBlock, dryRunBlock].filter((block) => block !== '')
    if (blocks.length > 0) prompt = [...blocks, prompt].filter((part) => part !== '').join('\n\n')

    // The user spoke: clear the proactive backoff. Reset before the turn so a
    // slow reply cannot count as silence and trigger a second message.
    proactiveScheduler?.noteInbound(accountId)

    // 5. Drive the agent, then send the reply back in chunks.
    if (config.typingIndicator) await transport.setTyping(true, message.conversationId)
    try {
      const startedAt = Date.now()
      hooks?.emit(HOOK_POINTS.inboundAccepted, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
      })
      const reply = await bridge.deliver({
        conversationId: message.conversationId,
        accountId,
        text: prompt,
        // Who caused the turn, for the tool audit: the sender is the only party
        // an operator can hold responsible for a destructive tool call.
        senderId: message.senderId,
        busyMessageMode: config.busyMessageMode,
        onProgress: async (note) => {
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: `（${note}）`,
            contextToken: message.contextToken,
          })
        },
        // A turn that outlives the wait still owes the user its answer: the
        // notice goes out through the caller's context token, and the late
        // reply is delivered later with a freshly fetched typing ticket (the
        // original one is one-shot and long expired by then).
        onLateReply: async (late) => {
          if (late.kind === 'timeout-notice') {
            await sendChunked(transport, config, {
              conversationId: message.conversationId,
              text: '（这条消息处理时间较长，先回复别的消息不影响它；结果出来后会直接发到这里）',
              contextToken: message.contextToken,
            })
            return
          }
          await transport.refreshConfig()
          const outbound = await resolveOutboundReply({
            config,
            transport,
            mediaDirs,
            stateRoot,
            reply: late.text,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          await sendChunked(transport, config, {
            conversationId: message.conversationId,
            text: outbound.text,
            contextToken: '',
          })
          await sendProducedFiles({
            config,
            transport,
            agentCwd,
            sinceMs: startedAt,
            alreadySent: outbound.sent,
            conversationId: message.conversationId,
            contextToken: '',
            warn,
            fileLog,
          })
          log(`late reply delivered for ${message.conversationId}`)
          fileLog.info(`late reply delivered to ${message.conversationId} after the wait gave up`)
        },
      })
      log(`turn settled in ${Date.now() - startedAt}ms for ${message.conversationId}`)
      hooks?.emit(HOOK_POINTS.turnSettled, {
        accountId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        ms: Date.now() - startedAt,
      })
      fileLog.info(`accepted message ${message.id} from ${message.senderId} (conversation ${message.conversationId}); agent turn settled in ${Date.now() - startedAt}ms`)
      // One settled agent turn = one memory turn. The summarizer counts it,
      // and every memorySummaryTurns of them fires a background summary into
      // conv memory — fire-and-forget, it must never delay or fail the reply.
      memorySummarizer?.afterTurn(accountId, message.conversationId)
      // ⑥ One row per day, written by the turn that already bumped the bond: a
      // sparkline later needs history, and history needs exactly one writer.
      if (effectiveConfig.current.memoryEnabled !== false && memoryShared === true) {
        try {
          const bondNow = readConvMemory(stateRoot, accountId, message.conversationId, { warn })?.bond
          const lifeNow = companion ? readOrInferLifeState(stateRoot, accountId, { bond: bondNow, warn, persist: false }) : undefined
          recordAffinitySnapshot(stateRoot, accountId, message.conversationId, { bond: bondNow, life: lifeNow, warn })
        } catch (error) {
          errLog(`affinity snapshot failed: ${String(error?.message ?? error)}`)
        }
      }
      // A late reply already went out through onLateReply; sending the empty
      // text here would be a stray message.
      if (reply.late === true) return
      // A cancelled turn has nothing to say: `/cancel` already sent its own
      // receipt, and an empty chunk would be a blank bubble in the chat.
      if (reply.cancelled === true) {
        fileLog.info(`turn cancelled by user for ${message.conversationId}`)
        return
      }
      // Media first, text second: the send already degrades to text when an
      // upload fails, and everything the user is about to see is decided here.
      const outbound = await resolveOutboundReply({
        config,
        transport,
        mediaDirs,
        stateRoot,
        reply: reply.text,
        conversationId: message.conversationId,
        contextToken: message.contextToken,
        warn,
        fileLog,
      })
      // Stickers: the model writes `[表情:开心]` where a person would drop a
      // sticker (the protocol has no sticker item, so a drawn PNG goes out as an
      // image bubble instead). Markers are stripped before anything counts
      // characters, or the bracket would show up in the bubble itself.
      const stickerPlan = companion && effectiveConfig.current.stickerEnabled !== false
        ? takeStickers(outbound.text, { modeId: activeMode?.id })
        : { text: outbound.text, stickers: [], dropped: [] }
      if (stickerPlan.dropped.length > 0) {
        warn(`dropped sticker marker(s): ${stickerPlan.dropped.join(', ')}`)
      }
      if (stickerPlan.stickers.length > MAX_STICKERS_PER_REPLY) {
        stickerPlan.stickers.length = MAX_STICKERS_PER_REPLY
      }
      const replyText = stickerPlan.text
      // P0: a companion answers the way a person types — a beat before the
      // first bubble, then two or three short ones. Everything else (command
      // receipts, errors, progress notes) stays instant, and `default` mode
      // plans delayMs 0 with a single bubble, so a tool never acts alive.
      const pacing = planCompanionReply({
        text: markdownToPlainText(replyText ?? '', resolveMarkdownMode(config)),
        mode: activeMode,
        life,
        config: effectiveConfig.current,
      })
      if (pacing.delayMs > 0) await sleep(pacing.delayMs)
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: replyText,
        bubbles: pacing.bubbles,
        gapMs: pacing.gapMs,
        contextToken: message.contextToken,
      })
      // One bubble per sticker, right after the words. A failed sticker costs a
      // log line: the reply has already been delivered.
      for (const stickerId of stickerPlan.stickers) {
        try {
          await channelFor(transport).sendMedia({
            filePath: stickerPath(stickerId),
            text: '',
            conversationId: message.conversationId,
            contextToken: message.contextToken,
            cdnBaseUrl: transport.cdnBaseUrl,
          })
          fileLog.info(`sent sticker ${stickerId} to ${message.conversationId}`)
        } catch (error) {
          warn(`sticker ${stickerId} failed: ${String(error)}`)
          fileLog.info(`sticker ${stickerId} failed: ${String(error)}`)
        }
      }
      await sendProducedFiles({
        config,
        transport,
        agentCwd,
        sinceMs: startedAt,
        alreadySent: outbound.sent,
        conversationId: message.conversationId,
        contextToken: message.contextToken,
        warn,
        fileLog,
      })
    } catch (error) {
      warn(`turn failed: ${String(error)}`)
      await sendChunked(transport, config, {
        conversationId: message.conversationId,
        text: `（处理失败：${String(error)}）`,
        contextToken: message.contextToken,
      })
    } finally {
      if (config.typingIndicator) await transport.setTyping(false, message.conversationId)
    }
  }
}

/**
 * Turn one agent reply into what actually goes out: the referenced local files
 * uploaded and sent as attachments, plus the text that is left.
 *
 * This is the only place outbound media is triggered, and it is triggered by the
 * reply's own content — there is no tool the agent can call to send a file. The
 * rule, and its two gates, live in `src/media/outbound.js`:
 *
 *  1. the reply references a file (`![alt](path)` or a line that is just a path);
 *  2. that path resolves inside {@link mediaDirs} and is an existing regular file.
 *
 * A refusal or a failed upload never loses the answer: the reference stays in the
 * text and `deliverOutboundMedia` appends one line naming the file and why it did
 * not arrive. That ordering is deliberate — a caption the user can act on beats a
 * silently missing attachment.
 *
 * @param {object} params
 * @param {{ mediaEnabled?: boolean, maxMediaBytes?: number }} params.config
 * @param {ILinkTransport} params.transport
 * @param {string[]} params.mediaDirs
 * @param {string} params.stateRoot
 * @param {string} params.reply
 * @param {string} params.conversationId
 * @param {string} [params.contextToken]
 * @param {(line: string) => void} params.warn
 * @param {{ info: (line: string) => void }} [params.fileLog]  Durable record.
 * @returns {Promise<string>} text to send, with a failure note when applicable
 */
export async function resolveOutboundReply(params) {
  const text = params.reply ?? ''
  const fileLog = params.fileLog ?? { info: () => {} }
  if (params.config.mediaEnabled === false) return { text, sent: [] }
  try {
    const result = await deliverOutboundMedia({
      text,
      to: params.conversationId,
      contextToken: params.contextToken,
      allowedDirs: params.mediaDirs,
      cdnBaseUrl: params.transport.cdnBaseUrl,
      opts: {
        baseUrl: params.transport.baseUrl,
        token: params.transport.token,
        accountId: params.transport.accountId,
      },
      ...(params.config.maxMediaBytes === undefined ? {} : { maxBytes: params.config.maxMediaBytes }),
      // Every delivery decision is recorded durably, not only on the host
      // logger: `ctx.logger` drops levels depending on the host's exporter
      // config, and a refusal that leaves no trace is indistinguishable from a
      // detector that never matched — which is exactly how a relative-path
      // refusal stayed invisible.
      warn: (line) => {
        params.warn(line)
        fileLog.info(`outbound media: ${line}`)
      },
      // deliverOutboundMedia's send seam passes `to` (the peer id; see
      // OutboundMedia and deliverOutboundMedia in src/media/outbound.js), while
      // `sendMedia` names the same value `conversationId`. Forwarding
      // mediaParams verbatim dropped the peer id on the floor: every
      // plugin-driven attachment went out as `to=undefined`, the getUploadUrl
      // request lost `to_user_id`, and the server answered `{ret:-2}` — the
      // file never reached the upload path at all. Adapt the differing key.
      send: ({ filePath, to, contextToken, cdnBaseUrl }) =>
        params.transport.sendMedia({ filePath, conversationId: to, contextToken, cdnBaseUrl }),
    })
    if (result.sent.length > 0) {
      const names = result.sent.map((filePath) => filePath.split('/').pop()).join(', ')
      params.warn(`sent ${result.sent.length} outbound media file(s)`)
      fileLog.info(`sent ${result.sent.length} outbound media file(s): ${names}`)
    }
    return { text: result.text, sent: result.sent }
  } catch (error) {
    // deliverOutboundMedia is written not to throw; if a future edit breaks
    // that, the reply must still go out rather than the turn dying here.
    params.warn(`outbound media step failed, sending text only: ${String(error)}`)
    fileLog.info(`outbound media step failed: ${String(error)}`)
    return { text, sent: [] }
  }
}

