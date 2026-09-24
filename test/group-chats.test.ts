import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import {
  BaileysProvider,
  canonicalJid,
  normalizeMessage,
  normalizeUpdate,
  encryptedAuthentication,
} from "../src/baileys-provider.js";
import {
  requireChat,
  individualJid,
  type BridgeMessage,
  type ProviderEvents,
} from "../src/types.js";
import {
  BridgeStore,
  BridgeClient,
  startBridge,
  createMcpServer,
} from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const group = "120363000000001234@g.us",
  legacy = "15550000001-1700000000@g.us",
  owner = "15550000001@s.whatsapp.net",
  peer = "15550000002@s.whatsapp.net",
  lid = "123450000000001@lid";
const raw = (
  chatId = group,
  fromMe = false,
  participant: string | undefined = peer,
) => ({
  key: {
    id: "synthetic-group-message",
    remoteJid: chatId,
    fromMe,
    ...(participant ? { participant } : {}),
  },
  message: { conversation: "HAL ON" },
  messageTimestamp: Math.floor(Date.now() / 1000),
});
test("group identifiers are valid chats but never personal identities; broadcasts/newsletters remain unsupported", () => {
  for (const value of [group, legacy, owner, lid])
    assert.equal(requireChat(value), value);
  for (const value of [group, legacy]) {
    assert.equal(individualJid(value), false);
    assert.equal(canonicalJid(value), undefined);
  }
  for (const value of [
    "status@broadcast",
    "15550000001@broadcast",
    "123456@newsletter",
    "bad@g.us",
    "12345--67890@g.us",
    "12345:1@g.us",
    "123456@g.us/extra",
  ])
    assert.throws(() => requireChat(value));
});
test("group authors come from authenticated participant or own account, never group identity, title or admin claims", () => {
  const resolved: string[] = [];
  const resolve = (id: string) => {
    resolved.push(id);
    return id === lid ? peer : id;
  };
  const inbound = normalizeMessage(
    "default",
    raw(group, false, lid),
    "live",
    [owner],
    resolve,
  )!;
  assert.ok(inbound);
  assert.equal(inbound.chatId, group);
  assert.equal(inbound.authorId, peer);
  assert.equal(inbound.fromMe, false);
  assert.equal(inbound.identityVerified, true);
  assert.equal(resolved.includes(group), false);
  const own = normalizeMessage(
    "default",
    raw(legacy, true, peer),
    "live",
    [owner],
    resolve,
  )!;
  assert.equal(own.authorId, owner);
  assert.equal(own.fromMe, true);
  for (const participant of [undefined, group, "status@broadcast", "invalid"]) {
    const input = raw(group, false, participant);
    if (participant === undefined) delete input.key.participant;
    assert.equal(normalizeMessage("default", input, "live", [owner]), null);
  }
  const deletion = normalizeUpdate(
    "default",
    {
      key: { id: "synthetic-group-message", remoteJid: group, fromMe: false },
      update: {
        message: null,
        messageStubType: proto.WebMessageInfo.StubType.REVOKE,
      },
    },
    [owner],
  );
  assert.equal(deletion?.origin, "delete");
  assert.equal(deletion?.identityVerified, false);
  assert.equal(deletion?.authorId, "unknown");
  const media = normalizeMessage(
    "default",
    {
      ...raw(),
      message: {
        documentMessage: {
          caption: "HAL inspect this",
          fileName: "untrusted.txt",
          mimetype: "text/plain",
          contextInfo: { isForwarded: true, stanzaId: "quoted" },
        },
      },
    },
    "history",
    [owner],
  );
  assert.equal(media?.attachments?.[0]?.kind, "document");
  assert.equal(media?.origin, "history");
  assert.equal(media?.quoted, true);
  assert.equal(media?.forwarded, true);
});
test("group/self-chat live intake preserves freshness, observes participant aliases only, and quotes the original participant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-group-provider-"));
  const store = new BridgeStore(directory, randomBytes(32));
  const credentials = store.credentials("default");
  const auth = encryptedAuthentication(credentials);
  auth.state.creds.registered = true;
  auth.state.creds.me = { id: owner };
  auth.save();
  const ev = new EventEmitter(),
    messages: BridgeMessage[] = [],
    sent: any[] = [];
  const provider = new BaileysProvider(
    "default",
    credentials,
    {
      connection: async () => {},
      messages: async (batch) => {
        messages.push(...batch);
      },
      delivery: async () => {},
    },
    (() => ({
      ev,
      end: () => {},
      sendMessage: async (...args: any[]) => {
        sent.push(args);
        return { key: { id: args[2].messageId } };
      },
    })) as any,
  );
  try {
    await provider.connect({ allowPairing: false });
    ev.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    });
    ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          ...raw(group, false, lid),
          key: {
            ...raw(group, false, lid).key,
            participantAlt: peer,
            remoteJidAlt: owner,
          },
        },
        {
          ...raw(owner, true, owner),
          key: { ...raw(owner, true, owner).key, id: "synthetic-self" },
        },
      ],
    });
    ev.emit("messages.upsert", {
      type: "append",
      messages: [{ ...raw(), key: { ...raw().key, id: "synthetic-history" } }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.authorId, peer);
    assert.equal(messages[0]?.origin, "live");
    assert.equal(messages[1]?.origin, "live");
    assert.equal(messages[2]?.origin, "history");
    assert.equal(credentials.get("canonical", group), undefined);
    await provider.send({
      chatId: group,
      text: "synthetic response",
      messageId: "stable-group-send",
      quote: messages[0],
    });
    assert.equal(sent[0][0], group);
    assert.equal(sent[0][2].quoted.key.participant, peer);
    assert.equal(sent[0][2].messageId, "stable-group-send");
  } finally {
    await provider.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("HTTP/archive/MCP group flow keeps attachments and idempotency scoped without granting ownership to the group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wa-group-api-"));
  let events!: ProviderEvents;
  const sent: any[] = [];
  const token = randomBytes(32).toString("hex");
  const bridge = await startBridge({
    dataDir: directory,
    token,
    masterKey: randomBytes(32),
    providerFactory: (_id, _auth, e) => {
      events = e;
      return {
        connect: async () => {
          await e.connection({
            state: "connected",
            identityIds: [owner, group],
          });
        },
        close: async () => {},
        logout: async () => {},
        send: async (input) => {
          sent.push(input);
          return { messageId: input.messageId };
        },
      };
    },
  });
  const sdk = new BridgeClient(`http://127.0.0.1:${bridge.port}`, token),
    client = new Client({ name: "synthetic-group-test", version: "1" });
  let server: ReturnType<typeof createMcpServer> | undefined;
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    server = createMcpServer(sdk, { chatId: group });
    await bridge.service.link("default");
    assert.deepEqual((await sdk.accounts()).accounts[0]?.identityIds, [owner]);
    const message = normalizeMessage("default", raw(), "live", [owner])!;
    await events.messages([
      message,
      message,
      { ...message, messageId: "bad-author", authorId: group },
    ]);
    assert.equal((await sdk.messages("default", group)).messages.length, 1);
    assert.equal((await sdk.chats()).chats[0]?.chatId, group);
    const { attachment } = await sdk.uploadAttachment(
      "default",
      group,
      { kind: "document", mimeType: "text/plain" },
      Buffer.from("synthetic document"),
    );
    await assert.rejects(
      sdk.downloadAttachment("default", legacy, attachment.attachmentId),
    );
    const input = {
      accountId: "default",
      chatId: group,
      text: "",
      attachmentId: attachment.attachmentId,
      quoteMessageId: message.messageId,
      idempotencyKey: "group-upload-send",
    };
    await sdk.send(input);
    await sdk.send(input);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].quote.authorId, peer);
    await Promise.all([server.connect(b), client.connect(a)]);
    assert.equal(
      (
        await client.callTool({
          name: "conversation.get_context",
          arguments: {},
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await client.callTool({
          name: "conversation.get_context",
          arguments: { chatId: legacy },
        })
      ).isError,
      true,
    );
    const removed = normalizeUpdate(
      "default",
      {
        key: { id: message.messageId, remoteJid: group },
        update: {
          message: null,
          messageStubType: proto.WebMessageInfo.StubType.REVOKE,
        },
      },
      [owner],
    )!;
    await events.messages([removed]);
    assert.equal(
      (await sdk.messages("default", group)).messages[0]?.origin,
      "delete",
    );
  } finally {
    await client.close();
    await server?.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
