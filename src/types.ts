export type AccountState =
  | "disconnected"
  | "linking"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "error";
export interface AccountSummary {
  accountId: string;
  state: AccountState;
  identityId?: string;
  identityIds?: string[];
  diagnosticCode?: "identity_conflict";
  history?: { storedMessages: number; retentionDays: number | null };
  connectionDiagnostics?: {
    attempts: number;
    disconnects: number;
    lastAttemptAt?: string;
    lastDisconnectAt?: string;
    lastDisconnectStatus?: number;
  };
}
export interface ConnectionDiagnosticUpdate {
  attemptStarted?: boolean;
  disconnected?: boolean;
  disconnectStatus?: number;
}
/** Only a bounded numeric HTTP/provider status; never error text or payload. */
export function recognizedDisconnectStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
export interface BridgeMessage {
  accountId: string;
  chatId: string;
  messageId: string;
  authorId: string;
  text: string;
  timestamp: string;
  fromMe: boolean;
  origin: "live" | "history" | "bridge" | "edit" | "delete";
  identityVerified: boolean;
  forwarded?: boolean;
  quoted?: boolean;
  attachments?: Attachment[];
}
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export interface Attachment {
  attachmentId: string;
  kind: "image" | "video" | "audio" | "document" | "sticker";
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
}
export type AttachmentUpload = Pick<
  Attachment,
  "kind" | "mimeType" | "fileName"
>;
export interface MessagePage {
  messages: BridgeMessage[];
  nextBefore?: string;
}
export interface MessageQuery {
  before?: string;
  after?: string;
  limit?: number;
}
export interface BridgeEvent {
  eventId: string;
  type: "message";
  message: BridgeMessage;
}
export interface SendRequest {
  accountId: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
  quoteMessageId?: string;
  attachmentId?: string;
}
export interface SendRecord {
  sendId: string;
  accountId: string;
  chatId: string;
  messageId: string;
  idempotencyKey: string;
  status: "reserved" | "sending" | "sent" | "delivery_unknown";
  createdAt: string;
}
export interface CredentialStore {
  /** Identity routing metadata only; never enumerate authentication/Signal records. */
  identityMappings?(): Array<{ id: string; canonical: string }>;
  get<T>(category: string, key: string): T | undefined;
  set(category: string, key: string, value: unknown): void;
  batch(
    items: Array<{ category: string; key: string; value: unknown | null }>,
  ): void;
  clear(): void;
}
export interface ProviderEvents {
  connection(update: {
    state: AccountState;
    identityIds?: string[];
    qr?: string;
    diagnosticCode?: "identity_conflict";
    diagnostics?: ConnectionDiagnosticUpdate;
  }): Promise<void>;
  messages(messages: BridgeMessage[]): Promise<void>;
  delivery(messageId: string): Promise<void>;
}
export interface ProviderPort {
  connect(options?: { allowPairing: boolean }): Promise<void>;
  requestPairingCode?(phoneNumber: string): Promise<string>;
  close(): Promise<void>;
  logout(): Promise<void>;
  downloadAttachment?(input: { attachmentId: string }): Promise<Uint8Array>;
  send(input: {
    chatId: string;
    text: string;
    messageId: string;
    quote?: BridgeMessage;
    attachment?: { metadata: Attachment; bytes: Uint8Array };
  }): Promise<{ messageId: string }>;
}
export type ProviderFactory = (
  accountId: string,
  auth: CredentialStore,
  events: ProviderEvents,
) => ProviderPort;
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = "BridgeError";
  }
}
export const individualJid = (value: string) =>
  /^[0-9]{5,32}@(s\.whatsapp\.net|lid)$/u.test(value);
/** Chat addresses are not identities: a group ID must never enter PN/LID alias resolution. */
export const groupJid = (value: string) =>
  /^[0-9]{5,32}(?:-[0-9]{5,32})?@g\.us$/u.test(value);
export const chatJid = (value: string) =>
  individualJid(value) || groupJid(value);
export const opaqueId = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value);
export function requireId(value: unknown): string {
  if (typeof value !== "string" || !opaqueId(value))
    throw new BridgeError("invalid_identifier");
  return value;
}
export function requireChat(value: unknown): string {
  if (typeof value !== "string" || !chatJid(value))
    throw new BridgeError("unsupported_chat");
  return value;
}
export function requirePhoneNumber(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{6,14}$/u.test(value))
    throw new BridgeError("invalid_phone_number");
  return value;
}
export function cursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{1,15}$/u.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new BridgeError("invalid_cursor");
  return String(Number(value));
}
