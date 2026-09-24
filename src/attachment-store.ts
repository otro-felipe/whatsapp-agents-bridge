import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Encryption } from "./encryption.js";
import { AttachmentFiles } from "./attachment-files.js";
import {
  attachmentMetadata,
  validateAttachmentBytes,
} from "./attachment-validation.js";
import { BridgeError, type Attachment } from "./types.js";
type Row = Record<string, unknown>;

/** Relational public metadata and encrypted filenames, separate from binary cache. */
export class AttachmentStore {
  private readonly files: AttachmentFiles;
  constructor(
    private readonly db: DatabaseSync,
    private readonly crypto: Encryption,
    directory: string,
    key: Uint8Array,
    private readonly now: () => Date,
    readonly maxBytes: number,
  ) {
    this.files = new AttachmentFiles(directory, key, maxBytes);
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,attachment_id TEXT NOT NULL,kind TEXT NOT NULL,mime_type TEXT NOT NULL,file_name_cipher BLOB,size_bytes INTEGER,content_hash TEXT,cached_at TEXT,created_at TEXT NOT NULL,PRIMARY KEY(account_id,chat_id,attachment_id));
      CREATE UNIQUE INDEX IF NOT EXISTS attachments_account_identity ON attachments(account_id,attachment_id);
      CREATE INDEX IF NOT EXISTS attachments_recent ON attachments(account_id,chat_id,created_at,attachment_id);
      CREATE TABLE IF NOT EXISTS message_attachments(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,attachment_id TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(account_id,chat_id,message_id,attachment_id),FOREIGN KEY(account_id,chat_id,message_id) REFERENCES messages(account_id,chat_id,message_id) ON DELETE CASCADE,FOREIGN KEY(account_id,chat_id,attachment_id) REFERENCES attachments(account_id,chat_id,attachment_id));
      CREATE TABLE IF NOT EXISTS event_attachments(event_id INTEGER NOT NULL,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,attachment_id TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,mime_type TEXT NOT NULL,file_name_cipher BLOB,size_bytes INTEGER,PRIMARY KEY(event_id,attachment_id),FOREIGN KEY(event_id) REFERENCES events(event_id) ON DELETE CASCADE);`);
  }
  private scope(accountId: string, chatId: string, id: string) {
    return `attachment:${accountId}:${chatId}:${id}`;
  }
  private row(accountId: string, chatId: string, id: string) {
    return this.db
      .prepare(
        "SELECT * FROM attachments WHERE account_id=? AND chat_id=? AND attachment_id=?",
      )
      .get(accountId, chatId, id);
  }
  private map(row: Row): Attachment {
    return {
      attachmentId: String(row.attachment_id),
      kind: row.kind as Attachment["kind"],
      mimeType: String(row.mime_type),
      ...(row.file_name_cipher instanceof Uint8Array
        ? {
            fileName: this.crypto.open<string>(
              row.file_name_cipher,
              this.scope(
                String(row.account_id),
                String(row.chat_id),
                String(row.attachment_id),
              ),
            ),
          }
        : {}),
      ...(typeof row.size_bytes === "number"
        ? { sizeBytes: row.size_bytes }
        : {}),
    };
  }
  get(accountId: string, chatId: string, id: string): Attachment {
    const row = this.row(accountId, chatId, id);
    if (!row) throw new BridgeError("attachment_not_found", 404);
    return this.map(row);
  }
  register(accountId: string, chatId: string, value: Attachment): Attachment {
    const metadata = attachmentMetadata(value),
      old = this.row(accountId, chatId, metadata.attachmentId);
    const owner = this.db
      .prepare(
        "SELECT chat_id FROM attachments WHERE account_id=? AND attachment_id=?",
      )
      .get(accountId, metadata.attachmentId);
    if (owner && owner.chat_id !== chatId)
      throw new BridgeError("attachment_scope_conflict", 409);
    if (old) {
      const previous = this.map(old);
      if (
        previous.kind !== metadata.kind ||
        previous.mimeType !== metadata.mimeType ||
        previous.fileName !== metadata.fileName ||
        (previous.sizeBytes !== undefined &&
          metadata.sizeBytes !== undefined &&
          previous.sizeBytes !== metadata.sizeBytes)
      )
        throw new BridgeError("attachment_metadata_conflict", 409);
      return previous;
    }
    this.db
      .prepare(
        "INSERT INTO attachments(account_id,chat_id,attachment_id,kind,mime_type,file_name_cipher,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        accountId,
        chatId,
        metadata.attachmentId,
        metadata.kind,
        metadata.mimeType,
        metadata.fileName === undefined
          ? null
          : this.crypto.seal(
              metadata.fileName,
              this.scope(accountId, chatId, metadata.attachmentId),
            ),
        metadata.sizeBytes ?? null,
        this.now().toISOString(),
      );
    return metadata;
  }
  list(accountId: string, chatId: string, messageId?: string): Attachment[] {
    const rows =
      messageId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM attachments WHERE account_id=? AND chat_id=? ORDER BY created_at DESC,attachment_id DESC LIMIT 50",
            )
            .all(accountId, chatId)
        : this.db
            .prepare(
              "SELECT a.* FROM attachments a JOIN message_attachments m USING(account_id,chat_id,attachment_id) WHERE m.account_id=? AND m.chat_id=? AND m.message_id=? ORDER BY m.ordinal",
            )
            .all(accountId, chatId, messageId);
    if (messageId === undefined) rows.reverse();
    return rows.map((row) => this.map(row));
  }
  message(
    accountId: string,
    chatId: string,
    messageId: string,
    attachments: Attachment[],
  ) {
    this.db
      .prepare(
        "DELETE FROM message_attachments WHERE account_id=? AND chat_id=? AND message_id=?",
      )
      .run(accountId, chatId, messageId);
    for (const [ordinal, metadata] of attachments.entries()) {
      this.register(accountId, chatId, metadata);
      this.db
        .prepare("INSERT INTO message_attachments VALUES(?,?,?,?,?)")
        .run(accountId, chatId, messageId, metadata.attachmentId, ordinal);
    }
  }
  event(
    eventId: string,
    accountId: string,
    chatId: string,
    attachments: Attachment[],
  ) {
    for (const [ordinal, metadata] of attachments.entries()) {
      const row = this.row(accountId, chatId, metadata.attachmentId)!;
      this.db
        .prepare("INSERT INTO event_attachments VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          Number(eventId),
          accountId,
          chatId,
          metadata.attachmentId,
          ordinal,
          metadata.kind,
          metadata.mimeType,
          row.file_name_cipher as Uint8Array | null,
          metadata.sizeBytes ?? null,
        );
    }
  }
  eventList(eventId: string): Attachment[] {
    return this.db
      .prepare(
        "SELECT * FROM event_attachments WHERE event_id=? ORDER BY ordinal",
      )
      .all(Number(eventId))
      .map((row) => this.map(row));
  }
  cached(
    accountId: string,
    chatId: string,
    id: string,
  ): Uint8Array | undefined {
    const metadata = this.get(accountId, chatId, id);
    if (metadata.sizeBytes !== undefined && metadata.sizeBytes > this.maxBytes)
      throw new BridgeError("attachment_too_large", 413);
    return this.files.read(this.scope(accountId, chatId, id));
  }
  cache(
    accountId: string,
    chatId: string,
    id: string,
    bytes: Uint8Array,
  ): Attachment {
    const metadata = this.get(accountId, chatId, id);
    validateAttachmentBytes(bytes, this.maxBytes);
    if (
      metadata.sizeBytes !== undefined &&
      metadata.sizeBytes !== bytes.byteLength
    )
      throw new BridgeError("attachment_size_mismatch", 502);
    const hash = createHash("sha256").update(bytes).digest("hex"),
      oldHash = this.row(accountId, chatId, id)?.content_hash;
    if (typeof oldHash === "string" && hash !== oldHash)
      throw new BridgeError("attachment_content_conflict", 409);
    this.files.write(this.scope(accountId, chatId, id), bytes);
    this.db
      .prepare(
        "UPDATE attachments SET size_bytes=?,content_hash=?,cached_at=? WHERE account_id=? AND chat_id=? AND attachment_id=?",
      )
      .run(
        bytes.byteLength,
        hash,
        this.now().toISOString(),
        accountId,
        chatId,
        id,
      );
    return this.get(accountId, chatId, id);
  }
  fingerprint(accountId: string, chatId: string, id: string) {
    this.get(accountId, chatId, id);
    return this.row(accountId, chatId, id)?.content_hash ?? null;
  }
  close() {
    this.files.close();
  }
}
