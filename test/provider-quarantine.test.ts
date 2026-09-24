import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BaileysProvider,
  encryptedAuthentication,
} from "../src/baileys-provider.js";
import { BridgeStore } from "../src/store.js";
import { IdentityMap } from "../src/identity-map.js";
import type { BridgeMessage } from "../src/types.js";
const owner = "15550000001@s.whatsapp.net",
  ownerLid = "123450000000001@lid",
  bad = "15550000002@s.whatsapp.net",
  good = "15550000003@s.whatsapp.net",
  badLid = "123450000000002@lid",
  otherLid = "123450000000003@lid",
  group = "120363000000001234@g.us";
const raw = (
  id: string,
  chatId = good,
  fromMe = false,
  participant?: string,
) => ({
  key: {
    id,
    remoteJid: chatId,
    fromMe,
    ...(participant ? { participant } : {}),
  },
  message: { conversation: "synthetic instruction" },
  messageTimestamp: Math.floor(Date.now() / 1000),
});
async function fixture(withOwnerLid = true) {
  const directory = await mkdtemp(join(tmpdir(), "wa-quarantine-provider-")),
    store = new BridgeStore(directory, randomBytes(32));
  const credentials = store.credentials("default"),
    identity = new IdentityMap(credentials);
  const auth = encryptedAuthentication(credentials);
  auth.state.creds.registered = true;
  auth.state.creds.me = {
    id: owner,
    ...(withOwnerLid ? { lid: ownerLid } : {}),
  };
  auth.save();
  const ev = new EventEmitter(),
    messages: BridgeMessage[] = [],
    updates: any[] = [],
    sends: any[] = [];
  let sockets = 0,
    downloads = 0;
  const provider = new BaileysProvider(
    "default",
    credentials,
    {
      connection: async (value) => {
        updates.push(value);
      },
      messages: async (batch) => {
        messages.push(...batch);
      },
      delivery: async () => {},
    },
    (() => {
      sockets++;
      return {
        ev,
        end: () => {},
        sendMessage: async (...args: any[]) => {
          sends.push(args);
          return { key: { id: args[2].messageId } };
        },
      };
    }) as any,
    (async () => {
      downloads++;
      return Readable.from([Buffer.from([1, 2, 3])]);
    }) as any,
  );
  return {
    credentials,
    identity,
    ev,
    messages,
    updates,
    sends,
    provider,
    get sockets() {
      return sockets;
    },
    get downloads() {
      return downloads;
    },
    start: async () => {
      await provider.connect({ allowPairing: false });
      ev.emit("connection.update", {
        connection: "open",
        receivedPendingNotifications: true,
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
    close: async () => {
      await provider.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("legacy conflict does not block a healthy connection and owner aliases are learned at connect", async () => {
  const f = await fixture();
  try {
    f.credentials.set("identity", "conflict", true);
    await f.start();
    assert.equal(f.sockets, 1);
    assert.equal(f.updates.at(-1).state, "connected");
    assert.equal(f.identity.resolve(ownerLid), owner);
  } finally {
    await f.close();
  }
});
test("one quarantined participant cannot freeze healthy direct/group traffic, but scoped send is rejected", async () => {
  const f = await fixture();
  try {
    f.identity.observe(bad, badLid);
    f.identity.observe(bad, otherLid);
    await f.start();
    f.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        raw("bad-direct", bad),
        raw("good-direct", good),
        raw("bad-group", group, false, badLid),
        raw("good-group", group, false, good),
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.messages.map((m) => m.messageId),
      ["good-direct", "good-group"],
    );
    assert.equal(f.updates.at(-1).state, "connected");
    assert.equal(f.updates.at(-1).diagnosticCode, "identity_conflict");
    await f.provider.send({
      chatId: good,
      text: "synthetic",
      messageId: "good-send",
    });
    await assert.rejects(
      f.provider.send({
        chatId: bad,
        text: "synthetic",
        messageId: "bad-send",
      }),
      /identity_conflict/,
    );
    assert.equal(f.sends.length, 1);
    f.ev.emit("messages.delete", {
      keys: [raw("bad-direct", bad).key, raw("good-direct", good).key],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.messages.at(-1)?.messageId, "good-direct");
    assert.equal(f.messages.at(-1)?.origin, "delete");
  } finally {
    await f.close();
  }
});
test("a quarantined account owner cannot authorize through fromMe or send while healthy incoming participants still flow", async () => {
  const f = await fixture();
  try {
    await f.start();
    f.identity.observe(owner, otherLid);
    f.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        raw("owner-group", group, true),
        raw("healthy-group", group, false, good),
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.messages.find((m) => m.messageId === "owner-group")?.identityVerified,
      false,
    );
    assert.equal(
      f.messages.find((m) => m.messageId === "healthy-group")?.identityVerified,
      true,
    );
    await assert.rejects(
      f.provider.send({
        chatId: group,
        text: "synthetic",
        messageId: "owner-conflicted-send",
      }),
      /owner_identity_conflict/,
    );
    assert.equal(f.sends.length, 0);
  } finally {
    await f.close();
  }
});

test("owner aliases learned on credential updates preserve authentication without requiring a restart", async () => {
  const f = await fixture(false);
  try {
    await f.start();
    f.ev.emit("creds.update", { me: { id: owner, lid: ownerLid } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.identity.resolve(ownerLid), owner);
    assert.equal(f.identity.isQuarantined(owner), false);
  } finally {
    await f.close();
  }
});

test("all aliases in one notification batch are checked before any author is accepted and healthy history stays history", async () => {
  const f = await fixture();
  try {
    await f.start();
    const aliased = (id: string, lid: string) => ({
      ...raw(id, bad),
      key: { ...raw(id, bad).key, remoteJidAlt: lid },
    });
    f.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        aliased("earlier-conflicting", badLid),
        raw("healthy-before", good),
        aliased("later-conflicting", otherLid),
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.messages.map((m) => m.messageId),
      ["healthy-before"],
    );
    f.ev.emit("messaging-history.set", {
      messages: [
        raw("bad-history", bad),
        raw("good-history", group, false, good),
      ],
      lidPnMappings: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.messages.at(-1)?.messageId, "good-history");
    assert.equal(f.messages.at(-1)?.origin, "history");
    assert.equal(
      f.messages.some((m) => m.messageId === "bad-history"),
      false,
    );
    f.ev.emit("messages.update", [
      {
        key: raw("bad-edit", bad).key,
        update: { message: { conversation: "synthetic edit" } },
      },
      {
        key: raw("good-edit", group, false, good).key,
        update: { message: { conversation: "synthetic edit" } },
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.messages.at(-1)?.messageId, "good-edit");
    assert.equal(f.messages.at(-1)?.origin, "edit");
    assert.equal(
      f.messages.some((m) => m.messageId === "bad-edit"),
      false,
    );
    f.ev.emit("messages.delete", {
      keys: [{ id: "group-tombstone", remoteJid: group }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.messages.at(-1)?.origin, "delete");
    assert.equal(f.messages.at(-1)?.authorId, "unknown");
    assert.equal(f.messages.at(-1)?.identityVerified, false);
    f.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.updates.at(-1)?.state, "logged_out");
  } finally {
    await f.close();
  }
});
test("quarantine denies only affected attachment locators and healthy group downloads remain readable", async () => {
  const f = await fixture();
  try {
    await f.start();
    const media = (id: string, participant: string) => ({
      ...raw(id, group, false, participant),
      message: {
        imageMessage: {
          mimetype: "image/png",
          url: "https://mmg.whatsapp.net/synthetic",
          directPath: "/synthetic",
          mediaKey: Buffer.from("synthetic"),
          fileLength: 3,
        },
      },
    });
    f.ev.emit("messages.upsert", {
      type: "notify",
      messages: [media("bad-media", bad), media("good-media", good)],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const badId = f.messages.find((m) => m.messageId === "bad-media")!
        .attachments![0]!.attachmentId,
      goodId = f.messages.find((m) => m.messageId === "good-media")!
        .attachments![0]!.attachmentId;
    f.identity.observe(bad, badLid);
    f.identity.observe(bad, otherLid);
    await assert.rejects(
      f.provider.downloadAttachment({ attachmentId: badId }),
      /identity_conflict/,
    );
    assert.deepEqual(
      await f.provider.downloadAttachment({ attachmentId: goodId }),
      Buffer.from([1, 2, 3]),
    );
    assert.equal(f.downloads, 1);
  } finally {
    await f.close();
  }
});

test("new contradictory aliases from edits and deletions are quarantined before publishing the batch", async () => {
  for (const event of ["messages.update", "messages.delete"]) {
    const f = await fixture();
    try {
      await f.start();
      const keys = [
        { ...raw("first-conflict", bad).key, remoteJidAlt: badLid },
        raw("healthy", good).key,
        { ...raw("second-conflict", bad).key, remoteJidAlt: otherLid },
      ];
      f.ev.emit(
        event,
        event === "messages.update"
          ? keys.map((key) => ({
              key,
              update: { message: { conversation: "synthetic edit" } },
            }))
          : { keys },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.identity.isQuarantined(bad), true);
      assert.deepEqual(
        f.messages.map((message) => message.messageId),
        ["healthy"],
      );
      assert.equal(f.updates.at(-1)?.state, "connected");
      assert.equal(f.updates.at(-1)?.diagnosticCode, "identity_conflict");
    } finally {
      await f.close();
    }
  }
});
