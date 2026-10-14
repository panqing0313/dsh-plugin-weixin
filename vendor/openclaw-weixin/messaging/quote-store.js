import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_MESSAGES_PER_ACCOUNT = 10_000;
const DEFAULT_MEDIA_RETENTION_DAYS = 7;
const DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT = 256 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_MEDIA_BYTES = 25 * 1024 * 1024;
const GC_WRITE_INTERVAL = 100;
const GC_TIMER_MS = 60 * 60 * 1000;
const QUOTE_MEDIA_SUBDIR = "inbound/openclaw-weixin-quotes";
function positiveNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function positiveInteger(value, fallback) {
    return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}
export function resolveQuoteCachePolicy(cfg) {
    const section = cfg.channels?.["openclaw-weixin"];
    const quote = section?.quoteCache;
    return {
        enabled: quote?.enabled !== false,
        retentionMs: positiveNumber(quote?.retentionDays, DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
        maxMessagesPerAccount: positiveInteger(quote?.maxMessagesPerAccount, DEFAULT_MAX_MESSAGES_PER_ACCOUNT),
        mediaRetentionMs: positiveNumber(quote?.mediaRetentionDays, DEFAULT_MEDIA_RETENTION_DAYS) * 24 * 60 * 60 * 1000,
        maxMediaBytesPerAccount: positiveInteger(quote?.maxMediaBytesPerAccount, DEFAULT_MAX_MEDIA_BYTES_PER_ACCOUNT),
        maxSingleMediaBytes: positiveInteger(quote?.maxSingleMediaBytes, DEFAULT_MAX_SINGLE_MEDIA_BYTES),
    };
}
function safePathSegment(raw) {
    const safe = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "_")
        .replace(/\.\.+/g, "_");
    return safe && safe !== "." && safe !== ".." ? safe : "default";
}
function accountMediaDirName(accountId) {
    const readable = safePathSegment(accountId).slice(0, 48);
    const digest = crypto.createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 16);
    return `${readable}-${digest}`;
}
/** OpenClaw media-store subdirectory owned and garbage-collected by this plugin. */
export function resolveQuoteMediaSubdir(accountId) {
    return path.posix.join(QUOTE_MEDIA_SUBDIR, accountMediaDirName(accountId));
}
function resolveQuoteMediaRoot() {
    return path.join(resolveStateDir(), "media", ...QUOTE_MEDIA_SUBDIR.split("/"));
}
function asStoredRow(value) {
    if (!value || typeof value !== "object")
        return null;
    return value;
}
export class QuoteStore {
    db;
    rootDir;
    mediaRoot;
    policy;
    writesSinceGc = 0;
    gcRunning = false;
    gcRequested = false;
    gcScheduled = false;
    closed = false;
    gcTimer;
    constructor(db, rootDir, mediaRoot, policy) {
        this.db = db;
        this.rootDir = rootDir;
        this.mediaRoot = mediaRoot;
        this.policy = policy;
        this.initializeSchema();
        this.migrateLegacyMedia();
        this.gcTimer = setInterval(() => this.requestGc(), GC_TIMER_MS);
        this.gcTimer.unref();
        this.runGc();
    }
    static async open(params) {
        if (!params.policy.enabled)
            return null;
        try {
            const sqlite = (await import("node:sqlite"));
            const rootDir = params.rootDir ?? path.join(resolveStateDir(), "openclaw-weixin");
            const mediaRoot = params.mediaRoot ?? resolveQuoteMediaRoot();
            fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
            fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
            try {
                fs.chmodSync(rootDir, 0o700);
            }
            catch {
                // best-effort on filesystems without POSIX permissions
            }
            const dbPath = path.join(rootDir, "ref-messages.sqlite");
            const db = new sqlite.DatabaseSync(dbPath);
            try {
                fs.chmodSync(dbPath, 0o600);
            }
            catch {
                // best-effort
            }
            return new QuoteStore(db, rootDir, mediaRoot, params.policy);
        }
        catch (err) {
            logger.warn(`quote cache disabled: node:sqlite is unavailable or the database could not be opened: ${String(err)}`);
            return null;
        }
    }
    updatePolicy(policy) {
        this.policy = policy;
        this.requestGc();
    }
    initializeSchema() {
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS quote_messages (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        media_path TEXT,
        media_mime TEXT,
        media_name TEXT,
        media_size INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS quote_messages_account_created
        ON quote_messages (account_id, created_at);
      CREATE INDEX IF NOT EXISTS quote_messages_media_path
        ON quote_messages (media_path);
    `);
    }
    /** Move media written by pre-managed-root builds without duplicating file contents. */
    migrateLegacyMedia() {
        const legacyRoots = [
            path.join(this.rootDir, "ref-media"),
            // A short-lived local build accidentally omitted the media/ segment.
            path.join(path.dirname(this.rootDir), ...QUOTE_MEDIA_SUBDIR.split("/")),
        ];
        for (const legacyRoot of new Set(legacyRoots)) {
            this.migrateLegacyMediaRoot(legacyRoot);
        }
    }
    migrateLegacyMediaRoot(legacyRoot) {
        if (path.resolve(legacyRoot) === path.resolve(this.mediaRoot) || !fs.existsSync(legacyRoot)) {
            return;
        }
        const rows = this.db
            .prepare(`
        SELECT account_id, media_path
        FROM quote_messages
        WHERE media_path IS NOT NULL
      `)
            .all();
        const canonicalLegacyRoot = fs.realpathSync(legacyRoot);
        const migrated = new Map();
        for (const row of rows) {
            if (migrated.has(row.media_path))
                continue;
            if (!fs.existsSync(row.media_path))
                continue;
            const canonicalLegacyPath = fs.realpathSync(row.media_path);
            const relative = path.relative(canonicalLegacyRoot, canonicalLegacyPath);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
                continue;
            const destinationDir = path.join(this.mediaRoot, accountMediaDirName(row.account_id));
            const destination = path.join(destinationDir, path.basename(row.media_path));
            try {
                fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
                if (!fs.existsSync(destination)) {
                    try {
                        fs.renameSync(row.media_path, destination);
                    }
                    catch (err) {
                        if (err.code !== "EXDEV")
                            throw err;
                        fs.copyFileSync(row.media_path, destination, fs.constants.COPYFILE_EXCL);
                        fs.unlinkSync(row.media_path);
                    }
                }
                else {
                    fs.unlinkSync(row.media_path);
                }
                migrated.set(row.media_path, destination);
            }
            catch (err) {
                logger.warn(`quote cache: failed to migrate media path=${row.media_path}: ${String(err)}`);
            }
        }
        for (const [legacyPath, managedPath] of migrated) {
            this.db
                .prepare("UPDATE quote_messages SET media_path = ? WHERE media_path = ?")
                .run(managedPath, legacyPath);
        }
    }
    find(accountId, conversationId, messageId) {
        if (this.closed || !messageId)
            return null;
        const row = asStoredRow(this.db
            .prepare(`
          SELECT account_id, conversation_id, message_id, direction, body,
                 media_path, media_mime, media_name, media_size, created_at
          FROM quote_messages
          WHERE account_id = ? AND conversation_id = ? AND message_id = ?
        `)
            .get(accountId, conversationId, messageId));
        if (!row)
            return null;
        if (Date.now() - row.created_at > this.policy.retentionMs) {
            this.deleteMessage(accountId, conversationId, messageId);
            return null;
        }
        return {
            accountId: row.account_id,
            conversationId: row.conversation_id,
            messageId: row.message_id,
            direction: row.direction,
            body: row.body,
            ...(row.media_path ? { mediaPath: row.media_path } : {}),
            ...(row.media_mime ? { mediaMime: row.media_mime } : {}),
            ...(row.media_name ? { mediaName: row.media_name } : {}),
            ...(typeof row.media_size === "number" ? { mediaSize: row.media_size } : {}),
            createdAt: row.created_at,
        };
    }
    async put(input) {
        if (this.closed || !input.messageId || (!input.body && !input.sourceMediaPath))
            return;
        const media = input.sourceMediaPath
            ? await this.registerManagedMedia(input.accountId, input.sourceMediaPath, input.mediaMime)
            : null;
        this.db
            .prepare(`
        INSERT INTO quote_messages (
          account_id, conversation_id, message_id, direction, body,
          media_path, media_mime, media_name, media_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, message_id) DO UPDATE SET
          direction = excluded.direction,
          body = excluded.body,
          media_path = COALESCE(excluded.media_path, quote_messages.media_path),
          media_mime = COALESCE(excluded.media_mime, quote_messages.media_mime),
          media_name = COALESCE(excluded.media_name, quote_messages.media_name),
          media_size = COALESCE(excluded.media_size, quote_messages.media_size),
          created_at = excluded.created_at
      `)
            .run(input.accountId, input.conversationId, input.messageId, input.direction, input.body, media?.path ?? null, input.mediaMime ?? media?.mime ?? null, input.mediaName ?? media?.name ?? null, media?.size ?? null, Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : Date.now());
        this.writesSinceGc += 1;
        if (media) {
            this.enforceMediaBudget(input.accountId);
        }
        if (this.writesSinceGc >= GC_WRITE_INTERVAL) {
            this.writesSinceGc = 0;
            this.requestGc();
        }
    }
    deleteAccount(accountId) {
        if (this.closed)
            return;
        this.db.prepare("DELETE FROM quote_messages WHERE account_id = ?").run(accountId);
        const accountMediaDir = path.join(this.mediaRoot, accountMediaDirName(accountId));
        try {
            fs.rmSync(accountMediaDir, { recursive: true, force: true });
        }
        catch (err) {
            logger.warn(`quote cache: failed to remove media for account=${accountId}: ${String(err)}`);
        }
    }
    deleteMessage(accountId, conversationId, messageId) {
        const existing = this.findMediaPath(accountId, conversationId, messageId);
        this.db
            .prepare("DELETE FROM quote_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?")
            .run(accountId, conversationId, messageId);
        if (existing)
            this.removeMediaIfOrphaned(existing);
    }
    findMediaPath(accountId, conversationId, messageId) {
        const row = this.db
            .prepare("SELECT media_path FROM quote_messages WHERE account_id = ? AND conversation_id = ? AND message_id = ?")
            .get(accountId, conversationId, messageId);
        return typeof row?.media_path === "string" ? row.media_path : null;
    }
    async registerManagedMedia(accountId, sourcePath, mime) {
        try {
            const accountDir = path.join(this.mediaRoot, accountMediaDirName(accountId));
            const canonicalRoot = await fs.promises
                .realpath(accountDir)
                .catch(() => path.resolve(accountDir));
            const canonicalSource = await fs.promises.realpath(sourcePath);
            const relative = path.relative(canonicalRoot, canonicalSource);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
                logger.warn(`quote cache: refusing unmanaged media path=${sourcePath}`);
                return null;
            }
            const stat = await fs.promises.stat(canonicalSource);
            if (!stat.isFile() || stat.size > this.policy.maxSingleMediaBytes)
                return null;
            return {
                path: path.resolve(sourcePath),
                ...(mime ? { mime } : {}),
                name: path.basename(canonicalSource),
                size: stat.size,
            };
        }
        catch (err) {
            logger.warn(`quote cache: failed to register media path=${sourcePath}: ${String(err)}`);
            return null;
        }
    }
    requestGc() {
        if (this.closed)
            return;
        if (this.gcRunning) {
            this.gcRequested = true;
            return;
        }
        if (this.gcScheduled)
            return;
        this.gcScheduled = true;
        queueMicrotask(() => {
            this.gcScheduled = false;
            this.runGc();
        });
    }
    runGc(now = Date.now()) {
        if (this.closed || this.gcRunning) {
            this.gcRequested = true;
            return;
        }
        this.gcRunning = true;
        try {
            const messageCutoff = now - this.policy.retentionMs;
            this.db.prepare("DELETE FROM quote_messages WHERE created_at < ?").run(messageCutoff);
            const accounts = this.db
                .prepare("SELECT DISTINCT account_id FROM quote_messages")
                .all();
            for (const { account_id: accountId } of accounts) {
                this.db
                    .prepare(`
            DELETE FROM quote_messages
            WHERE rowid IN (
              SELECT rowid FROM quote_messages
              WHERE account_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT -1 OFFSET ?
            )
          `)
                    .run(accountId, this.policy.maxMessagesPerAccount);
                this.expireOldMedia(accountId, now - this.policy.mediaRetentionMs);
                this.enforceMediaBudget(accountId);
            }
            this.pruneOrphanMediaFiles();
        }
        catch (err) {
            logger.warn(`quote cache GC failed: ${String(err)}`);
        }
        finally {
            this.gcRunning = false;
            if (this.gcRequested) {
                this.gcRequested = false;
                this.requestGc();
            }
        }
    }
    listMedia(accountId) {
        return this.db
            .prepare(`
        SELECT media_path, MAX(COALESCE(media_size, 0)) AS media_size,
               MAX(created_at) AS newest_at
        FROM quote_messages
        WHERE account_id = ? AND media_path IS NOT NULL
        GROUP BY media_path
        ORDER BY newest_at ASC
      `)
            .all(accountId);
    }
    expireOldMedia(accountId, cutoff) {
        for (const media of this.listMedia(accountId)) {
            if (media.newest_at >= cutoff)
                continue;
            this.detachMedia(media.media_path);
        }
    }
    enforceMediaBudget(accountId) {
        const rows = this.listMedia(accountId);
        let total = rows.reduce((sum, row) => sum + Math.max(0, row.media_size), 0);
        for (const row of rows) {
            if (total <= this.policy.maxMediaBytesPerAccount)
                break;
            this.detachMedia(row.media_path);
            total -= Math.max(0, row.media_size);
        }
    }
    detachMedia(mediaPath) {
        this.db
            .prepare("UPDATE quote_messages SET media_path = NULL WHERE media_path = ?")
            .run(mediaPath);
        this.removeMediaIfOrphaned(mediaPath);
    }
    removeMediaIfOrphaned(mediaPath) {
        const row = this.db
            .prepare("SELECT 1 AS found FROM quote_messages WHERE media_path = ? LIMIT 1")
            .get(mediaPath);
        if (row?.found)
            return;
        try {
            fs.unlinkSync(mediaPath);
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                logger.warn(`quote cache: failed to remove media path=${mediaPath}: ${String(err)}`);
            }
        }
    }
    pruneOrphanMediaFiles() {
        if (!fs.existsSync(this.mediaRoot))
            return;
        const known = new Set(this.db
            .prepare("SELECT DISTINCT media_path FROM quote_messages WHERE media_path IS NOT NULL")
            .all().map((row) => row.media_path));
        const visit = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory())
                    visit(fullPath);
                else if (entry.isFile() && !known.has(fullPath)) {
                    try {
                        fs.unlinkSync(fullPath);
                    }
                    catch {
                        // retry during the next GC pass
                    }
                }
            }
        };
        visit(this.mediaRoot);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearInterval(this.gcTimer);
        this.db.close();
    }
}
let activeStore = null;
let initialization = null;
const activeAccounts = new Set();
export async function initializeQuoteStore(cfg, accountId) {
    if (accountId)
        activeAccounts.add(accountId);
    const policy = resolveQuoteCachePolicy(cfg);
    if (!policy.enabled) {
        activeStore?.close();
        activeStore = null;
        initialization = null;
        return null;
    }
    if (activeStore) {
        activeStore.updatePolicy(policy);
        return activeStore;
    }
    if (!initialization) {
        initialization = QuoteStore.open({ policy }).then((store) => {
            activeStore = store;
            return store;
        });
    }
    return initialization;
}
export function getQuoteStore() {
    return activeStore;
}
export function getActiveQuoteMediaSubdir(accountId) {
    return activeStore ? resolveQuoteMediaSubdir(accountId) : undefined;
}
export function closeQuoteStore() {
    activeStore?.close();
    activeStore = null;
    initialization = null;
    activeAccounts.clear();
}
export function deleteQuoteCacheForAccount(accountId) {
    if (activeStore) {
        activeStore.deleteAccount(accountId);
        return;
    }
    const rootDir = path.join(resolveStateDir(), "openclaw-weixin");
    const mediaRoot = resolveQuoteMediaRoot();
    const dbPath = path.join(rootDir, "ref-messages.sqlite");
    if (!fs.existsSync(dbPath))
        return;
    try {
        const require = createRequire(import.meta.url);
        const sqlite = require("node:sqlite");
        const db = new sqlite.DatabaseSync(dbPath);
        db.prepare("DELETE FROM quote_messages WHERE account_id = ?").run(accountId);
        db.close();
        fs.rmSync(path.join(mediaRoot, accountMediaDirName(accountId)), {
            recursive: true,
            force: true,
        });
        fs.rmSync(path.join(rootDir, "ref-media", accountMediaDirName(accountId)), {
            recursive: true,
            force: true,
        });
    }
    catch (err) {
        logger.warn(`quote cache: failed to delete account=${accountId}: ${String(err)}`);
    }
}
export function deactivateQuoteStoreAccount(accountId) {
    activeAccounts.delete(accountId);
    if (activeAccounts.size === 0)
        closeQuoteStore();
}