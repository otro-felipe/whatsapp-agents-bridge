import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  normalizeMessage,
  normalizeUpdate,
  canonicalJid,
  encryptedAuthentication,
  BaileysProvider,
} from "../src/baileys-provider.js";
import { proto } from "@whiskeysockets/baileys";
import { BridgeStore } from "../src/store.js";
import { IdentityMap } from "../src/identity-map.js";

test("saved linked auth starts a connection and reports only allowlisted disconnect metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-diagnostics-provider-"));
  const key = randomBytes(32);
  let store = new BridgeStore(directory, key);
  const auth = encryptedAuthentication(store.credentials("default"));
  auth.state.creds.registered = true;
  auth.state.creds.me = {
    id: "15551234567:1@s.whatsapp.net",
    name: "synthetic",
  };
  auth.save();
  store.close();
  store = new BridgeStore(directory, key);
  const emitter = new EventEmitter();
  const updates: any[] = [];
  let created = 0;
  const provider = new BaileysProvider(
    "default",
    store.credentials("default"),
    {
      connection: async (update) => {
        updates.push(update);
      },
      messages: async () => {},
      delivery: async () => {},
    },
    ((config: any) => {
      created++;
      assert.equal(config.auth.creds.registered, true);
      return { ev: emitter, end: () => {} };
    }) as any,
  );
  try {
    await provider.connect({ allowPairing: false });
    assert.equal(created, 1);
    assert.deepEqual(updates.at(-1), {
      state: "reconnecting",
      diagnostics: { attemptStarted: true },
    });
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: {
          message: "synthetic-private-error",
          output: { statusCode: 515 },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates.at(-1), {
      state: "reconnecting",
      diagnostics: { disconnected: true, disconnectStatus: 515 },
    });
    assert.equal(
      JSON.stringify(updates).includes("synthetic-private-error"),
      false,
    );
  } finally {
    await provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("full history includes attachments, rejects groups without a participant, and never promotes old history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-history-provider-"));
  const store = new BridgeStore(directory, randomBytes(32));
  const emitter = new EventEmitter();
  let configuration: any;
  const messages: any[] = [],
    states: string[] = [];
  const provider = new BaileysProvider(
    "default",
    store.credentials("default"),
    {
      connection: async (update) => {
        states.push(update.state);
      },
      messages: async (batch) => {
        messages.push(...batch);
      },
      delivery: async () => {},
    },
    ((config: any) => {
      configuration = config;
      return { ev: emitter, end: () => {} };
    }) as any,
  );
  try {
    await provider.connect({ allowPairing: true });
    assert.equal(configuration.syncFullHistory, true);
    assert.deepEqual(
      configuration.browser,
      ["Mac OS", "Chrome", "14.4.1"],
      "history support must preserve the original linked browser profile",
    );
    assert.equal(
      configuration.shouldSyncHistoryMessage({
        syncType: proto.HistorySync.HistorySyncType.FULL,
      }),
      true,
    );
    emitter.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      states.at(-1),
      "connected",
      "linked status must not wait for pending history to finish",
    );
    const base = {
      key: {
        id: "old-command",
        remoteJid: "15551234567@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: 946684800,
      message: { conversation: "HAL ON" },
    };
    emitter.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [
        base,
        {
          ...base,
          key: { ...base.key, id: "image" },
          message: { imageMessage: { caption: "HAL command" } },
        },
        {
          ...base,
          key: { ...base.key, id: "group", remoteJid: "123456@g.us" },
        },
      ],
      progress: 50,
    });
    emitter.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          ...base,
          key: { ...base.key, id: "pending-notification" },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      messages.map((message) => message.messageId),
      ["old-command", "image", "pending-notification"],
    );
    assert.ok(messages.every((message) => message.origin === "history"));
  } finally {
    await provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pairing adapter waits for internal QR readiness, persists auth and never exposes QR during code pairing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-code-adapter-"));
  const store = new BridgeStore(directory, randomBytes(32));
  const emitter = new EventEmitter();
  let calls = 0,
    configuration: any;
  const updates: unknown[] = [];
  const socket = {
    ev: emitter,
    end: () => {},
    requestPairingCode: async (phone: string) => {
      assert.equal(phone, "15551234567");
      calls++;
      configuration.auth.creds.pairingCode = "TEST1234";
      emitter.emit("creds.update", configuration.auth.creds);
      return "TEST1234";
    },
  };
  const provider = new BaileysProvider(
    "default",
    store.credentials("default"),
    {
      connection: async (update) => {
        updates.push(update);
      },
      messages: async () => {},
      delivery: async () => {},
    },
    ((config: any) => {
      configuration = config;
      return socket;
    }) as any,
  );
  try {
    const pending = provider.requestPairingCode("15551234567");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    emitter.emit("connection.update", { qr: "synthetic-internal-qr" });
    assert.equal(await pending, "TEST1234");
    assert.equal(calls, 1);
    assert.equal(
      JSON.stringify(updates).includes("synthetic-internal-qr"),
      false,
    );
    assert.equal(
      encryptedAuthentication(store.credentials("default")).state.creds
        .pairingCode,
      "TEST1234",
    );
  } finally {
    await provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing adapter before socket readiness rejects pending code and ignores late QR", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-code-cancel-"));
  const store = new BridgeStore(directory, randomBytes(32));
  const emitter = new EventEmitter();
  let calls = 0;
  const provider = new BaileysProvider(
    "default",
    store.credentials("default"),
    {
      connection: async () => {},
      messages: async () => {},
      delivery: async () => {},
    },
    (() => ({
      ev: emitter,
      end: () => {},
      requestPairingCode: async () => {
        calls++;
        return "LATE1234";
      },
    })) as any,
  );
  try {
    const pending = provider.requestPairingCode("15551234567");
    const observed = assert.rejects(pending, /pairing_cancelled/);
    await new Promise((resolve) => setImmediate(resolve));
    await provider.close();
    emitter.emit("connection.update", { qr: "synthetic-late-qr" });
    await observed;
    assert.equal(calls, 0);
  } finally {
    await provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const peer = "56922222222@s.whatsapp.net";
const owner = "56911111111@s.whatsapp.net";
test("Baileys text normalization trusts provider owner metadata and carries forwarding/quotation flags", () => {
  const normalized = normalizeMessage(
    "default",
    {
      key: {
        id: "message-1",
        remoteJid: "56922222222:12@s.whatsapp.net",
        fromMe: true,
      },
      messageTimestamp: 1_700_000_000,
      message: {
        extendedTextMessage: {
          text: "HAL ON",
          contextInfo: {
            isForwarded: true,
            stanzaId: "quoted-id",
            quotedMessage: { conversation: "untrusted quoted command" },
          },
        },
      },
    },
    "live",
    [owner, "12345678901@lid"],
  );
  assert.equal(normalized?.authorId, owner);
  assert.equal(normalized?.chatId, peer);
  assert.equal(normalized?.identityVerified, true);
  assert.equal(normalized?.forwarded, true);
  assert.equal(normalized?.quoted, true);
  assert.equal(normalized?.origin, "live");
  assert.equal(normalized?.text, "HAL ON");
  const unverified = normalizeMessage(
    "default",
    {
      key: { id: "message-2", remoteJid: peer, fromMe: true },
      message: { conversation: "I am the owner" },
      messageTimestamp: 1,
    },
    "live",
    [],
  );
  assert.equal(unverified?.identityVerified, false);
  assert.equal(unverified?.authorId, "unknown");
  assert.equal(canonicalJid("12345-67890@g.us"), undefined);
});

test("normalization rejects groups without a participant and disappearing content while retaining media and edits", () => {
  const key = { id: "message-3", remoteJid: peer, fromMe: false };
  assert.equal(
    normalizeMessage(
      "default",
      {
        key: { ...key, remoteJid: "123456@g.us" },
        message: { conversation: "HAL ON" },
      },
      "live",
      [owner],
    ),
    null,
  );
  assert.equal(
    normalizeMessage(
      "default",
      { key, message: { imageMessage: { caption: "HAL ON" } } },
      "live",
      [owner],
    )?.attachments?.[0]?.kind,
    "image",
  );
  assert.equal(
    normalizeMessage(
      "default",
      {
        key,
        message: { ephemeralMessage: { message: { conversation: "HAL ON" } } },
      },
      "live",
      [owner],
    ),
    null,
  );
  const edited = normalizeMessage(
    "default",
    {
      key,
      message: { editedMessage: { message: { conversation: "edited text" } } },
    },
    "edit",
    [owner],
  );
  assert.equal(edited?.origin, "edit");
  assert.equal(edited?.text, "edited text");
});

test("Baileys authentication and Signal buffers survive encrypted SQLite roundtrip without plaintext fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-provider-test-"));
  const key = randomBytes(32);
  let store = new BridgeStore(directory, key);
  try {
    const auth = encryptedAuthentication(store.credentials("default"));
    auth.state.creds.me = { id: owner, lid: "12345678901@lid" };
    auth.save();
    await auth.state.keys.set({
      "pre-key": {
        synthetic: {
          public: Buffer.from([1, 2, 3]),
          private: Buffer.from([4, 5, 6]),
        },
      },
    });
    store.close();
    store = new BridgeStore(directory, key);
    const restored = encryptedAuthentication(store.credentials("default"));
    assert.equal(restored.state.creds.me?.id, owner);
    assert.deepEqual(
      (await restored.state.keys.get("pre-key", ["synthetic"])).synthetic
        ?.private,
      Buffer.from([4, 5, 6]),
    );
    await restored.state.keys.set({ "pre-key": { synthetic: null } });
    assert.equal(
      (await restored.state.keys.get("pre-key", ["synthetic"])).synthetic,
      undefined,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider revoke updates become deletion tombstones, never a fresh invocation", () => {
  const removed = normalizeUpdate(
    "default",
    {
      key: { id: "revoked-id", remoteJid: peer, fromMe: false },
      update: {
        message: null,
        messageStubType: proto.WebMessageInfo.StubType.REVOKE,
      },
    },
    [owner],
  );
  assert.equal(removed?.origin, "delete");
  assert.equal(removed?.text, "");
  assert.equal(removed?.messageId, "revoked-id");
});

test("authenticated PN/LID aliases keep the first observed canonical identity and fail closed on conflicting histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-identity-test-"));
  const store = new BridgeStore(directory, randomBytes(32));
  try {
    const identity = new IdentityMap(store.credentials("default"));
    const lid = "12345678901@lid";
    assert.equal(identity.resolve(lid), lid);
    assert.equal(identity.observe(peer, lid), true);
    assert.equal(identity.resolve(peer), lid);
    assert.equal(identity.resolve(lid), lid);
    const secondLid = "12345678902@lid",
      secondPn = "56933333333@s.whatsapp.net";
    identity.resolve(secondPn);
    identity.resolve(secondLid);
    assert.equal(identity.observe(secondPn, secondLid), true);
    assert.equal(identity.hasConflict(), false);
    assert.equal(identity.resolve(secondPn), secondPn);
    assert.equal(identity.resolve(secondLid), secondLid);
    assert.equal(identity.observe(secondPn, "12345678903@lid"), false);
    assert.equal(identity.isQuarantined(secondPn), true);
    assert.equal(identity.isQuarantined(secondLid), true);
    assert.equal(
      new IdentityMap(store.credentials("default")).hasConflict(),
      true,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
