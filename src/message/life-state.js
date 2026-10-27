/**
 * Life state: how the character is doing right now, inferred — not configured.
 *
 * A companion that answers in the same register at 07:00 and 23:40 is the
 * tell that gives a bot away. This module keeps a tiny per-account snapshot
 * (mood / activity / energy) on disk, drifts it with the clock, the time since
 * the last message and how much the two of you have been chatting today, and
 * renders it as one prompt block.
 *
 * Everything is deterministic given `now` and the prior snapshot, so a test can
 * pin the hour and assert the mood it produces. There is no model call and no
 * hidden state beyond the JSON file.
 */

import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJson } from '../atomic.js'
import { keyedStatePath } from '../state-layout.js'

const noopWarn = () => {};

/** How often the snapshot is persisted; a per-message write would be waste. */
export const LIFE_WRITE_INTERVAL_MS = 5 * 60_000;
/** Energy drifts back to the clock's baseline over roughly this long. */
const ENERGY_RECOVERY_HOURS = 3;

function safeName(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 120);
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * Where one account's snapshot lives.
 * @param {string} stateRoot
 * @param {string} accountId
 * @returns {string}
 */
export function lifeFilePath(stateRoot, accountId) {
  return keyedStatePath(stateRoot, 'memoryDir', `life-${safeName(accountId)}.json`);
}

/**
 * Read the snapshot; `null` when it does not exist yet or is not a snapshot.
 * @param {string} stateRoot
 * @param {string} accountId
 * @param {{ warn?: (line: string) => void }} [options]
 */
export function readLifeState(stateRoot, accountId, { warn = noopWarn } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lifeFilePath(stateRoot, accountId), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const energy = Number(parsed.energy);
    return {
      mood: typeof parsed.mood === 'string' ? parsed.mood : '',
      activity: typeof parsed.activity === 'string' ? parsed.activity : '',
      energy: Number.isFinite(energy) ? Math.min(100, Math.max(0, energy)) : 50,
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
      firstSeenAt: Number.isFinite(Number(parsed.firstSeenAt)) ? Number(parsed.firstSeenAt) : 0,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`life state unreadable (${String(error)})`);
    return null;
  }
}

/**
 * Persist a snapshot. Failures only warn: the reply must never wait on this.
 * @returns {boolean}
 */
export function writeLifeState(stateRoot, accountId, life, { warn = noopWarn } = {}) {
  try {
    const file = lifeFilePath(stateRoot, accountId);
    return atomicWriteJson(file, { schemaVersion: 1, ...life }, { warn: (message) => warn(`life state not written (${message})`) });
  } catch (error) {
    warn(`life state not written (${String(error)})`);
    return false;
  }
}

/**
 * Baseline energy for an hour of the day: low at night, high mid-morning.
 * @param {number} hour 0–23, local time
 * @returns {number}
 */
export function baseEnergyFor(hour) {
  if (hour <= 4) return 22;
  if (hour <= 6) return 32;
  if (hour <= 8) return 58;
  if (hour <= 11) return 72;
  if (hour <= 13) return 58;
  if (hour <= 17) return 70;
  if (hour <= 19) return 52;
  if (hour <= 22) return 46;
  return 32;
}

/**
 * What the character is plausibly doing at this hour.
 * @param {number} hour 0–23, local time
 * @param {boolean} [weekend]
 * @returns {string}
 */
export function activityFor(hour, weekend = false) {
  if (hour <= 5) return '这个点还醒着';
  if (weekend) {
    if (hour <= 8) return '刚起，还赖在床上';
    if (hour <= 11) return '在家，慢悠悠的';
    if (hour <= 13) return '刚吃完午饭';
    if (hour <= 17) return '在忙自己的事';
    if (hour <= 21) return '在家窝着';
    if (hour <= 22) return '在收拾准备睡';
    return '准备睡了';
  }
  if (hour <= 6) return '刚醒，还没完全清醒';
  if (hour <= 8) return '在上班路上';
  if (hour <= 11) return '在上班，抽空回你';
  if (hour <= 13) return '在吃午饭';
  if (hour <= 17) return '还在上班';
  if (hour <= 19) return '刚下班，在路上';
  if (hour <= 22) return '在家歇着';
  return '准备睡了';
}

/**
 * Mood from energy, the hour, and how long it has been since the last message.
 * Deliberately blunt heuristics: they only need to be plausible, never clever.
 * @param {{ energy?: number, hour?: number, gapMs?: number }} [params]
 * @returns {string}
 */
export function inferMood({ energy = 50, hour = 12, gapMs = 0 } = {}) {
  const daysAway = gapMs / 86_400_000;
  if (daysAway >= 3) return '好久没聊天了，有点想你';
  if (hour >= 23 || hour < 6) return '有点困，但还是想再说两句';
  if (energy <= 22) return '今天挺累的，不太想动';
  if (energy <= 38) return '有点乏，回得会慢一点';
  if (energy >= 80) return '精神不错，心情挺好';
  return '平静';
}

/**
 * Infer the current snapshot.
 *
 * Energy starts from the clock's baseline, drifts from the previous snapshot
 * over {@link ENERGY_RECOVERY_HOURS}, and pays a small price for a heavy chat
 * day — a character that has been talking all day is a little flatter.
 *
 * @param {{ now?: number, prior?: object | null, bond?: object | null }} [params]
 * @returns {{ mood: string, activity: string, energy: number, updatedAt: number, firstSeenAt: number }}
 */
export function inferLifeState({ now = Date.now(), prior = null, bond = null } = {}) {
  const date = new Date(now);
  const hour = date.getHours();
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  const target = baseEnergyFor(hour);
  let energy = target;
  const priorEnergy = Number(prior?.energy);
  const priorAt = Number(prior?.updatedAt);
  if (Number.isFinite(priorEnergy) && Number.isFinite(priorAt) && priorAt > 0) {
    const hoursAway = Math.max(0, (now - priorAt) / 3_600_000);
    const recovery = Math.min(1, hoursAway / ENERGY_RECOVERY_HOURS);
    energy = priorEnergy + (target - priorEnergy) * recovery;
  }
  const msgsToday = Number(bond?.msgsToday);
  if (Number.isFinite(msgsToday) && msgsToday > 0) energy -= Math.min(14, msgsToday * 0.4);
  // A small wobble keyed to a ten-minute bucket, so two snapshots taken minutes
  // apart do not print the exact same number.
  energy += ((Math.floor(now / 600_000) * 7) % 5) - 2;
  energy = Math.round(Math.min(100, Math.max(5, energy)));
  const lastMessageAt = Number(bond?.lastMessageAt);
  const gapMs = Number.isFinite(lastMessageAt) && lastMessageAt > 0 ? Math.max(0, now - lastMessageAt) : 0;
  return {
    activity: activityFor(hour, weekend),
    mood: inferMood({ energy, hour, gapMs }),
    energy,
    updatedAt: now,
    firstSeenAt: Number(prior?.firstSeenAt) > 0 ? Number(prior.firstSeenAt) : now,
  };
}

/**
 * Read, infer, and (at most every {@link LIFE_WRITE_INTERVAL_MS}) persist.
 * @returns {{ mood: string, activity: string, energy: number, updatedAt: number, firstSeenAt: number }}
 */
export function readOrInferLifeState(stateRoot, accountId, { now = Date.now(), bond = null, warn = noopWarn, persist = true } = {}) {
  const prior = readLifeState(stateRoot, accountId, { warn });
  const life = inferLifeState({ now, prior, bond });
  if (persist && (prior === null || now - Number(prior.updatedAt) >= LIFE_WRITE_INTERVAL_MS)) {
    writeLifeState(stateRoot, accountId, life, { warn });
  }
  return life;
}

/**
 * The prompt block. Empty when there is nothing to say, so a stock assistant
 * never pays for it.
 * @param {{ mood?: string, activity?: string, energy?: number } | null} life
 * @returns {string}
 */
export function lifeBlock(life) {
  if (life === null || life === undefined) return '';
  const mood = typeof life.mood === 'string' ? life.mood.trim() : '';
  if (mood === '') return '';
  const activity = typeof life.activity === 'string' ? life.activity.trim() : '';
  const energyValue = Number(life.energy);
  const energy = Number.isFinite(energyValue) ? Math.round(energyValue) : 50;
  const state = `${activity === '' ? '' : `${activity}，`}${mood}。精力 ${energy}/100。`;
  const hint = energy <= 35
    ? '这时候你不太有力气长篇大论：回短一点、慢一点，也可以直接说累。'
    : '这时候状态还行：话可以多说两句，语气跟着心情走。';
  return [
    '<weixin_life>',
    `【状态】${state}`,
    hint,
    '别把这段状态直接念给对方听，除非对方问起。',
    '</weixin_life>',
  ].join('\n');
}

/**
 * One line for the settings card: `在家歇着 · 平静 · 精力 46/100`.
 * @param {{ mood?: string, activity?: string, energy?: number } | null} life
 * @returns {string}
 */
export function lifeSummary(life) {
  if (life === null || life === undefined) return '';
  const parts = [];
  if (typeof life.activity === 'string' && life.activity.trim() !== '') parts.push(life.activity.trim());
  if (typeof life.mood === 'string' && life.mood.trim() !== '') parts.push(life.mood.trim());
  const energyValue = Number(life.energy);
  if (Number.isFinite(energyValue)) parts.push(`精力 ${Math.round(energyValue)}/100`);
  return parts.join(' · ');
}
