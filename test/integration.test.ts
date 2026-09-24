import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startBridge, type BridgeInstance } from "../src/index.js";
import type {
  ProviderEvents,
  ProviderPort,
  BridgeMessage,
} from "../src/types.js";

const owner = "56911111111@s.whatsapp.net";
const peer = "56922222222@s.whatsapp.net";
class FakeProvider implements ProviderPort {
  sends: Array<{ chatId: string; messageId: string; text: string }> = [];
  fail = false;
  block: Promise<void> | undefined;
  onSend: (() => void) | undefined;
  constructor(readonly events: ProviderEvents) {}
  async connect() {
    await this.events.connection({
      state: "linking",
      qr: "synthetic-link-data",
    });
  }
  async close() {}
  async logout() {
    await this.events.connection({ state: "logged_out" });
  }
  async send(input: { chatId: string; messageId: string; text: string }) {
    this.sends.push(input);
    this.onSend?.();
    await this.block;
    if (this.fail) throw new Error("synthetic_transport_uncertainty");
    return { messageId: input.messageId };
  }
}
async function fixture(
  extra: {
    now?: () => Date;
    retentionDays?: number;
    historyRetentionDays?: number | null;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wa-bridge-test-"));
  const token = randomBytes(32).toString("base64url");
  const key = randomBytes(32);
  let provider!: FakeProvider;
  const options = {
    dataDir: directory,
    token,
    masterKey: key,
    ...extra,
    providerFactory: (_id: string, _auth: unknown, events: ProviderEvents) =>
      (provider = new FakeProvider(events)),
  };
  let bridge = await startBridge(options);
  const request = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`http://127.0.0.1:${bridge.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    directory,
    token,
    key,
    request,
    get bridge() {
      return bridge;
    },
    get provider() {
      return provider;
    },
    async connect() {
      await request("/v1/accounts/default/link", {});
      await provider.events.connection({
        state: "connected",
        identityIds: [owner, "12345678901@lid"],
      });
    },
    async restart() {
      await bridge.close();
      bridge = await startBridge(options);
    },
    async cleanup() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function message(
  id: string,
  extra: Partial<BridgeMessage> = {},
): BridgeMessage {
  return {
    accountId: "default",
    chatId: peer,
    messageId: id,
    authorId: owner,
    text: "HAL ON",
    timestamp: new Date().toISOString(),
    fromMe: true,
    origin: "live",
    identityVerified: true,
    ...extra,
  };
}

test("connection diagnostics persist only recognized numeric codes and store-generated counters/timestamps", async () => {
  const f = await fixture({ now: () => new Date("2026-09-05T12:00:00.000Z") });
  try {
    await f.connect();
    await f.provider.events.connection({
      state: "reconnecting",
      diagnostics: {
        attemptStarted: true,
        disconnected: true,
        disconnectStatus: 515,
        error: "synthetic-private-error",
        lastDisconnectAt: "private-date",
      },
      error: "synthetic-private-error",
    } as any);
    const expected = {
      attempts: 1,
      disconnects: 1,
      lastAttemptAt: "2026-09-05T12:00:00.000Z",
      lastDisconnectAt: "2026-09-05T12:00:00.000Z",
      lastDisconnectStatus: 515,
    };
    let body = (await (await f.request("/v1/accounts")).json()) as any;
    assert.deepEqual(body.accounts[0].connectionDiagnostics, expected);
    assert.equal(
      JSON.stringify(body).includes("synthetic-private-error"),
      false,
    );
    await f.restart();
    body = (await (await f.request("/v1/accounts")).json()) as any;
    assert.deepEqual(body.accounts[0].connectionDiagnostics, expected);
    for (const code of [405, 409, 429, 502, 504]) {
      await f.provider.events.connection({
        state: "reconnecting",
        diagnostics: { disconnected: true, disconnectStatus: code },
      });
      body = (await (await f.request("/v1/accounts")).json()) as any;
      assert.equal(
        body.accounts[0].connectionDiagnostics.lastDisconnectStatus,
        code,
      );
    }
    for (const code of [
      "401",
      99,
      600,
      999,
      515.1,
      { secret: "synthetic-private-error" },
      undefined,
    ]) {
      await f.provider.events.connection({
        state: "reconnecting",
        diagnostics: { disconnected: true, disconnectStatus: code },
      } as any);
      body = (await (await f.request("/v1/accounts")).json()) as any;
      assert.equal(
        body.accounts[0].connectionDiagnostics.lastDisconnectStatus,
        undefined,
      );
    }
    for (const file of ["bridge.sqlite", "bridge.sqlite-wal"]) {
      const bytes = await readFile(join(f.directory, file)).catch(() =>
        Buffer.alloc(0),
      );
      assert.equal(
        bytes.includes(Buffer.from("synthetic-private-error")),
        false,
      );
      assert.equal(bytes.includes(Buffer.from("private-date")), false);
    }
  } finally {
    await f.cleanup();
  }
});

test("API requires bearer and exact loopback Host, rejects browser Origin and oversized bodies", async () => {
  const f = await fixture();
  try {
    const url = `http://127.0.0.1:${f.bridge.port}`;
    assert.equal((await fetch(url + "/v1/accounts")).status, 401);
    assert.equal(
      await new Promise<number>((resolve) => {
        const req = httpRequest(
          url + "/v1/accounts",
          {
            headers: {
              Authorization: `Bearer ${f.token}`,
              Host: "attacker.example",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(url + "/v1/accounts", {
          headers: {
            Authorization: `Bearer ${f.token}`,
            Origin: "https://attacker.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/v1/messages", {
          accountId: "default",
          chatId: peer,
          text: "x".repeat(100_000),
          idempotencyKey: "too-big",
        })
      ).status,
      413,
    );
    assert.equal((await f.request("/v1/accounts")).status, 200);
  } finally {
    await f.cleanup();
  }
});

test("pairing QR is available only through explicit link read, never safe account state or journal", async () => {
  const f = await fixture();
  try {
    await f.request("/v1/accounts/default/link", {});
    assert.equal(
      Boolean((await (await f.request("/v1/accounts/default/link")).json()).qr),
      true,
    );
    assert.equal(
      JSON.stringify(await (await f.request("/v1/accounts")).json()).includes(
        "synthetic-link-data",
      ),
      false,
    );
    assert.equal(f.bridge.store.eventsAfter("0", 100).length, 0);
    await f.request("/v1/accounts/default/link", undefined, "DELETE");
    assert.equal(
      Boolean((await (await f.request("/v1/accounts/default/link")).json()).qr),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("complete inbound batches deduplicate, preserve history provenance, edits and delete tombstones", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.provider.events.messages([
      message("message-a"),
      message("message-b", { text: "contact", fromMe: false, authorId: peer }),
      message("message-history", { origin: "history" }),
    ]);
    await f.provider.events.messages([
      message("message-a"),
      message("message-history", { origin: "live" }),
    ]);
    assert.equal(f.bridge.store.eventsAfter("0", 100).length, 3);
    await f.provider.events.messages([
      message("message-b", {
        origin: "edit",
        text: "edited",
        fromMe: false,
        authorId: peer,
      }),
    ]);
    await f.provider.events.messages([
      message("message-b", {
        origin: "delete",
        text: "",
        fromMe: false,
        authorId: peer,
      }),
    ]);
    const events = f.bridge.store.eventsAfter("0", 100);
    assert.deepEqual(
      events.map((e) => e.message.origin),
      ["live", "live", "history", "edit", "delete"],
    );
    const list = await (
      await f.request(
        `/v1/chats/${encodeURIComponent(peer)}/messages?accountId=default`,
      )
    ).json();
    assert.equal(
      list.messages.find((m: BridgeMessage) => m.messageId === "message-b")
        .text,
      "",
    );
  } finally {
    await f.cleanup();
  }
});

test("outbound idempotency reserves stable provider ID, prevents conflicting reuse and recognizes bridge echo", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const body = {
      accountId: "default",
      chatId: peer,
      text: "[HAL] Hola",
      idempotencyKey: "request-1",
    };
    const first = await (await f.request("/v1/messages", body)).json();
    const second = await (await f.request("/v1/messages", body)).json();
    assert.equal(first.send.messageId, second.send.messageId);
    assert.equal(f.provider.sends.length, 1);
    assert.equal(
      (await f.request("/v1/messages", { ...body, text: "different" })).status,
      409,
    );
    await f.provider.events.messages([
      message(first.send.messageId, { text: body.text }),
    ]);
    assert.equal(
      f.bridge.store.eventsAfter("0", 100)[0]?.message.origin,
      "bridge",
    );
    assert.equal(
      (await (await f.request(`/v1/sends/${first.send.sendId}`)).json()).send
        .status,
      "sent",
    );
  } finally {
    await f.cleanup();
  }
});

test("uncertain delivery survives restart without blind retry and provider echo can reconcile it", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.provider.fail = true;
    const body = {
      accountId: "default",
      chatId: peer,
      text: "synthetic result",
      idempotencyKey: "unknown-1",
    };
    const first = await (await f.request("/v1/messages", body)).json();
    assert.equal(first.send.status, "delivery_unknown");
    await f.restart();
    await f.connect();
    const duplicate = await (await f.request("/v1/messages", body)).json();
    assert.equal(duplicate.send.messageId, first.send.messageId);
    assert.equal(f.provider.sends.length, 0);
    await f.provider.events.messages([
      message(first.send.messageId, { text: body.text }),
    ]);
    assert.equal(
      (await (await f.request(`/v1/sends/${first.send.sendId}`)).json()).send
        .status,
      "sent",
    );
  } finally {
    await f.cleanup();
  }
});

test("credential rows and context are encrypted at rest; wrong master key fails closed", async () => {
  const f = await fixture();
  try {
    f.bridge.store
      .credentials("default")
      .set("fixture", "test-key", { sensitive: "synthetic-private-material" });
    await f.connect();
    await f.provider.events.messages([
      message("private-message", { text: "synthetic-private-chat" }),
    ]);
    const files = await Promise.all(
      ["bridge.sqlite", "bridge.sqlite-wal"].map(async (name) => {
        try {
          return await readFile(join(f.directory, name));
        } catch {
          return Buffer.alloc(0);
        }
      }),
    );
    for (const bytes of files) {
      assert.equal(bytes.includes("synthetic-private-material"), false);
      assert.equal(bytes.includes("synthetic-private-chat"), false);
    }
    await f.bridge.close();
    await assert.rejects(
      startBridge({
        dataDir: f.directory,
        token: f.token,
        masterKey: randomBytes(32),
        providerFactory: () => {
          throw new Error("must_not_start");
        },
      }),
      /master_key_invalid/,
    );
  } finally {
    await f.cleanup();
  }
});

test("SSE replays only after durable cursor; checkpoints are monotonic and bounded by latest event", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.provider.events.messages([message("event-1"), message("event-2")]);
    const rows = f.bridge.store.eventsAfter("0", 10);
    const first = rows[0]!.eventId,
      second = rows[1]!.eventId;
    const abort = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${f.bridge.port}/v1/events`,
      {
        headers: { Authorization: `Bearer ${f.token}`, "Last-Event-ID": first },
        signal: abort.signal,
      },
    );
    const reader = response.body!.getReader();
    let output = "";
    while (!output.includes("event-2")) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
    }
    abort.abort();
    assert.equal(output.includes("event-1"), false);
    assert.equal(output.includes(`id: ${second}`), true);
    assert.equal(
      (await f.request("/v1/checkpoint", { eventId: second })).status,
      200,
    );
    assert.equal(
      (await f.request("/v1/checkpoint", { eventId: first })).status,
      409,
    );
    assert.equal(
      (await f.request("/v1/checkpoint", { eventId: "999999" })).status,
      409,
    );
    assert.equal(
      (await (await f.request("/v1/events/checkpoint")).json()).eventId,
      second,
    );
  } finally {
    await f.cleanup();
  }
});

test("offline preflight does not consume idempotency and unlink invalidates callbacks from the old provider", async () => {
  const f = await fixture();
  try {
    const body = {
      accountId: "default",
      chatId: peer,
      text: "synthetic",
      idempotencyKey: "offline-preflight",
    };
    assert.equal((await f.request("/v1/messages", body)).status, 409);
    await f.connect();
    assert.equal(
      (await (await f.request("/v1/messages", body)).json()).send.status,
      "sent",
    );
    const old = f.provider;
    await f.request("/v1/accounts/default/link", undefined, "DELETE");
    await old.events.connection({ state: "connected", identityIds: [owner] });
    await old.events.messages([message("stale-after-unlink")]);
    assert.equal(f.bridge.store.account("default").state, "logged_out");
    assert.equal(f.bridge.store.eventsAfter("0").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("context returns most recent bounded messages and preserves forwarded and quoted metadata after restart", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.provider.events.messages(
      Array.from({ length: 6 }, (_, i) =>
        message("context-" + i, {
          timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          forwarded: i === 5,
          quoted: i === 5,
        }),
      ),
    );
    await f.restart();
    const result = await (
      await f.request(`/v1/chats/${encodeURIComponent(peer)}/messages?limit=2`)
    ).json();
    assert.deepEqual(
      result.messages.map((m: BridgeMessage) => m.messageId),
      ["context-4", "context-5"],
    );
    assert.equal(result.messages[1].forwarded, true);
    assert.equal(result.messages[1].quoted, true);
    const events = f.bridge.store.eventsAfter("0");
    assert.equal(events[5]?.message.forwarded, true);
  } finally {
    await f.cleanup();
  }
});

test("retention expires replay visibly, keeps durable head, and explicit checkpoint to head permits resync", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const f = await fixture({
    now: () => now,
    retentionDays: 1,
    historyRetentionDays: 1,
  });
  try {
    await f.connect();
    await f.provider.events.messages([message("expired")]);
    now = new Date("2026-01-03T00:00:00Z");
    f.bridge.store.prune();
    const response = await f.request("/v1/events?after=0");
    assert.equal(response.status, 410);
    const value = await response.json();
    assert.equal(value.error.code, "cursor_expired");
    assert.equal(value.eventId, "1");
    assert.equal(f.bridge.store.messages("default", peer).length, 0);
    assert.equal(
      (await f.request("/v1/checkpoint", { eventId: "1" })).status,
      200,
    );
    assert.equal((await f.request("/v1/events?after=99")).status, 409);
  } finally {
    await f.cleanup();
  }
});

test("MCP uses the authenticated API, scopes context and sends, and exposes no pairing tools", async () => {
  const [
    { createMcpServer },
    { BridgeClient },
    { Client },
    { InMemoryTransport },
  ] = await Promise.all([
    import("../src/mcp.js"),
    import("../src/client.js"),
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const f = await fixture();
  const server = createMcpServer(
    new BridgeClient(`http://127.0.0.1:${f.bridge.port}`, f.token),
    { chatId: peer },
  );
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await f.connect();
    await f.provider.events.messages([message("mcp-context")]);
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(
      tools.tools.some((t) => /link|qr/i.test(t.name)),
      false,
    );
    const context = await client.callTool({
      name: "conversation.get_context",
      arguments: {},
    });
    assert.equal(context.isError, undefined);
    const denied = await client.callTool({
      name: "conversation.send",
      arguments: {
        chatId: owner,
        text: "synthetic",
        idempotencyKey: "scope-denied",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(f.provider.sends.length, 0);
    const sent = await client.callTool({
      name: "conversation.send",
      arguments: { text: "synthetic", idempotencyKey: "mcp-send" },
    });
    assert.equal(sent.isError, undefined);
    assert.equal(f.provider.sends.length, 1);
  } finally {
    await client.close();
    await server.close();
    await f.cleanup();
  }
});

test("shutdown marks in-flight sends unknown and duplicate concurrent requests never send twice", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.provider.block = new Promise(() => {});
    const started = new Promise<void>(
      (resolve) => (f.provider.onSend = resolve),
    );
    const body = {
      accountId: "default",
      chatId: peer,
      text: "synthetic",
      idempotencyKey: "pending-shutdown",
    };
    const pending = f.request("/v1/messages", body);
    await started;
    const duplicate = await (await f.request("/v1/messages", body)).json();
    assert.equal(duplicate.send.status, "sending");
    assert.equal(f.provider.sends.length, 1);
    const closedAt = Date.now();
    await f.bridge.close();
    assert.ok(
      Date.now() - closedAt < 2000,
      "shutdown should cancel the bounded send wait",
    );
    assert.equal(
      (await (await pending).json()).send.status,
      "delivery_unknown",
    );
  } finally {
    await f.cleanup();
  }
});
