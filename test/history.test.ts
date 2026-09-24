import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startBridge, BridgeClient, createMcpServer } from "../src/index.js";
import type { BridgeMessage, ProviderEvents } from "../src/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const chat = "15551234567@s.whatsapp.net",
  other = "15557654321@s.whatsapp.net";
const historical = (
  n: number,
  overrides: Partial<BridgeMessage> = {},
): BridgeMessage => ({
  accountId: "default",
  chatId: chat,
  messageId: `history-${n}`,
  authorId: chat,
  text: `HAL synthetic historical ${n}`,
  timestamp: new Date(946684800000 + n * 1000).toISOString(),
  fromMe: true,
  identityVerified: true,
  origin: "history",
  ...overrides,
});
async function fixture(historyRetentionDays?: number | null) {
  const directory = await mkdtemp(join(tmpdir(), "wa-archive-"));
  const token = randomBytes(32).toString("base64url"),
    key = randomBytes(32);
  let now = new Date("2026-01-01T00:00:00Z"),
    events!: ProviderEvents;
  const options = {
    dataDir: directory,
    token,
    masterKey: key,
    now: () => now,
    ...(historyRetentionDays === undefined ? {} : { historyRetentionDays }),
    providerFactory: (
      _id: string,
      _auth: unknown,
      callbacks: ProviderEvents,
    ) => {
      events = callbacks;
      return {
        connect: async () => {
          await callbacks.connection({
            state: "connected",
            identityIds: [other],
          });
        },
        close: async () => {},
        logout: async () => {},
        send: async () => {
          throw new Error("must_not_send");
        },
      };
    },
  };
  let bridge = await startBridge(options);
  const request = (query = "", selected = chat) =>
    fetch(
      `http://127.0.0.1:${bridge.port}/v1/chats/${encodeURIComponent(selected)}/messages?accountId=default&${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  return {
    directory,
    request,
    get bridge() {
      return bridge;
    },
    get events() {
      return events;
    },
    get client() {
      return new BridgeClient(`http://127.0.0.1:${bridge.port}`, token);
    },
    async connect() {
      await bridge.service.link("default");
    },
    advance(days: number) {
      now = new Date(now.getTime() + days * 86400000);
    },
    async restart() {
      await bridge.close();
      bridge = await startBridge(options);
    },
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("default archive survives journal expiry and restart, stays encrypted, and history never becomes live", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const messages = [historical(1, { text: "HAL ON" }), historical(2)];
    await f.events.messages(messages);
    await f.events.messages(messages);
    assert.equal(f.bridge.store.eventsAfter("0").length, 2);
    assert.ok(
      f.bridge.store
        .eventsAfter("0")
        .every((event) => event.message.origin === "history"),
    );
    f.advance(400);
    f.bridge.store.prune();
    await f.restart();
    assert.equal((await (await f.request()).json()).messages.length, 2);
    assert.throws(() => f.bridge.store.eventsAfter("0"), /cursor_expired/);
    await f.connect();
    await f.events.messages([
      historical(1, { text: "HAL ON", origin: "live" }),
    ]);
    assert.equal(f.bridge.store.head(), "2");
    assert.equal(
      f.bridge.store.message("default", chat, "history-1")?.origin,
      "history",
    );
    const metadata = (await f.client.accounts()).accounts[0]!;
    assert.equal(metadata.history?.storedMessages, 2);
    assert.equal(metadata.history?.retentionDays, null);
    for (const name of ["bridge.sqlite", "bridge.sqlite-wal"]) {
      const bytes = await readFile(join(f.directory, name)).catch(() =>
        Buffer.alloc(0),
      );
      assert.equal(bytes.includes("HAL synthetic historical"), false);
    }
  } finally {
    await f.close();
  }
});

test("backward pages use chat-scoped cursors, stable chronological ordering and an explicit end", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.events.messages([
      historical(1),
      historical(2),
      historical(3),
      historical(4),
      historical(5),
      historical(6),
      historical(99, { chatId: other, messageId: "foreign-cursor" }),
    ]);
    const latest = await (await f.request("limit=2")).json();
    assert.deepEqual(
      latest.messages.map((m: BridgeMessage) => m.messageId),
      ["history-5", "history-6"],
    );
    assert.equal(latest.nextBefore, "history-5");
    const middle = await (
      await f.request(`limit=2&before=${latest.nextBefore}`)
    ).json();
    assert.deepEqual(
      middle.messages.map((m: BridgeMessage) => m.messageId),
      ["history-3", "history-4"],
    );
    assert.equal(middle.nextBefore, "history-3");
    const first = await (
      await f.request(`limit=2&before=${middle.nextBefore}`)
    ).json();
    assert.deepEqual(
      first.messages.map((m: BridgeMessage) => m.messageId),
      ["history-1", "history-2"],
    );
    assert.equal(first.nextBefore, undefined);
    assert.deepEqual(await (await f.request("before=history-1")).json(), {
      messages: [],
    });
    assert.equal((await f.request("before=foreign-cursor")).status, 404);
    assert.equal(
      (await f.request("before=history-3&after=history-1")).status,
      400,
    );
    const after = await (await f.request("after=history-2&limit=2")).json();
    assert.deepEqual(
      after.messages.map((m: BridgeMessage) => m.messageId),
      ["history-3", "history-4"],
    );
  } finally {
    await f.close();
  }
});

test("finite archive retention is independent from the seven-day operational journal", async () => {
  const f = await fixture(30);
  try {
    await f.connect();
    await f.events.messages([historical(1)]);
    f.advance(8);
    f.bridge.store.prune();
    assert.equal((await (await f.request()).json()).messages.length, 1);
    assert.throws(() => f.bridge.store.eventsAfter("0"), /cursor_expired/);
    f.advance(23);
    f.bridge.store.prune();
    assert.equal((await (await f.request()).json()).messages.length, 0);
  } finally {
    await f.close();
  }
});

test("MCP paginates archived history through the API without changing its configured chat scope", async () => {
  const f = await fixture();
  const server = createMcpServer(f.client, { chatId: chat });
  const client = new Client({ name: "synthetic-history", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await f.connect();
    await f.events.messages([historical(1), historical(2), historical(3)]);
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const page = await client.callTool({
      name: "conversation.get_context",
      arguments: { before: "history-3", limit: 1 },
    });
    assert.deepEqual(
      (page.structuredContent as any).messages.map(
        (m: BridgeMessage) => m.messageId,
      ),
      ["history-2"],
    );
    assert.equal(page.structuredContent?.nextBefore, "history-2");
    assert.equal(
      (
        await client.callTool({
          name: "conversation.get_context",
          arguments: { chatId: other, before: "history-3" },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
