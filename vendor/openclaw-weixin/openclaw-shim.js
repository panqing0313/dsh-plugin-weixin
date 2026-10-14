/**
 * Minimal local stand-in for the three `openclaw/plugin-sdk/*` bindings that the
 * vendored Tencent `openclaw-weixin` transport imports.
 *
 * Why this exists: the Tencent package (MIT) is published as an OpenClaw plugin,
 * so three of its modules import host-runtime helpers from the OpenClaw SDK.
 * dsh-weixin is a DSH plugin, not an OpenClaw plugin, so there is no OpenClaw
 * host to supply them. Rather than emulate the whole OpenClaw plugin runtime
 * (channel runtime, hook runner, config mutation), this shim supplies exactly
 * the three leaf helpers, with DSH-appropriate behavior:
 *
 *  - `normalizeAccountId`      — identity normalization (pure).
 *  - `mutateConfigFile`        — a no-op: DSH keeps plugin config in cordis.yml,
 *                                not in openclaw.json, so there is no file to bump.
 *  - `resolvePreferredOpenClawTmpDir` — where the transport's JSON-line log goes.
 *                                Redirected to the DSH weixin state dir so the log
 *                                sits next to the credentials instead of in /tmp.
 *
 * It also carries one redirection of a *package-internal* import, not an SDK one:
 * `messaging/send.js` needs `getMediaLabel` from `messaging/inbound.js`, and
 * `inbound.js` is deliberately not vendored — see THIRD-PARTY-NOTICES.md
 * ("What was changed", item 4). The helper is reproduced here verbatim.
 *
 * Source: vendor/openclaw-weixin (MIT, Copyright (C) 2026 Tencent).
 */
import os from 'node:os'
import path from 'node:path'
import { MessageItemType } from './api/types.js'

/**
 * Normalize an account id the way the upstream SDK does: trim, lowercase.
 * Upstream additionally strips a channel prefix; weixin account ids arrive
 * already bare (e.g. `b0f5860fdecb@im.bot`), so trim + lowercase is the whole
 * contract here.
 */
export function normalizeAccountId(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * No-op write-back. Weixin credentials live in the DSH weixin state dir
 * (`~/.dsh/weixin/`), and plugin settings live in cordis patch config; there is
 * no `openclaw.json` to mutate, so the config-reload bump that upstream performs
 * after a successful login has nothing to do here.
 */
export async function mutateConfigFile(_params) {
  return undefined
}

/** Directory for the transport's own JSON-line log file. */
export function resolvePreferredOpenClawTmpDir() {
  const override = process.env.DSH_WEIXIN_LOG_DIR?.trim()
  if (override) return override
  return path.join(os.homedir(), '.dsh', 'weixin', 'logs')
}

/**
 * Placeholder body used when an outbound media message is cached in the quote
 * store. Copied verbatim from upstream `messaging/inbound.js` (function
 * `getMediaLabel`); the four labels are the protocol's item-type names and are
 * the only thing `messaging/send.js` needs from that module.
 */
export function getMediaLabel(type) {
  switch (type) {
    case MessageItemType.IMAGE:
      return '[图片]'
    case MessageItemType.VIDEO:
      return '[视频]'
    case MessageItemType.FILE:
      return '[文件]'
    case MessageItemType.VOICE:
      return '[语音]'
    default:
      return ''
  }
}
