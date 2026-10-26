/**
 * Human pacing for companion conversations.
 *
 * A companion mode (anything but the stock `default` assistant) should not
 * answer like a machine: a person takes a beat before the first line and often
 * sends two or three short bubbles instead of one wall of text. This module
 * turns one settled reply into that shape, and it is deliberately pure — the
 * caller passes the clock/jitter RNG, so tests can pin every number.
 *
 * The `default` assistant keeps the plain chunked send: it is a tool, and a
 * tool does not need to act alive.
 */

import { DEFAULT_MODE_ID } from '../persona.js';
import { stickerHint } from './stickers.js';

/** Upper bound for the pause before the first bubble. */
export const DEFAULT_REPLY_DELAY_MAX_MS = 2400;
/** Most bubbles one reply is cut into. */
export const DEFAULT_BUBBLE_SPLIT_MAX = 3;
/** Pause between bubbles. */
export const DEFAULT_BUBBLE_GAP_MS = 700;
/** A fragment shorter than this rides along with its neighbour. */
export const MIN_BUBBLE_CHARS = 6;
/** Replies shorter than this are never split at all: one short line is already human. */
export const MIN_SPLIT_CHARS = 20;
/** A tail this short may ride alone as a closing beat ("晚安。", "行。"). */
export const MAX_TAIL_BUBBLE_CHARS = 14;

/**
 * Is this mode one of the companion personas (girlfriend, jarvis, a game…)?
 *
 * The stock assistant is the only mode with no emotional framing, so it is the
 * one mode that gets no pacing, no state block, and no bond line.
 *
 * @param {{ id?: string } | null | undefined} mode
 * @returns {boolean}
 */
export function isCompanionMode(mode) {
  return mode !== null && mode !== undefined && mode.id !== DEFAULT_MODE_ID;
}

/**
 * Pause before the first bubble: grows with the length of the reply (a long
 * answer takes longer to type), jitters so it never looks like a timer, and
 * stretches when the character is tired.
 *
 * @param {string} text
 * @param {{ energy?: number } | null} [life]
 * @param {number} [maxDelayMs]
 * @param {() => number} [rng]
 * @returns {number} milliseconds, 0 when pacing is off
 */
export function replyDelayMs(text, life, maxDelayMs = DEFAULT_REPLY_DELAY_MAX_MS, rng = Math.random) {
  const cap = Number.isFinite(Number(maxDelayMs)) ? Math.max(0, Number(maxDelayMs)) : DEFAULT_REPLY_DELAY_MAX_MS;
  if (cap === 0) return 0;
  const length = [...String(text ?? '')].length;
  const jitter = 0.8 + rng() * 0.45; // 0.80 – 1.25
  const energy = Number(life?.energy);
  const tired = Number.isFinite(energy) && energy > 0 && energy < 30 ? 1.35 : 1;
  const raw = (240 + length * 16) * jitter * tired;
  return Math.round(Math.min(cap, Math.max(220, raw)));
}

/** Split a reply into sentences; CJK enders plus the newline itself. */
function splitSentences(text) {
  return text
    .split(/(?<=[。！？!?…~～])\s*|\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function needsSpace(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function joinFragments(left, right) {
  return `${left}${needsSpace(left, right) ? ' ' : ''}${right}`;
}

/**
 * Cut one reply into at most `maxBubbles` pieces.
 *
 * Paragraphs win over sentences (a deliberate blank line is a deliberate beat),
 * fragments shorter than {@link MIN_BUBBLE_CHARS} ride along with their
 * neighbour, except a short closing line — that one may stay alone, which is
 * what makes "晚安。" arrive as its own bubble. Code blocks and very short
 * replies are never split.
 *
 * @param {string} text
 * @param {number} [maxBubbles]
 * @returns {string[]}
 */
export function splitIntoBubbles(text, maxBubbles = DEFAULT_BUBBLE_SPLIT_MAX) {
  const source = String(text ?? '').trim();
  if (source === '') return [];
  if (!Number.isFinite(Number(maxBubbles)) || Number(maxBubbles) <= 1) return [source];
  if (source.includes('```')) return [source];

  // A deliberate blank line is a deliberate beat, so paragraphs split whatever
  // their length. Only sentence-level splitting needs the length floor: cutting
  // a two-clause short reply into two bubbles reads as choppy, not human.
  const paragraphs = source
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  let pieces;
  if (paragraphs.length > 1) {
    pieces = paragraphs;
  } else {
    if (source.length < MIN_SPLIT_CHARS) return [source];
    pieces = splitSentences(source);
  }
  if (pieces.length <= 1) return [source];

  const merged = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const last = index === pieces.length - 1;
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(piece);
      continue;
    }
    const closingBeat = last && piece.length <= MAX_TAIL_BUBBLE_CHARS && previous.length >= MIN_BUBBLE_CHARS;
    if (piece.length < MIN_BUBBLE_CHARS && !closingBeat) {
      merged[merged.length - 1] = joinFragments(previous, piece);
      continue;
    }
    merged.push(piece);
  }

  const cap = Math.max(1, Math.floor(Number(maxBubbles)));
  if (merged.length <= cap) return merged;
  const head = merged.slice(0, cap - 1);
  const tail = merged.slice(cap - 1).join('');
  return [...head, tail];
}

/**
 * How one settled reply should go out.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {{ id?: string } | null} [params.mode] the mode the conversation is in
 * @param {{ energy?: number } | null} [params.life]
 * @param {{ humanPacing?: boolean, replyDelayMaxMs?: number, bubbleSplitMax?: number, bubbleGapMs?: number }} [params.config]
 * @param {() => number} [params.rng]
 * @returns {{ delayMs: number, bubbles: string[], gapMs: number }}
 */
export function planCompanionReply({ text, mode, life = null, config = {}, rng = Math.random } = {}) {
  const source = String(text ?? '');
  if (!isCompanionMode(mode) || config.humanPacing === false) {
    return { delayMs: 0, bubbles: [source], gapMs: 0 };
  }
  const maxBubbles = Number(config.bubbleSplitMax ?? DEFAULT_BUBBLE_SPLIT_MAX);
  const bubbles = splitIntoBubbles(source, maxBubbles);
  const delayMs = replyDelayMs(source, life, Number(config.replyDelayMaxMs ?? DEFAULT_REPLY_DELAY_MAX_MS), rng);
  if (bubbles.length <= 1) return { delayMs, bubbles, gapMs: 0 };
  const baseGap = Number(config.bubbleGapMs ?? DEFAULT_BUBBLE_GAP_MS);
  const gapMs = Math.max(0, Math.round(Math.max(0, baseGap) * (0.7 + rng() * 0.6)));
  return { delayMs, bubbles, gapMs };
}

/**
 * How a companion should write in WeChat at all.
 *
 * Prompt-level only: the persona prompts say *who* is talking, this says *how*
 * a chat message looks. It is one block for every companion mode and none for
 * the stock assistant.
 *
 * A character pack's stickers are only offered in that character's mode, so
 * the hint and the parser agree on what one conversation may send.
 *
 * @param {{ stickers?: boolean, modeId?: string }} [options]
 * @returns {string}
 */
export function buildHumanStyleBlock({ stickers = false, modeId } = {}) {
  return [
    '<weixin_style>',
    '【怎么发消息】你在微信上和对方聊天，不是写文档：',
    '- 一次说一两句，短句；不要用标题、编号列表、加粗或表格这类排版；',
    '- 可以有口语词（嗯、行、哈哈）和 emoji，但别每句都带；',
    '- 想补充的话可以另起一条再说，不要全堆在一段里。',
    // Only offered when the sticker channel is on: a marker the pipeline will
    // not honour becomes a stray bracket in the user's chat.
    ...(stickers ? [stickerHint(modeId)] : []),
    '</weixin_style>',
  ].join('\n');
}
