import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { BridgeStore } from "./store.js";
import { attachmentList, uploadMetadata } from "./attachment-validation.js";
import {
  BridgeError,
  individualJid,
  groupJid,
  chatJid,
  opaqueId,
  requireId,
  requireChat,
  requirePhoneNumber,
  type BridgeEvent,
  type BridgeMessage,
  type ProviderFactory,
  type ProviderPort,
  type SendRequest,
  type SendRecord,
  type Attachment,
  type AttachmentUpload,
} from "./types.js";
interface CodeAttempt {
  controller: AbortController;
  expiresAt?: number;
  timer?: NodeJS.Timeout;
}
export class BridgeService {
  private readonly providers = new Map<string, ProviderPort>();
  private readonly generations = new Map<string, symbol>();
  private readonly links = new Map<string, { qr: string; expiresAt: number }>();
  private readonly codeAttempts = new Map<string, CodeAttempt>();
  private readonly closingAccounts = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly bus = new EventEmitter();
  private readonly attachmentDownloads = new Map<string, Promise<Uint8Array>>();
  private stopped = false;
  constructor(
    readonly store: BridgeStore,
    private readonly factory: ProviderFactory,
    private readonly now: () => Date = () => new Date(),
    private readonly pairingRequestTimeoutMs = 12_000,
  ) {
    if (
      !Number.isInteger(pairingRequestTimeoutMs) ||
      pairingRequestTimeoutMs < 1 ||
      pairingRequestTimeoutMs > 30_000
    )
      throw new BridgeError("invalid_pairing_timeout");
  }
  subscribe(listener: (event: BridgeEvent) => void) {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }
  async restore() {
    for (const account of this.store.accounts())
      if (account.identityIds?.length && account.state !== "logged_out")
        await this.provider(account.accountId).connect({ allowPairing: false });
  }
  async link(accountId: string) {
    this.store.account(accountId);
    await this.expireCodeAttempt(accountId);
    if (this.codeAttempts.has(accountId) || this.closingAccounts.has(accountId))
      throw new BridgeError("pairing_in_progress", 409);
    if (this.store.account(accountId).state === "connected") return;
    await this.provider(accountId).connect({ allowPairing: true });
  }
  async requestPairingCode(accountId: string, input: unknown) {
    const phoneNumber = requirePhoneNumber(input);
    if (this.stopped) throw new BridgeError("bridge_stopping", 503);
    this.store.account(accountId);
    await this.expireCodeAttempt(accountId);
    const account = this.store.account(accountId);
    if (account.state === "connected" || account.identityIds?.length)
      throw new BridgeError("already_linked", 409);
    if (this.codeAttempts.has(accountId) || this.closingAccounts.has(accountId))
      throw new BridgeError("pairing_in_progress", 409);
    const metadata = this.store.credentials("_system");
    const previous = metadata.get<number>("pairing-cooldown", accountId);
    if (previous !== undefined && this.now().getTime() - previous < 60_000)
      throw new BridgeError("pairing_cooldown", 429);
    const provider = this.provider(accountId);
    if (!provider.requestPairingCode)
      throw new BridgeError("pairing_code_unavailable", 501);
    metadata.set("pairing-cooldown", accountId, this.now().getTime());
    const attempt: CodeAttempt = { controller: new AbortController() };
    this.codeAttempts.set(accountId, attempt);
    this.links.delete(accountId);
    this.store.setAccount(accountId, "linking");
    let timeout: NodeJS.Timeout | undefined, cancel: (() => void) | undefined;
    try {
      const code = await Promise.race([
        provider.requestPairingCode(phoneNumber),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new BridgeError("pairing_cancelled", 409));
          attempt.controller.signal.addEventListener("abort", cancel, {
            once: true,
          });
          timeout = setTimeout(
            () => reject(new BridgeError("pairing_timeout", 504)),
            this.pairingRequestTimeoutMs,
          );
        }),
      ]);
      if (
        this.codeAttempts.get(accountId) !== attempt ||
        attempt.controller.signal.aborted
      )
        throw new BridgeError("pairing_cancelled", 409);
      if (typeof code !== "string" || !/^[A-Z0-9]{8}$/u.test(code))
        throw new BridgeError("pairing_failed", 502);
      attempt.expiresAt = this.now().getTime() + 60_000;
      attempt.timer = setTimeout(() => {
        void this.expireCodeAttempt(accountId).catch(() => undefined);
      }, 60_000);
      attempt.timer.unref();
      return {
        state: "linking" as const,
        code,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      };
    } catch (error) {
      if (this.codeAttempts.get(accountId) === attempt)
        await this.discardCodeAttempt(accountId, attempt, "error");
      if (
        error instanceof BridgeError &&
        ["pairing_timeout", "pairing_cancelled", "already_linked"].includes(
          error.code,
        )
      )
        throw error;
      throw new BridgeError("pairing_failed", 502);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (cancel)
        attempt.controller.signal.removeEventListener("abort", cancel);
    }
  }
  linkState(accountId: string) {
    const account = this.store.account(accountId);
    const qr = this.links.get(accountId);
    if (qr && qr.expiresAt <= this.now().getTime())
      this.links.delete(accountId);
    return {
      state: account.state,
      ...(this.links.has(accountId)
        ? { qr: this.links.get(accountId)!.qr }
        : {}),
    };
  }
  async unlink(accountId: string) {
    this.store.account(accountId);
    if (this.closingAccounts.has(accountId))
      throw new BridgeError("pairing_in_progress", 409);
    this.closingAccounts.add(accountId);
    this.cancelCodeAttempt(accountId);
    this.links.delete(accountId);
    this.generations.delete(accountId);
    const provider = this.providers.get(accountId);
    this.providers.delete(accountId);
    try {
      await provider?.logout();
    } finally {
      try {
        await provider?.close();
        this.store.credentials(accountId).clear();
        this.store.setAccount(accountId, "logged_out", []);
      } finally {
        this.closingAccounts.delete(accountId);
      }
    }
  }
  async send(input: SendRequest): Promise<SendRecord> {
    if (this.stopped) throw new BridgeError("bridge_stopping", 503);
    requireId(input.accountId);
    requireChat(input.chatId);
    requireId(input.idempotencyKey);
    if (
      typeof input.text !== "string" ||
      (input.text.trim().length === 0 && input.attachmentId === undefined) ||
      input.text.length > 4096 ||
      Buffer.byteLength(input.text) > 16_384
    )
      throw new BridgeError("invalid_text");
    if (input.quoteMessageId !== undefined) requireId(input.quoteMessageId);
    if (input.attachmentId !== undefined) requireId(input.attachmentId);
    this.store.account(input.accountId);
    // Resolve an existing idempotent operation even if the account is now offline.
    const existing = this.store.existingSend(input);
    if (existing) return existing;
    if (this.store.account(input.accountId).state !== "connected")
      throw new BridgeError("account_not_connected", 409);
    const quote = input.quoteMessageId
      ? this.store.message(input.accountId, input.chatId, input.quoteMessageId)
      : undefined;
    if (input.quoteMessageId && !quote)
      throw new BridgeError("quote_not_found", 404);
    const metadata =
      input.attachmentId !== undefined
        ? this.attachment(input.accountId, input.chatId, input.attachmentId)
        : undefined;
    if (
      metadata &&
      ["audio", "sticker"].includes(metadata.kind) &&
      input.text.trim()
    )
      throw new BridgeError("attachment_caption_unsupported");
    const attachment =
      input.attachmentId !== undefined
        ? {
            bytes: await this.downloadAttachment(
              input.accountId,
              input.chatId,
              input.attachmentId,
            ),
            metadata: this.attachment(
              input.accountId,
              input.chatId,
              input.attachmentId,
            ),
          }
        : undefined;
    if (this.stopped) throw new BridgeError("bridge_stopping", 503);
    if (this.store.account(input.accountId).state !== "connected")
      throw new BridgeError("account_not_connected", 409);
    const reservation = this.store.reserve(input);
    if (!reservation.created) return reservation.send;
    const record = reservation.send;
    this.store.setSend(record.sendId, "sending");
    let timeout: NodeJS.Timeout | undefined;
    let cancel: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.provider(input.accountId).send({
          chatId: input.chatId,
          text: input.text,
          messageId: record.messageId,
          ...(quote ? { quote } : {}),
          ...(attachment ? { attachment } : {}),
        }),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new BridgeError("bridge_stopping", 503));
          this.shutdown.signal.addEventListener("abort", cancel, {
            once: true,
          });
          timeout = setTimeout(
            () => reject(new BridgeError("send_timeout", 504)),
            25_000,
          );
        }),
      ]);
      if (result.messageId !== record.messageId)
        throw new BridgeError("provider_message_id_mismatch", 502);
      this.store.setSend(record.sendId, "sent");
    } catch {
      this.store.setSend(record.sendId, "delivery_unknown");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (cancel) this.shutdown.signal.removeEventListener("abort", cancel);
    }
    return this.store.send(record.sendId);
  }
  listAttachments(
    accountId: string,
    chatId: string,
    messageId?: string,
  ): Attachment[] {
    this.attachmentScope(accountId, chatId);
    if (messageId !== undefined) requireId(messageId);
    return this.store.attachments.list(accountId, chatId, messageId);
  }
  attachment(accountId: string, chatId: string, id: string): Attachment {
    this.attachmentScope(accountId, chatId);
    return this.store.attachments.get(accountId, chatId, requireId(id));
  }
  uploadAttachment(
    accountId: string,
    chatId: string,
    metadata: AttachmentUpload,
    bytes: Uint8Array,
  ): Attachment {
    this.attachmentScope(accountId, chatId);
    const attachment = uploadMetadata(
      randomUUID(),
      metadata,
      bytes,
      this.store.attachments.maxBytes,
    );
    this.store.attachments.register(accountId, chatId, attachment);
    return this.store.attachments.cache(
      accountId,
      chatId,
      attachment.attachmentId,
      bytes,
    );
  }
  async downloadAttachment(
    accountId: string,
    chatId: string,
    id: string,
  ): Promise<Uint8Array> {
    this.attachment(accountId, chatId, id);
    const cached = this.store.attachments.cached(accountId, chatId, id);
    if (cached) return cached;
    if (this.store.account(accountId).state !== "connected")
      throw new BridgeError("account_not_connected", 409);
    const key = JSON.stringify([accountId, chatId, id]);
    const pending = this.attachmentDownloads.get(key);
    if (pending) return pending;
    const provider = this.provider(accountId),
      generation = this.generations.get(accountId);
    if (!provider.downloadAttachment)
      throw new BridgeError("attachment_download_unavailable", 501);
    const operation = (async () => {
      let timeout: NodeJS.Timeout | undefined, cancel: (() => void) | undefined;
      try {
        const bytes = await Promise.race([
          provider.downloadAttachment!({ attachmentId: id }),
          new Promise<never>((_, reject) => {
            cancel = () => reject(new BridgeError("bridge_stopping", 503));
            this.shutdown.signal.addEventListener("abort", cancel, {
              once: true,
            });
            timeout = setTimeout(
              () => reject(new BridgeError("attachment_download_timeout", 504)),
              30_000,
            );
          }),
        ]);
        if (this.stopped || this.generations.get(accountId) !== generation)
          throw new BridgeError("attachment_download_cancelled", 409);
        this.store.attachments.cache(accountId, chatId, id, bytes);
        return bytes;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("attachment_download_failed", 502);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (cancel) this.shutdown.signal.removeEventListener("abort", cancel);
        this.attachmentDownloads.delete(key);
      }
    })();
    this.attachmentDownloads.set(key, operation);
    return operation;
  }
  private attachmentScope(accountId: string, chatId: string) {
    if (this.stopped) throw new BridgeError("bridge_stopping", 503);
    requireId(accountId);
    requireChat(chatId);
    this.store.account(accountId);
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const accountId of this.codeAttempts.keys())
      this.cancelCodeAttempt(accountId);
    this.shutdown.abort();
    this.generations.clear();
    this.links.clear();
    await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.close()),
    );
    this.providers.clear();
    this.bus.removeAllListeners();
  }
  private provider(accountId: string): ProviderPort {
    const existing = this.providers.get(accountId);
    if (existing) return existing;
    const generation = Symbol();
    this.generations.set(accountId, generation);
    const current = () =>
      !this.stopped && this.generations.get(accountId) === generation;
    const provider = this.factory(
      accountId,
      this.store.credentials(accountId),
      {
        connection: async (update) => {
          if (!current()) return;
          const ids = update.identityIds?.filter(individualJid);
          this.store.setAccount(
            accountId,
            update.state,
            ids,
            update.diagnosticCode,
            update.diagnostics,
          );
          if (update.state === "connected") this.cancelCodeAttempt(accountId);
          if (update.qr && !this.codeAttempts.has(accountId))
            this.links.set(accountId, {
              qr: update.qr,
              expiresAt: this.now().getTime() + 60_000,
            });
          else if (update.state !== "linking") this.links.delete(accountId);
        },
        messages: async (messages) => {
          if (!current()) return;
          for (const incoming of messages) {
            if (
              incoming.accountId !== accountId ||
              !chatJid(incoming.chatId) ||
              (groupJid(incoming.chatId) &&
                !individualJid(incoming.authorId) &&
                !(
                  ["edit", "delete"].includes(incoming.origin) &&
                  incoming.authorId === "unknown" &&
                  incoming.identityVerified === false
                )) ||
              !opaqueId(incoming.messageId) ||
              typeof incoming.text !== "string" ||
              incoming.text.length > 32_000 ||
              !Number.isFinite(Date.parse(incoming.timestamp))
            )
              continue;
            let attachments: Attachment[];
            try {
              attachments =
                incoming.origin === "delete"
                  ? []
                  : attachmentList(incoming.attachments);
            } catch {
              continue;
            }
            if (
              !incoming.text.trim() &&
              !attachments.length &&
              incoming.origin !== "delete"
            )
              continue;
            const bridge = this.store.bridgeSend(
              accountId,
              incoming.chatId,
              incoming.messageId,
            );
            if (bridge && incoming.fromMe)
              this.store.reconcile(accountId, incoming.messageId);
            const normalized: BridgeMessage = {
              ...incoming,
              attachments,
              origin:
                bridge &&
                incoming.origin !== "delete" &&
                incoming.origin !== "edit"
                  ? "bridge"
                  : incoming.origin,
            };
            let event: BridgeEvent | null;
            try {
              event = this.store.ingest(normalized);
            } catch (error) {
              if (
                error instanceof BridgeError &&
                [
                  "attachment_metadata_conflict",
                  "attachment_scope_conflict",
                ].includes(error.code)
              )
                continue;
              throw error;
            }
            if (event) this.bus.emit("event", event);
          }
        },
        delivery: async (messageId) => {
          if (current()) this.store.reconcile(accountId, messageId);
        },
      },
    );
    this.providers.set(accountId, provider);
    return provider;
  }
  private cancelCodeAttempt(accountId: string) {
    const attempt = this.codeAttempts.get(accountId);
    if (!attempt) return;
    this.codeAttempts.delete(accountId);
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.controller.abort();
  }
  private async expireCodeAttempt(accountId: string) {
    const attempt = this.codeAttempts.get(accountId);
    if (
      attempt?.expiresAt !== undefined &&
      attempt.expiresAt <= this.now().getTime()
    )
      await this.discardCodeAttempt(accountId, attempt, "disconnected");
  }
  private async discardCodeAttempt(
    accountId: string,
    attempt: CodeAttempt,
    state: "disconnected" | "error",
  ) {
    if (this.codeAttempts.get(accountId) !== attempt) return;
    this.cancelCodeAttempt(accountId);
    if (this.stopped || this.store.account(accountId).state === "connected")
      return;
    this.closingAccounts.add(accountId);
    this.generations.delete(accountId);
    const provider = this.providers.get(accountId);
    this.providers.delete(accountId);
    try {
      await provider?.close();
    } finally {
      this.links.delete(accountId);
      this.store.credentials(accountId).clear();
      this.store.setAccount(accountId, state, []);
      this.closingAccounts.delete(accountId);
    }
  }
}
