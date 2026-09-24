import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  getAudioDuration,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type WASocket,
  type AnyMessageContent,
} from "@whiskeysockets/baileys";
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { createPrivateTemporaryDirectory } from "./private-files.js";
import { join } from "node:path";
import pino from "pino";
import { IdentityMap } from "./identity-map.js";
import {
  BridgeError,
  individualJid,
  groupJid,
  requirePhoneNumber,
  recognizedDisconnectStatus,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type BridgeMessage,
  type CredentialStore,
  type ProviderEvents,
  type ProviderPort,
} from "./types.js";

function visibleContent(
  message: proto.IMessage | null | undefined,
): proto.IMessage | null {
  let content = message;
  for (let depth = 0; content && depth < 5; depth++) {
    if (
      content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.viewOnceMessageV2Extension
    )
      return null;
    if (content.editedMessage?.message) content = content.editedMessage.message;
    else if (content.documentWithCaptionMessage?.message)
      content = content.documentWithCaptionMessage.message;
    else return content;
  }
  return null;
}
function mediaOf(content: proto.IMessage | null) {
  if (!content) return;
  for (const kind of [
    "image",
    "video",
    "audio",
    "document",
    "sticker",
  ] as const) {
    const media = content[`${kind}Message`];
    if (media) return { kind, media };
  }
}
function validateDownloadSource(message: WAMessage) {
  const selected = mediaOf(visibleContent(message.message));
  if (!selected) throw new BridgeError("attachment_unavailable", 404);
  if (Number(selected.media.fileLength ?? 0) > MAX_ATTACHMENT_BYTES)
    throw new BridgeError("attachment_too_large", 413);
  const directPath = selected.media.directPath;
  if (directPath) {
    if (!directPath.startsWith("/") || directPath.startsWith("//"))
      throw new BridgeError("attachment_unavailable", 404);
  } else {
    const url = new URL(selected.media.url ?? "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "mmg.whatsapp.net" ||
      url.username ||
      url.password ||
      url.port
    )
      throw new BridgeError("attachment_unavailable", 404);
  }
}
function attachmentMetadata(
  accountId: string,
  chatId: string,
  messageId: string,
  content: proto.IMessage | null,
): Attachment | undefined {
  const selected = mediaOf(content);
  if (!selected) return;
  const { kind, media } = selected;
  const fallback = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/ogg",
    document: "application/octet-stream",
    sticker: "image/webp",
  }[kind];
  const candidate = media.mimetype?.split(";")[0]?.trim().toLowerCase();
  const prefix = kind === "sticker" ? "image" : kind;
  const mimeType =
    candidate &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(candidate) &&
    (kind === "document" || candidate.startsWith(`${prefix}/`))
      ? candidate
      : fallback;
  const fileName =
    "fileName" in media && typeof media.fileName === "string"
      ? media.fileName
          .replace(/[\/\\\x00-\x1f\x7f]/g, "_")
          .trim()
          .slice(0, 255)
      : undefined;
  const size = Number(media.fileLength);
  return {
    attachmentId:
      "wa-att-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            accountId,
            chatId,
            messageId,
            kind,
            media.fileSha256
              ? Buffer.from(media.fileSha256).toString("base64")
              : "",
          ]),
        )
        .digest("hex"),
    kind,
    mimeType,
    ...(fileName && fileName !== "." && fileName !== ".." ? { fileName } : {}),
    ...(media.fileLength != null && Number.isSafeInteger(size) && size >= 0
      ? { sizeBytes: size }
      : {}),
  };
}

export function canonicalJid(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const match = value.match(/^(\d{5,32})(?::\d+)?@(s\.whatsapp\.net|lid)$/u);
  return match ? `${match[1]}@${match[2]}` : undefined;
}
export function canonicalChatJid(value: unknown): string | undefined {
  return typeof value === "string" && groupJid(value)
    ? value
    : canonicalJid(value);
}
/** Provider identity comes from authenticated key metadata, never message text. */
export function normalizeMessage(
  accountId: string,
  input: WAMessage,
  origin: "live" | "history" | "edit" | "delete",
  ownerIds: string[],
  resolve: (id: string) => string = (id) => id,
): BridgeMessage | null {
  const rawChat = canonicalChatJid(input.key.remoteJid),
    id = input.key.id;
  if (!rawChat || !id) return null;
  const isGroup = groupJid(rawChat);
  const chatId = isGroup ? rawChat : resolve(rawChat),
    fromMe = input.key.fromMe === true;
  const rawAuthor = fromMe
    ? ownerIds.find(individualJid)
    : (canonicalJid(input.key.participant) ?? (isGroup ? undefined : rawChat));
  if (isGroup && !rawAuthor && (origin === "live" || origin === "history"))
    return null;
  const authorId = rawAuthor ? resolve(rawAuthor) : "unknown";
  const original =
    origin === "edit" && input.message?.editedMessage?.message
      ? input.message.editedMessage.message
      : input.message;
  const content = visibleContent(original);
  if (original && !content) return null;
  const selected = mediaOf(content);
  if (
    selected &&
    (("viewOnce" in selected.media && selected.media.viewOnce === true) ||
      (selected.media.contextInfo?.expiration ?? 0) > 0)
  )
    return null;
  const attachment =
    origin === "delete"
      ? undefined
      : attachmentMetadata(accountId, chatId, id, content);
  const extended = content?.extendedTextMessage;
  const text =
    origin === "delete"
      ? ""
      : (content?.conversation ??
        extended?.text ??
        (selected && "caption" in selected.media
          ? selected.media.caption
          : undefined) ??
        (attachment ? "" : undefined));
  if (
    typeof text !== "string" ||
    (origin !== "delete" && !text.trim() && !attachment)
  )
    return null;
  const context = selected?.media.contextInfo ?? extended?.contextInfo;
  const forwarded = context?.isForwarded === true;
  const timestamp = Number(input.messageTimestamp ?? 0) * 1000;
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp > 8_640_000_000_000_000
  )
    return null;
  return {
    accountId,
    chatId,
    messageId: id,
    authorId,
    text,
    timestamp: new Date(timestamp).toISOString(),
    fromMe,
    origin,
    forwarded,
    quoted: Boolean(context?.stanzaId),
    ...(attachment ? { attachments: [attachment] } : {}),
    identityVerified: fromMe
      ? ownerIds.length > 0 && ownerIds.every(individualJid)
      : Boolean(rawAuthor),
  };
}

export function normalizeUpdate(
  accountId: string,
  { key, update }: WAMessageUpdate,
  ownerIds: string[],
  resolve: (id: string) => string = (id) => id,
): BridgeMessage | null {
  const deleted =
    update.messageStubType === proto.WebMessageInfo.StubType.REVOKE;
  if (!deleted && !update.message) return null;
  return normalizeMessage(
    accountId,
    {
      key,
      message: deleted ? null : (update.message ?? null),
      messageTimestamp:
        update.messageTimestamp ?? Math.floor(Date.now() / 1000),
    },
    deleted ? "delete" : "edit",
    ownerIds,
    resolve,
  );
}

export function encryptedAuthentication(store: CredentialStore): {
  state: AuthenticationState;
  save: () => void;
} {
  const read = <T>(category: string, key: string): T | undefined => {
    const value = store.get<string>(category, key);
    return value === undefined
      ? undefined
      : (JSON.parse(value, BufferJSON.reviver) as T);
  };
  const creds =
    read<AuthenticationState["creds"]>("auth", "creds") ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ) => {
        const result = {} as { [id: string]: SignalDataTypeMap[T] };
        for (const id of ids) {
          let value = read<SignalDataTypeMap[T]>("signal:" + type, id);
          if (value && type === "app-state-sync-key")
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as unknown as Record<string, unknown>,
            ) as unknown as SignalDataTypeMap[T];
          if (value !== undefined) result[id] = value;
        }
        return result;
      },
      set: async (data) => {
        const updates: Array<{
          category: string;
          key: string;
          value: string | null;
        }> = [];
        for (const [category, values] of Object.entries(data))
          for (const [key, value] of Object.entries(values ?? {}))
            updates.push({
              category: "signal:" + category,
              key,
              value:
                value === null
                  ? null
                  : JSON.stringify(value, BufferJSON.replacer),
            });
        store.batch(updates);
      },
    },
  };
  return {
    state,
    save: () =>
      store.set(
        "auth",
        "creds",
        JSON.stringify(state.creds, BufferJSON.replacer),
      ),
  };
}

/** No provider logger may emit pairing, credentials, message bodies or raw errors. */
export class BaileysProvider implements ProviderPort {
  private socket: WASocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private liveReady = false;
  private connected = false;
  private startedAt = 0;
  private attempts = 0;
  private operation: Promise<void> = Promise.resolve();
  private allowPairing = false;
  private codePairing = false;
  private codeRequest: symbol | undefined;
  private codeCancellation: AbortController | undefined;
  private readiness:
    | {
        promise: Promise<void>;
        resolve(): void;
        reject(error: BridgeError): void;
      }
    | undefined;
  private readonly identities: IdentityMap;
  private readonly auth: ReturnType<typeof encryptedAuthentication>;
  private readonly downloads = new Set<AbortController>();
  constructor(
    private readonly accountId: string,
    private readonly credentials: CredentialStore,
    private readonly events: ProviderEvents,
    private readonly createSocket: typeof makeWASocket = makeWASocket,
    private readonly downloadMedia: typeof downloadMediaMessage = downloadMediaMessage,
  ) {
    this.auth = encryptedAuthentication(credentials);
    this.identities = new IdentityMap(credentials);
  }
  async connect(options: { allowPairing: boolean } = { allowPairing: true }) {
    if (this.socket) return;
    this.observeOwnerIdentity();
    this.stopped = false;
    this.allowPairing = options.allowPairing;
    if (!this.auth.state.creds.registered && !this.allowPairing) {
      await this.events.connection({ state: "disconnected" });
      return;
    }
    this.startedAt = Date.now();
    this.liveReady = false;
    this.connected = false;
    this.auth.save();
    await this.events.connection({
      state: this.auth.state.creds.registered ? "reconnecting" : "linking",
      diagnostics: { attemptStarted: true },
    });
    const socket = this.createSocket({
      auth: this.auth.state,
      logger: pino({ level: "silent" }),
      // Preserve the browser profile used for initial linking. Desktop would
      // change the reconnect payload from WEB_BROWSER to DARWIN.
      browser: Browsers.macOS("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,
      getMessage: async () => undefined,
    });
    this.socket = socket;
    let resolveReady!: () => void, rejectReady!: (error: BridgeError) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    this.readiness = {
      promise: ready,
      resolve: resolveReady,
      reject: rejectReady,
    };
    const enqueue = (run: () => Promise<void>) => {
      this.operation = this.operation
        .then(async () => {
          if (!this.stopped && this.socket === socket) await run();
        })
        .catch(async () => {
          if (!this.stopped) await this.events.connection({ state: "error" });
        });
    };
    socket.ev.on("creds.update", (update) =>
      enqueue(async () => {
        Object.assign(this.auth.state.creds, update);
        this.observeOwnerIdentity();
        this.auth.save();
        if (this.identities.hasConflict()) await this.reportIdentityConflict();
      }),
    );
    socket.ev.on("connection.update", (update) =>
      enqueue(async () => {
        if (update.qr) {
          if (!this.allowPairing) {
            await this.close();
            await this.events.connection({ state: "logged_out" });
            return;
          }
          this.readiness?.resolve();
          await this.events.connection({
            state: "linking",
            ...(this.codePairing ? {} : { qr: update.qr }),
          });
        }
        if (update.receivedPendingNotifications) this.liveReady = true;
        if (update.connection === "open") {
          this.connected = true;
          this.attempts = 0;
          this.allowPairing = false;
        }
        if (this.connected && update.connection !== "close")
          await this.events.connection({
            // Pairing is complete when the authenticated socket opens. Keep
            // liveReady separate so pending history remains non-triggering.
            state: "connected",
            identityIds: this.ownerIds(),
            ...(this.identities.hasConflict()
              ? { diagnosticCode: "identity_conflict" }
              : {}),
          });
        if (update.connection === "close") {
          for (const download of this.downloads) download.abort();
          this.readiness?.reject(new BridgeError("pairing_failed", 502));
          this.codeCancellation?.abort(new BridgeError("pairing_failed", 502));
          this.socket = undefined;
          this.connected = false;
          this.liveReady = false;
          const code = (
            update.lastDisconnect?.error as
              { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          const status = recognizedDisconnectStatus(code);
          const diagnostics = {
            disconnected: true,
            ...(status !== undefined ? { disconnectStatus: status } : {}),
          };
          if (code === DisconnectReason.loggedOut) {
            this.credentials.clear();
            this.auth.state.creds = initAuthCreds();
            await this.events.connection({
              state: "logged_out",
              identityIds: [],
              diagnostics,
            });
            return;
          }
          if (this.codePairing && !this.auth.state.creds.registered) {
            await this.events.connection({ state: "error", diagnostics });
            return;
          }
          await this.events.connection({ state: "reconnecting", diagnostics });
          const delay = Math.min(
            30_000,
            1000 * 2 ** Math.min(this.attempts++, 5),
          );
          if (!this.stopped) {
            this.timer = setTimeout(() => {
              this.timer = undefined;
              void this.connect({ allowPairing: this.allowPairing }).catch(() =>
                this.events.connection({ state: "error" }),
              );
            }, delay);
            this.timer.unref();
          }
        }
      }),
    );
    socket.ev.on("lid-mapping.update", (mapping) =>
      enqueue(async () => {
        if (
          !this.identities.observe(
            canonicalJid(mapping.pn),
            canonicalJid(mapping.lid),
          )
        )
          await this.reportIdentityConflict();
      }),
    );
    socket.ev.on("messages.upsert", (batch) =>
      enqueue(async () => {
        for (const raw of batch.messages) this.observeMessageIdentity(raw.key);
        if (this.identities.hasConflict()) await this.reportIdentityConflict();
        const normalized: BridgeMessage[] = [];
        for (const raw of batch.messages) {
          if (!this.isMessageIdentitySafe(raw.key)) continue;
          const fresh =
            batch.type === "notify" &&
            !batch.requestId &&
            this.liveReady &&
            Number(raw.messageTimestamp ?? 0) * 1000 >= this.startedAt - 2000;
          const message = normalizeMessage(
            this.accountId,
            raw,
            fresh ? "live" : "history",
            this.ownerIds(),
            (id) => this.resolve(id),
          );
          if (message) {
            this.verifyOwnerMessage(message);
            this.retainAttachmentSource(message, raw);
            normalized.push(message);
          }
        }
        await this.events.messages(normalized);
      }),
    );
    socket.ev.on("messaging-history.set", (history) =>
      enqueue(async () => {
        for (const mapping of history.lidPnMappings ?? [])
          this.identities.observe(
            canonicalJid(mapping.pn),
            canonicalJid(mapping.lid),
          );
        for (const raw of history.messages)
          this.observeMessageIdentity(raw.key);
        if (this.identities.hasConflict()) await this.reportIdentityConflict();
        const messages = history.messages
          .map((raw) => {
            if (!this.isMessageIdentitySafe(raw.key)) return null;
            const message = normalizeMessage(
              this.accountId,
              raw,
              "history",
              this.ownerIds(),
              (id) => this.resolve(id),
            );
            if (message) {
              this.verifyOwnerMessage(message);
              this.retainAttachmentSource(message, raw);
            }
            return message;
          })
          .filter((m): m is BridgeMessage => m !== null);
        await this.events.messages(messages);
      }),
    );
    socket.ev.on("messages.update", (updates) =>
      enqueue(async () => {
        for (const { key } of updates) this.observeMessageIdentity(key);
        if (this.identities.hasConflict()) await this.reportIdentityConflict();
        for (const { key, update } of updates) {
          if (!this.isMessageIdentitySafe(key)) continue;
          if (
            key.fromMe &&
            !this.ownerIdentityQuarantined() &&
            key.id &&
            update.status !== undefined &&
            update.status !== null &&
            update.status >= proto.WebMessageInfo.Status.SERVER_ACK
          )
            await this.events.delivery(key.id);
          const message = normalizeUpdate(
            this.accountId,
            { key, update },
            this.ownerIds(),
            (id) => this.resolve(id),
          );
          if (message) {
            this.verifyOwnerMessage(message);
            this.retainAttachmentSource(message, { key, ...update });
            await this.events.messages([message]);
          }
        }
      }),
    );
    socket.ev.on("messages.delete", (deletion) =>
      enqueue(async () => {
        if (!("keys" in deletion)) return;
        for (const key of deletion.keys) this.observeMessageIdentity(key);
        if (this.identities.hasConflict()) await this.reportIdentityConflict();
        const messages = deletion.keys
          .filter((key) => this.isMessageIdentitySafe(key))
          .map((key) => this.deletion(key))
          .filter((m): m is BridgeMessage => m !== null);
        await this.events.messages(messages);
      }),
    );
  }
  async requestPairingCode(input: string): Promise<string> {
    const phoneNumber = requirePhoneNumber(input);
    if (this.connected || this.auth.state.creds.registered)
      throw new BridgeError("already_linked", 409);
    if (this.codeRequest) throw new BridgeError("pairing_in_progress", 409);
    const request = Symbol();
    const cancellation = new AbortController();
    this.codeRequest = request;
    this.codeCancellation = cancellation;
    this.codePairing = true;
    let timeout: NodeJS.Timeout | undefined, cancel: (() => void) | undefined;
    const current = () =>
      this.codeRequest === request &&
      !cancellation.signal.aborted &&
      !this.stopped;
    try {
      return await Promise.race([
        (async () => {
          await this.connect({ allowPairing: true });
          const socket = this.socket,
            ready = this.readiness;
          if (!socket || !ready) throw new BridgeError("pairing_failed", 502);
          await ready.promise;
          if (!current() || this.socket !== socket)
            throw new BridgeError("pairing_cancelled", 409);
          if (this.connected || this.auth.state.creds.registered)
            throw new BridgeError("already_linked", 409);
          const code = await socket.requestPairingCode(phoneNumber);
          // creds.update is serialized and encrypted before the code leaves this process.
          await this.operation;
          if (!current() || this.socket !== socket)
            throw new BridgeError("pairing_cancelled", 409);
          if (typeof code !== "string" || !/^[A-Z0-9]{8}$/u.test(code))
            throw new BridgeError("pairing_failed", 502);
          this.auth.save();
          return code;
        })(),
        new Promise<never>((_, reject) => {
          cancel = () =>
            reject(
              cancellation.signal.reason instanceof BridgeError
                ? cancellation.signal.reason
                : new BridgeError("pairing_cancelled", 409),
            );
          cancellation.signal.addEventListener("abort", cancel, { once: true });
          timeout = setTimeout(
            () => reject(new BridgeError("pairing_timeout", 504)),
            12_000,
          );
        }),
      ]);
    } catch (error) {
      if (
        error instanceof BridgeError &&
        ["pairing_cancelled", "pairing_timeout", "already_linked"].includes(
          error.code,
        )
      )
        throw error;
      throw new BridgeError("pairing_failed", 502);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (cancel) cancellation.signal.removeEventListener("abort", cancel);
      if (this.codeRequest === request) {
        this.codeRequest = undefined;
        this.codeCancellation = undefined;
      }
    }
  }
  async send(input: Parameters<ProviderPort["send"]>[0]) {
    this.assertSendIdentity(input.chatId);
    if (!this.socket || !this.connected)
      throw new BridgeError("account_not_connected", 409);
    const socket = this.socket;
    let directory: string | undefined;
    try {
      let content: AnyMessageContent = { text: input.text, linkPreview: null };
      if (input.attachment) {
        const { metadata, bytes } = input.attachment;
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          throw new BridgeError("attachment_too_large", 413);
        if (
          (metadata.kind === "audio" || metadata.kind === "sticker") &&
          input.text.trim()
        )
          throw new BridgeError("attachment_caption_unsupported");
        directory = await createPrivateTemporaryDirectory("whatsapp-send-");
        const filePath = join(directory, "upload");
        const handle = await open(filePath, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        const data = { url: filePath };
        const caption = input.text ? { caption: input.text } : {};
        const document = {
          document: data,
          mimetype: metadata.mimeType,
          fileName: metadata.fileName ?? "attachment",
          ...caption,
        };
        // rc14 copies even file input into a default-mode plaintext temporary
        // when it computes thumbnails/duration. Supply metadata to skip that path.
        switch (metadata.kind) {
          case "image":
            content = {
              image: data,
              mimetype: metadata.mimeType,
              jpegThumbnail: "",
              ...caption,
            };
            break;
          case "video":
            content = {
              video: data,
              mimetype: metadata.mimeType,
              jpegThumbnail: "",
              ...caption,
            };
            break;
          case "audio": {
            const seconds = await getAudioDuration(filePath).catch(
              () => undefined,
            );
            content =
              typeof seconds === "number" &&
              Number.isFinite(seconds) &&
              seconds >= 0
                ? { audio: data, mimetype: metadata.mimeType, seconds }
                : document;
            break;
          }
          case "sticker":
            content = { sticker: data, mimetype: metadata.mimeType };
            break;
          default:
            content = document;
        }
      }
      if (this.socket !== socket || !this.connected || this.stopped)
        throw new BridgeError("account_not_connected", 409);
      this.assertSendIdentity(input.chatId);
      const result = await socket.sendMessage(input.chatId, content, {
        messageId: input.messageId,
        ...(input.quote
          ? {
              quoted: {
                key: {
                  remoteJid: input.chatId,
                  id: input.quote.messageId,
                  fromMe: input.quote.fromMe,
                  ...(groupJid(input.chatId)
                    ? { participant: input.quote.authorId }
                    : {}),
                },
                message: { conversation: input.quote.text },
              },
            }
          : {}),
      });
      if (!result?.key.id) throw new BridgeError("provider_send_unknown", 502);
      return { messageId: result.key.id };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("provider_send_unknown", 502);
    } finally {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(() => {
          throw new BridgeError("attachment_cleanup_failed", 500);
        });
    }
  }
  async downloadAttachment(input: {
    attachmentId: string;
  }): Promise<Uint8Array> {
    if (!this.socket || !this.connected || this.stopped)
      throw new BridgeError("account_not_connected", 409);
    const saved = this.credentials.get<string>(
      "attachment-source",
      input.attachmentId,
    );
    if (!saved) throw new BridgeError("attachment_unavailable", 404);
    let stream:
      Awaited<ReturnType<typeof downloadMediaMessage<"stream">>> | undefined;
    const cancellation = new AbortController();
    this.downloads.add(cancellation);
    const signal = AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(25_000),
    ]);
    try {
      const message = JSON.parse(saved, BufferJSON.reviver) as WAMessage;
      this.assertReadableIdentity(message.key);
      // Provider locators never become API parameters. Restrict even an inbound locator to WhatsApp's media host.
      validateDownloadSource(message);
      const socket = this.socket;
      stream = await this.downloadMedia(
        message,
        "stream",
        { host: "mmg.whatsapp.net", options: { signal, redirect: "error" } },
        {
          logger: pino({ level: "silent" }),
          reuploadRequest: async (raw) => {
            if (this.socket !== socket || this.stopped || signal.aborted)
              throw new BridgeError("attachment_unavailable", 404);
            this.assertReadableIdentity(raw.key);
            const updated = await socket.updateMediaMessage(raw);
            if (this.socket !== socket || this.stopped || signal.aborted)
              throw new BridgeError("attachment_unavailable", 404);
            this.assertReadableIdentity(updated.key);
            validateDownloadSource(updated);
            this.credentials.set(
              "attachment-source",
              input.attachmentId,
              JSON.stringify(updated, BufferJSON.replacer),
            );
            return updated;
          },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        this.assertReadableIdentity(message.key);
        if (this.socket !== socket || this.stopped || signal.aborted)
          throw new BridgeError("attachment_unavailable", 404);
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES)
          throw new BridgeError("attachment_too_large", 413);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("attachment_download_failed", 502);
    } finally {
      stream?.destroy();
      cancellation.abort();
      this.downloads.delete(cancellation);
    }
  }
  private retainAttachmentSource(message: BridgeMessage, raw: WAMessage) {
    for (const attachment of message.attachments ?? [])
      this.credentials.set(
        "attachment-source",
        attachment.attachmentId,
        JSON.stringify(
          { ...raw, message: visibleContent(raw.message) },
          BufferJSON.replacer,
        ),
      );
  }
  async logout() {
    this.stopped = true;
    for (const download of this.downloads) download.abort();
    this.cancelPairing();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.auth.state.creds.registered) await this.socket?.logout();
    } finally {
      this.socket?.end(undefined);
      this.socket = undefined;
    }
  }
  async close() {
    this.stopped = true;
    for (const download of this.downloads) download.abort();
    this.cancelPairing();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.end(undefined);
    this.socket = undefined;
  }
  private cancelPairing() {
    const error = new BridgeError("pairing_cancelled", 409);
    this.readiness?.reject(error);
    this.codeCancellation?.abort(error);
    this.codeRequest = undefined;
  }
  private ownerIds() {
    const me = this.auth.state.creds.me;
    return [
      ...new Set(
        [me?.phoneNumber, me?.id, me?.lid]
          .map(canonicalJid)
          .filter((id): id is string => id !== undefined),
      ),
    ];
  }
  private resolve(id: string) {
    return this.identities.resolve(id);
  }
  private observeOwnerIdentity() {
    const ids = this.ownerIds();
    const pn = ids.find((id) => id.endsWith("@s.whatsapp.net"));
    const lid = ids.find((id) => id.endsWith("@lid"));
    return this.identities.observe(pn, lid);
  }
  private ownerIdentityQuarantined() {
    return this.ownerIds().some((id) => this.identities.isQuarantined(id));
  }
  private verifyOwnerMessage(message: BridgeMessage) {
    if (message.fromMe && this.ownerIdentityQuarantined())
      message.identityVerified = false;
  }
  private messageIdentityPair(key: WAMessageKey) {
    return typeof key.remoteJid === "string" && groupJid(key.remoteJid)
      ? ([
          canonicalJid(key.participant),
          canonicalJid(key.participantAlt),
        ] as const)
      : ([
          canonicalJid(key.remoteJid),
          canonicalJid(key.remoteJidAlt),
        ] as const);
  }
  private observeMessageIdentity(key: WAMessageKey): boolean {
    const [first, second] = this.messageIdentityPair(key);
    const observed = this.identities.observe(first, second);
    return observed && this.isMessageIdentitySafe(key);
  }
  private isMessageIdentitySafe(key: WAMessageKey) {
    // Authenticated own group messages may be archived with identityVerified=false.
    // A quarantined owner must never regain control via an absent participant field.
    if (
      key.fromMe &&
      typeof key.remoteJid === "string" &&
      groupJid(key.remoteJid)
    )
      return true;
    return this.messageIdentityPair(key).every(
      (id) => !id || !this.identities.isQuarantined(id),
    );
  }
  private assertSendIdentity(chatId: string) {
    if (this.ownerIdentityQuarantined())
      throw new BridgeError("owner_identity_conflict", 409);
    const person = canonicalJid(chatId);
    if (person && this.identities.isQuarantined(person))
      throw new BridgeError("identity_conflict", 409);
  }
  private assertReadableIdentity(key: WAMessageKey) {
    if (!this.isMessageIdentitySafe(key))
      throw new BridgeError("identity_conflict", 409);
  }
  private reportIdentityConflict() {
    return this.events.connection({
      state: this.connected ? "connected" : "error",
      diagnosticCode: "identity_conflict",
      identityIds: this.ownerIds(),
    });
  }
  private deletion(key: WAMessageKey) {
    const message = normalizeMessage(
      this.accountId,
      { key, messageTimestamp: Math.floor(Date.now() / 1000) },
      "delete",
      this.ownerIds(),
      (id) => this.resolve(id),
    );
    if (message) this.verifyOwnerMessage(message);
    return message;
  }
}
