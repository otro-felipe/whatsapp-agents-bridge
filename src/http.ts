import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { BridgeService } from "./service.js";
import {
  BridgeError,
  cursor,
  requireChat,
  requireId,
  MAX_ATTACHMENT_BYTES,
  type AttachmentUpload,
  type SendRequest,
} from "./types.js";
export async function createHttpServer(
  service: BridgeService,
  token: string,
  port = 0,
  allowedOrigins: string[] = [],
) {
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512 ||
    /\s/.test(token)
  )
    throw new BridgeError("token_invalid");
  const digest = createHash("sha256").update(token).digest();
  const consumer = digest.toString("hex");
  const streams = new Set<ServerResponse>();
  let boundPort = port;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const failure =
        error instanceof BridgeError
          ? error
          : new BridgeError("internal_error", 500);
      send(response, failure.status, {
        error: { code: failure.code },
        ...(failure.code === "cursor_expired"
          ? { eventId: service.store.head() }
          : {}),
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const allowedHosts = new Set([
      `127.0.0.1:${boundPort}`,
      `localhost:${boundPort}`,
    ]);
    if (!allowedHosts.has(req.headers.host ?? ""))
      throw new BridgeError("host_not_allowed", 403);
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin))
      throw new BridgeError("origin_not_allowed", 403);
    if (origin) res.setHeader("access-control-allow-origin", origin);
    const authorization = req.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      !supplied ||
      supplied.length > 512 ||
      !timingSafeEqual(digest, createHash("sha256").update(supplied).digest())
    )
      throw new BridgeError("unauthorized", 401);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    if (url.username || url.password) throw new BridgeError("invalid_url");
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new BridgeError("invalid_path");
    }
    const method = req.method ?? "GET";
    if (method === "GET" && path === "/health")
      return send(res, 200, { status: "ok", version: 1 });
    if (method === "GET" && path === "/v1/accounts")
      return send(res, 200, { accounts: service.store.accounts() });
    const pairing = path.match(/^\/v1\/accounts\/([^/]+)\/pairing-code$/u);
    if (method === "POST" && pairing) {
      const input = await body(req);
      exact(input, ["phoneNumber"]);
      return send(
        res,
        200,
        await service.requestPairingCode(
          requireId(pairing[1]),
          input.phoneNumber,
        ),
      );
    }
    const link = path.match(/^\/v1\/accounts\/([^/]+)\/link$/u);
    if (link) {
      const id = requireId(link[1]);
      if (method === "POST") {
        await body(req);
        await service.link(id);
        return send(res, 202, { state: service.store.account(id).state });
      }
      if (method === "GET") return send(res, 200, service.linkState(id));
      if (method === "DELETE") {
        await service.unlink(id);
        return send(res, 200, { state: "logged_out" });
      }
    }
    if (method === "GET" && path === "/v1/chats")
      return send(res, 200, {
        chats: service.store.chats(
          requireId(url.searchParams.get("accountId") ?? "default"),
        ),
      });
    const messages = path.match(/^\/v1\/chats\/([^/]+)\/messages$/u);
    const attachments = path.match(
      /^\/v1\/chats\/([^/]+)\/attachments(?:\/(list|[^/]+)(\/content)?)?$/u,
    );
    if (attachments) {
      const accountId = requireId(
        url.searchParams.get("accountId") ?? "default",
      );
      const chatId = requireChat(attachments[1]);
      const id = attachments[2];
      if (method === "POST" && !id) {
        if (
          [...url.searchParams.keys()].some(
            (key) => !["accountId", "kind", "fileName"].includes(key),
          )
        )
          throw new BridgeError("unknown_field");
        const metadata = {
          kind: url.searchParams.get("kind") ?? "document",
          mimeType:
            req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ??
            "application/octet-stream",
          ...(url.searchParams.has("fileName")
            ? { fileName: url.searchParams.get("fileName")! }
            : {}),
        } as AttachmentUpload;
        const bytes = await binaryBody(req);
        return send(res, 200, {
          attachment: service.uploadAttachment(
            accountId,
            chatId,
            metadata,
            bytes,
          ),
        });
      }
      if (method === "GET" && (!id || id === "list"))
        return send(res, 200, {
          attachments: service.listAttachments(
            accountId,
            chatId,
            url.searchParams.get("messageId") ?? undefined,
          ),
        });
      if (method === "GET" && id) {
        const attachment = service.attachment(accountId, chatId, requireId(id));
        if (!attachments[3]) return send(res, 200, { attachment });
        const bytes = await service.downloadAttachment(
          accountId,
          chatId,
          attachment.attachmentId,
        );
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          throw new BridgeError("attachment_too_large", 413);
        res.writeHead(200, {
          "content-type": attachment.mimeType,
          "content-length": bytes.byteLength,
          "content-disposition": "attachment",
        });
        res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return;
      }
    }
    if (method === "GET" && messages)
      return send(
        res,
        200,
        service.store.messagePage(
          requireId(url.searchParams.get("accountId") ?? "default"),
          requireChat(messages[1]),
          {
            ...(url.searchParams.has("after")
              ? { after: url.searchParams.get("after")! }
              : {}),
            ...(url.searchParams.has("before")
              ? { before: url.searchParams.get("before")! }
              : {}),
            limit: limit(url.searchParams.get("limit"), 50, 100),
          },
        ),
      );
    if (method === "POST" && path === "/v1/messages") {
      const input = await body(req);
      exact(input, [
        "accountId",
        "chatId",
        "text",
        "idempotencyKey",
        "quoteMessageId",
        "attachmentId",
      ]);
      return send(res, 200, {
        send: await service.send(input as unknown as SendRequest),
      });
    }
    const sent = path.match(/^\/v1\/sends\/([^/]+)$/u);
    if (method === "GET" && sent)
      return send(res, 200, { send: service.store.send(requireId(sent[1])) });
    if (method === "GET" && path === "/v1/events/head")
      return send(res, 200, { eventId: service.store.head() });
    if (method === "GET" && path === "/v1/events/checkpoint")
      return send(res, 200, { eventId: service.store.checkpoint(consumer) });
    if (method === "POST" && path === "/v1/checkpoint") {
      const input = await body(req);
      exact(input, ["eventId"]);
      return send(res, 200, {
        eventId: service.store.saveCheckpoint(consumer, cursor(input.eventId)),
      });
    }
    if (method === "GET" && path === "/v1/events") {
      let after = cursor(
        req.headers["last-event-id"] ??
          url.searchParams.get("after") ??
          service.store.checkpoint(consumer),
      );
      service.store.assertCursor(after);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      });
      res.flushHeaders();
      streams.add(res);
      let draining = false;
      const drain = () => {
        if (draining || res.destroyed) return;
        draining = true;
        try {
          while (!res.destroyed) {
            const page = service.store.eventsAfter(after, 100);
            if (page.length === 0) break;
            for (const event of page) {
              if (
                !res.write(
                  `id: ${event.eventId}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
                )
              ) {
                res.end();
                return;
              }
              after = event.eventId;
            }
            if (page.length < 100) break;
          }
        } catch {
          res.end();
        } finally {
          draining = false;
        }
      };
      const unsubscribe = service.subscribe(drain);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.write(": keepalive\n\n")) res.end();
      }, 15_000);
      heartbeat.unref();
      res.on("close", () => {
        unsubscribe();
        clearInterval(heartbeat);
        streams.delete(res);
      });
      drain();
      return;
    }
    throw new BridgeError("not_found", 404);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new BridgeError("listen_failed", 500);
  boundPort = address.port;
  return {
    port: boundPort,
    async close() {
      for (const stream of streams) stream.end();
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
async function binaryBody(request: IncomingMessage): Promise<Uint8Array> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_ATTACHMENT_BYTES) {
    request.resume();
    throw new BridgeError("attachment_too_large", 413);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      request.resume();
      throw new BridgeError("attachment_too_large", 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new BridgeError("json_required", 415);
  if (Number(request.headers["content-length"] ?? 0) > 32_768) {
    request.resume();
    throw new BridgeError("payload_too_large", 413);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new BridgeError("payload_too_large", 413);
    chunks.push(Buffer.from(chunk));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new BridgeError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new BridgeError("invalid_request");
  return parsed as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new BridgeError("unknown_field");
}
function limit(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max)
    throw new BridgeError("invalid_limit");
  return number;
}
