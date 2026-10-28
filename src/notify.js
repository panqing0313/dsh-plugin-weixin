/**
 * Local notification bridge: turn the plugin into a push channel for the machine.
 *
 * The gap this closes: a long build, a nightly backup, a cron job or a CI run has
 * no way to reach the operator where they actually are. The agent can only speak
 * inside a turn, and a turn only exists because someone sent a message.
 *
 * So this is a deliberately tiny HTTP surface on 127.0.0.1: one endpoint
 * (`POST /notify`), a bearer token, and a size/rate limit. It never calls a
 * model — a notification costs nothing but the message itself.
 *
 * Three properties matter:
 *  1. **Local only.** The socket binds 127.0.0.1, never 0.0.0.0. A push channel
 *     reachable from the LAN would be a remote-control surface.
 *  2. **Token required, compared in constant time.** The token is generated once
 *     and stored 0600 under the state root; the settings card shows the file,
 *     not the secret in a log line.
 *  3. **It cannot take the plugin down.** A busy port, a malformed body or a
 *     send failure is reported and swallowed; the channel keeps working.
 *
 * @module dsh-weixin/notify
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Where the generated token lives, relative to the state root. */
export const NOTIFY_TOKEN_FILE = 'notify.json'
/** Loopback only. Changing this would expose the endpoint to the network. */
export const NOTIFY_HOST = '127.0.0.1'
/** Default port; configurable because two installs may share a machine. */
export const DEFAULT_NOTIFY_PORT = 47832
/** A notification is a sentence, not a document. */
export const MAX_NOTIFY_TEXT = 4000
/** Refuse an oversized request before it can grow in memory. */
export const MAX_NOTIFY_BODY = 16 * 1024
/** Per-minute budget; a runaway loop calling curl must not flood WeChat. */
export const NOTIFY_RATE_PER_MINUTE = 30

function tokenPath(stateRoot) {
  return path.join(stateRoot, NOTIFY_TOKEN_FILE)
}

/** The persisted token, or '' when none has been generated yet. */
export function readNotifyToken(stateRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath(stateRoot), 'utf8'))
    return typeof parsed?.token === 'string' ? parsed.token : ''
  } catch {
    return ''
  }
}

/**
 * The token to use: the configured one when set, else the persisted one, else a
 * freshly generated one written 0600. Returns '' only when the file cannot be
 * written — the caller then leaves the bridge off rather than serving without
 * authentication.
 */
export function ensureNotifyToken(stateRoot, { configured = '', warn = () => {} } = {}) {
  if (String(configured) !== '') return String(configured)
  const existing = readNotifyToken(stateRoot)
  if (existing !== '') return existing
  const token = crypto.randomBytes(24).toString('base64url')
  try {
    fs.mkdirSync(stateRoot, { recursive: true })
    fs.writeFileSync(tokenPath(stateRoot), `${JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
    return token
  } catch (error) {
    warn(`notify token could not be written: ${String(error?.message ?? error)}`)
    return ''
  }
}

function constantTimeEqual(given, expected) {
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Build the server. `send(text)` is the caller's transport-aware delivery; the
 * bridge knows nothing about accounts, conversations or chunking.
 *
 * @param {{
 *   token: string,
 *   send: (text: string) => Promise<void>,
 *   port?: number,
 *   warn?: (message: string) => void,
 *   ratePerMinute?: number,
 * }} options
 */
export function createNotifyServer({ token, send, port = DEFAULT_NOTIFY_PORT, warn = () => {}, ratePerMinute = NOTIFY_RATE_PER_MINUTE }) {
  /** @type {number[]} */
  const hits = []
  let closed = false

  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = String(req.url ?? '').split('?')[0]
      if (req.method !== 'POST' || pathname !== '/notify') {
        json(res, 404, { ok: false, error: 'not found' })
        return
      }

      const now = Date.now()
      while (hits.length > 0 && now - hits[0] >= 60_000) hits.shift()
      if (hits.length >= ratePerMinute) {
        json(res, 429, { ok: false, error: 'too many notifications' })
        return
      }
      hits.push(now)

      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))
      const given = req.headers['x-notify-token'] ?? bearer?.[1] ?? ''
      if (!constantTimeEqual(given, token)) {
        json(res, 401, { ok: false, error: 'bad token' })
        return
      }

      let body = ''
      try {
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_NOTIFY_BODY) {
            json(res, 413, { ok: false, error: 'body too large' })
            req.destroy()
            return
          }
        }
      } catch {
        json(res, 400, { ok: false, error: 'unreadable body' })
        return
      }

      let text = body
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed === 'object' && parsed !== null) text = String(parsed.text ?? '')
      } catch {
        // Plain text is the other supported shape; JSON is not required.
      }
      text = text.trim()
      if (text === '') {
        json(res, 400, { ok: false, error: 'empty text' })
        return
      }
      if (text.length > MAX_NOTIFY_TEXT) text = `${text.slice(0, MAX_NOTIFY_TEXT)}…`

      try {
        await send(text)
        json(res, 200, { ok: true })
      } catch (error) {
        warn(`notify send failed: ${String(error?.message ?? error)}`)
        json(res, 502, { ok: false, error: 'send failed' })
      }
    })()
  })

  return {
    server,
    /**
     * Bind the loopback socket. Resolves with the port actually bound (useful
     * with port 0 in tests), or undefined when binding failed — a busy port
     * must not break the channel.
     */
    listen() {
      return new Promise((resolve) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          warn(`notify bridge could not listen on ${NOTIFY_HOST}:${port}: ${String(error?.message ?? error)}`)
          resolve(undefined)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          server.unref?.()
          resolve(server.address()?.port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, NOTIFY_HOST)
      })
    },
    /** Stop accepting requests. Idempotent. */
    async stop() {
      if (closed) return
      closed = true
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
