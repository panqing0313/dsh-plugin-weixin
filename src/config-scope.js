// Per-conversation configuration overrides.
//
// The config schema has always been global-then-account: one set of values for
// the whole plugin, optionally narrowed per bot account. That is the wrong
// shape for the settings people actually want to change per chat — pace this
// group chat slowly and this private chat quickly, keep memory off for the work
// thread, use a different persona for each person. Today the only way to get
// that is to switch accounts, which is not a choice.
//
// This module stores overrides keyed by (accountId, conversationId) and layers
// them over the account config for one message. Only the keys listed in
// SCOPABLE_KEYS may be overridden: an override that could move a credential or
// an allowlist is a security footgun dressed as a convenience, and nothing on
// this list can widen who may talk to the bot.

import path from 'node:path';

import { atomicWriteJson, readJsonFile } from './atomic.js';

/** Keys a conversation is allowed to override. Add deliberately. */
export const SCOPABLE_KEYS = Object.freeze([
  'maxMessageLength',
  'markdownMode',
  'typingIndicator',
  'humanPacing',
  'replyDelayMaxMs',
  'bubbleSplitMax',
  'bubbleGapMs',
  'lifeState',
  'stickerEnabled',
  'memoryEnabled',
  'memoryRecentTurns',
  'memoryRecall',
  'memoryRecallDays',
  'memoryRecallHits',
  'personaDefaultMode',
]);

const SCOPE_VERSION = 1;

export function scopeFilePath(stateRoot) {
  return path.join(stateRoot, 'config-scope.json');
}

function keyFor(accountId, conversationId) {
  return `${accountId ?? ''}|${conversationId ?? ''}`;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeScope(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const scope = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SCOPABLE_KEYS.includes(key) !== true) continue;
    const clean = sanitizeValue(value);
    if (clean !== undefined) scope[key] = clean;
  }
  return Object.keys(scope).length === 0 ? undefined : scope;
}

/** All overrides, as `{ 'account|conversation': { key: value } }`. */
export function readScopes(stateRoot, { warn } = {}) {
  const store = readJsonFile(scopeFilePath(stateRoot), {
    version: SCOPE_VERSION,
    fallback: () => ({ scopes: {} }),
    warn,
  });
  const scopes = {};
  for (const [key, value] of Object.entries(store?.scopes ?? {})) {
    const scope = sanitizeScope(value);
    if (scope !== undefined) scopes[key] = scope;
  }
  return scopes;
}

/** The override for one conversation, or undefined when it has none. */
export function readScope(stateRoot, accountId, conversationId, options) {
  const scopes = readScopes(stateRoot, options);
  return scopes[keyFor(accountId, conversationId)];
}

/**
 * Replace (or, with an empty patch, clear) one conversation's overrides.
 * Returns what was stored, so the caller can echo it back.
 */
export function writeScope(stateRoot, accountId, conversationId, patch, { warn } = {}) {
  const scopes = readScopes(stateRoot, { warn });
  const key = keyFor(accountId, conversationId);
  const scope = sanitizeScope(patch ?? {});
  if (scope === undefined) delete scopes[key];
  else scopes[key] = { ...scopes[key], ...scope };
  atomicWriteJson(scopeFilePath(stateRoot), { schemaVersion: SCOPE_VERSION, scopes }, { warn });
  return scopes[key];
}

/** Layer a scope over the account config. Unknown keys were already dropped. */
export function scopedConfig(base, scope) {
  if (scope === undefined || scope === null) return base;
  const layered = { ...base };
  for (const key of SCOPABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(scope, key)) layered[key] = scope[key];
  }
  return layered;
}

/** Is this conversation overriding anything at all? Used by the card and /status. */
export function describeScope(scope) {
  if (scope === undefined) return '';
  return Object.entries(scope)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}
