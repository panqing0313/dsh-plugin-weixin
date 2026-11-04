/**
 * 配置的生效时机。
 *
 * 设置卡保存会写进 `config.json`，但「写进去了」和「什么时候算数」不是一件事。
 * 这个模块把三件事分开说清楚：
 *
 *   - `live`：**下一条消息**就按新值走。热路径（限流、会话命令、提醒、主动
 *     开口、记忆、群聊、导出……）每一处都重新读存档配置，所以这些立刻生效。
 *   - `restart`：要等插件重新加载。长轮询间隔、ASR 子进程、通知服务监听端口、
 *     OCR 超时这些在启动时一次性建立的东西，改了不会自己重建。
 *   - `login`：改的是账号本身，要重新登录。
 *
 * 为什么要有这张表：改完设置发现「没反应」，最常见的原因不是没保存，而是改的
 * 那一项本来就属于重启才生效的那一类。
 *
 * 表必须覆盖 schema 的每一个字段：`test/config-effect.test.js` 拿
 * `Config.dict` 的实际字段名核对，漏项会直接失败，而不是悄悄归到「重启生效」。
 *
 * @module dsh-weixin/config-effect
 */

/** @typedef {'live' | 'restart' | 'login'} EffectKind */

/**
 * 每一项的生效时机。
 *
 * @type {Record<string, EffectKind>}
 */
export const CONFIG_EFFECTS = Object.freeze({
  // —— 重启后才生效：启动时一次性建立的东西 ——
  'sendIntervalMs': 'restart', 'voiceOutbound': 'restart', 'ocrTimeoutMs': 'restart', 'notifyPort': 'restart', 'eventPollMs': 'restart',
  'asr': 'restart',

  // —— 保存即生效：每条消息 / 每个 tick 都重读存档配置 ——
  'enabled': 'live', 'accountId': 'live', 'cwd': 'live', 'allowedSenders': 'live', 'allowedChats': 'live',
  'maxMessageLength': 'live', 'sendCooldownMs': 'live', 'messageJournal': 'live', 'personaDefaultMode': 'live', 'memoryEnabled': 'live',
  'memorySummaryTurns': 'live', 'memoryStaleDays': 'live', 'memoryGlobalMaxFacts': 'live', 'memorySimilarityRoute': 'live', 'memoryConvMaxChars': 'live', 'memoryGlobalMaxTokens': 'live',
  'chatProvider': 'live', 'chatModel': 'live', 'sideProvider': 'live', 'sideModel': 'live', 'documentExtract': 'live',
  'ocrEnabled': 'live', 'ocrCommand': 'live', 'ocrMaxChars': 'live', 'documentTextChars': 'live', 'proactiveProvider': 'live',
  'proactiveModel': 'live', 'reportProvider': 'live', 'reportModel': 'live', 'memoryProvider': 'live', 'memoryModel': 'live',
  'memoryRecentTurns': 'live', 'memoryRecall': 'live', 'memoryRecallDays': 'live', 'memoryRecallHits': 'live', 'knowledgeEnabled': 'live', 'knowledgeHits': 'live', 'humanPacing': 'live',
  'replyDelayMaxMs': 'live', 'bubbleSplitMax': 'live', 'bubbleGapMs': 'live', 'lifeState': 'live', 'stickerEnabled': 'live',
  'stickerKeepBuiltins': 'live',
  'ttsVoice': 'live', 'voiceReplies': 'live', 'voiceReplyMaxChars': 'live',
  'proactiveEnabled': 'live', 'proactiveMinGapMinutes': 'live', 'proactiveMaxPerDay': 'live', 'proactiveWindowStart': 'live', 'proactiveWindowEnd': 'live', 'proactiveLearnedWindow': 'live',
  'groupChatEnabled': 'live', 'groupReplyWhen': 'live', 'groupBotNames': 'live', 'groupKeywords': 'live', 'packsIndexUrl': 'live',
  'groupSummaryEnabled': 'live', 'groupSummaryEvery': 'live', 'contactStaleDays': 'live', 'contactRefreshEnabled': 'live', 'contactRefreshPerDay': 'live', 'pricePer1kInputYuan': 'live', 'pricePer1kOutputYuan': 'live', 'usageAwarenessEnabled': 'live',
  'groupShareMemory': 'live', 'videoFrames': 'live', 'richContent': 'live', 'codeFileThreshold': 'live', 'locale': 'live',
  'toolNotices': 'live', 'quietHoursEnabled': 'live', 'quietHoursStart': 'live', 'quietHoursEnd': 'live', 'senderRatePerMinute': 'live',
  'senderDailyLimit': 'live', 'maxQueuedPerConversation': 'live', 'retentionJournalDays': 'live', 'retentionAuditDays': 'live', 'retentionMediaDays': 'live',
  'retentionExportsDays': 'live', 'retentionLogsDays': 'live', 'dryRun': 'live', 'metricsExport': 'live', 'backupEnabled': 'live',
  'backupKeep': 'live', 'notifyEnabled': 'live', 'notifyToken': 'live', 'webhookUrl': 'live', 'webhookSecret': 'live',
  'webhookTimeoutMs': 'live', 'awayAutoReply': 'live', 'dateReminderEnabled': 'live', 'dateReminderWhen': 'live', 'mediaMaxBytes': 'live',
  'dateReminderLeadDays': 'live', 'digestEnabled': 'live', 'backgroundDailyLimit': 'live', 'digestWhen': 'live', 'memoryReviewEnabled': 'live',
  'memoryReviewWhen': 'live', 'toolAudit': 'live', 'markdownMode': 'live', 'busyMessageMode': 'live', 'sourceContext': 'live',
  'readLinks': 'live', 'progressAfterMs': 'live', 'progressToolAfterMs': 'live', 'progressEveryMs': 'live', 'maxTurnWaitMs': 'live',
  'typingIndicator': 'live', 'mediaEnabled': 'live', 'autoSendFiles': 'live', 'maxMediaBytes': 'live', 'maxInboundMediaBytes': 'live',
  'cdnBaseUrl': 'live',
})

/**
 * 人类可读的生效时机。
 *
 * @param {EffectKind} kind
 * @returns {{ label: string, labelEn: string }}
 */
export function effectLabel(kind) {
  if (kind === 'restart') return { label: '重启后生效', labelEn: 'takes effect after a restart' }
  if (kind === 'login') return { label: '重新登录后生效', labelEn: 'takes effect after signing in again' }
  return { label: '保存即生效', labelEn: 'takes effect immediately' }
}

/**
 * @param {string} field
 * @returns {EffectKind}
 */
export function effectOf(field) {
  return CONFIG_EFFECTS[field] ?? 'live'
}

/**
 * 「多久以前」的一行话。和 `/keyword stats` 用的是同一种语气。
 *
 * @param {number} at
 * @param {number} now
 */
function describeWhen(at, now) {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/**
 * `/config` 的回答：分三段说清楚「现在算数的」「要重启的」。
 *
 * @param {{ fields: string[], configFile?: string, savedAt?: number, now?: number }} input
 * @returns {string}
 */
export function describeConfigEffect({ fields, configFile, savedAt, now = Date.now() }) {
  const live = []
  const restart = []
  const login = []
  for (const field of fields) {
    const kind = effectOf(field)
    if (kind === 'restart') restart.push(field)
    else if (kind === 'login') login.push(field)
    else live.push(field)
  }
  const lines = []
  lines.push(`配置一共 ${fields.length} 项：${live.length} 项保存即生效，${restart.length} 项要重启。`)
  const head = live.slice(0, 8).join('、')
  lines.push(`· 保存即生效（下一条消息就按新值走）：${head}${live.length > 8 ? ` 等 ${live.length} 项` : ''}`)
  lines.push(`· 重启 DSH 后才生效：${restart.length > 0 ? restart.join('、') : '（没有）'}`)
  if (login.length > 0) lines.push(`· 重新登录后才生效：${login.join('、')}`)
  if (typeof configFile === 'string' && configFile !== '') lines.push(`· 存档：${configFile}`)
  lines.push(
    Number.isFinite(savedAt) && savedAt > 0
      ? `· 上次保存：${describeWhen(savedAt, now)}`
      : '· 还没通过设置卡保存过，用的是默认值。',
  )
  lines.push('想确认某一项到底有没有算数：改完发一条消息试试，或者用 /diag 看当前值。')
  return lines.join('\n')
}
