import {
  BridgeError,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentUpload,
  type AccountSummary,
  type MessagePage,
  type MessageQuery,
  type SendRecord,
  type SendRequest,
} from "./types.js";
export class BridgeClient {
  private readonly base: URL;
  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.base = new URL(baseUrl);
    if (
      this.base.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== "/"
    )
      throw new BridgeError("local_url_required");
    if (token.length < 32 || token.length > 512 || /\s/u.test(token))
      throw new BridgeError("token_invalid");
  }
  accounts() {
    return this.request<{ accounts: AccountSummary[] }>("/v1/accounts");
  }
  chats(accountId = "default") {
    return this.request<{
      chats: Array<{
        accountId: string;
        chatId: string;
        lastMessageAt: string;
      }>;
    }>(`/v1/chats?accountId=${encodeURIComponent(accountId)}`);
  }
  messages(accountId: string, chatId: string, options: MessageQuery = {}) {
    const query = new URLSearchParams({
      accountId,
      limit: String(options.limit ?? 50),
      ...(options.after !== undefined ? { after: options.after } : {}),
      ...(options.before !== undefined ? { before: options.before } : {}),
    });
    return this.request<MessagePage>(
      `/v1/chats/${encodeURIComponent(chatId)}/messages?${query}`,
    );
  }
  send(input: SendRequest) {
    return this.request<{ send: SendRecord }>("/v1/messages", input);
  }
  attachments(accountId: string, chatId: string, messageId?: string) {
    const query = new URLSearchParams({
      accountId,
      ...(messageId ? { messageId } : {}),
    });
    return this.request<{ attachments: Attachment[] }>(
      `/v1/chats/${encodeURIComponent(chatId)}/attachments?${query}`,
    );
  }
  attachment(accountId: string, chatId: string, attachmentId: string) {
    return this.request<{ attachment: Attachment }>(
      this.attachmentPath(accountId, chatId, attachmentId),
    );
  }
  async uploadAttachment(
    accountId: string,
    chatId: string,
    metadata: AttachmentUpload,
    bytes: Uint8Array,
  ) {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new BridgeError("attachment_too_large", 413);
    const query = new URLSearchParams({
      accountId,
      kind: metadata.kind,
      ...(metadata.fileName ? { fileName: metadata.fileName } : {}),
    });
    const response = await this.fetchResponse(
      `/v1/chats/${encodeURIComponent(chatId)}/attachments?${query}`,
      {
        method: "POST",
        headers: { "content-type": metadata.mimeType },
        body: new Uint8Array(bytes),
      },
    );
    return this.json<{ attachment: Attachment }>(response);
  }
  async downloadAttachment(
    accountId: string,
    chatId: string,
    attachmentId: string,
  ): Promise<Uint8Array> {
    const response = await this.fetchResponse(
      this.attachmentPath(accountId, chatId, attachmentId, true),
    );
    if (!response.ok) return this.json<never>(response);
    if (!response.body)
      throw new BridgeError("attachment_download_failed", 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES)
        throw new BridgeError("attachment_too_large", 413);
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_ATTACHMENT_BYTES)
          throw new BridgeError("attachment_too_large", 413);
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("attachment_download_failed", 502);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  private attachmentPath(
    accountId: string,
    chatId: string,
    attachmentId: string,
    content = false,
  ) {
    return `/v1/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attachmentId)}${content ? "/content" : ""}?${new URLSearchParams({ accountId })}`;
  }
  sendStatus(id: string) {
    return this.request<{ send: SendRecord }>(
      `/v1/sends/${encodeURIComponent(id)}`,
    );
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchResponse(path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return this.json<T>(response);
  }
  private async fetchResponse(path: string, input: RequestInit = {}) {
    try {
      return await fetch(new URL(path, this.base), {
        ...input,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...input.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new BridgeError("bridge_unavailable", 503);
    }
  }
  private async json<T>(response: Response): Promise<T> {
    const result = (await response.json()) as { error?: { code?: string } };
    if (!response.ok)
      throw new BridgeError(
        result.error?.code ?? "bridge_request_failed",
        response.status,
      );
    return result as T;
  }
}
