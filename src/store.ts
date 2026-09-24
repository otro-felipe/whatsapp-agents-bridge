import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Encryption } from "./encryption.js";
import { AttachmentStore } from "./attachment-store.js";
import { attachmentList } from "./attachment-validation.js";
import { ensurePrivateDirectorySync } from "./private-files.js";
import {
  BridgeError,
  cursor,
  requireId,
  recognizedDisconnectStatus,
  MAX_ATTACHMENT_BYTES,
  type ConnectionDiagnosticUpdate,
  type MessagePage,
  type MessageQuery,
  type AccountSummary,
  type AccountState,
  type BridgeEvent,
  type BridgeMessage,
  type CredentialStore,
  type SendRecord,
  type SendRequest,
} from "./types.js";
type Row = Record<string, unknown>;
export class BridgeStore {
  readonly attachments!: AttachmentStore;
  private readonly db: DatabaseSync;
  private readonly crypto: Encryption;
  private closed = false;
  constructor(
    directory: string,
    key: Uint8Array,
    private readonly now: () => Date = () => new Date(),
    private readonly retentionDays = 7,
    private readonly historyRetentionDays: number | null = null,
    maxAttachmentBytes = MAX_ATTACHMENT_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxAttachmentBytes) ||
      maxAttachmentBytes < 1 ||
      maxAttachmentBytes > MAX_ATTACHMENT_BYTES
    )
      throw new BridgeError("invalid_attachment_limit");
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 365
    )
      throw new BridgeError("invalid_retention");
    if (
      historyRetentionDays !== null &&
      (!Number.isInteger(historyRetentionDays) ||
        historyRetentionDays < 1 ||
        historyRetentionDays > 36500)
    )
      throw new BridgeError("invalid_history_retention");
    ensurePrivateDirectorySync(directory);
    this.crypto = new Encryption(key);
    const path = join(directory, "bridge.sqlite");
    this.db = new DatabaseSync(path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    try {
      this.db
        .exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS secret_records(account_id TEXT NOT NULL,category TEXT NOT NULL,key_id TEXT NOT NULL,value BLOB NOT NULL,PRIMARY KEY(account_id,category,key_id));
      CREATE TABLE IF NOT EXISTS accounts(account_id TEXT PRIMARY KEY,state TEXT NOT NULL,diagnostic_code TEXT);
      CREATE TABLE IF NOT EXISTS identities(account_id TEXT NOT NULL,identity_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(account_id,identity_id));
      CREATE TABLE IF NOT EXISTS messages(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,author_id TEXT NOT NULL,text_cipher BLOB NOT NULL,timestamp TEXT NOT NULL,from_me INTEGER NOT NULL,origin TEXT NOT NULL,identity_verified INTEGER NOT NULL,forwarded INTEGER NOT NULL DEFAULT 0,quoted INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL,PRIMARY KEY(account_id,chat_id,message_id));
      CREATE TABLE IF NOT EXISTS events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,author_id TEXT NOT NULL,text_cipher BLOB NOT NULL,timestamp TEXT NOT NULL,from_me INTEGER NOT NULL,origin TEXT NOT NULL,identity_verified INTEGER NOT NULL,forwarded INTEGER NOT NULL DEFAULT 0,quoted INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends(send_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,text_cipher BLOB,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(account_id,idempotency_key),UNIQUE(account_id,chat_id,message_id));
      CREATE TABLE IF NOT EXISTS checkpoints(consumer_id TEXT PRIMARY KEY,event_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(account_id,chat_id,timestamp);
      CREATE INDEX IF NOT EXISTS events_received ON events(received_at);`);
      for (const table of ["messages", "events"]) {
        const columns = new Set(
          this.db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => String(row.name)),
        );
        for (const name of ["forwarded", "quoted"])
          if (!columns.has(name))
            this.db.exec(
              `ALTER TABLE ${table} ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`,
            );
      }
      if (
        !this.db
          .prepare("PRAGMA table_info(accounts)")
          .all()
          .some((row) => row.name === "diagnostic_code")
      )
        this.db.exec("ALTER TABLE accounts ADD COLUMN diagnostic_code TEXT");
      const accountColumns = new Set(
        this.db
          .prepare("PRAGMA table_info(accounts)")
          .all()
          .map((row) => String(row.name)),
      );
      for (const [name, type] of [
        ["connection_attempts", "INTEGER NOT NULL DEFAULT 0"],
        ["disconnects", "INTEGER NOT NULL DEFAULT 0"],
        ["last_attempt_at", "TEXT"],
        ["last_disconnect_at", "TEXT"],
        ["last_disconnect_status", "INTEGER"],
      ]) {
        if (!accountColumns.has(name!))
          this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
      }
      if (
        !this.db
          .prepare("PRAGMA table_info(sends)")
          .all()
          .some((row) => row.name === "attachment_id")
      )
        this.db.exec("ALTER TABLE sends ADD COLUMN attachment_id TEXT");
      this.attachments = new AttachmentStore(
        this.db,
        this.crypto,
        directory,
        key,
        this.now,
        maxAttachmentBytes,
      );
      const sentinel = this.credentials("_system").get<string>(
        "integrity",
        "master",
      );
      if (sentinel === undefined)
        this.credentials("_system").set(
          "integrity",
          "master",
          "whatsapp-agents-bridge/v1",
        );
      else if (sentinel !== "whatsapp-agents-bridge/v1")
        throw new BridgeError("master_key_invalid", 500);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO accounts(account_id,state) VALUES('default','disconnected')",
        )
        .run();
      this.db
        .prepare(
          "UPDATE sends SET status='delivery_unknown' WHERE status IN ('sending','reserved')",
        )
        .run();
      this.db
        .prepare(
          "UPDATE accounts SET state='disconnected' WHERE state NOT IN ('logged_out','disconnected')",
        )
        .run();
      this.prune();
    } catch (error) {
      this.attachments?.close();
      this.db.close();
      this.crypto.close();
      throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  credentials(accountId: string): CredentialStore {
    const get = <T>(category: string, key: string): T | undefined => {
      const row = this.db
        .prepare(
          "SELECT value FROM secret_records WHERE account_id=? AND category=? AND key_id=?",
        )
        .get(accountId, category, key);
      return row
        ? this.crypto.open<T>(
            row.value as Uint8Array,
            `credential:${accountId}:${category}:${key}`,
          )
        : undefined;
    };
    const write = (category: string, key: string, value: unknown | null) => {
      if (value === null)
        this.db
          .prepare(
            "DELETE FROM secret_records WHERE account_id=? AND category=? AND key_id=?",
          )
          .run(accountId, category, key);
      else
        this.db
          .prepare(
            "INSERT INTO secret_records VALUES(?,?,?,?) ON CONFLICT(account_id,category,key_id) DO UPDATE SET value=excluded.value",
          )
          .run(
            accountId,
            category,
            key,
            this.crypto.seal(
              value,
              `credential:${accountId}:${category}:${key}`,
            ),
          );
    };
    return {
      get,
      identityMappings: () =>
        this.db
          .prepare(
            "SELECT key_id,value FROM secret_records WHERE account_id=? AND category='canonical'",
          )
          .all(accountId)
          .map((row) => ({
            id: String(row.key_id),
            canonical: this.crypto.open<string>(
              row.value as Uint8Array,
              `credential:${accountId}:canonical:${String(row.key_id)}`,
            ),
          })),
      set: write,
      batch: (items) =>
        this.transaction(() => {
          for (const item of items) write(item.category, item.key, item.value);
        }),
      clear: () =>
        this.db
          .prepare("DELETE FROM secret_records WHERE account_id=?")
          .run(accountId),
    };
  }
  accounts(): AccountSummary[] {
    return (
      this.db
        .prepare("SELECT * FROM accounts ORDER BY account_id")
        .all() as Row[]
    ).map((row) => {
      const accountId = String(row.account_id);
      const ids = this.db
        .prepare(
          "SELECT identity_id FROM identities WHERE account_id=? ORDER BY ordinal",
        )
        .all(accountId)
        .map((r) => String(r.identity_id));
      return {
        accountId,
        state: row.state as AccountState,
        connectionDiagnostics: {
          attempts: Number(row.connection_attempts),
          disconnects: Number(row.disconnects),
          ...(typeof row.last_attempt_at === "string"
            ? { lastAttemptAt: row.last_attempt_at }
            : {}),
          ...(typeof row.last_disconnect_at === "string"
            ? { lastDisconnectAt: row.last_disconnect_at }
            : {}),
          ...(recognizedDisconnectStatus(row.last_disconnect_status) !==
          undefined
            ? {
                lastDisconnectStatus: recognizedDisconnectStatus(
                  row.last_disconnect_status,
                )!,
              }
            : {}),
        },
        history: {
          storedMessages: Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM messages WHERE account_id=?",
              )
              .get(accountId)?.count ?? 0,
          ),
          retentionDays: this.historyRetentionDays,
        },
        ...(ids.length ? { identityId: ids[0]!, identityIds: ids } : {}),
        ...(row.diagnostic_code === "identity_conflict"
          ? { diagnosticCode: "identity_conflict" as const }
          : {}),
      };
    });
  }
  account(id: string): AccountSummary {
    const account = this.accounts().find((a) => a.accountId === id);
    if (!account) throw new BridgeError("account_not_found", 404);
    return account;
  }
  setAccount(
    id: string,
    state: AccountState,
    identities?: string[],
    diagnosticCode?: "identity_conflict",
    diagnostics?: ConnectionDiagnosticUpdate,
  ) {
    this.account(id);
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE accounts SET state=?,diagnostic_code=? WHERE account_id=?",
        )
        .run(state, diagnosticCode ?? null, id);
      if (diagnostics?.attemptStarted === true)
        this.db
          .prepare(
            "UPDATE accounts SET connection_attempts=connection_attempts+1,last_attempt_at=? WHERE account_id=?",
          )
          .run(this.now().toISOString(), id);
      if (diagnostics?.disconnected === true)
        this.db
          .prepare(
            "UPDATE accounts SET disconnects=disconnects+1,last_disconnect_at=?,last_disconnect_status=? WHERE account_id=?",
          )
          .run(
            this.now().toISOString(),
            recognizedDisconnectStatus(diagnostics.disconnectStatus) ?? null,
            id,
          );
      if (identities) {
        this.db.prepare("DELETE FROM identities WHERE account_id=?").run(id);
        for (const [index, identity] of [...new Set(identities)].entries())
          this.db
            .prepare("INSERT INTO identities VALUES(?,?,?)")
            .run(id, identity, index);
      }
    });
  }
  message(
    accountId: string,
    chatId: string,
    messageId: string,
  ): BridgeMessage | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM messages WHERE account_id=? AND chat_id=? AND message_id=?",
      )
      .get(accountId, chatId, messageId);
    return row ? this.mapMessage(row) : undefined;
  }
  ingest(message: BridgeMessage): BridgeEvent | null {
    return this.transaction(() => {
      const attachments =
        message.origin === "delete" ? [] : attachmentList(message.attachments);
      const previous = this.message(
        message.accountId,
        message.chatId,
        message.messageId,
      );
      if (
        previous &&
        ((message.origin !== "edit" && message.origin !== "delete") ||
          previous.origin === "delete" ||
          (previous.text === message.text &&
            previous.origin === message.origin))
      ) {
        // A repeated archive item may enrich a text-only record imported by an
        // older bridge. Preserve provenance and do not emit a fresh event.
        if (
          previous.origin !== "delete" &&
          !previous.attachments?.length &&
          attachments.length
        )
          this.attachments.message(
            message.accountId,
            message.chatId,
            message.messageId,
            attachments,
          );
        return null;
      }
      const m: BridgeMessage = {
        accountId: message.accountId,
        chatId: message.chatId,
        messageId: message.messageId,
        authorId: message.authorId,
        text: message.origin === "delete" ? "" : message.text,
        timestamp: message.timestamp,
        fromMe: message.fromMe,
        origin: message.origin,
        identityVerified: message.identityVerified,
        ...(message.forwarded !== undefined
          ? { forwarded: message.forwarded === true }
          : {}),
        ...(message.quoted !== undefined
          ? { quoted: message.quoted === true }
          : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      const sealed = this.crypto.seal(m.text, this.messageAad(m)),
        at = this.now().toISOString();
      const values = [
        m.accountId,
        m.chatId,
        m.messageId,
        m.authorId,
        sealed,
        m.timestamp,
        Number(m.fromMe),
        m.origin,
        Number(m.identityVerified),
        Number(m.forwarded === true),
        Number(m.quoted === true),
        at,
      ] as const;
      this.db
        .prepare(
          `INSERT INTO messages(account_id,chat_id,message_id,author_id,text_cipher,timestamp,from_me,origin,identity_verified,forwarded,quoted,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,chat_id,message_id) DO UPDATE SET author_id=excluded.author_id,text_cipher=excluded.text_cipher,timestamp=excluded.timestamp,from_me=excluded.from_me,origin=excluded.origin,identity_verified=excluded.identity_verified,forwarded=excluded.forwarded,quoted=excluded.quoted,received_at=excluded.received_at`,
        )
        .run(...values);
      this.attachments.message(m.accountId, m.chatId, m.messageId, attachments);
      const result = this.db
        .prepare(
          "INSERT INTO events(account_id,chat_id,message_id,author_id,text_cipher,timestamp,from_me,origin,identity_verified,forwarded,quoted,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(...values);
      this.attachments.event(
        String(result.lastInsertRowid),
        m.accountId,
        m.chatId,
        attachments,
      );
      return {
        eventId: String(result.lastInsertRowid),
        type: "message",
        message: m,
      };
    });
  }
  chats(accountId: string) {
    this.account(accountId);
    return this.db
      .prepare(
        "SELECT chat_id,MAX(timestamp) AS last_message_at FROM messages WHERE account_id=? GROUP BY chat_id ORDER BY last_message_at DESC LIMIT 500",
      )
      .all(accountId)
      .map((row) => ({
        accountId,
        chatId: String(row.chat_id),
        lastMessageAt: String(row.last_message_at),
      }));
  }
  messages(accountId: string, chatId: string, after?: string, limit = 50) {
    return this.messagePage(accountId, chatId, {
      ...(after !== undefined ? { after } : {}),
      limit,
    }).messages;
  }
  messagePage(
    accountId: string,
    chatId: string,
    query: MessageQuery = {},
  ): MessagePage {
    this.account(accountId);
    if (query.before !== undefined && query.after !== undefined)
      throw new BridgeError("conflicting_message_cursors");
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BridgeError("invalid_limit");
    const anchorId = query.before ?? query.after;
    let anchor: BridgeMessage | undefined;
    if (anchorId !== undefined) {
      requireId(anchorId);
      anchor = this.message(accountId, chatId, anchorId);
      if (!anchor) throw new BridgeError("message_cursor_not_found", 404);
    }
    let rows: Row[];
    if (!anchor) {
      rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE account_id=? AND chat_id=? ORDER BY timestamp DESC,message_id DESC LIMIT ?",
        )
        .all(accountId, chatId, limit);
      rows.reverse();
    } else if (query.before !== undefined) {
      rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE account_id=? AND chat_id=? AND (timestamp<? OR (timestamp=? AND message_id<?)) ORDER BY timestamp DESC,message_id DESC LIMIT ?",
        )
        .all(
          accountId,
          chatId,
          anchor.timestamp,
          anchor.timestamp,
          anchor.messageId,
          limit,
        );
      rows.reverse();
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM messages WHERE account_id=? AND chat_id=? AND (timestamp>? OR (timestamp=? AND message_id>?)) ORDER BY timestamp,message_id LIMIT ?",
        )
        .all(
          accountId,
          chatId,
          anchor.timestamp,
          anchor.timestamp,
          anchor.messageId,
          limit,
        );
    }
    const messages = rows.map((row) => this.mapMessage(row));
    const first = messages[0];
    const hasEarlier =
      first &&
      this.db
        .prepare(
          "SELECT 1 FROM messages WHERE account_id=? AND chat_id=? AND (timestamp<? OR (timestamp=? AND message_id<?)) LIMIT 1",
        )
        .get(
          accountId,
          chatId,
          first.timestamp,
          first.timestamp,
          first.messageId,
        );
    return {
      messages,
      ...(hasEarlier ? { nextBefore: first!.messageId } : {}),
    };
  }
  head(): string {
    return String(
      this.db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='events'")
        .get()?.seq ?? 0,
    );
  }
  floor(): number {
    return Number(
      this.db
        .prepare("SELECT value FROM metadata WHERE key='event_floor'")
        .get()?.value ?? 0,
    );
  }
  assertCursor(after: string) {
    const value = Number(cursor(after));
    if (value < this.floor()) throw new BridgeError("cursor_expired", 410);
    if (value > Number(this.head())) throw new BridgeError("cursor_ahead", 409);
  }
  eventsAfter(after: string, limit = 500): BridgeEvent[] {
    this.assertCursor(after);
    return this.db
      .prepare(
        "SELECT * FROM events WHERE event_id>? ORDER BY event_id LIMIT ?",
      )
      .all(Number(after), limit)
      .map((row) => ({
        eventId: String(row.event_id),
        type: "message",
        message: this.mapMessage(row),
      }));
  }
  checkpoint(consumer: string) {
    return String(
      this.db
        .prepare("SELECT event_id FROM checkpoints WHERE consumer_id=?")
        .get(consumer)?.event_id ?? 0,
    );
  }
  saveCheckpoint(consumer: string, after: string) {
    this.assertCursor(after);
    if (Number(after) < Number(this.checkpoint(consumer)))
      throw new BridgeError("checkpoint_rollback", 409);
    this.db
      .prepare(
        "INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(consumer_id) DO UPDATE SET event_id=excluded.event_id",
      )
      .run(consumer, Number(after));
    return after;
  }
  existingSend(request: SendRequest): SendRecord | undefined {
    const requestHash = this.requestHash(request);
    const old = this.db
      .prepare("SELECT * FROM sends WHERE account_id=? AND idempotency_key=?")
      .get(request.accountId, request.idempotencyKey);
    if (old) {
      if (old.request_hash !== requestHash)
        throw new BridgeError("idempotency_conflict", 409);
      return this.mapSend(old);
    }
    return undefined;
  }
  reserve(request: SendRequest): { send: SendRecord; created: boolean } {
    const old = this.existingSend(request);
    if (old) return { send: old, created: false };
    const requestHash = this.requestHash(request);
    const id = randomUUID(),
      messageId = "3EB0" + randomBytes(14).toString("hex").toUpperCase(),
      createdAt = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO sends(send_id,account_id,chat_id,message_id,idempotency_key,request_hash,text_cipher,status,created_at,attachment_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        request.accountId,
        request.chatId,
        messageId,
        request.idempotencyKey,
        requestHash,
        this.crypto.seal(request.text, `send:${id}`),
        "reserved",
        createdAt,
        request.attachmentId ?? null,
      );
    return { send: this.send(id), created: true };
  }
  private requestHash(request: SendRequest) {
    const values: unknown[] = [
      request.chatId,
      request.text,
      request.quoteMessageId ?? null,
    ];
    // Keep the existing text-only hash format valid across upgrades.
    if (request.attachmentId !== undefined)
      values.push(
        request.attachmentId,
        this.attachments.fingerprint(
          request.accountId,
          request.chatId,
          request.attachmentId,
        ),
      );
    return createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }
  send(id: string): SendRecord {
    const row = this.db.prepare("SELECT * FROM sends WHERE send_id=?").get(id);
    if (!row) throw new BridgeError("send_not_found", 404);
    return this.mapSend(row);
  }
  setSend(id: string, status: SendRecord["status"]) {
    this.db
      .prepare("UPDATE sends SET status=? WHERE send_id=? AND status<>'sent'")
      .run(status, id);
  }
  bridgeSend(accountId: string, chatId: string, messageId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sends WHERE account_id=? AND chat_id=? AND message_id=?",
        )
        .get(accountId, chatId, messageId),
    );
  }
  reconcile(accountId: string, messageId: string) {
    this.db
      .prepare(
        "UPDATE sends SET status='sent' WHERE account_id=? AND message_id=?",
      )
      .run(accountId, messageId);
  }
  prune() {
    const cutoff = new Date(
      this.now().getTime() - this.retentionDays * 86_400_000,
    ).toISOString();
    this.transaction(() => {
      const last = Number(
        this.db
          .prepare("SELECT MAX(event_id) AS id FROM events WHERE received_at<?")
          .get(cutoff)?.id ?? 0,
      );
      if (last > this.floor())
        this.db
          .prepare(
            "INSERT INTO metadata VALUES('event_floor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(last));
      this.db.prepare("DELETE FROM events WHERE event_id<=?").run(this.floor());
      if (this.historyRetentionDays !== null) {
        const historyCutoff = new Date(
          this.now().getTime() - this.historyRetentionDays * 86_400_000,
        ).toISOString();
        this.db
          .prepare("DELETE FROM messages WHERE received_at<?")
          .run(historyCutoff);
      }
      this.db
        .prepare("UPDATE sends SET text_cipher=NULL WHERE created_at<?")
        .run(cutoff);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.attachments.close();
    this.crypto.close();
  }
  private messageAad(
    m: Pick<BridgeMessage, "accountId" | "chatId" | "messageId">,
  ) {
    return `message:${m.accountId}:${m.chatId}:${m.messageId}`;
  }
  private mapMessage(row: Row): BridgeMessage {
    const base = {
      accountId: String(row.account_id),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
    };
    const attachments =
      row.event_id !== undefined
        ? this.attachments.eventList(String(row.event_id))
        : this.attachments.list(base.accountId, base.chatId, base.messageId);
    return {
      ...base,
      authorId: String(row.author_id),
      text: this.crypto.open<string>(
        row.text_cipher as Uint8Array,
        this.messageAad(base),
      ),
      timestamp: String(row.timestamp),
      fromMe: Boolean(row.from_me),
      origin: row.origin as BridgeMessage["origin"],
      identityVerified: Boolean(row.identity_verified),
      forwarded: Boolean(row.forwarded),
      quoted: Boolean(row.quoted),
      ...(attachments.length ? { attachments } : {}),
    };
  }
  private mapSend(row: Row): SendRecord {
    return {
      sendId: String(row.send_id),
      accountId: String(row.account_id),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      idempotencyKey: String(row.idempotency_key),
      status: row.status as SendRecord["status"],
      createdAt: String(row.created_at),
    };
  }
}
