import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeStore } from "../src/store.js";
import { BridgeService } from "../src/service.js";
import type {
  Attachment,
  BridgeMessage,
  ProviderEvents,
  ProviderPort,
} from "../src/types.js";

const chat = "15551234567@s.whatsapp.net",
  other = "15557654321@s.whatsapp.net";
const binary = Buffer.from("synthetic-private-attachment-body");
const attachment: Attachment = {
  attachmentId: "file-one",
  kind: "document",
  mimeType: "application/pdf",
  fileName: "synthetic-private-name.pdf",
  sizeBytes: binary.length,
};
function message(extra: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    accountId: "default",
    chatId: chat,
    messageId: "message-one",
    authorId: chat,
    text: "",
    timestamp: "2026-09-05T10:00:00.000Z",
    fromMe: false,
    origin: "history",
    identityVerified: true,
    attachments: [attachment],
    ...extra,
  };
}
async function fixture(limit = 64 * 1024 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "wa-attachments-core-")),
    key = randomBytes(32);
  let store = new BridgeStore(directory, key, undefined, 7, null, limit);
  let events!: ProviderEvents,
    downloads = 0,
    sends: any[] = [],
    failSend = false;
  let onDownload: (() => Promise<Uint8Array>) | undefined;
  const factory = (
    _account: string,
    _auth: unknown,
    callbacks: ProviderEvents,
  ): ProviderPort => {
    events = callbacks;
    return {
      connect: async () => {
        await events.connection({ state: "connected", identityIds: [chat] });
      },
      close: async () => {},
      logout: async () => {},
      downloadAttachment: async () => {
        downloads++;
        return onDownload ? onDownload() : binary;
      },
      send: async (input) => {
        sends.push(input);
        if (failSend) throw new Error("synthetic-uncertain");
        return { messageId: input.messageId };
      },
    };
  };
  let service = new BridgeService(store, factory);
  await service.link("default");
  return {
    directory,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get events() {
      return events;
    },
    get downloads() {
      return downloads;
    },
    sends,
    downloadWith(fn: () => Promise<Uint8Array>) {
      onDownload = fn;
    },
    fail() {
      failSend = true;
    },
    async restart() {
      await service.close();
      store.close();
      store = new BridgeStore(directory, key, undefined, 7, null, limit);
      service = new BridgeService(store, factory);
      await service.restore();
    },
    async close() {
      await service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("attachment-only history persists safe metadata and encrypted lazy cache across restart without eager downloads", async () => {
  const f = await fixture();
  try {
    await f.events.messages([
      message({
        attachments: [
          {
            ...attachment,
            mediaKey: "synthetic-private-locator",
            url: "https://invalid.test/private",
          } as any,
        ],
      }),
    ]);
    assert.equal(f.downloads, 0);
    assert.deepEqual(
      f.store.message("default", chat, "message-one")?.attachments,
      [attachment],
    );
    assert.deepEqual(f.store.eventsAfter("0")[0]?.message.attachments, [
      attachment,
    ]);
    assert.deepEqual(
      f.service.listAttachments("default", chat, "message-one"),
      [attachment],
    );
    assert.equal(
      JSON.stringify(f.store.eventsAfter("0")).includes(
        "synthetic-private-locator",
      ),
      false,
    );
    const pages = await Promise.all([
      f.service.downloadAttachment("default", chat, "file-one"),
      f.service.downloadAttachment("default", chat, "file-one"),
    ]);
    assert.deepEqual(Buffer.from(pages[0]!), binary);
    assert.equal(f.downloads, 1);
    await f.restart();
    assert.deepEqual(
      Buffer.from(
        await f.service.downloadAttachment("default", chat, "file-one"),
      ),
      binary,
    );
    assert.equal(f.downloads, 1);
    await assert.rejects(
      f.service.downloadAttachment("default", other, "file-one"),
      { code: "attachment_not_found" },
    );
    for (const name of await readdir(f.directory, { recursive: true })) {
      const bytes = await readFile(join(f.directory, name)).catch(() =>
        Buffer.alloc(0),
      );
      for (const secret of [
        binary,
        Buffer.from(attachment.fileName!),
        Buffer.from("synthetic-private-locator"),
      ])
        assert.equal(bytes.includes(secret), false);
    }
  } finally {
    await f.close();
  }
});

test("uploads and sends are scoped, immutable and idempotent with stable provider IDs and uncertain delivery", async () => {
  const f = await fixture();
  try {
    const uploaded = f.service.uploadAttachment(
      "default",
      chat,
      { kind: "document", mimeType: "application/pdf", fileName: "sample.pdf" },
      binary,
    );
    assert.equal(uploaded.sizeBytes, binary.length);
    const request = {
      accountId: "default",
      chatId: chat,
      text: "",
      attachmentId: uploaded.attachmentId,
      idempotencyKey: "send-file",
    };
    const result = await f.service.send(request);
    assert.equal(result.status, "sent");
    assert.equal(f.sends[0].messageId, result.messageId);
    assert.deepEqual(Buffer.from(f.sends[0].attachment.bytes), binary);
    assert.equal((await f.service.send(request)).sendId, result.sendId);
    assert.equal(f.sends.length, 1);
    const another = f.service.uploadAttachment(
      "default",
      chat,
      { kind: "document", mimeType: "application/pdf" },
      Buffer.from("other synthetic"),
    );
    await assert.rejects(
      f.service.send({ ...request, attachmentId: another.attachmentId }),
      { code: "idempotency_conflict" },
    );
    await assert.rejects(
      f.service.send({
        ...request,
        chatId: other,
        idempotencyKey: "wrong-scope",
      }),
      { code: "attachment_not_found" },
    );
    assert.equal(f.sends.length, 1);
    f.fail();
    const uncertain = await f.service.send({
      ...request,
      idempotencyKey: "uncertain",
    });
    assert.equal(uncertain.status, "delivery_unknown");
    await f.restart();
    assert.equal(
      (await f.service.send({ ...request, idempotencyKey: "uncertain" }))
        .status,
      "delivery_unknown",
    );
    assert.equal(f.sends.length, 2);
  } finally {
    await f.close();
  }
});

test("attachment size, metadata and filename validation precede transport and unsafe input never becomes a cache path", async () => {
  const f = await fixture(16);
  try {
    assert.throws(
      () =>
        f.service.uploadAttachment(
          "default",
          chat,
          { kind: "document", mimeType: "application/pdf" },
          binary,
        ),
      { code: "attachment_too_large" },
    );
    assert.throws(
      () =>
        f.service.uploadAttachment(
          "default",
          chat,
          {
            kind: "document",
            mimeType: "application/pdf",
            fileName: "../../escape",
          },
          Buffer.from("ok"),
        ),
      { code: "invalid_attachment_filename" },
    );
    assert.throws(
      () =>
        f.service.uploadAttachment(
          "default",
          chat,
          { kind: "image", mimeType: "text/html" },
          Buffer.from("ok"),
        ),
      { code: "invalid_attachment_mime" },
    );
    await f.events.messages([message()]);
    await assert.rejects(
      f.service.downloadAttachment("default", chat, "file-one"),
      { code: "attachment_too_large" },
    );
    assert.equal(f.downloads, 0);
  } finally {
    await f.close();
  }
});

test("attachment identifiers cannot be rebound to another chat and invalid items do not discard the remaining batch", async () => {
  const f = await fixture();
  try {
    await f.events.messages([
      message(),
      message({ chatId: other }),
      message({
        messageId: "invalid",
        attachments: [{ ...attachment, fileName: "../private" }],
      }),
      message({
        messageId: "valid-last",
        text: "synthetic final",
        attachments: [],
      }),
    ]);
    assert.equal(f.store.message("default", other, "message-one"), undefined);
    assert.equal(f.store.message("default", chat, "invalid"), undefined);
    assert.equal(
      f.store.message("default", chat, "valid-last")?.text,
      "synthetic final",
    );
    assert.equal(f.store.head(), "2");
  } finally {
    await f.close();
  }
});

test("late downloads after unlink and oversized unknown-size downloads never enter the cache", async () => {
  const f = await fixture();
  try {
    await f.events.messages([message()]);
    let resolve!: (bytes: Uint8Array) => void;
    f.downloadWith(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.service.downloadAttachment("default", chat, "file-one");
    await f.service.unlink("default");
    resolve(binary);
    await assert.rejects(pending, { code: "attachment_download_cancelled" });
    assert.equal(
      f.store.attachments.cached("default", chat, "file-one"),
      undefined,
    );
  } finally {
    await f.close();
  }
  const small = await fixture(16);
  try {
    await small.events.messages([
      message({
        attachments: [
          {
            attachmentId: "unknown-size",
            kind: "document",
            mimeType: "application/pdf",
          },
        ],
      }),
    ]);
    await assert.rejects(
      small.service.downloadAttachment("default", chat, "unknown-size"),
      { code: "attachment_too_large" },
    );
    assert.equal(small.downloads, 1);
    assert.equal(
      small.store.attachments.cached("default", chat, "unknown-size"),
      undefined,
    );
  } finally {
    await small.close();
  }
});

test("cache authentication detects tampering without downloading again and a file ID cannot change content", async () => {
  const f = await fixture();
  try {
    const uploaded = f.service.uploadAttachment(
      "default",
      chat,
      { kind: "document", mimeType: "application/pdf" },
      binary,
    );
    assert.throws(
      () =>
        f.store.attachments.cache(
          "default",
          chat,
          uploaded.attachmentId,
          Buffer.alloc(binary.length, 65),
        ),
      { code: "attachment_content_conflict" },
    );
    const names = await readdir(join(f.directory, "attachments"));
    const path = join(f.directory, "attachments", names[0]!);
    const ciphertext = await readFile(path);
    ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
    await writeFile(path, ciphertext);
    await assert.rejects(
      f.service.downloadAttachment("default", chat, uploaded.attachmentId),
      { code: "attachment_corrupt" },
    );
    assert.equal(f.downloads, 0);
  } finally {
    await f.close();
  }
});

test("replayed history enriches old metadata without fresh events and edit/delete snapshots preserve event provenance", async () => {
  const f = await fixture();
  try {
    await f.events.messages([
      message({ text: "old caption", attachments: [] }),
    ]);
    await f.events.messages([message({ text: "old caption" })]);
    assert.equal(f.store.head(), "1");
    assert.deepEqual(
      f.store.message("default", chat, "message-one")?.attachments,
      [attachment],
    );
    await f.events.messages([
      message({ origin: "edit", text: "edited caption" }),
    ]);
    await f.events.messages([message({ origin: "delete", attachments: [] })]);
    assert.equal(
      f.store.message("default", chat, "message-one")?.attachments,
      undefined,
    );
    assert.deepEqual(
      f.service.listAttachments("default", chat, "message-one"),
      [],
    );
    const history = f.store.eventsAfter("0");
    assert.deepEqual(
      history.map((event) => event.message.origin),
      ["history", "edit", "delete"],
    );
    assert.deepEqual(history[1]?.message.attachments, [attachment]);
    assert.equal(history[2]?.message.attachments, undefined);
  } finally {
    await f.close();
  }
});

test("unsupported captions fail before reserving an outbox ID or invoking transport", async () => {
  const f = await fixture();
  try {
    for (const kind of ["audio", "sticker"] as const) {
      const uploaded = f.service.uploadAttachment(
        "default",
        chat,
        { kind, mimeType: kind === "audio" ? "audio/ogg" : "image/webp" },
        binary,
      );
      const request = {
        accountId: "default",
        chatId: chat,
        text: "caption",
        attachmentId: uploaded.attachmentId,
        idempotencyKey: `caption-${kind}`,
      };
      await assert.rejects(f.service.send(request), {
        code: "attachment_caption_unsupported",
      });
      assert.equal(f.store.existingSend(request), undefined);
      assert.equal(f.sends.length, 0);
    }
  } finally {
    await f.close();
  }
});

test("chat attachment listing stays bounded to the latest fifty while message-scoped queries remain exact", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 70; index++) {
      const suffix = String(index).padStart(3, "0");
      await f.events.messages([
        message({
          messageId: `message-${suffix}`,
          attachments: [{ ...attachment, attachmentId: `file-${suffix}` }],
        }),
      ]);
    }
    const latest = f.service.listAttachments("default", chat);
    assert.equal(latest.length, 50);
    assert.equal(latest[0]?.attachmentId, "file-020");
    assert.equal(latest.at(-1)?.attachmentId, "file-069");
    assert.deepEqual(
      f.service
        .listAttachments("default", chat, "message-000")
        .map((item) => item.attachmentId),
      ["file-000"],
    );
  } finally {
    await f.close();
  }
});
