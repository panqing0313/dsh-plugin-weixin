/**
 * 首次上手：把「还缺什么」算成一份能照着做的清单。
 *
 * 为什么不让设置卡自己判断：卡片能看到的只有它自己那几个 remote 返回值，而
 * 「配好了没有」是个跨组件的事实——有没有账号、宿主版本对不对、白名单是不是
 * 空的、有没有知识库文件。判断逻辑放在这里，卡片只负责渲染，测试也只测这里。
 *
 * 每一步都带三类信息：
 * - `state`：`done` 已完成 / `todo` 需要做 / `blocked` 做不了（缺前置条件）/ `note` 只是提示；
 * - `action`：点一下能做的事（卡片里实现成按钮），没有就是纯文字说明；
 * - `why`：为什么这一步重要——清单最怕的是「照着做完了不知道为什么」。
 *
 * 这里刻意不发明新概念：每一步对应插件里已经存在的机制（登录、白名单、设置卡、
 * 知识库目录、模板包），引导只是把它们按「先做什么」排序。
 *
 * @module dsh-weixin/onboarding
 */

/** 清单里的每一步，顺序即「先做什么」。 */
export const ONBOARDING_STEPS = Object.freeze([
  'account',
  'host',
  'allowlist',
  'persona',
  'proactive',
  'knowledge',
  'backup',
])

/**
 * @typedef {object} OnboardingInput
 * @property {Array<{ accountId: string, allowedSenders?: string[] }>} [accounts] 已登录的账号
 * @property {number} [accountCount] 账号数量（没有 accounts 时用）
 * @property {string | null} [hostVersion]
 * @property {boolean} [hostTested]
 * @property {string[]} [allowedSenders] 全局白名单
 * @property {boolean} [personaDefaultMode] 是否设置过默认模式
 * @property {boolean} [proactiveEnabled]
 * @property {boolean} [knowledgeEnabled]
 * @property {number} [knowledgeFiles]
 * @property {boolean} [backupEnabled]
 * @property {boolean} [dryRun]
 */

/**
 * 算一份上手清单。纯函数：不读盘、不看时钟，输入什么就答什么。
 *
 * @param {OnboardingInput} input
 * @returns {{ steps: Array<object>, done: number, total: number, complete: boolean }}
 */
export function buildOnboardingChecklist(input = {}) {
  const accounts = Array.isArray(input.accounts) ? input.accounts : []
  const accountCount = Number.isFinite(input.accountCount) ? input.accountCount : accounts.length
  const globalSenders = Array.isArray(input.allowedSenders) ? input.allowedSenders.filter((id) => typeof id === 'string' && id !== '') : []
  /**
   * 白名单算「完成」的条件：全局有名字，或者至少有一个账号自己配了名字。
   * 只看全局会骗人——账号级覆盖是常见做法，只配账号级的用户会一直看到「还没配」。
   */
  const perAccountSenders = accounts.some((account) => Array.isArray(account?.allowedSenders) && account.allowedSenders.length > 0)
  const allowlisted = globalSenders.length > 0 || perAccountSenders

  const steps = [
    {
      id: 'account',
      title: '登录一个微信账号',
      titleEn: 'Log a WeChat account in',
      state: accountCount > 0 ? 'done' : 'todo',
      action: accountCount > 0 ? null : 'login',
      detail: accountCount > 0 ? `已登录 ${accountCount} 个账号。` : '还没有账号。扫码登录后，消息才会进来。',
      detailEn: accountCount > 0 ? `${accountCount} account(s) signed in.` : 'No account yet — nothing arrives until you scan the QR code.',
      why: '扫码这一步只能你本人做，插件代替不了。',
      whyEn: 'Only you can scan the code; the plugin cannot do it for you.',
    },
    {
      id: 'host',
      title: '确认宿主版本在测试过的列表里',
      titleEn: 'Check the host version is one we tested',
      state: input.hostVersion == null || input.hostVersion === ''
        ? 'note'
        // An untested host is a caution, not an unfinished step: nothing the
        // operator can do in this app changes the version of DSH it is running.
        : input.hostTested === false ? 'note' : 'done',
      action: null,
      detail: input.hostVersion == null || input.hostVersion === ''
        ? '读不到宿主版本；功能能跑，出问题时会先排查这一项。'
        : input.hostTested === false
          ? `宿主 ${input.hostVersion} 不在测试列表里，遇到怪问题先看 compatibility.md。`
          : `宿主 ${input.hostVersion}，已验证过。`,
      detailEn: input.hostVersion == null || input.hostVersion === ''
        ? 'Host version unknown; everything still works, but this is the first thing to check if something looks odd.'
        : input.hostTested === false
          ? `Host ${input.hostVersion} is not in the tested list; check docs/compatibility.md if something looks broken.`
          : `Host ${input.hostVersion} — tested.`,
      why: '插件跑在宿主进程里，版本不对时第一个表现出来的是「莫名其妙不响应」。',
      whyEn: 'The plugin runs inside the host process; a version mismatch usually shows up as unexplained silence.',
    },
    {
      id: 'allowlist',
      title: '告诉它「谁能让它干活」',
      titleEn: 'Decide who is allowed to talk to it',
      state: allowlisted ? 'done' : accountCount > 0 ? 'todo' : 'blocked',
      action: allowlisted ? null : 'allowlist',
      detail: allowlisted
        ? `白名单里有 ${globalSenders.length > 0 ? globalSenders.length : '（账号级）'} 个名字。`
        : accountCount > 0
          ? '白名单还是空的：任何人都能指挥它（第一次扫码的那个人会被自动加入）。'
          : '先登录，再决定谁可以跟它说话。',
      detailEn: allowlisted
        ? `The allowlist covers ${globalSenders.length > 0 ? globalSenders.length : 'per-account'} sender(s).`
        : accountCount > 0
          ? 'The allowlist is empty: anyone can drive it (the first person to scan is enrolled automatically).'
          : 'Log in first, then decide who may talk to it.',
      why: '它能在你电脑上读写文件、跑命令。白名单是唯一的人为边界。',
      whyEn: 'It can read and write files and run commands on this machine. The allowlist is the boundary.',
    },
    {
      id: 'persona',
      title: '选一个说话的样子',
      titleEn: 'Pick how it talks',
      state: input.personaDefaultMode === true ? 'done' : 'note',
      action: 'persona',
      detail: input.personaDefaultMode === true
        ? '已经设过默认模式。'
        : '默认是「默认助手」：不扮演，问什么答什么。想要陪聊感就去个性化里挑一个，或者导入模板包。',
      detailEn: input.personaDefaultMode === true
        ? 'A default mode is set.'
        : 'It answers as a plain assistant by default. Pick a persona — or import a pack — if you want company.',
      why: '同一个模型，换个说话方式，用起来完全是两件事。',
      whyEn: 'Same model, different voice — it feels like a different product.',
    },
    {
      id: 'proactive',
      title: '决定它要不要主动找你',
      titleEn: 'Decide whether it speaks first',
      state: input.proactiveEnabled === true ? 'done' : 'note',
      action: 'options',
      detail: input.proactiveEnabled === true
        ? '主动开口是开的（有窗口、每日条数与间隔上限）。'
        : '主动开口是关的：只有你先说话它才回。怕打扰就保持关闭。',
      detailEn: input.proactiveEnabled === true
        ? 'Proactive is on (with a window, a daily cap and a minimum gap).'
        : 'Proactive is off: it only answers. Leave it off if you would rather it stayed quiet.',
      why: '这是最容易「惊喜」的开关，明确一次比事后猜好。',
      whyEn: 'This is the switch most likely to surprise someone; decide it on purpose.',
    },
    {
      id: 'knowledge',
      title: '把资料交给它（可选）',
      titleEn: 'Hand it your documents (optional)',
      state: input.knowledgeEnabled === false
        ? 'note'
        : Number.isFinite(input.knowledgeFiles) && input.knowledgeFiles > 0 ? 'done' : 'note',
      action: 'knowledge',
      detail: input.knowledgeEnabled === false
        ? '知识库是关的。'
        : Number.isFinite(input.knowledgeFiles) && input.knowledgeFiles > 0
          ? `知识库里有 ${input.knowledgeFiles} 份文件。`
          : '把 md/txt/pdf/docx 放进知识库目录，问到相关内容它会带出处回答。',
      detailEn: input.knowledgeEnabled === false
        ? 'The knowledge base is off.'
        : Number.isFinite(input.knowledgeFiles) && input.knowledgeFiles > 0
          ? `${input.knowledgeFiles} file(s) in the knowledge base.`
          : 'Drop md/txt/pdf/docx files into the knowledge folder and answers will cite them.',
      why: '「它知道我家的事」和「它不知道」的区别，全在这里。',
      whyEn: 'This is the difference between "it knows my stuff" and "it does not".',
    },
    {
      id: 'backup',
      title: '打开自动备份（可选）',
      titleEn: 'Turn on backups (optional)',
      state: input.backupEnabled === true ? 'done' : 'note',
      action: 'options',
      detail: input.backupEnabled === true
        ? '自动备份是开的。'
        : '备份是关的：日报、记忆、提醒都在数据目录里，换机器或误删就没有了。',
      detailEn: input.backupEnabled === true
        ? 'Automatic backups are on.'
        : 'Backups are off: digests, memory and reminders all live in the state directory.',
      why: '记忆是这个插件最贵的东西，丢了重建不回来。',
      whyEn: 'Memory is the most expensive thing here; it cannot be rebuilt once lost.',
    },
  ]

  const done = steps.filter((step) => step.state === 'done').length
  return {
    steps,
    done,
    total: steps.length,
    // 「完成」只要求前三个必须项都做完；其余是提示项。
    // Only steps the operator can actually finish here count. The host version is
    // not one of them — you cannot upgrade DSH from inside the plugin, and a
    // runner with no DSH at all must still be able to say "the rest is done".
    complete: steps.filter((step) => ['account', 'allowlist'].includes(step.id)).every((step) => step.state === 'done'),
  }
}

/**
 * 一行摘要，给侧边栏/标题用：「还需要 2 步」。
 *
 * @param {ReturnType<typeof buildOnboardingChecklist>} checklist
 * @param {(zh: string, en: string) => string} t
 */
export function describeOnboardingProgress(checklist, t = (zh) => zh) {
  const todo = checklist.steps.filter((step) => step.state === 'todo').length
  if (todo === 0) return t('已经可以用了', 'Ready to use')
  return t(`还差 ${todo} 步就能用`, `${todo} step(s) left before it works`)
}

/** 用一段文字回答「我该做什么」——比如第一次打开设置卡时的说明。 */
export function describeNextStep(checklist, t = (zh) => zh) {
  const next = checklist.steps.find((step) => step.state === 'todo')
  if (next === undefined) return t('没有必须做的了。', 'Nothing left that you have to do.')
  return t(`下一步：${next.title}`, `Next: ${next.titleEn}`)
}

/**
 * 第一个能用到的东西：把清单的最短路径写成命令序列。
 *
 * 为什么值得单独一个函数：`docs/quickstart.md` 与 README 的首屏都要一段
 * 「三条命令跑起来」，而它必须和清单同源——清单里先登录、再白名单，这里
 * 就不能反过来；否则文档和界面各说各话，这才是新手最容易被绊倒的地方。
 *
 * @param {{ loginHint?: string }} [options]
 */
export function quickstartLines(options = {}) {
  const login = typeof options.loginHint === 'string' && options.loginHint !== '' ? options.loginHint : 'node bin/login.js'
  return [
    { command: 'npm install dsh-plugin-weixin && node bin/doctor.mjs', note: '装好并自检：宿主版本、依赖、数据目录都会报出来。' },
    { command: login, note: '扫码登录一个微信账号——这一步只能用手机完成。' },
    { command: 'node bin/onboard.mjs', note: '把它需要的目录与默认配置建好，然后告诉你还差哪一步。' },
  ]
}
