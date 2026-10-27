# dsh-plugin-weixin

<p>
  <a href="README.md">简体中文</a> ｜ <b>English</b>
</p>

[![npm](https://img.shields.io/npm/v/dsh-plugin-weixin.svg)](https://www.npmjs.com/package/dsh-plugin-weixin)
[![CI](https://github.com/panqing0313/dsh-plugin-weixin/actions/workflows/ci.yml/badge.svg)](https://github.com/panqing0313/dsh-plugin-weixin/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-plugin-weixin.svg)](LICENSE)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-weixin icon" />

Turn **personal WeChat** into a remote control surface for DeepSeek Harness (DSH): send one line in WeChat, the DSH Agent opens a session locally, runs it, and sends the result back to you.

- **You want to get work done from WeChat** → [Install](#install) → [Login](#login) → [Authorization](#authorization-important); three steps and you can send messages.
- **You want to change behavior** → [Configuration](#configuration) (29 items; the settings card carries the same table).
- **You want to know what changed in a release** → [CHANGELOG.md](CHANGELOG.md).
- **Something is broken** → `npm run doctor` (11 checks), then the troubleshooting order in [Documentation](#documentation).

## Contents

- [Highlights](#highlights) · [Current status](#current-status) · [Repository layout](#repository-layout)
- [Install](#install) · [Login](#login) · [Authorization (important)](#authorization-important) · [Configuration](#configuration)
- [Sessions](#sessions-one-wechat-conversation-can-have-multiple-dsh-sessions) · [Outbound attachments](#outbound-attachments-imagesvideosfiles-the-plugin-sends-you) · [Inbound media](#inbound-media-imagesfilesvoicevideo-from-wechat)
- [Scheduled reminders](#scheduled-reminders-remind-and-the-settings-card) · [Scheduled proactive messages](#scheduled-proactive-messages-subscribe) · [Message journal](#message-journal-messagejournal) · [Local recall search](#local-recall-search-recall) · [Immediate summary and export](#immediate-summary-and-export-summary--export)
- [Quiet hours](#quiet-hours-quiethours) · [The Stats tab](#the-stats-tab-stats) · [Persona and memory](#persona-and-memory-mode--remember--forget--memory) · [Companion pacing and life state](#companion-pacing-and-life-state-humanpacing--lifestate) · [Memory corrections](#memory-corrections-remember-old--new--automatic-correction)
- [Language](#language-locale) · [Model routing](#model-routing-chatprovider--sideprovider--memoryprovider) · [The memory model](#the-memory-model-structured-profile--events--person-digest--standalone-model) · [Stickers](#stickers-stickerenabled) · [Speaking first](#speaking-first-proactiveenabled) · [Voice and video](#voice-and-video-voiceoutbound--videoframes)
- [Rich content](#rich-content-richcontent--codefilethreshold) · [Dangerous-tool notices](#dangerous-tool-notices-toolnotices) · [Group chat](#group-chat-groupchatenabled--groupreplywhen--groupsharememory) · [Tool audit](#tool-audit-toolaudit) · [Speech recognition](#speech-recognition-asr)
- [Markdown handling](#markdown-handling) · [Development](#development) · [Release](#release) · [Documentation](#documentation)

## Highlights

What changed in each release lives in [CHANGELOG.md](CHANGELOG.md); this section only covers what works **now**.

### What it can do today

- **Several WeChat accounts at once** — more than one WeChat ID. Add them one by one by QR in the settings card (or `node bin/login.js --account work`); each account sends and receives on its own and long-polls on its own, so logging in, logging out or re-logging one account does not affect the others. A completed scan takes effect immediately, **no DSH restart needed**.
- **Per-account allowlists** — each account can override the global `allowedSenders` / `allowedChats` (edit them right in the settings card; saving re-mounts that account); leave them empty to fall back to the global config. Who can make your Agent work is decided per account.
- **Sessions isolated per account** — each account's WeChat conversations have their own DSH session lines (`/new`, `/list`, `/use`) and never share context. A new session's title carries a `备注名:` prefix and is mirrored as the host sidebar session name, so multiple accounts are distinguishable at a glance; delete session lines you no longer need at any time.
- **One-click pause** — silence one account: Pause immediately stops its inbound polling (the other accounts keep sending and receiving), Resume brings it back seamlessly, and neither needs a restart.
- **Voice works out of the box** — inbound voice is transcoded locally from SILK to WAV, the ASR bridge turns it into text and hands it to the Agent (a hot call takes about 300ms); when recognition fails it degrades to a file on disk. Audio attachments can also go out as voice bubbles (`voiceOutbound`, **off** by default — in practice the iLink server accepts bot voice with `ret=0` but does not deliver it; read [Outbound voice](#outbound-voice-voiceoutbound) before turning it on).
- **Management lives in the settings card, and in the left sidebar** — accounts, sessions, 29 config items, voice models, message journal / stats / reminders / persona / about (version, check for updates, project links) all live in the WeChat card on the DSH settings page; **the same card is also mounted as the "WeChat" page in the left sidebar** (`sidebar.panellist` one line + the `main` panel), so account status, message journal and stats are visible without opening settings. Config items follow the UI language (a Chinese UI is all Chinese; groups start collapsed, click to expand the fields).

Underneath it uses WeChat's **iLink Bot API** (`ilinkai.weixin.qq.com`); the transport layer comes from Tencent's official open-source plugin
[`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT, 2.4.10).
This project vendors it into `vendor/openclaw-weixin/`, strips the OpenClaw coupling, and binds it directly to DSH's `agents` service.

![dsh-plugin-weixin: talking to a DSH Agent inside WeChat](assets/hero.png)

![The journey of one voice message: SILK transcoding, local ASR, step-by-step degradation](assets/voice-pipeline.png)

## Current status

**Verified on real devices**: plugin loading, QR code login, long-poll message reception, allowlist, dedupe, opening a DSH session, reading replies, chunked replies,
"typing", inbound images and files, inbound voice **recognized into text** (SILK → WAV → ASR, hot call about 300ms),
**multiple DSH sessions under one conversation** (`/new`, `/list`, `/use`, switching keeps the context),
**multi-account login and switching** (a second account takes effect right after its scan, no restart).

**Not yet verified**: long-running operation, long-term concurrent use of multiple accounts, group chat; **sending** video (needs video encoding; images,
files and audio voice are supported today); native image understanding (inbound images are handed to the Agent as local paths and the Agent opens them with `read_image` —
that depends on the current model and toolchain, it is not something the plugin itself guarantees).

## Repository layout

```
src/index.js            Plugin entry: name / inject / Config / apply
src/agent-bridge.js     WeChat conversation ↔ DSH agent session (create/resume + followup)
src/session-reader.js   Read assistant replies and running tools back from the session log
src/transport/ilink.js  iLink long polling + send + sendMedia + typing
src/security/allowlist.js  Sender/conversation allowlist (denies everyone by default)
src/message/{chunker,dedupe,markdown}.js  Chunking, bounded dedupe, Markdown→plain text
src/media/inbound.js    Inbound media: download, decrypt, write to disk, voice transcoding
src/media/outbound.js   Outbound media: path allowlist, attachment reference detection, upload
src/media/asr.js        Speech recognition: resident ASR bridge client (degrades instead of throwing)
src/state.js            Redirect the credential dir from ~/.openclaw to ~/.dsh/weixin
bin/login.js            QR code login CLI
bin/install.mjs         Install into a given DSH profile
vendor/openclaw-weixin/ Tencent's official MIT transport layer (OpenClaw deps stripped)
```

## Install

### Option 1: install from npm / git (recommended for most users)

DSH's plugin page (sidebar **Plugins**) or the `plugin_manager` tool can install straight from the registry:

```
dsh-plugin-weixin
```

You can also enter a git URL or an absolute path. After installation DSH mounts the bundle automatically; restart to take effect.

Currently published version: [`dsh-plugin-weixin@0.9.9`](https://www.npmjs.com/package/dsh-plugin-weixin).

- **0.8.0** — **First-contact auto-registration**: after a new account scans, the sender of its first message is automatically added to that account's allowlist and let through (previously a new account denied everyone, so the second account looked "dead" after scanning, with the reason only in the logs); below the account row on the login card there is now an allowlist summary (ids listed when there is a list, otherwise a note that the first message is auto-registered).
- **0.7.0** — the sidebar knows its accounts: new session titles carry a `备注名: ` prefix and are mirrored as host session names; session-line deletion is opened up (lines in use and the last line can both be deleted); the settings card gains an **About** tab: current version, check for updates (compared against the npm registry, and it says so when the network is unreachable), project links and the data location.
- **0.6.0** — **files the agent produces are delivered automatically**: files the agent writes into the working directory during a turn (screenshots, converted PDFs, ...) are sent to WeChat even when the reply never mentions them (`autoSendFiles` turns this off); **a failed model call no longer wedges the session**: the reason comes back immediately and the next message is handled normally at once (previously it waited 20 minutes and piled every following message into the queue).
- **0.5.0** — new `/clear` to wipe the current session and start over; fix for outbound attachment recipients being dropped to `to=undefined` at the handoff (plugin-driven attachment upload had been failing that way since 0.1.0); a watchdog for inbound long-poll bodies that hang (the root cause of the phone showing "cannot connect to openclaw"); PDF/Word and other documents written as markdown links are delivered too; schema defaults no longer overwrite the ASR command saved in the settings page.
- **0.4.0** — one WeChat conversation can carry multiple DSH sessions (`/new`, `/list`, `/use`, switching away does not destroy them); **every config item can be viewed and edited in the settings page**; sessions opened by this plugin get a WeChat icon in the session list; the QR code no longer depends on python or undeclared packages (Windows fix); outbound relative paths resolve against the agent working directory.
- **0.3.0** — the repo ships an ASR bridge, so speech recognition works out of the box (see [Speech recognition](#speech-recognition-asr)).
- **0.2.0** — queueing / interjecting while busy, resend on timeout, source blocks, the settings card enters the host Settings.
- **0.1.0 / 0.1.1** — first release: QR polling, the inbound loop started automatically after login, allowlist merging, automatic recovery of archived sessions.

### Option 2: install from source

```bash
git clone <this-repo> && cd dsh-plugin-weixin
node bin/install.mjs                      # installs into $DSH_PROFILE (or desktop) by default
node bin/install.mjs --profile web        # install into another profile
node bin/install.mjs --uninstall
```

The script does three things:

1. puts the package (including `vendor/`) into `<profile>/node_modules/dsh-weixin`;
2. appends `dsh-weixin` to `dsh.profile.bundles` in `<profile>/package.json`;
3. appends one `dsh-weixin` line to `<profile>/cordis.patch.yml` (idempotent; refreshes that line if it already exists).

It also moves two **optional** dependencies (`qrcode-terminal`, `silk-wasm`) into the profile's `node_modules` —
otherwise they are only visible inside this repo and silently degrade once installed into a profile.

> **Note: how long this installation survives depends on the version declared in the profile.**
>
> - When the declared range and the installed version **agree**, the `pnpm install` at app startup sees nothing to do and the copy is kept (locally modified files are not overwritten);
> - When the declared range **changes** (e.g. the profile still says `^0.9.3` while you installed 0.9.5), pnpm installs whatever version that range resolves to
>   from the registry and the manually copied sources are overwritten wholesale — newly added files simply disappear, which shows up as
>   "different features before and after a restart"; that is exactly how the sidebar entry vanished once.
>
> To make the installation stable long-term, add `--pin`:
>
> ```bash
> node bin/install.mjs --profile desktop --pin
> ```
>
> `--pin` points the profile's `dependencies` at the version of this exact code (`^<version>`) and refreshes the lockfile with the pnpm bundled with the app. It only makes sense for **published versions**: pinning to a source version that is not published yet just makes pnpm fail to find the package — in that case verify with a temporary copy first and `--pin` after the release. Non-caret declarations (e.g. `file:...tgz`) are not rewritten, only reported.

Restart DSH for it to take effect.

## Login

```bash
node bin/login.js                    # prints a QR code in the terminal, scan it with WeChat on your phone
node bin/login.js --account work     # pick an id when you have several accounts
node bin/login.js --force            # force a new scan even when an account already exists
```

Credentials are written to `~/.dsh/weixin/openclaw-weixin/accounts/<id>.json`, permissions `0600`, **on this machine only**.
`bin/login.js` takes no password and never prints the token to the log (the vendor code redacts it).

### Logging in from the DSH settings page

"Settings → Plugins → dsh-plugin-weixin" also lets you scan without opening a terminal:

- After clicking "Scan to log in to WeChat", the card shows **a real QR image** (the host renders the login link
  iLink returns into a PNG and sends it back, so the client needs no QR library at all);
- The QR code can be drawn **on any platform**, with no python and no extra packages: the QR matrix comes from
  `qrcode-terminal` (already a dependency) and the PNG is encoded by hand in `src/png.js` using only `node:zlib`.
  Early implementations looked for the npm `qrcode` package first and then for `python3` — the former was never a
  dependency and the latter does not exist on Windows, so Windows users saw a **broken-image icon** instead of a
  QR code. That path is now pinned down by tests;
- If drawing really fails, the card **says "the QR image is unavailable, click below to open it in a browser"**
  instead of stuffing the login link into an `<img>` and showing a broken image;
- Next to the QR code are "Open in browser" and "Copy link" — the `qrcode_img_content` iLink returns is actually a
  **login link** (`https://liteapp.weixin.qq.com/q/...`), not an image; opened in a browser the link scans just the
  same;
- When a verification code is required the card switches to an input box and keeps polling after submission; an
  expired QR code refreshes automatically (at most 3 times).

### Logging out and re-binding

"Log out" only deletes the **local** credentials. iLink has no server-side unbind endpoint, so the bot stays attached on the WeChat side (your phone still shows
"bound"), therefore:

- After logging out, the card showing "not logged in" is **an accurate display, not stale state** — this machine really has no credentials left.
  The card's state is decided by the local account files; "bound" on the phone describes the server-side binding relationship, and the two were never the same thing;
- If you scanned with the settings page before that logout, that flow **never worked end to end** (polling sat in `poll(null)`,
  see `docs/progress.md`). That is: after scanning, the card stays on the QR page and nobody handles the scan result, which has
  nothing to do with the phone showing "bound". After the fix, scanning again is what actually reaches the server;
- Even once you reach the server there is one more case: when the server still believes this machine is bound to the same bot, it answers `binded_redirect`
  and **refuses to issue new credentials** (this branch's semantics come from the vendor sources; the vendor CLI reads it as an idempotent success
  "already connected to this OpenClaw, no need to reconnect", but that only holds while **this machine still holds the token** — after a logout the token
  is gone and there is no local interface that could unbind);
- The card reports this case separately as "needs attention" and gives the only workable action: **first unbind that bot in WeChat on your phone**,
  then scan again.

In short: logging out = this machine forgets; to re-bind = unbind on the phone first.

### No DSH reload needed after a successful QR scan

If this machine has no credentials when the plugin loads (a fresh install, or right after a logout), the `getUpdates` long poll that receives messages
**cannot start** at that moment. After a successful scan in the settings page, the login notifies the host to start that loop immediately for the
**freshly written credentials**, so the redundant "scan → reload DSH → it works" step is gone.

If WeChat on your phone still says "cannot connect to openclaw right now", check four things in order:

1. whether the plugin log has `listening as account <id>` — if not, the loop did not start;
2. whether it has `settings login service unavailable` — if so the login service was not installed: the scan **does** succeed and the
   credentials **are** written to disk, but nobody is listening for "login completed", so the loop never switches to the new credentials (historically
   this line swallowed a misuse of `ctx.plugin()`, with symptoms identical to "the loop did not start");
3. whether it has `no Weixin account is saved` (no credentials) or `is already being listened to` (a duplicate trigger, normal);
4. whether the server rejects the credentials: `getUpdates errcode=-14` means the login expired and you need to scan again.

When switching to a new bot (the token changed) the plugin **stops the old long poll before starting the new one**: two long polls on the same credential make
the server **split** inbound messages between the two loops instead of delivering one copy to each.

### Managing multiple accounts

Several accounts can be logged in at the same time (add them one by one with `node bin/login.js --account work`, or scan one by one behind
**Add account** in the settings card). Every saved account has **its own inbound loop**: one account's credentials expiring, logging in or logging out
does not affect the others' sending and receiving. Sessions are isolated per account as well — the same WeChat conversation under two accounts is two
independent session lines, and `/list` and `/use` only touch the lines of the account that received the message.

The login card under "Settings → WeChat" lists one row per account: the note name (or the account id), the last-active time
("just now / N minutes ago / N hours ago / N days ago"), a paused marker, and three actions:

- **Rename** — give the account a note name (e.g. "work"); display only, stored locally in
  `~/.dsh/weixin/accounts-registry.json`. Editing happens inside the card: after clicking "Rename" an input appears under the account row,
  **Save** applies it and **Cancel** discards it (the desktop cannot pop a browser-style prompt, so it is inline editing, not a dialog);
- **Allowlist** — set the allowed senders for this one account (comma separated, prefilled with the currently effective
  list). Empty = clear the override and fall back to the global allowlist; changes take effect **immediately**, no reload. The effective
  rule is that the account override wins over the global `allowedSenders`;
- **Pause / Resume** — pause one account's inbound (the credentials are kept and the phone still shows it as bound).
  Pausing takes effect **immediately**, no reload; a paused account logs one explicit line
  (`account "<id>" is paused; not starting its loop`), so deliberate silence is not misread as a failure;
- **Log out** — log out only this account; the others keep sending and receiving.

The registry is pure metadata: a corrupt file loses at most note names and pause markers and never affects message delivery.

## Authorization (important)

WeChat text is **not** an authorization credential. Therefore:

- `allowedSenders` defaults to **empty**, which equals denying everyone — a plugin with no allowlist configured drives nothing;
- A sender not on the allowlist only gets one warn line; no session is created and no reply is sent;
- **First-contact auto-registration**: when an account's own allowlist is empty (never configured in the card and never registered), the sender of the
  first message received is taken to be the person who scanned the code, added to that account's allowlist automatically, and allowed through this one time —
  at scan time only the bot id is known, a person's WeChat id only appears with the first message. Other strangers are still denied afterwards; add people in the
  settings card, or clear it and start over;
- Real file modifications and command execution are still decided by DSH's own permission layer and confirmation flow; this plugin does not bypass them.

## Configuration

The `config` of that line in `cordis.patch.yml`:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Turning it off stops the long poll from starting |
| `accountId` | `''` | Empty = only use the single saved account |
| `cwd` | `''` | Agent working directory; empty = inherit the session default |
| `allowedSenders` | `[]` | WeChat user ids allowed to drive the Agent |
| `allowedChats` | `[]` | Conversation allowlist; empty = no conversation restriction |
| `maxMessageLength` | `1500` | Character limit for one outbound message |
| `sendIntervalMs` | `1200` | Minimum gap in milliseconds between two outgoing messages (text chunks and attachments both count). In practice about 20 messages in a few minutes triggers an account-level sending block (≥30 minutes); this interval keeps chunked replies under that line |
| `sendCooldownMs` | `30000` | Cooldown in milliseconds after 3 consecutive send failures, so a temporary rejection does not escalate into an account block |
| `readLinks` | `true` | Fetch the page text for the Agent when a message contains an http(s) link; a link that cannot be fetched only reports one line of reason and does not affect the message |
| `messageJournal` | `true` | Record recent sent and received messages in a local journal; the "Message journal" tab of the settings card shows the latest 50 |
| `personaDefaultMode` | `'default'` | Default conversation mode for new sessions. The "default mode" selector on the "Persona" tab of the settings card overrides it live (saved to disk, takes effect with no reload) |
| `memoryEnabled` | `true` | Fold long-term memory, conversation summaries and the recent-message window into the prompt. Turning it off disables /remember, /forget and /memory along with it; /mode is a separate feature and is unaffected |
| `memorySummaryTurns` | `10` | After how many completed agent turns the summary of this conversation is updated automatically in the background |
| `memoryGlobalMaxFacts` | `30` | Upper bound on long-term memory entries; once full, /remember refuses new ones instead of silently evicting the oldest |
| `memoryConvMaxChars` | `1200` | Character limit for the conversation summary |
| `memoryProvider` | `''` | Memory model provider (used for summaries / extraction / consolidation). Empty = keep using the current session's model |
| `memoryModel` | `''` | Memory model model; only effective together with provider |
| `memoryRecentTurns` | `5` | How many recent messages to backfill on a cold start: injected once, only into a **new session line** (first message, `/new`, `/mode` switch); an already-connected session does not repeat it. 0 disables it |
| `memoryRecall` | `true` | When a message mentions something from the past, search the local journal for the original text and fold it into the prompt; a casual chat that hits nothing spends no tokens |
| `memoryRecallDays` | `180` | How many days back local recall search looks (older journal files are still on disk, just not indexed) |
| `memoryRecallHits` | `3` | At most how many matching originals to inject at once (each truncated to 140 characters) |
| `humanPacing` | `true` | Companion mode's "reply like a human": a first-message delay plus splitting long replies into several bubbles. Only applies outside "default assistant" mode |
| `replyDelayMaxMs` | `2400` | Upper bound in milliseconds on the pause before the first reply: the actual pause varies with reply length and current energy, slower when tired |
| `bubbleSplitMax` | `3` | Maximum number of bubbles a long reply is split into (1 = no splitting). A single short sentence is always one message |
| `bubbleGapMs` | `700` | Pause in milliseconds between two bubbles; the actual value jitters between 0.7× and 1.3× |
| `lifeState` | `true` | Infer mood / what it is doing / energy from the clock and fold that into the prompt so the tone follows the state (throttled to disk every 5 minutes, no model involved) |
| `stickerEnabled` | `true` | Let the model write `[表情:开心]` to send a sticker image instead (an image bubble). When off, the marker is not even taught to the model |
| `proactiveEnabled` | `false` | Companion mode "speaks first": sends a message on its own when the other side has been quiet for a while. **Off** by default, only applies outside "default assistant" mode |
| `proactiveMinGapMinutes` | `180` | At least this long since the other side's last message before it may speak first; also the base for the backoff when unanswered (doubles each time, up to one day) |
| `proactiveMaxPerDay` | `3` | Maximum number of proactive messages per account per day |
| `proactiveWindowStart` | `'09:00'` | Start of the speaking window (local `HH:mm`); nothing is sent outside it, and a reversed window falls back to the default |
| `proactiveWindowEnd` | `'23:00'` | End of the speaking window (local `HH:mm`); must be later than the start |
| `quietHoursEnabled` | `false` | Do-not-disturb switch: while on, scheduled reminders and /subscribe proactive messages that fall inside the window are deferred until it ends (rescheduled — never lost, never duplicated) |
| `quietHoursStart` | `'23:00'` | Quiet hours start (local `HH:mm`). Must be strictly earlier than the end (or cross midnight); equal ends are treated as unconfigured |
| `quietHoursEnd` | `'07:00'` | Quiet hours end (local `HH:mm`). A window crossing midnight (e.g. 23:00 → 07:00) counts as two segments |
| `groupChatEnabled` | `false` | Take part in group chat. Off by default: a bot that answers every group message is just spam in a real group; private chats are unaffected |
| `richContent` | `true` | Rich content: long code blocks are sent as files (indentation/language/line count intact), Markdown tables become aligned text |
| `videoFrames` | `true` | On receiving a video, pull three still frames with the local ffmpeg and hand them to the model (the model cannot read video, but it can read images) |
| `codeFileThreshold` | `1200` | Above how many characters a code block is sent as a file; shorter ones stay in the bubble |
| `groupReplyWhen` | `'mention'` | When to reply in a group: `mention` answers only when addressed, `all` answers every message |
| `groupShareMemory` | `false` | Whether to inject long-term memory, recall snippets and the closeness line in groups too. Off by default — those blocks are the owner's own private business |
| `toolAudit` | `true` | Append every agent tool call to `<state dir>/audit/` (one JSONL per day): tool name, arguments truncated to 500 characters, which account/conversation/sender triggered it, whether the result carries an error |
| `voiceOutbound` | `false` | Send audio attachments as WeChat voice notes instead of files (wav/silk transcoded in-process, everything else via ffmpeg). **Off** by default: in practice the server accepts bot voice (ret=0) but does not deliver it, so turning it on makes attachments disappear silently; a rejected send still degrades to a file automatically |
| `markdownMode` | `'strip'` | Markdown handling for replies: `strip` converts to WeChat-readable plain text, `off` sends as-is |
| `progressAfterMs` | `45000` | Send a progress hint before the timeout |
| `maxTurnWaitMs` | `1200000` | Upper bound on waiting for one turn |
| `typingIndicator` | `true` | Show "typing" when there is a typing ticket |
| `mediaEnabled` | `true` | Send local files referenced in a reply as attachments (outbound) |
| `maxMediaBytes` | `104857600` (100MB) | Size limit for outbound attachments |
| `maxInboundMediaBytes` | `20971520` (20MB) | Download size limit for inbound attachments |
| `cdnBaseUrl` | empty (not configured) | CDN root for inbound downloads and outbound uploads. Empty means "not configured here": the `cdnBaseUrl` from the account record is used first, then the upstream default `https://novac2c.cdn.weixin.qq.com/c2c` |
| `asr.modelDir` | `''` | Voice model directory; empty = `~/.dsh/weixin/asr-models`. The input box in the settings page overrides it (and writes it into `<stateDir>/asr-config.json`) |

Reload the plugin after changing the config.

**All of these options can now be changed in the settings page**: open the **Config items** tab under "Settings → WeChat", edit item by item and
save. The form reads the plugin's own schema, so every option carries its default, its current value and where that value comes from
(`default` / from `config` / saved); items changed but not saved are marked. Saving writes only the items you changed,
into `~/.dsh/weixin/config.json` (next to the credentials, so reinstalling the plugin does not lose them).

Priority: **value saved in the UI > `config` in `cordis.patch.yml` > schema default**.
To drop a change, click "restore default" on that item.

Only two are read-only in the UI:

- `maxTurnWaitMs` — lowering it silently truncates long replies, so it is not a good everyday switch;
- `enabled` — it is the plugin's master switch; change it in the YAML (the settings page still works after turning it off,
  so you can configure everything first and enable it afterwards).

**Files the agent produces are delivered automatically**: files the agent writes into the working directory during a turn (screenshots, converted documents,
exported data, ...) are sent to WeChat right after the reply goes out, without an extra "send it to my WeChat" — even when the reply text never references them.
Only deliverable extensions (images/documents/audio-video) are accepted, subdirectories are not recursed into, and it does not apply while `mediaEnabled` is off either.
The settings page can turn it off under "Media → auto-deliver produced files".


## Sessions (one WeChat conversation can have multiple DSH sessions)

By default one WeChat conversation maps to exactly one DSH session, and its context keeps growing as you chat. The plugin supports **session lines**:
the same WeChat conversation can hold several DSH sessions, each with its own context and no interference between them.

Send commands directly in WeChat (they only take effect when the whole message is exactly the command; `看看 /new 这个命令` and
`/steer /new` do not count):

| Command | Effect |
| --- | --- |
| `/new` | Open a new session; the following messages go into it |
| `/list` | List every session line under the current conversation, `▶` marks the one in use |
| `/use <index>` | Switch to line N (indices come from `/list`) |
| `/clear` | Wipe the current session and start over: that line is removed from `/list` and a brand-new one opens at once |
| `/cancel` | Interrupt **the turn currently running** (for when a long task is stuck). Messages already queued still proceed; the reply is recorded as "cancelled" rather than "model call failed" |
| `/status` | Show the current account and conversation status: account name, whether paused, last send/receive, allowlist size and source, number of session lines |
| `/remind <time> <content>` | Scheduled reminder: at the set time the bot sends the content straight into the current conversation (e.g. `/remind 10m standup`, `/remind 18:30 clock out`, `/remind 2026-10-20 09:00 weekly report`) |
| `/remindlist` | List this account's reminders that have not fired yet (with indices) |
| `/remindcancel <index>` | Cancel a reminder that has not fired yet |

**Switching preserves, it does not reset**: the line you switch away from is not ended or cleared, and its earlier context is all there when you
switch back. The indices in `/list` are **absolute** (counting from 1), so even when only the latest 10 are shown the indices never shift
because of collapsing.

`/clear` is the only command that loses context, so it only applies to "the line currently in use" and takes no argument —
`/clear 3` and the like are not recognized. The cleared line is only removed from the session-line list and `/use` cannot switch back to it
afterwards; the host's session file is left exactly as it is and no history is deleted.

Commands are answered directly by the plugin and **cost no model conversation**: sending `/new` leaves no question-and-answer turn behind.

Two established facts:

- **Upgrading does not lose context.** The first session line keeps its historical id (`weixin-<conversation slug>`), so an old conversation is still that same line after you install a new version;
- Storage lives in `<stateDir>/sessions.json` (by default `~/.dsh/weixin/sessions.json`); deleting it is equivalent to keeping only one default session line.

### Managing from the settings page

The plugin card in the DSH settings page has a "Sessions" tab: it lists the session lines under every WeChat conversation, marks the one in use,
and lets you click "Switch" to jump to one — no need to go back to WeChat and type `/use`. Every session line has a
**"Delete"** button (effective after confirmation): it removes just that line, the other lines are unaffected; deleting the line in use falls back
automatically to the first remaining one; deleting the last line removes the whole conversation entry and the next message creates a clean new
session line. Every conversation entry also carries an **account marker** (each account's note name or account id), so you can tell at a glance
which account a conversation belongs to; historical conversations from before the upgrade (no account prefix) show no marker. Changes take effect in real time, no reload needed.
The card only reads that file and only writes it, the same path as sending commands from WeChat, so both sides always see the same thing.

### Spotting WeChat sessions in the session list

In the session list on the left of the workspace, rows for **sessions opened by this plugin** start with a WeChat icon (14px, WeChat brand green `#07C160`),
distinguishable from other sessions at a glance.

With multiple accounts, the **title itself** of a session line carries the account marker: a new line is titled like
`备注名: first message` (the short form of the account id when there is no note name), and the sidebar, `/list` and the settings card see the same
title, with no extra inline marker needed. Historical conversations from before the upgrade keep their original titles without a prefix. That title is also
**written into the host session** on the first message (`sessionTitle.rename`, pinned to the user origin), so the host sidebar
shows this `备注名: message` rather than an AI title the host made up; after that the host no longer renames it by itself.

Detection only looks at the `weixin-` prefix of the session id: this plugin opens `weixin-<conversation slug>`, the second line of the same conversation is
`weixin-<conversation slug>--<timestamp>`; other sessions use DSH's own `session-<uuid>` and are never mislabeled.

The icon is mounted in the slot the host declares, `sidebar.session.row.leading`. That slot is provided by ui-workspace to
**every** session row and only renders while the row is idle; archived rows are left empty, and search results have no such position;
the host's own schedule clock (ui-schedule) occupies it too — this plugin uses **its own seat id**, so both coexist without displacing each other.

For sessions not opened by this plugin the component returns `null` — it does not take a single pixel and never puts a WeChat icon on someone else's session.

With multiple accounts there is also a **very faint ownership hint** next to the icon: which WeChat account this session row belongs to, taken from
the note name set for the account in the settings page (the account id when none is set), at most 6 characters, with an ellipsis beyond that. Ownership comes
from the same `/api/weixin/sessions` data as the card, so it is only shown for sessions that match an account; historical conversations from before the
upgrade match nothing and keep just the icon. The hint, like the icon, is decorative and takes part in no behavior beyond layout.

## Outbound attachments (images/videos/files the plugin sends you)

When the Agent **references a local file** in its reply, the plugin uploads the file and sends it as an attachment. Which notations are recognized depends on the **extension**:

```markdown
![caption](image.png)               ← image syntax, any extension is recognized
![caption](/abs/path/a.png)
![caption](<path with spaces.png>)  ← wrap paths containing spaces in angle brackets
[report](report.pdf)                ← link syntax: only applies to "naturally an attachment" extensions
report.pdf                          ← a relative path alone on a line / in a list item: again attachment types only
/abs/path/a.pdf                     ← an absolute, ~/ or C:\ path alone on a line: any extension is recognized
```

**It is delivered even without a reference** (`autoSendFiles`, on by default): files the agent writes into its working directory during a turn —
desktop screenshots, converted PDFs, exported data — are sent to your WeChat automatically after the reply goes out, even if the reply text never mentions them.
Boundaries: only the first level of the working directory is scanned (`tools/`, `crops/` and other subdirectories are not touched), only
deliverable extensions are sent, at most 5 per turn with newer ones first; files already referenced in the reply are not sent twice; the settings page
can turn it off under "Media → auto-deliver produced files".

**Why two different treatments**: nothing in a WeChat reply renders a PDF inline, so `[report](report.pdf)` can only
mean "send me the file"; but `[screenshot](icon.png)` may just be the agent **pointing at a path**, and treating it as an upload would send unrelated images or
even a source tree. The full list of attachment types lives in `ATTACHMENT_EXT` (`src/media/outbound.js`): `pdf doc(x) xls(x)
ppt(x) csv zip tar gz 7z rar mp3 wav m4a ogg mp4 mov webm mkv avi silk`.

These are **not** recognized: paths inside inline code and code blocks (that is **showing** syntax), bare paths in running text (e.g. "the file is in
/tmp/a.pdf"), `![x](with spaces.png)` (not wrapped in angle brackets), and network images such as `https://...` — network images
were never something the plugin should upload in the first place.

The form sent is decided by **MIME** (not the extension):

| Type | Extensions | What you receive |
| --- | --- | --- |
| Image | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` | Image message |
| Video | `.mp4` `.mov` `.avi` `.mkv` `.webm` | Video message |
| Other | everything else (including `.pdf` `.zip` `.docx`, and also `.svg` `.heic` `.m4v` `.wav`) | File attachment |

Note the third row: `getMimeFromFilename` does not recognize `.svg` `.heic` `.tif` `.avif` `.m4v` `.3gp` `.flv` `.wmv`,
so they **degrade to file attachments** — you do receive them, but without a native image/video bubble. For the native effect, pick extensions from the first two rows.

Single-file limit **100MB** (`maxMediaBytes` is adjustable), at most 5 attachments per reply. A failed send never swallows the reply:
the reason is appended as one line after the text.

Files must be inside an **allowed directory**: the agent session's working directory, or `~/.dsh/weixin`. Paths are resolved through `realpath` before containment
is checked, a symlink pointing outside the directory is rejected too, and `..` escapes are judged on the literal path. Loosening "reference detection" does not change this boundary — detection only decides
"whether to try sending", whether it can be read is always decided by the directory check. See "Outbound attachments" in `docs/security.md`.

### Outbound voice (voiceOutbound)

Audio attachments (`.wav`/`.silk`/`.mp3`/`.m4a`/`.aac`/`.ogg`/`.opus`/`.flac`…) can be sent as WeChat **voice bubbles** instead of files: wav/silk is transcoded to SILK in-process (24 kHz, other sample rates linearly resampled), other formats are decoded with `ffmpeg`. When the server **rejects** the send it degrades automatically to a plain file attachment, so audio only degrades, it never disappears.

But it is **off** by default, and the reason deserves honesty: two measurements (2026-06 and 2026-10-26, the latter with a fresh `context_token`, upload and `sendmessage` both returning `ret=0`) showed that **the iLink server accepts the bot's `voice_item` but does not deliver it to the recipient** — the message is silently swallowed server-side, most likely an account-side voice/TTS capability switch. So:

- `voiceOutbound: false` (default) → audio attachments are sent as files and arrive reliably;
- `voiceOutbound: true` → try voice bubbles; if Tencent ever opens up delivery the bubbles will appear normally, the only risk being that an attachment may vanish silently.

To try it some day, turn the switch on, have the agent send some audio, then look for the `sent voice media … (server ret=…)` line in `~/.dsh/weixin/logs/openclaw-*.log`: `ret=0` with nothing on the phone = still not delivered.

## Inbound media (images/files/voice/video from WeChat)

Media sent by a user goes **through the allowlist and dedupe first, and only then** is downloaded from the CDN — an unauthorized sender never makes this machine issue any request
to the CDN (an assertion in `test/e2e.test.js` guards this). After download it is decrypted with AES-128-ECB and stored under
`<stateDir>/media/inbound/` (by default `~/.dsh/weixin/media/inbound/`), then the **local absolute path plus which tool to read it with** is
assembled into the prompt handed to the Agent: images point at `read_image`, files and videos at `read`. A caption attached to a WeChat image is
preserved as well, so the Agent has both the image and the question.

Two security points:

- **A filename from the other side is never used to build a path.** The filename is basename'd first, separators and `.`/`..` segments are removed, a random
  prefix is added, and the write uses the `wx` exclusive mode. `../../etc/passwd` only becomes `a1b2c3d4-passwd` inside the receiving directory; it cannot escape.
- **Size is checked against `Content-Length` first and against the actual byte count after reading.** Headers can be missing, and they can lie; both checks must pass.

Failures are **not silent**: a failed download returns the specific reason to the user (e.g. `CDN returned 403`, `30.0MB, over the 20.0MB limit`)
instead of a vague "not supported". Only genuinely unknown item types (such as `TOOL_CALL_*`) keep the "not supported" notice.

### Links in messages (readLinks)

With `readLinks` on (the default), an http(s) link in a message makes the plugin fetch the page text, strip the HTML and fold it into the prompt handed to the Agent
(at most 3 links, 20000 characters of text each, 512KB of raw response). So "what does this article say" can be answered
directly instead of "I cannot open links". Fetching is best effort: only http(s) is touched; binary content (images/audio/video) is not force-read as
text; a link that cannot be fetched only gives the Agent one line of reason (`HTTP 500`, `request failed: …`), and the message itself still runs its full turn.
`test/links.test.js` and the readLinks cases in `test/e2e.test.js` guard this behavior.

### Scheduled reminders (/remind and the settings card)

Schedule them in WeChat with `/remind 10m content`, `/remind 18:30 content` or `/remind 2026-10-20 09:00 content`;
`/remindlist` shows them and `/remindcancel <index>` cancels one. The "Scheduled reminders" tab of the settings card shows the pending reminders of all accounts
(time due, content) and you can click "Cancel" directly — effective immediately, no need to send a command in WeChat. When a reminder is due the plugin sends the text
directly, wrapped as `（提醒：内容）` ("(reminder: content)"), without spending a model call; if the matching account is offline at that moment the reminder is dropped with a warning (expired ones are not sent after a restart).
`test/scheduler.test.js`, `test/reminders-ui.test.js` and the e2e reminders cases guard this behavior.

### Scheduled proactive messages (/subscribe)

`/remind` sends fixed text at a set time with zero model cost; `/subscribe` instead **has the agent generate a message on the spot at the set time and then send it** —
with the current persona, memory and recent conversation, so a morning greeting uses the tone of the mode you picked and a weekly report talks about what you talked about that week:

- `/subscribe 每天 08:00 早安，问问我睡得怎么样` and `/subscribe 每周日 21:30 聊聊这周` (an English rendering of the two:
  "every day at 08:00, say good morning and ask how I slept" / "every Sunday at 21:30, talk about this week"), a bare
  `HH:mm` equals every day; a one-off time (`10m`, `2026-11-01 09:00`) fires once and is then removed automatically.
- `/subscribelist` shows them (most recent first), `/subscribecancel <index>` cancels one; at most 20 per account.
- Missed dues: a recurring subscription catches up once within 30 minutes and is skipped beyond that (no queue bombing); a one-off that expires is dropped.
  If the matching account is offline when due, it is likewise not sent later. Generation runs in a separate side session, so it does not occupy the normal conversation before it finishes.
`test/subscriptions.test.js` and the /subscribe cases in `test/session-commands.test.js` guard this behavior.

### Message journal (messageJournal)

With `messageJournal` on (the default), every text message sent or received is appended to a local journal (`<state dir>/journal/`,
one file per day, text truncated to 200 characters). The "Message journal" tab of the settings card shows the latest 50 (in ↓ / out ↑, account, time,
content, newest first), so you can confirm every account is alive without digging through logs. Writing the journal is best effort: failures only warn and never affect message delivery.
At the top of the tab there is an **Export records** button: it renders the last 30 days as Markdown and the card downloads it directly, without going through a server-side file.
`test/journal.test.js` and the messageJournal cases in `test/e2e.test.js` guard this behavior.

### Local recall search (/recall)

The message journal already keeps every message locally; what was missing was "being able to find it": summaries are lossy, and facts are hand-curated.
With `memoryRecall` on (the default), every message first searches the local journal — Chinese is split into bigrams, English into words,
BM25 scoring, the index lands in `<state dir>/memory/index/<account>.json`, appended incrementally to the per-day files, covering only the last
`memoryRecallDays` days (180 by default; older journal files are still on disk, just not indexed).

Tokens are only spent when a search is **worth it**: when the message contains words like 「上次 / 之前 / 那天 / 我说过」 ("last time / before / that day / I said"), or when the lexical match is dense enough
(≥2 terms and the score clears the bar), **3 dated originals (`memoryRecallHits`)** are folded into a `<weixin_recall>`
block; a casual chat that hits nothing injects nothing, 0 tokens. The current message and instructions like `/recall` itself never match themselves.

`/recall <keyword>` flips through the records by hand: it replies with the dated originals directly, **without going through the model and without spending tokens**; if nothing is found in this
conversation it widens to the whole account (you often cannot remember which conversation something was said in). `test/recall.test.js`, the /recall cases in `test/session-commands.test.js`
and the local recall cases in e2e guard this behavior.

### Immediate summary and export (/summary · /export)

- `/summary` has the side session summarize this conversation **on the spot** (where the chat got to, what was decided, what is still open, what you two agreed on,
  no more than 300 characters). It only replies to you and **does not write back to the conversation summary** — things worth keeping are for the automatic summary; this step is a "take a look".
  When a turn is already running it answers "wait until this turn finishes" and does not interrupt the turn in progress.
- `/export [days]` renders the chat log of the last N days (30 by default) as Markdown: short records (≤3000 characters) are replied with directly,
  long ones are written to `<state dir>/exports/chat-<account>-<conversation>-<time>.md` and the path is reported.
  The export button on the "Message journal" tab of the settings card goes through the same rendering, only as a browser download instead.
`test/chat-export.test.js` and the /summary and /export cases in `test/session-commands.test.js` guard this behavior.

### Quiet hours (quietHours)

With `quietHoursEnabled` on, `/remind` reminders and `/subscribe` proactive messages that come due between `quietHoursStart` and `quietHoursEnd` (23:00–07:00 by default, crossing midnight supported)
are **deferred until the window ends**: reminders stay on disk and are rescheduled, subscriptions do not consume a run and fire after being pushed back. So nothing rings at night and nothing is lost in the morning. Equal start and end are treated as "not configured"
(otherwise it would mean permanently silent, swallowing every scheduled message). `test/quiet-hours.test.js` guards this behavior.

### The Stats tab (stats)

The "Stats" tab of the settings card reports send/receive volume for the last 7/14/30 days: totals (in ↓ / out ↑), a per-day bar chart, a 24-hour distribution,
and the most active conversations. Every number is **computed on the spot** from the local message journal (no caching, no upload), so it is always consistent with the "Message journal" tab.
`test/stats.test.js` and the stats cases in `test/login-remote.test.js` guard this behavior.

### Persona and memory (/mode · /remember · /forget · /memory)

Each WeChat conversation can pick a conversation mode (up to 8 more can be customized in the settings card; a mode is just a tone prompt —
it only changes how things are said, not the facts or the task abilities). Twelve built-in roles:

| Mode | In one line |
| --- | --- |
| Default assistant | No role-play, answers what is asked — also the only mode that skips "companion pacing / life state" |
| Girlfriend / Boyfriend | Affectionate and colloquial, short messages, caring and a little coy |
| Friend | An old friend of many years: casual, direct, unafraid of a joke |
| Jarvis | A restrained, professional British butler: conclusion first, then one to three points |
| Little whale girl | A mischievous, cute little whale: curious, fond of being spoiled, a "blub blub" verbal tic |
| Mature older sister (御姐) | Composed and confident, terse and brisk, calls you "kid", care hidden inside arrangements |
| Understanding big sister | Catches the emotion first and discusses business after; gives only one piece of advice, never nags |
| Warm guy | Considerate and dependable without being greasy; care lands on specifics (have you eaten, what time did you sleep) |
| Cute daughter | A clingy but sensible little daughter: reports her day, acts spoiled for company |
| Catgirl | A cat's temperament: mostly aloof, clingy once you come close, an occasional "meow" |
| Tsundere | Sharp words, a caring heart, the roundabout care of "it's not like I did it for you" |

There are also three **game modes**: turtle soup (海龟汤: poses the riddle, only answers yes/no/irrelevant, hints on request), idiom chain (成语接龙: you lose when you cannot continue, win streaks are tracked),
text adventure (second person, choice based). In WeChat:

- `/mode` shows which modes exist and which one is in use (roles and games grouped); `/mode 女友` and `/mode 海龟汤` switch. Switching **opens a new session line**
  (`/list` can switch back to the old line at any time and the old context is not lost) — for a game this is starting a new round;
  `/mode 默认` returns to a normal assistant and leaves the game.
- `/remember I am allergic to peanuts` writes one thing into **long-term memory** (it survives across conversations, restarts and /new);
  `/forget <index or keyword>` deletes it; `/memory` shows all of it. Once long-term memory is full (30 entries by default)
  `/remember` refuses explicitly instead of silently evicting the oldest.
- Every conversation also has an **automatic summary**: every `memorySummaryTurns` (10 by default) turns, the plugin condenses the recent conversation into a summary
  in a separate side session in the background — it never sends WeChat messages, you only feel it in the prompt of the next reply.
- With memory on there is also a **closeness** line: which day you met, how many messages in total, the mood right now (late night / lively / quiet for a while / calm,
  produced by deterministic rules, no model cost). It appears at the very front of the prompt (`【我们】…`), in `/status`, in `/memory` and in the settings card,
  giving the tone a sense of accumulated relationship.

When sending a message the plugin folds three things into the prompt (all before your text): the current mode's persona block,
the `<weixin_memory>` memory block (long-term memory + this conversation's summary + recent messages on a cold start), and only then what you said.

**The recent-message window is only injected into the cold-start message**: once the conversation is connected, the agent already has those exchanges
in its own history, and repeating them every turn is pure double billing; the current message itself is not copied into the window either (it sits right after the block). Measured cold vs warm:
the standing overhead dropped from about 945 characters (~630 tokens) to about 322 characters (~215 tokens), at the cost of about 300 extra tokens on that cold start.

The settings card gains a **Persona** tab: switch/add/edit custom modes (built-in modes are read-only), change the account-level default mode
(saved to disk, takes effect with no reload), clear a conversation's mode override, add and remove long-term memories, wipe a conversation summary.
Stored in `<state dir>/persona-modes.json`, `persona-active.json` and under `memory/`, in the same directory as the credentials.
`test/persona.test.js`, `test/memory.test.js`, `test/memory-summarizer.test.js`,
`test/session-commands.test.js` and the persona/memory/summarizer cases in e2e guard this behavior.

### Companion pacing and life state (humanPacing · lifeState)

"Default assistant" is a tool: ask a question, get an answer, faster and more accurate is better. Companion modes like girlfriend / boyfriend / friend / Jarvis are
**another person**: they have their own pace and state, so the plugin does three extra things on the reply path (all only for companion modes).

- **Pacing**: the first reply pauses for a jittered value within `replyDelayMaxMs` (2400ms by default) — longer replies pause longer, and
  energy below 30 multiplies it by 1.35 again; a long reply is split by paragraph/sentence into at most `bubbleSplitMax` (3 by default) bubbles,
  with `bubbleGapMs` (700ms by default, 0.7–1.3× jitter) between them; a closing sentence like "晚安。" of ≤14 characters becomes its own bubble,
  and that is the most human-feeling touch in WeChat. Code blocks are kept whole and never split, so commands are not cut in half.
- **State**: with `lifeState` on, the plugin infers `mood / what it is doing / energy` from "what time it is, which weekday, how long since you last talked, how many messages today"
  (pure functions, no model calls); the same state is shared at account level and throttled to disk every 5 minutes into
  `<state dir>/memory/life-<account>.json`. When it enters the prompt (the `<weixin_life>` block) it comes with a reminder:
  "if the state is fine, say a bit more; if tired, reply short and slower, and you may simply say you are tired" — **and the agent must not read the state out loud**.
- **Default assistant is unaffected**: in "default assistant" mode there is no delay, no splitting and no state block; "we have known each other N days" in `/status` and
  `/memory` is only shown for companion modes too — a tool should not report a mood.

In the "Persona" tab of the settings card, each conversation's row now shows `模式：女友 · 在家歇着 · 有点乏，回得会慢一点 ·
精力 34/100 · 我们认识第 3 天`: the mode and the state are both computed on the spot, nothing is typed in by hand.
`test/human-pace.test.js`, `test/life-state.test.js` and the `companion pacing` cases in e2e guard this behavior.

### Memory corrections (/remember old → new · automatic correction)

Memory used to only **pile up**: the user says "I moved to Hangzhou", the old entry "the user lives in Beijing" stays, both go into the prompt and the model picks one by itself.

There are now two correction paths:

- **Automatic**: when the background summary turns the conversation into JSON every N turns, for a fact that overturns an older setting it writes the original text of the overturned
  entry into `supersedes`; when storing, the old fact is **replaced** (not appended alongside) and the old text goes into the "past wordings" history (at most 20).
- **Manual**: `/remember I live in Beijing → I moved to Hangzhou` (the arrow may be `→`, `->` or `=>`), explicitly saying "replace the old one with the new one".

`/memory` shows the latest 5 "past wordings: old → new", so corrections and deletions can be told apart. Matching is loose (a substring hit in either direction counts), so
reworded old text can be replaced too; when long-term memory is full a correction still succeeds — replacement does not add an entry.

The snippets from recall search (`/recall`, automatic injection) also carry a line "order is by relevance, not by time; when the same topic conflicts, the later one wins",
because what it returns is historical original text and the model must not treat an old claim as current fact.

### Language (locale)

The replies sent in WeChat come from a text catalog (`src/i18n.js`); `locale: "zh"` (the default) speaks Chinese, `"en"` speaks English.

What is in the catalog: **the `/help` text for all session commands** (20 entries), `（暂不支持这条消息：…）`, rate-limit notices, dangerous-tool notices. What is not in it: the settings card labels in `src/client.js` (that is DSH's UI language, which has its own `t(en, zh)` mechanism), the long replies of individual features (`/status`, `/list`, `/memory` details, ...) and logs (logs are **always English**, because they are for whoever reads the files).

`npm run i18n` prints the list of "Chinese lines not yet in the catalog", sorted by file — the number exists to be watched going down, not as a gate; `npm run i18n -- --fail-over 800` can turn it into a hard gate once the team decides so.

When adding a new user-visible string, first add both `{zh, en}` languages to `CATALOG`; `test/i18n.test.js` rejects entries that only have one language.

### Model routing (chatProvider · sideProvider · memoryProvider)

Three kinds of work, three budgets: conversation deserves a good model, background summaries do not, and speaking first is only twenty characters of personality.

| Config | Used for | When empty |
| --- | --- | --- |
| `chatProvider` / `chatModel` | main conversation turns | keeps the DSH current session model |
| `sideProvider` / `sideModel` | side sessions: `/summary`, `/subscribe` firing, speaking first | falls back to the memory model first, then to the conversation model |
| `memoryProvider` / `memoryModel` | background memory summaries, fact extraction, digest consolidation | falls back to the conversation model |

Two rules: **half a pair does nothing** (both provider and model are needed, otherwise you are asking the host to guess, and that ambiguity is exactly what this switch exists to remove); **routing is re-read on every request**, so a change in the settings card applies to the next message with no restart.

### The memory model (structured profile · events · person digest · standalone model)

Long-term memory used to be just a list of facts plus a conversation summary. Now it is **structured memory**:

- **Person profile**: how to address you, daily rhythm, likes / dislikes, important dates. The model decides and fills these in on every summary,
  and mistakes can be corrected directly in the "Persona" tab of the settings card (`memoryProfileSave`) — it edits the same file.
- **Events and to-dos**: things with a date (`[2026-10-28] health check tomorrow`), entries past their date are cleaned up automatically,
  and they can be marked done or deleted; `/memory` lists them as well.
- **Person digest**: once facts exceed 10 and it has been more than 6 hours since the last consolidation, the background does one
  **merge and dedupe** — compressing scattered facts into a digest under 200 characters, and trimming the fact list to at most 10.
  The digest comes first when injecting, so "who this person is" always precedes details, and the block's total length does not grow without bound.
- **Injected by importance**: every fact carries a weight from 1 to 5, and facts extracted by the model default to 4; injection goes digest first, then profile,
  then facts in descending weight, and stops once `memoryGlobalMaxChars` (1500 by default) is exceeded — **length has a budget; more is not better**.
- **Memory can pick its own model**: with `memoryProvider` + `memoryModel` both set, summaries / extraction / consolidation all use that model while
  the conversation itself keeps its original model. The side session id carries the model name, so changing the model opens a new side session (an established session cannot change its route).

The output order of `/memory` is now: `我们认识第 N 天…` (companion modes only) → person digest → the profile about you →
events and to-dos → numbered long-term memory list → this conversation's memory → recent-message window count.

### Stickers (stickerEnabled)

The WeChat protocol has no sticker (meme pack) message type — `MessageItemType` only has text / image / voice / file / video —
so tappable, animated native sticker packs cannot be sent. The plugin takes another route: **36 built-in sticker images, and the model picks one with a marker**.

![Thirty-six built-in sticker images](docs/stickers.png)

- The assets are `assets/stickers/*.png` in the repo (360×420 transparent PNGs generated by `scripts/make-stickers.py`,
  rerun the script to redraw them): 12 base ones (happy / lol / sob / aggrieved / angry / shy / speechless / sleepy / like you /
  awesome / go for it / good night), 12 cute ones (excited / snicker / facepalm / hug / cheer / confetti / munching / applause / nod /
  shake head / shocked / finger heart), plus three character packs that **follow the role**: catgirl (meow / lick paw / bristle / nuzzle),
  little whale girl (gurgle / spout / tail wag / peek), cute daughter (act cute / head pat / smug / cry).
- Character packs only appear in the matching mode: when the current conversation is catgirl the prompt lists only the four cat ones, and those four do not resolve at other times
  — there is no "girlfriend mode sends a cat paw" cross-contamination.
- Companion modes' prompts carry a line "available: happy, lol, ... at most one at a time"; the model writes
  `[表情:困了]` in the body, and before sending the plugin strips the marker and sends the matching PNG through the **image channel** (a native image bubble,
  exactly the same path as sending an image by hand). Unknown names or more than two markers are deleted with one warning line, and no
  `[表情:???]` is left in the body; the same one is sent only once. Full-width colons, `[表情: 开心 ]` and trailing bits like `晚安~` are all recognized.
- With `stickerEnabled` off the marker is neither taught nor parsed, and replies are plain text.

`test/stickers.test.js` checks that every image really exists and is a real PNG; the `stickers` cases in e2e assert that the marker is stripped,
sent as an `image_item`, and that `getuploadurl` uses `media_type: 1` (image rather than file).

### Speaking first (proactiveEnabled)

By default it only answers. With `proactiveEnabled` on, conversations in companion mode send the first message themselves **after the other side has been quiet for a while**
— the "what are you up to" / "it is raining here" kind of WeChat message.

- Every 5 minutes it looks at the candidate conversations (sorted by recent activity); whether it may send is decided by **pure functions**, in this order: the mode must be a companion mode →
  inside `proactiveWindowStart`–`proactiveWindowEnd` → at least `proactiveMinGapMinutes` since the other side's last message →
  if the previous proactive message went unanswered, back off (interval doubles by `2^miss`, up to 24 hours) → today's count is under `proactiveMaxPerDay` →
  finally one dice roll (35%), so it never shows up as punctually as an alarm clock.
- The content is generated by a **side session**: persona + pacing hint + life state + memory + a paragraph of "what time it is now, how long the other side has been silent,
  one or two sentences, do not interrogate where they went, do not say 'I came to you first'", plus your last message attached so it does not repeat it. The side session **does not** produce
  a bubble in the agent session; only the one or two sentences it wrote go out.
- The moment the other side speaks, the backoff resets to zero immediately (slow replies are not treated as silence); a failed send counts as "unanswered" once, so a broken channel is not
  retried every 5 minutes. If the generated text is empty, nothing is sent at all.
- "Default assistant" mode never speaks first, and the config switch cannot reach it.

`test/proactive.test.js` pins each gate separately (window, interval, backoff, daily cap, dice);
the `proactive` cases in e2e verify that it really does send one on its own, and only one, with no inbound message.

### Voice and video (voiceOutbound · videoFrames)

**Outbound voice is not delivered**, and that is server behavior, not an implementation problem: iLink accepts `voice_item` (`ret=0`) and the upload succeeds, but it is **never delivered** — measured once in 2026-06 and again on 2026-10-26 with a fresh token, with no bubble on the phone. So voice attachments are sent as **files** by default (openable, listenable), and `voiceOutbound` stays off.

**Inbound voice** has local speech recognition: the transcript enters the prompt as the user's own words (separated by `【语音转写】`), and when nothing can be recognized it says so plainly ("nothing was recognized") instead of letting the model guess.

**Inbound video** used to be a dead end — the model cannot read mp4 and the prompt could only say "cannot be read directly". Now a received video gets three PNG frames pulled with the local ffmpeg (skipping the first frame, which is often black, spread evenly up to just before the end), and the prompt lists each frame's timestamp and path so the model can look at them with `read_image`. A missing ffmpeg, an undecodable codec or a zero-length clip only affects understanding of that one video; the file is still saved.

### Rich content (richContent · codeFileThreshold)

A WeChat bubble holds nothing but plain text, so "Markdown support" is meaningless; what matters is **no longer losing what Markdown carries**:

- **Long code blocks** (over 1200 characters by default) are written to a file together with indentation, language and line count (`snippets/`, e.g. `snippet-1.py`) and sent as an attachment; the bubble keeps one line `（代码 60 行、1800 字，已作为文件 snippet-1.py 发出）`
("60 lines, 1800 characters, sent as the file snippet-1.py"). Short code blocks stay in the bubble — a two-line example is harder to read as an attachment.
- **Markdown tables** become column-aligned text (CJK counted as two columns wide), far easier to scan than `| a | b |`.
- A code block that is still streaming and whose fence is not closed yet is treated as body text, so already-written characters are not swallowed.

With `richContent` off it falls back to the old behavior: everything flattened into one text.

### Dangerous-tool notices (toolNotices)

The plugin **cannot block** tool execution: DSH does not expose approval/permission hooks to plugins (`@deepseek-ai/dsh-user-approval` is an application-layer package, and neither the `dsh-agent` README nor its `lib/` has any permission/approval interface), so "click approve in WeChat before the tool runs" is not something this plugin can do.

The half it can do is **timely notice**: when the Agent is about to write a file, delete a file, move a file or run a command during a turn, it immediately sends a WeChat message (tool name + argument summary; arguments containing `rm -rf`, `sudo`, `curl | bash`, `git push --force`, `chmod 777`, `dd if=` and the like are marked ⚠️ risky), and says plainly: `/cancel` can stop **the steps after this one** — the step already running may have executed.

The same tool in the same conversation is only announced once every ten minutes, so a turn that runs commands back to back does not spam. `toolNotices: false` turns it off.

### Group chat (groupChatEnabled · groupReplyWhen · groupShareMemory)

The `conversationId` of a group message is the `group_id`, so the reply address was always right; what was missing was the judgment — the bot used to answer every single message in a group.

Now it **does not join groups** by default; once enabled it defaults to **answering only when addressed** (`@name`, matched against the bot name in the first line, because iLink does not provide an @ list), and only `groupReplyWhen: "all"` answers every message.

Private matters do not follow it into groups either: replies in a group **do not inject** long-term memory, recall snippets or the closeness line (`groupShareMemory: true` injects them). A group shares one session line, so context in a group is shared by all members — that is recorded under "known gaps" in the architecture doc.

### Tool audit (toolAudit)

Logs cannot answer "who made it delete that directory yesterday at 15:20": logs are a process stream and are gone once they roll over. With `toolAudit` on
(the default), every tool the agent runs appends one JSONL line to `<state dir>/audit/` (one file per day,
`audit-YYYY-MM-DD.jsonl`) recording **which tool, which arguments (truncated to 500 characters), which account/conversation/sender triggered it,
and whether the result carries an error**.

One line records one thing, paired by `callId`: `kind: "tool/call"` records the tool name and arguments, `kind: "tool/result"` records
`ok` and `durationMs`. That way the file is always append-only and history never has to be rewritten. A few boundaries:

- Writing the audit is an observation: when the arguments cannot be `JSON.stringify`'d (circular references, BigInt) it falls back to `String()` and still leaves a line;
  an unwritable directory or a full disk only warns, and it **never affects a turn**;
- The arguments are model-produced raw text and may contain secrets or paths — the audit files are local files, so do not paste them into a public issue;
- Only tool calls are recorded, not tool output content (output can be enormous and is already in the session log);
- A call interrupted by `/cancel` is never left dangling: a tool the host killed never emits a result event, so the bridge writes its own line
  `ok: false, aborted: true` with how long it had been running, so "did that command finish or not" always has an answer.

`test/tool-audit.test.js` covers writing/truncation/torn lines/failure degradation, and the toolAudit cases in `test/e2e.test.js` cover
"the plugin really wires it to disk, and writes not a single file when turned off".

Voice is in WeChat's SILK format. The plugin tries to convert it to WAV with the upstream `silkToWav`; `silk-wasm` is now one of the
`optionalDependencies` (usable when installed; removing it or a failed install does not affect plugin loading, it takes the degraded path).
When `silk-wasm` is missing it stores the raw `.silk` following upstream behavior and hands the path to the Agent, with the reply noting that this is untranscoded
SILK.

### Speech recognition (ASR)

Once converted to WAV it can be handed to a resident ASR bridge process to actually "understand" it. The bridge is a **line-protocol** child process:
one `{"wav":"/absolute/path.wav"}` per line on stdin, one `{"ok":true,"text":"..."}` or
`{"ok":false,"error":"..."}` per line on stdout. The process is **resident and reused** — starting a new Python process per voice message costs 15–25 seconds of cold start,
which is unacceptable.

```yaml
asr:
  enabled: true
  command: python3
  args: [bin/asr-bridge.py]                    # the bridge shipped in this repo (relative paths resolve against the plugin dir)
  timeoutMs: 60000
  modelDir: /path/to/models                    # model directory (also editable in the settings page, see below)
  env:
    DSH_WEIXIN_ASR_LANGUAGE: zh                # pin the language; detected automatically when omitted
```

**How the YAML and the settings page relate**: the settings page writes `<stateDir>/config.json`, which is newer than the YAML,
so when the same field is set in both the settings page wins; only when the settings page value is empty (`''`, `[]`, `{}`)
does it fall back to the YAML. Changes still require a DSH restart to be re-read.

> **A pit we have already stepped in (0.4.0 and earlier)**: the config the host passes in when importing a plugin has gone through schema instantiation, so
> fields like `asr.command` carry an empty-string default even when you never configured them. Old versions merged that section with a shallow spread,
> and the empty default overwrote the real command from the settings page — the symptom was the settings page clearly showing a command while voice kept answering
> `no ASR bridge is configured`. It is now decided field by field: a non-empty saved value wins.

### A bridge ships in the repo: `bin/asr-bridge.py`

If you do not want to write a bridge yourself, use the one in this repo. It implements the line protocol above and picks one of two engines automatically:

| Engine | When it applies | Install | Measured hot call |
| --- | --- | --- | --- |
| **mlx-whisper** | preferred when importable (Apple Silicon) | `pip install mlx-whisper` | **0.29s** (3.7s of audio, M4 GPU) |
| **faster-whisper** | other platforms / no mlx | `pip install faster-whisper` | 5.3s (the same clip, Rosetta CPU) |

Both are supported because the gap on real machines is large: on the same M4, mlx on the GPU is **18×** faster than x86_64 Python
on the CPU. The bridge picks by itself, so users do not have to care.

Models are downloaded from the "Voice models" block of the settings page (it downloads from the mirror you pick). **Usable as soon as the download finishes**: when the bridge finds
`<model dir>/mlx-community__whisper-small-mlx` (or `Systran__faster-whisper-small`) on disk it loads from disk and makes no network
request. That is deliberate — `huggingface_hub`'s metadata probe (a HEAD request that redirects to a CDN) fails with an SSL EOF on some mirrors while a plain GET works; loading from disk bypasses that step entirely.

Install (pick one for your machine):

```bash
pip install mlx-whisper        # Apple Silicon, uses the GPU
pip install faster-whisper     # other platforms, uses the CPU
```

Then configure `command` + `args` as in the YAML above. Environment variables (all optional):

| Variable | Purpose |
| --- | --- |
| `DSH_WEIXIN_ASR_MODEL` | size: `tiny`/`base`/`small`/`medium`/`large-v3` (default `small`) |
| `DSH_WEIXIN_ASR_LANGUAGE` | pin the language (e.g. `zh`); auto-detected when omitted |
| `DSH_WEIXIN_ASR_MODEL_DIR` | model directory (default `~/.dsh/weixin/asr-models`) |
| `DSH_WEIXIN_ASR_MODEL_PATH` | point directly at a model directory or repo, highest priority |
| `DSH_WEIXIN_ASR_PROMPT` | initial prompt, a plain Mandarin sample by default (see below) |
| `HF_ENDPOINT` | set to `https://hf-mirror.com` when the direct connection fails |

**Why an initial prompt is needed**: whisper outputs **Traditional Chinese** for Mandarin. The default prompt is an ordinary Mandarin sample
that pins the output to Simplified — this was measured (`今天天氣不錯` → `今天天气不错`), not guessed.

**Why non-speech returns empty**: pure tones/silence make whisper invent content (a subtitle credit like `字幕by索兰娅` appeared in testing). The bridge detects "the whole segment contains no speech" and returns an empty string — empty is the honest answer, and the plugin turns it into "did not catch that"
rather than treating invented words as what the user said.

### The model directory is configurable

In the "Voice models" block of the settings page the directory is an **editable input box**:

- After editing, click "Set directory"; the host does `mkdir -p` and remembers the path, and it still applies after a restart
  (written to `<stateDir>/asr-config.json`);
- That directory drives **both** download and transcription: downloaded models land in `<dir>/<repo>`,
  and at transcription time `HF_HOME` and `DSH_WEIXIN_ASR_MODEL` both point at this directory, so a finished download is directly usable,
  with no need to edit config files again;
- `asr.env.HF_HOME` / `asr.env.DSH_WEIXIN_ASR_MODEL` in the config have higher priority —
  values written by hand are not overwritten by the UI.


**The bridge is optional, and you can write your own.** The plugin only depends on the line protocol above: it runs your `command`, writes the WAV path into
stdin, and reads JSON line by line from stdout. Any process that satisfies "read one line of `{"wav": "..."}` → write one line of
`{"ok": true, "text": "..."}`" will do; the model can be `whisper.cpp`, a cloud API, or anything else —
the plugin does not care. The `bin/asr-bridge.py` shipped in the repo just paves the most common road.

`asr.enabled: false` by default; without configuring it there is no such pipeline at all.

An empty `command` disables recognition and voice is delivered as a file only. The three degradations are independent, and what the Agent receives distinguishes
"the transcoding module is not installed", "it was transcoded but the bridge failed" and "it was recognized but empty":

| Case | What the Agent receives |
| --- | --- |
| Recognition succeeded | `【语音转写】` + the user's own words (explicitly marked "treat as the user's own words") |
| Recognition empty | Says plainly that nothing was recognized and **requires no speculation** — an empty result must not be invented |
| Bridge failed / timed out | Still gives the WAV path, with the reason for the failure |
| No `silk-wasm` | Gives the `.silk` path and notes it was not transcoded |

A bridge that crashes mid-request is restarted automatically and only affects that one message (it degrades); later requests work as usual. `timeoutMs` is a
**backstop**, not a latency target — cold-starting the model can take tens of seconds, hence the 60s default; a measured hot call takes about 294ms.

> Measured on this machine: `2ee80de6-voice.silk` (3830 bytes) → WAV 113324 bytes → transcript 「你是谁」.
> The model cache lives where `HF_HOME` points (the stationData volume); **do not** let it land on the system disk.

## Markdown handling

WeChat does not render Markdown, so `**bold**`, `##### heading` and `![img](path)` show up verbatim. The outbound path therefore converts the reply
to plain text **first** and **then** chunks it by `maxMessageLength` — the order cannot be reversed, otherwise chunk lengths would be computed on the unconverted text and overflow.

With `markdownMode` set to `strip` (the default) the upstream `StreamingMarkdownFilter`
(`vendor/openclaw-weixin/messaging/markdown-filter.js`) is reused, with rules exactly matching upstream:

| Kept | Stripped (markers removed, content kept) |
| --- | --- |
| `**bold**`, `___bold___` | italic / bold-italic markers on CJK content |
| code fences ```, inline code `` ` `` | H5/H6 headings (`#####`, `######`) |
| tables `\|…\|`, horizontal rules `---` | images `![alt](url)` (removed entirely) |
| italics on non-CJK content | |

Whitespace (blank lines, trailing newlines, CRLF) is preserved byte for byte. With `markdownMode: 'off'` it is sent as-is, which is handy for troubleshooting and comparison.

> Note: `![alt](path)` is also **outbound attachment** syntax. With `mediaEnabled` on, that reference goes to the media layer for upload first and
> only the alt text remains in the text; whatever `stripMediaReferences` already handled in the media step never reaches the Markdown filter.

## Development

```bash
npm test                       # node --test "test/**/*.test.js"
npm run check                  # syntax + packaging metadata (CI runs this first)
npm run doctor                 # ten checks: accounts / allowlist / lock / backlog / logs / version
npm run vendor                 # verify vendor/ still equals the recorded tarball
node bin/login.js              # a real QR code login
```

Local dev requires symlinking DSH's `@deepseek-ai/{schemastery,cosmokit,dsh-llm}` into `node_modules/@deepseek-ai/`
(they live in the profile and are not public npm packages):

```bash
mkdir -p node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/cosmokit    node_modules/@deepseek-ai/cosmokit
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm            node_modules/@deepseek-ai/dsh-llm
```

## Release

### Release provenance

npm can attach a **provenance** statement to a tarball: that it was built from this repository, this commit, by this CI, with a signature exchanged for CI's OIDC identity. That statement only exists when you look at `dist.attestations` with `npm view dsh-plugin-weixin --json` — a manual `npm publish` on your own machine cannot get it, npm simply rejects `--provenance`.

So there are two paths:

| Approach | Result |
|---|---|
| local `node bin/release.mjs <version>` | tags, creates a release, installs the local profile, **no provenance** (the script says so) |
| push tag `v<version>` | `.github/workflows/release.yml` installs dependencies from that tag in CI, runs the full test suite, verifies the tag matches the `package.json` version, then `npm publish --provenance` — provenance included |

The CI path needs the repository secret `NPM_TOKEN` (an npm Automation token) and `id-token: write` in the workflow (already declared in the file).


One command runs the whole release chain (verify → test → bump version → pack and verify → publish → tag → GitHub Release):

```bash
npm run release 0.4.0 -- --dry-run   # rehearsal: no commit, no publish, working tree restored at the end
npm run release 0.4.0                # real release
```

The script follows "the order that actually works", and every step corresponds to a pit hit during a manual release:

| Step | What it does | Why |
| --- | --- | --- |
| Preflight | working tree clean, on main, in sync with origin, version not published before, npm logged in, **every published version has a matching tag** | `git describe` locates the previous version by tag; a missing tag makes this Release Notes repeat the previous release's content (0.3.0 missed one) |
| Test | `npm test` must be all green | never release with red |
| Version | edit `package.json`, sync the README's "currently published version" line and the version list | the README once said 0.1.0 for a long time while npm was already at 0.2.0 |
| Pack & verify | `npm pack` then check the file list (no missing `bin/asr-bridge.py`, no `__pycache__`/test files), and **really run `bin/asr-bridge.py` once in a temporary unpacked directory** | proves the very package about to be uploaded works, not just that the tests pass |
| Commit | one `chore(release): x.y.z` commit | |
| Publish | `npm publish`, then **poll the registry until the version is actually visible** | npm returns success first and processes the upload asynchronously; querying immediately reads the old version and looks like a failure |
| Verify | compare the registry's `dist.shasum` with the local tarball | confirm the published package is the one built locally |
| Tag | create `v x.y.z`, push main and the tag, generate the GitHub Release from the commit log | |
| Install | `node bin/install.mjs --profile $DSH_PROFILE` | self-test on this machine |

Three things to note:

- **It must run from a real terminal.** `npm publish` may ask for a one-time password (OTP) in the browser; when stdout is not a TTY npm masks the auth link (`***`), and that step cannot be automated.
- A rehearsal (`--dry-run`) really performs the packaging and the bridge smoke test, but restores `package.json`/`README.md` and deletes the tarball before finishing, leaving the working tree as it was.
- A new version gets an entry with `TODO` copy inserted at the top of the README version list; **change it to what this release actually contains before committing** (the script prompts you clearly).

## Documentation

- [Architecture and troubleshooting](docs/architecture.md) — how messages come in and go out, and where to look first when something breaks
- [Implementation plan](docs/plan.md)
- [Port audit checklist](docs/hermes-port-audit.md)
- [Progress log](docs/progress.md)
- [Security policy](docs/security.md)
- [Third-party code](THIRD-PARTY-NOTICES.md)

## Supporting the author

If this plugin has been useful to you, you are welcome to buy the author a coffee — scan the code below with WeChat to tip, and encourage continued updates, polish and better features.

<p align="center"><img src="assets/donate-qr.jpg" alt="WeChat tip QR code" width="280" /></p>

Or open an Issue / PR: [github.com/panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)
