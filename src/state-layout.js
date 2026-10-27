// Every file the plugin keeps on disk, declared in one place.
//
// The state root had grown a dozen `path.join(stateRoot, 'something.json')`
// calls scattered across a dozen modules. Two consequences, both real:
//
//   * no single answer to "what does this plugin write?" — the retention sweep,
//     the storage panel and the docs each rediscovered the list, and a new file
//     stayed invisible to all three until someone remembered it;
//   * nothing enforced that a path stayed inside the state root, so a crafted
//     account id with a slash in it could aim a store outside the plugin's own
//     directory.
//
// This module is that list. Modules keep their own helper functions (they know
// their suffixes) but build them from here, and the guards below keep every
// path inside the root.
//
// (`src/state.js` is a different thing: it decides *where* the root is and owns
// the plugin configuration file. This one describes what lives under it.)

import path from 'node:path';

/**
 * The layout. `dir` entries are directories the plugin owns; `file` entries are
 * single-file stores.
 */
export const STATE_LAYOUT = Object.freeze({
  accounts: { kind: 'dir', relative: 'openclaw-weixin', label: '账号凭证' },
  sessions: { kind: 'file', relative: 'sessions.json', label: '会话线' },
  personaModes: { kind: 'file', relative: 'persona-modes.json', label: '人设目录' },
  personaActive: { kind: 'file', relative: 'persona-active.json', label: '人设绑定' },
  reminders: { kind: 'file', relative: 'reminders.json', label: '定时提醒' },
  subscriptions: { kind: 'file', relative: 'subscriptions.json', label: '定时主动消息' },
  outbox: { kind: 'file', relative: 'outbox.json', label: '待发队列' },
  configScope: { kind: 'file', relative: 'config-scope.json', label: '会话级配置' },
  instanceLock: { kind: 'file', relative: 'instance.lock', label: '实例锁' },
  memoryDir: { kind: 'dir', relative: 'memory', label: '记忆' },
  memoryIndexDir: { kind: 'dir', relative: 'memory/index', label: '回忆索引' },
  journalDir: { kind: 'dir', relative: 'journal', label: '消息流水' },
  auditDir: { kind: 'dir', relative: 'audit', label: '工具审计' },
  mediaInboundDir: { kind: 'dir', relative: 'media/inbound', label: '收到的媒体' },
  exportsDir: { kind: 'dir', relative: 'exports', label: '聊天导出' },
  snippetsDir: { kind: 'dir', relative: 'snippets', label: '代码片段' },
  logsDir: { kind: 'dir', relative: 'logs', label: '运行日志' },
});

/** Every entry, with its resolved absolute path. */
export function statePaths(stateRoot) {
  const root = path.resolve(stateRoot);
  const resolved = {};
  for (const [key, entry] of Object.entries(STATE_LAYOUT)) {
    resolved[key] = { ...entry, absolute: path.join(root, entry.relative) };
  }
  return resolved;
}

/** Resolve one entry by key; throws on a typo instead of writing somewhere new. */
export function statePath(stateRoot, key) {
  const entry = STATE_LAYOUT[key];
  if (entry === undefined) throw new Error(`unknown state entry: ${key}`);
  return path.join(path.resolve(stateRoot), entry.relative);
}

/** A store file must stay inside the state root. */
export function isInsideStateRoot(stateRoot, candidate) {
  const root = path.resolve(stateRoot) + path.sep;
  return path.resolve(candidate).startsWith(root);
}

/**
 * Build a per-key file path inside a directory entry (memory, index, …), with
 * the key sanitised so a slash or a `..` cannot escape the directory.
 */
export function keyedStatePath(stateRoot, dirKey, name) {
  const dir = statePath(stateRoot, dirKey);
  const safe = String(name).replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 160);
  const full = path.join(dir, safe);
  if (isInsideStateRoot(stateRoot, full) !== true) throw new Error(`state path escaped the root: ${safe}`);
  return full;
}

/** Directory entries the retention sweep may delete from, with their day windows. */
export const SWEEPABLE = Object.freeze({
  journalDir: 'journalDays',
  auditDir: 'auditDays',
  mediaInboundDir: 'mediaDays',
  exportsDir: 'exportsDays',
  logsDir: 'logsDays',
});
