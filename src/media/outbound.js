/**
 * Outbound media: send a local file back to Weixin as an image, video or file
 * attachment.
 *
 * The seam between the channel and the vendored Tencent upload/send pipeline:
 * this module owns everything dsh-weixin is allowed to decide (which file, is it
 * inside an allowed directory, MIME → kind, how big) and delegates every
 * protocol/crypto step to `vendor/openclaw-weixin/messaging/send-media.js`.
 *
 * Three deliberate properties:
 *  - **Nothing is sent without both gates.** A path is sent only when it
 *    resolves inside an allowed directory AND the file exists and is a regular
 *    file. Weixin text is not an authorization credential, so an agent reply
 *    must not be able to name `/etc/passwd` (or `../../etc/passwd`) and have it
 *    uploaded to Tencent's CDN.
 *  - **The upload waits for the file to settle.** A tool that is still writing
 *    the file when the turn ends would otherwise upload a truncated part.
 *  - **Failure is returned, never thrown.** The caller must still deliver the
 *    text half of a reply; see {@link OutboundMediaError}.
 * @module dsh-weixin/media/outbound
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Largest file this channel will upload. The CDN path reads the whole file into
 * memory (`fs.readFile` inside the vendored upload), so an unbounded file is an
 * out-of-memory risk rather than a slow send.
 */
export const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024

/** How long to wait for a still-growing file to stop changing. */
const SETTLE_TIMEOUT_MS = 3_000
const SETTLE_STABLE_MS = 250
const SETTLE_POLL_MS = 50

/**
 * A refusal, not a transport error: the caller reports the reason in the text
 * reply and never retries.
 */
export class OutboundMediaError extends Error {
  /**
   * @param {string} message  Human-readable reason, safe to send to the user.
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'OutboundMediaError'
    this.code = code
  }
}

/**
 * The directories an agent reply is allowed to reference.
 *
 * `cwd` (the DSH session working directory) and `~/.dsh/weixin` (the plugin's
 * own state tree) are the only two places a Weixin conversation's files can be
 * produced, and the outbound directory scope is pinned to exactly these — see
 * `docs/security.md`, "出站附件" for the reasoning.
 *
 * @param {{ cwd?: string, stateDir?: string, allowedDirs?: string[] }} [params]
 * @returns {string[]} absolute, deduplicated directory paths
 */
export function allowedMediaDirs(params = {}) {
  const candidates = [
    ...(Array.isArray(params.allowedDirs) ? params.allowedDirs : []),
    params.cwd,
    params.stateDir ?? path.join(os.homedir(), '.dsh', 'weixin'),
  ]
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    seen.add(path.resolve(candidate))
  }
  return [...seen]
}

/**
 * Is `candidate` the same path as, or below, `root`?
 *
 * `path.relative` is the check, not `String.startsWith`: `/wi/evil` starts with
 * `/wi` but is not inside it, and `relative` also collapses `..` segments, so
 * `cwd/../../etc/passwd` resolves outside the root and is refused. A relative
 * result that escapes starts with `..` or is absolute (different drive on
 * Windows).
 *
 * @param {string} root  Absolute, already resolved.
 * @param {string} candidate  Absolute, already resolved.
 */
export function isInside(root, candidate) {
  const rel = path.relative(root, candidate)
  if (rel === '') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolve a candidate path and prove it is inside one of `roots`.
 *
 * Both sides are `realpath`-resolved before the containment check. That is not
 * belt-and-braces:
 *  - a symlink *inside* an allowed directory pointing at `/etc` is a traversal
 *    that lexical comparison alone would admit;
 *  - and the roots themselves are routinely symlinked — on macOS `/var` is
 *    `/private/var`, so `os.tmpdir()` and any `cwd` under it are only equal to
 *    a realpath'd candidate once the root is resolved too.
 *
 * @param {string} filePath
 * @param {string[]} roots  Also the basis for resolving a relative path: each
 *   root is tried in order, and a relative reference is taken to be relative to
 *   the first root it resolves inside.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string, code: string }>}
 */
export async function resolveAllowedPath(filePath, roots) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, reason: 'empty path', code: 'invalid-path' }
  }
  // An agent writes `![shot](desktop.png)` meaning "the file I just made", which
  // lives in the agent's working directory — one of `roots` — NOT wherever this
  // host process happens to have been started. Resolving against
  // `process.cwd()` therefore lands outside every allowed directory and every
  // relative reference is refused, which is indistinguishable to the user from
  // the feature not existing at all.
  //
  // Trying each root in order (rather than only the first) keeps a deployment
  // that allows several directories working: the reference resolves inside
  // whichever one actually holds the file.
  const isAbsolute = path.isAbsolute(filePath)
  // The `..`-escape verdict must be read off the reference the agent WROTE.
  // `path.join(root, 'sub/../../x')` collapses the `..` on the way in, so a
  // containment check against the joined string can no longer tell a climb from
  // a path that was simply never inside — and the user gets "outside the
  // allowed directories" for a mistake that was actually a bad relative path.
  const escapedWithDotDot = /(^|[/\\])\.\.([/\\]|$)/.test(filePath)
  const candidates = isAbsolute ? [filePath] : roots.map((root) => path.join(root, filePath))
  // `~` is what an agent writes when it means the home directory.
  const expandedCandidates = candidates.map((candidate) =>
    candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate,
  )

  const refusals = []
  /** A contained candidate whose file is not there; a later root may still have it. */
  let absent
  for (const expanded of expandedCandidates) {
    const attempt = await containPath(expanded, roots)
    if (attempt.ok && attempt.existed) return attempt
    // Contained but missing: remember it and keep looking, because the same
    // relative name may resolve to a real file under a LATER allowed root. The
    // absent result is still returned if no root has the file, so the caller
    // refuses it with the accurate "does not exist" rather than a containment
    // complaint that would be untrue.
    if (attempt.ok) {
      absent ??= attempt
      continue
    }
    refusals.push(escapedWithDotDot ? { ...attempt, reason: 'path escapes the allowed directories with ".."' } : attempt)
  }
  if (absent !== undefined) return absent
  // None resolved. Prefer a `..` escape over a plain miss, and a real reason
  // over a synthetic one, so the note the user reads names the actual mistake.
  return refusals.find((entry) => entry.reason.includes('..')) ?? refusals[0] ?? {
    ok: false,
    reason: 'path is outside the allowed directories',
    code: 'path-not-allowed',
  }
}

/**
 * Containment test for one already-absolute spelling of a path.
 *
 * Split out so a relative reference can be tried against several candidate
 * bases without repeating the realpath dance for each.
 *
 * @param {string} expanded  Absolute, `~` already expanded.
 * @param {string[]} roots
 * @returns {Promise<{ ok: true, path: string, existed: boolean } | { ok: false, reason: string, code: string }>}
 */
async function containPath(expanded, roots) {
  const absolute = path.resolve(expanded)
  let real = absolute
  let existed = true
  try {
    real = await fs.realpath(absolute)
  } catch {
    // Not there yet, or unreadable. Falling back to the lexical path would make
    // containment fail spuriously whenever a root is symlinked — on macOS the
    // root realpath is `/private/var/...` while a missing child is still spelled
    // `/var/...`, so a plain "does not exist" would be reported to the user as
    // "outside the allowed directories". Resolve the nearest existing ancestor
    // instead, so containment stays truthful for paths that simply do not exist.
    existed = false
    real = await realpathNearestAncestor(absolute)
  }
  const realRoots = (await Promise.all(roots.map((root) => realpathIfDirectory(root)))).filter(
    (root) => root !== null,
  )
  if (!realRoots.some((root) => isInside(root, real))) {
    // Distinguish a path that climbed out with `..` from one that was simply
    // never inside: the first is an agent writing a wrong relative reference,
    // the second is a wrong absolute one, and the user-facing note reads better
    // when it says which.
    //
    // Tested against `expanded`, NOT `absolute`: `path.resolve` has already
    // collapsed every `..`, so the resolved string can never contain one.
    // `\` is included because a Windows-style reply may reach a macOS host
    // unchanged.
    const climbed = /(^|[/\\])\.\.([/\\]|$)/.test(expanded)
    return {
      ok: false,
      reason: climbed
        ? 'path escapes the allowed directories with ".."'
        : 'path is outside the allowed directories',
      code: 'path-not-allowed',
    }
  }
  return { ok: true, path: real, existed }
}

/**
 * `realpath` the deepest ancestor that exists, then re-append the missing tail.
 *
 * Used only for paths that do not exist: containment must be judged against the
 * physical location the file *would* occupy, so a symlinked root compares equal
 * and a genuinely out-of-bounds target is still refused.
 */
async function realpathNearestAncestor(absolute) {
  let current = absolute
  const tail = []
  for (;;) {
    const parent = path.dirname(current)
    tail.unshift(path.basename(current))
    if (parent === current) return absolute // Reached the filesystem root.
    try {
      const resolved = await fs.realpath(parent)
      return path.join(resolved, ...tail)
    } catch {
      current = parent
    }
  }
}

/**
 * `realpath` a root, keeping only roots that can actually contain a file.
 *
 * A root that is a regular file (or is missing) can never contain anything, so
 * it is dropped rather than used for containment. Without this, a root like
 * `/etc/passwd` would make `/etc/passwd/anything` compare "inside" it; the
 * later `stat` refuses that path honestly, but the contract would be asserting
 * containment that cannot exist.
 *
 * Dropping rather than failing is the safe direction: a missing allowed
 * directory must not make every reference look out of bounds.
 */
async function realpathIfDirectory(root) {
  try {
    const resolved = await fs.realpath(root)
    const stat = await fs.stat(resolved)
    return stat.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

/** MIME type from extension, mirroring the vendored router's own source. */
async function mimeFor(filePath) {
  const { getMimeFromFilename } = await import('../../vendor/openclaw-weixin/media/mime.js')
  return getMimeFromFilename(filePath)
}

/**
 * Upload kind for a MIME type. Mirrors the routing in the vendored
 * `sendWeixinMediaFile` so this module's decision and the vendor's agree.
 * @param {string} mime
 * @returns {'video'|'image'|'file'}
 */
export function mediaKindForMime(mime) {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return 'file'
}

/**
 * Wait until the file stops growing.
 *
 * An agent turn can end while a background tool is still writing its output; a
 * file that changes size between two polls is not ready, so the wait extends
 * until it is stable for {@link SETTLE_STABLE_MS} or {@link SETTLE_TIMEOUT_MS}
 * elapses (in which case whatever is on disk is sent, matching the caller's
 * "deliver something" contract).
 *
 * @param {string} filePath
 * @param {() => Promise<void>} sleep
 */
async function waitForStableSize(filePath, sleep) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  let previous = -1
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    let size
    try {
      size = (await fs.stat(filePath)).size
    } catch {
      return
    }
    if (size !== previous) {
      previous = size
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= SETTLE_STABLE_MS) {
      return
    }
    await sleep(SETTLE_POLL_MS)
  }
}

/**
 * Resolve a referenced local path into everything needed to send it.
 *
 * This is the whole authorization decision; {@link sendOutboundMedia} performs
 * no further checks. Pure I/O — nothing here talks to Weixin — so the tests can
 * exercise the gate without a server.
 *
 * @param {object} params
 * @param {string} params.filePath
 * @param {string[]} params.allowedDirs
 * @param {number} [params.maxBytes]
 * @param {() => Promise<void>} [params.sleep]  Test seam.
 * @returns {Promise<{ ok: true, path: string, size: number, mime: string, kind: 'video'|'image'|'file', name: string }
 *   | { ok: false, status: string }>}
 */
export async function resolveOutboundMedia(params) {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES
  const resolved = await resolveAllowedPath(params.filePath, params.allowedDirs)
  if (!resolved.ok) return { ok: false, status: resolved.reason }

  const filePath = resolved.path
  await waitForStableSize(filePath, params.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    return { ok: false, status: 'the file does not exist' }
  }
  if (!stat.isFile()) return { ok: false, status: 'the path is not a regular file' }
  if (stat.size === 0) return { ok: false, status: 'the file is empty' }
  if (stat.size > maxBytes) {
    return { ok: false, status: `the file is larger than the ${Math.floor(maxBytes / (1024 * 1024))}MB upload limit` }
  }

  const mime = await mimeFor(filePath)
  return {
    ok: true,
    path: filePath,
    size: stat.size,
    mime,
    kind: mediaKindForMime(mime),
    name: path.basename(filePath),
  }
}

/**
 * Upload one local file to the Weixin CDN and send it to `to`.
 *
 * @param {object} params
 * @param {string} params.filePath  Already validated (see {@link resolveOutboundMedia}).
 * @param {string} params.to        Conversation id (`msg.to_user_id`).
 * @param {string} params.contextToken  Echoed inbound token; iLink routes by it.
 * @param {string} params.cdnBaseUrl
 * @param {{ baseUrl: string, token: string, accountId?: string, timeoutMs?: number }} params.opts
 * @param {string} [params.text]    Caption, sent as a separate text item first.
 * @returns {Promise<{ kind: 'video'|'image'|'file', filekey?: string, serverMessageId?: string }>}
 * @throws {OutboundMediaError} when the upload or the send fails.
 */
export async function sendOutboundMedia(params) {
  const { filePath, to, contextToken, cdnBaseUrl, opts, text } = params
  const mime = await mimeFor(filePath)
  const kind = mediaKindForMime(mime || '')
  const { sendWeixinMediaFile } = await import('../../vendor/openclaw-weixin/messaging/send-media.js')
  try {
    const result = await sendWeixinMediaFile({
      filePath,
      to,
      ...(text ? { text } : {}),
      cdnBaseUrl,
      opts: { ...opts, contextToken },
    })
    return { kind, ...(result ?? {}) }
  } catch (error) {
    throw new OutboundMediaError(`upload/send failed: ${String(error?.message ?? error)}`, 'send-failed')
  }
}

/**
 * The `opts` the vendored send pipeline needs, assembled once.
 *
 * `accountId` is optional upstream (it only keys the quote cache); `baseUrl` and
 * `token` are the iLink credentials the upload-URL request authenticates with.
 *
 * @param {{ baseUrl: string, token: string, accountId?: string, timeoutMs?: number }} params
 */
export function mediaSendOptions(params) {
  return {
    baseUrl: params.baseUrl,
    token: params.token,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  }
}

// ---------------------------------------------------------------------------
// Detection: which local files does an agent's reply point at?
// ---------------------------------------------------------------------------

/**
 * Extensions that are *attachments by nature* — a document, archive or media
 * container the user is meant to receive, never something that renders inline.
 *
 * This set is what makes a markdown LINK an upload. An image in a link
 * (`[shot](a.png)`) is plausibly the agent pointing at where a picture lives,
 * and turning every link into an upload would send source trees to Tencent. But
 * `[报告](报告.pdf)` cannot mean anything except "here is the file" — nothing
 * renders a PDF inline in a WeChat reply, and this is exactly the shape agents
 * write for documents (measured: every real .pdf/.docx reply in this project's
 * own transcripts used link syntax with a relative path, and none arrived).
 *
 * Anything not listed here keeps the stricter rule: only image syntax.
 */
const ATTACHMENT_EXT = 'pdf|docx?|xlsx?|pptx?|csv|zip|tar|gz|tgz|7z|rar|mp3|wav|m4a|ogg|mp4|mov|webm|mkv|avi|silk'

/** Every extension this channel will deliver, image or attachment. */
const MEDIA_EXT = `png|jpe?g|gif|webp|bmp|${ATTACHMENT_EXT}|txt|md|json|log`

/**
 * Markdown image reference: `![alt](path)`.
 *
 * Image syntax is accepted for **any** media extension: `![x](a.pdf)` is
 * unambiguous, because the agent chose the upload-shaped delimiter itself.
 *
 * The path may be wrapped in `<...>` — the usual way to write a path containing
 * spaces — and `<...>` contents are allowed to contain spaces.
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^<>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g

/**
 * Markdown link reference: `[text](path)`.
 *
 * Deliberately narrower than the image form — see {@link ATTACHMENT_EXT} for
 * why only attachment extensions qualify. `[alt](a.png)` stays a link *about*
 * an image and is not uploaded.
 */
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]\n]*)\]\(\s*(?:<([^<>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g

/**
 * An explicit path written on its own line, or in a list/bullet.
 *
 * Absolute, home-relative and Windows-shaped paths are accepted for any media
 * extension. A *relative* path is accepted too, but only when it carries an
 * attachment extension (see {@link RELATIVE_SAFE_RE}): `report.pdf` alone on a
 * line is an instruction to send that document, while `shot.png` alone on a
 * line is ambiguous — the agent may only be naming a file it discussed. A wrong
 * guess fails closed: the resolver tries every allowed root and reports why
 * nothing was sent, and it can never reach outside the configured directories.
 *
 * The token may not contain a quote/backtick/angle bracket, so prose is still
 * never mistaken for a path.
 */
const BARE_PATH_RE = new RegExp(
  `^[\\s>\\-+*]*((?:(?:~/|/|[A-Za-z]:[\\\\/])[^\\s\`'"<>|]*?|(?![/~])[^\\s\`'"<>|]*?)\\.(?:${MEDIA_EXT}))\\s*$`,
  'gim',
)

/** A relative path is auto-detected only for these extensions. */
const RELATIVE_SAFE_RE = new RegExp(`\\.(${ATTACHMENT_EXT})$`, 'i')

/** How many files one reply may carry: iLink sends one item per request. */
export const MAX_MEDIA_PER_REPLY = 5

/**
 * Find the local files an agent's reply references.
 *
 * @param {string} text
 * @returns {Array<{ path: string, alt?: string, raw: string, index: number }>}
 *   In document order, deduplicated by path, capped at {@link MAX_MEDIA_PER_REPLY}.
 */
export function detectMediaReferences(text) {
  if (typeof text !== 'string' || text === '') return []
  /** @type {Array<{ path: string, alt?: string, raw: string, index: number }>} */
  const found = []
  const seen = new Set()

  const push = (raw, target, alt, index) => {
    const value = String(target).trim()
    if (value === '' || seen.has(value)) return
    // A URL is not a local file. Left in, `https://host/a.png` reaches the
    // resolver, fails to `stat`, and the user gets "附件发送失败 … the file does
    // not exist" stapled onto a perfectly good reply — a note about a mistake
    // nobody made. Only `file:` is deliberately kept: that IS a local path.
    // A single-letter scheme is a Windows drive (`C:\\x\\y.png`), not a URL, so it
    // must survive; every longer scheme is a URL and must not.
    if (/^(?!file:)(?![A-Za-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(value)) return
    seen.add(value)
    found.push({ path: value, ...(alt === undefined ? {} : { alt }), raw, index })
  }

  // Code is quoted, not referenced. An agent that writes `` `![alt](p)` `` to
  // *show* the syntax must not make us upload `p`, and the same goes for a path
  // sitting in a fenced block. Masking (rather than deleting) keeps every index
  // aligned with the original text, because `stripMediaReferences` later cuts
  // `raw` spans out of that original.
  const scanText = maskCode(text)

  // Both link forms capture the target twice: group 2 is the `<...>`-wrapped
  // form (which may contain spaces) and group 3 the bare form (which may not).
  const target = (match) => match[2] ?? match[3]

  for (const match of scanText.matchAll(MARKDOWN_IMAGE_RE)) {
    const value = target(match)
    if (value === undefined) continue
    push(text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length), value, match[1], match.index ?? 0)
  }
  for (const match of scanText.matchAll(MARKDOWN_LINK_RE)) {
    const value = target(match)
    // A link is only a reference when the target is an attachment by nature.
    if (value === undefined || !RELATIVE_SAFE_RE.test(value)) continue
    push(text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length), value, match[1], match.index ?? 0)
  }
  for (const match of scanText.matchAll(BARE_PATH_RE)) {
    const value = match[1]
    // A bare relative path is only a reference for attachment extensions; the
    // regex admits any extension so it can capture both shapes, so the filter
    // lives here where the leading shape is still known.
    const absolute = /^(?:~\/|\/|[A-Za-z]:[\\/])/.test(value)
    if (!absolute && !RELATIVE_SAFE_RE.test(value)) continue
    push(text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length), value, undefined, match.index ?? 0)
  }

  found.sort((a, b) => a.index - b.index)
  return found.slice(0, MAX_MEDIA_PER_REPLY)
}

/**
 * Blank out fenced blocks and inline code spans, preserving length and newlines.
 *
 * Length-preserving is the whole point: every regex match index stays valid
 * against the original string, so the caller can slice the real reference text
 * back out. Replacing with spaces also keeps a masked path from accidentally
 * forming a new match across the boundary.
 *
 * @param {string} text
 * @returns {string} Same length as `text`, with code regions blanked.
 */
function maskCode(text) {
  const chars = [...text]
  const blank = (start, end) => {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  // Index at which the paragraph containing `from` ends: the start of the first
  // blank line after it, or the end of the text. A code span cannot cross this,
  // so it is also the limit on how far a rejected opener may look for a partner.
  const blankLineAfter = (from) => {
    const match = /\n[ \t]*\n/.exec(text.slice(from))
    return match === null ? text.length : from + match.index
  }

  // Fenced blocks first, following CommonMark's delimiter rules: an opening
  // fence is a run of 3+ backticks or tildes, and it is closed only by a run of
  // the SAME character that is AT LEAST AS LONG as the opener.
  //
  // Comparing the character alone is a real bug, not a nicety: a four-backtick
  // fence exists precisely so it can contain ``` inside it, and closing on the
  // first inner ``` would expose whatever the agent is *showing* as code — an
  // `![x](/path)` in that block would be treated as a real attachment and
  // uploaded.
  // The indent is capped at three spaces because CommonMark reads four or more
  // leading spaces as an INDENTED CODE BLOCK, not a fence: the backticks are then
  // literal text, the image below them is a real image, and masking it would lose
  // an attachment the user can actually see.
  const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/gm

  // Is `tail` — everything after the run on a candidate line — acceptable as the
  // tail of a CLOSING fence?
  //
  // CommonMark requires a closing fence to carry nothing but whitespace, and the
  // common reading of that stops at spaces. This predicate is deliberately a
  // little wider, because that is what the renderers we are compared against
  // actually do: after the run, they allow a further sequence of fence MARKERS
  // (` and ~), optionally followed by spaces. So all of
  //
  //     ```          ```~          ```~~          ```~~~          ```~` 
  //
  // close the fence above them, while
  //
  //     ```x         ```-         ``` ~         ```~x          ```\t
  //
  // do not: any ordinary character — OR ANY TAB — disqualifies the line, and once
  // disqualifying text appears, trailing spaces cannot rescue it. The markers must
  // be contiguous: ` ~` breaks the run and the line stops being a closer.
  //
  // Getting this wrong in the "too narrow" direction loses attachments, which is
  // the quieter failure of the two. A line like
  //
  //     ```
  //     ```~~~
  //     ![x](/path)
  //
  // really does close the fence above it, so the following image is a REAL image
  // that the user can see; refusing to close leaves the fence open to the end of
  // the reply and silently drops that attachment. The reverse direction — closing
  // a fence that is still open — is what leaks code as an upload, so this
  // predicate is only ever applied to lines the pairing loop already accepted on
  // marker character, run length, and non-empty-tail grounds.
  const isCloserTail = (tail) => {
    if (tail.includes('\t')) return false
    return /^(?:[`~]*)(?: *)$/.test(tail)
  }
  // Backtick runs that begin a line but are REJECTED as fence openers, keyed by
  // position so the span pass can reconsider them.
  //
  //     ``` run `code` end ![x](/path)
  //
  // The line starts with three backticks, but its info string contains a
  // backtick, so CommonMark does not read it as a fence at all: the two single
  // backticks pair into a code span and the image is REAL.
  //
  // Only backtick fences can be rejected this way, and only backtick runs can
  // delimit an inline span, so `rejectedFenceStarts` stays backtick-only.
  //
  // Such a run is NOT a fence and never takes part in fence pairing, so it can
  // neither open, close, nor block a fence. Two consequences follow, and getting
  // either wrong leaks an attachment:
  //
  //  * A fence left open ABOVE the rejected opener still runs to the end of the
  //    reply (or is closed by a later legal closer). The rejected opener is just
  //    more content inside it.
  //  * A legal fence opener BELOW the rejected opener still opens. The rejected
  //    opener is paragraph text; it does not shield the lines under it.
  //
  // The ONLY thing a rejected opener can swallow is its own span partner: when a
  // run of EQUAL length sits on the immediately following line, the two pair into
  // one inline code span, and everything between them is code. That partner must
  // therefore be kept out of fence pairing too — otherwise
  //
  //     ```js`x\n![x](/path)\n```
  //
  // would be read as a fence (blanking nothing useful) instead of the span that
  // CommonMark actually produces, and the image would look real.
  //
  // Only backtick fences can be rejected this way, and only backtick runs can
  // delimit an inline span, so this stays backtick-only.
  const rejectedFenceStarts = new Map()

  // Every candidate fence opener or closer, in document order, tagged with the
  // character that must pair with it. Tilde and backtick fences are tracked
  // together so that one character's fence cannot be closed by the other's.
  const fenceEvents = []
  for (const match of text.matchAll(fence)) {
    const run = match[2]
    const start = match.index ?? 0
    if (run[0] === '`' && match[3].includes('`')) {
      rejectedFenceStarts.set(start, run.length)
      continue
    }
    fenceEvents.push({
      start,
      // Where the RUN itself starts — `start` is the start of the line, so for an
      // indented fence it points at the indentation. Every "was this run already
      // blanked?" test must use this, or an indented fence reads as blank.
      runStart: start + match[1].length,
      marker: run[0],
      ticks: run.length,
      blankable: isCloserTail(match[3]),
    })
  }

  // A rejected opener pairs with a same-length run later in the SAME paragraph,
  // consuming it as a span partner rather than a fence opener. Everything between
  // the pair is code, so blank it here — fence pairing below must never see the
  // partner.
  //
  // "Same paragraph" is load-bearing and is the whole subtlety: CommonMark code
  // spans do not cross a blank line. Every example below is annotated with what
  // marked actually renders, not with what the pairing logic "intends":
  //
  //     ```js`x\n![x](/path)\n```      span — image is in <code>, NOT sent
  //     ```js`x\n\n![x](/path)\n```    no span (blank line) — ```js`x becomes a
  //                                    paragraph and the SECOND ``` opens a fence,
  //                                    so the image is in <pre><code>, NOT sent
  //     ```js`x\n```\n![x](/path)      the second ``` opens a fence that swallows
  //                                    the image — in <pre><code>, NOT sent
  //     ```js`x\n```\n\n![x](/path)    a blank line does NOT close a fence, so the
  //                                    fence runs on — in <pre><code>, NOT sent
  //
  // Note the second case: a blank line suppresses the SPAN, but the run below then
  // becomes a fence opener and swallows the image anyway. That is why neither
  // adjacency nor the paragraph boundary alone decides the answer — what matters
  // is that masking the UNION of the span reading and the fence reading is never
  // narrower than what CommonMark actually puts in code.
  //
  // A rejected opener's partner is ALSO allowed to keep acting as a fence opener.
  // The two readings are not exclusive, and masking their UNION is what matches
  // CommonMark in both orderings of the same three runs:
  //
  //     ````js`\n````\n![x](/path)     the partner ```` is the thing that starts
  //                                     the code region, so blanking must start
  //                                     there and run on — the image is BELOW it
  //     ```![x](/path)js`x\n```      the partner ` ``` ` is the thing that ENDS
  //                                     the region, so blanking must start at the
  //                                     rejected opener — the image is ABOVE it
  //
  // Treating the partner as span-only gets the first case wrong; treating it as
  // fence-only gets the second wrong. Blanking both ranges covers both.
  //
  // The candidate list is built BEFORE this blanking for that reason: the span
  // range covers the partner run, and a partner that has already been blanked
  // would otherwise be filtered out below and never get to open its fence.
  const fenceCandidates = fenceEvents.filter((event) => chars[event.runStart] !== ' ')
  for (const [start, ticks] of rejectedFenceStarts) {
    const paragraphEnd = blankLineAfter(text, start)
    const partner = fenceEvents.find(
      (event) => event.start > start && event.start < paragraphEnd && event.marker === '`' && event.ticks === ticks,
    )
    if (partner === undefined) continue
    blank(start, partner.start + partner.ticks)
  }

  // Walk the fence candidates in order. A candidate that OPENS a fence is only
  // masked once a matching closer arrives.
  let open = null
  for (const event of fenceCandidates) {
    if (open === null) {
      open = event
      continue
    }
    // A closing fence must use the SAME character, be at least as long as the
    // opener, and carry an acceptable tail (`blankable`, see `isCloserTail`).
    // Mixing characters here would let ``` close a ~~~ fence (or vice versa),
    // which is not a fence in CommonMark and would expose the block's contents as
    // real attachments.
    if (event.marker === open.marker && event.ticks >= open.ticks && event.blankable) {
      blank(open.start, event.start + event.ticks)
      open = null
    }
  }
  // An unclosed fence runs to the end of the reply. This is unconditional: the
  // rejected-opener span pairing above has already removed the only runs that
  // could legitimately have been that fence's closer-as-span-partner, so any
  // opener still standing really does swallow the rest of the text.
  if (open !== null) blank(open.start, text.length)

  // Inline spans, following CommonMark's code-span rule: a run of backticks is
  // closed by a run of EXACTLY the same length.
  //
  // Two separate mistakes are possible here, and both hide real attachments:
  //
  //  * Closing on a LONGER run. ```` exists so it can contain ``` — closing on
  //    the first inner ``` would reopen the middle of a span.
  //  * Blanking an opener that nothing can close. Runs are matched left to
  //    right: the first run pairs with the NEXT run of its own length, and a run
  //    with no such partner is literal text, not an unterminated span. Treating
  //    it as unterminated blanks the rest of the reply, which is how
  //        inline ``` run then `code` end ![x](/path)
  //    (a real image per CommonMark: the two single backticks pair up) silently
  //    lost its attachment.
  const backtick = /(`+)/g
  const runs = Array.from(text.matchAll(backtick))
    .map((match) => ({ index: match.index ?? 0, ticks: match[1].length }))
    // Backticks already masked by a fence cannot delimit a span.
    .filter((run) => chars[run.index] !== ' ')

  // Pair each run with the next run of equal length, if any.
  let pending = null
  for (const run of runs) {
    if (pending === null) {
      const partner = runs.find((other) => other.index > run.index && other.ticks === run.ticks)
      if (partner === undefined) continue // Unterminated run: literal text.
      pending = run
      continue
    }
    if (run.ticks === pending.ticks) {
      blank(pending.index, run.index + run.ticks)
      pending = null
    }
  }
  // No trailing "unmatched opener" branch is needed here, and the one that used
  // to sit at this spot was unreachable as well as wrong.
  //
  // Wrong: a run is only ever assigned to `pending` after a same-length partner
  // is confirmed to exist LATER in `runs` (see the `continue` above), so a
  // genuinely unmatched run — the literal-text case — never becomes `pending`
  // and never extends a span. Its partner search is what rejects it.
  //
  // Unreachable: because that partner is later in iteration order, the loop is
  // guaranteed to reach a run of equal length and clear `pending` before it
  // ends. Exhaustive generation over backtick/letter/newline alphabets up to
  // length 5 (9330 inputs) reaches a trailing `pending !== null` zero times, and
  // instrumenting the real function shows the same. (It also read `pending.start`
  // — `pending` carries `index`, not `start` — so had it ever run it would have
  // called blank(undefined, …) and silently masked nothing.)

  return chars.join('')
}

/**
 * Remove the media references that were sent, so the text half of the reply
 * does not repeat what the user is already looking at.
 *
 * A markdown image becomes its alt text (or nothing); a bare path line becomes
 * empty and its blank line is collapsed.
 *
 * @param {string} text
 * @param {Array<{ raw: string, alt?: string }>} references
 */
export function stripMediaReferences(text, references) {
  let out = text
  for (const reference of references) {
    const replacement = reference.alt !== undefined && reference.alt.trim() !== '' ? reference.alt.trim() : ''
    out = out.split(reference.raw).join(replacement)
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Pull the media (and the remaining text) out of one agent reply.
 *
 * Pure and synchronous — every filesystem/network decision is left to the
 * caller — so a test can pin the detection rule without I/O.
 *
 * @param {string} text
 * @returns {{ text: string, media: Array<{ path: string, alt?: string, raw: string, index: number }> }}
 */
export function splitOutboundMedia(text) {
  const media = detectMediaReferences(text)
  if (media.length === 0) return { text, media: [] }
  return { text: stripMediaReferences(text, media), media }
}

/**
 * Send every file an agent reply references, then return the text that is left
 * once those references are removed.
 *
 * The whole point of returning rather than throwing: a failed upload must cost
 * the user a caption, never the entire answer. Each failure becomes one appended
 * line naming the file and the reason, so the user learns what did not arrive
 * instead of silently missing an attachment.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {string} params.to
 * @param {string} [params.contextToken]
 * @param {string[]} params.allowedDirs
 * @param {string} params.cdnBaseUrl
 * @param {{ baseUrl: string, token: string, accountId?: string }} params.opts
 * @param {number} [params.maxBytes]
 * @param {(line: string) => void} [params.warn]
 * @param {(params: object) => Promise<any>} [params.send]  Test seam; defaults to
 *   {@link sendOutboundMedia}.
 * @returns {Promise<{ text: string, sent: string[], failed: Array<{ path: string, reason: string }> }>}
 */
export async function deliverOutboundMedia(params) {
  const send = params.send ?? sendOutboundMedia
  const { text, media } = splitOutboundMedia(params.text ?? '')
  const sent = []
  const failed = []
  /** @type {Array<{ raw: string, alt?: string }>} */
  const delivered = []

  for (const reference of media) {
    const resolved = await resolveOutboundMedia({
      filePath: reference.path,
      allowedDirs: params.allowedDirs,
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
    })
    if (!resolved.ok) {
      params.warn?.(`refusing media ${reference.path}: ${resolved.status}`)
      failed.push({ path: reference.path, reason: resolved.status })
      // The reference stays in the text: nothing was sent, so removing it would
      // hide a file the user was told about.
      continue
    }
    try {
      await send({
        filePath: resolved.path,
        to: params.to,
        contextToken: params.contextToken,
        cdnBaseUrl: params.cdnBaseUrl,
        opts: params.opts,
      })
      sent.push(resolved.path)
      delivered.push(reference)
    } catch (error) {
      const reason = String(error?.message ?? error)
      params.warn?.(`sending media ${resolved.path} failed: ${reason}`)
      failed.push({ path: resolved.path, reason })
    }
  }

  let remaining = delivered.length > 0 ? stripMediaReferences(text, delivered) : text
  if (failed.length > 0) {
    const lines = failed.map((entry) => `（附件发送失败：${entry.path} — ${entry.reason}）`)
    remaining = remaining === '' ? lines.join('\n') : `${remaining}\n${lines.join('\n')}`
  }
  return { text: remaining, sent, failed }
}
