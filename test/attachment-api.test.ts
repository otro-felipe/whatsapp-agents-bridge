import test from "node:test";
import assert from "node:assert/strict";
import fileSystem from "node:fs/promises";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  startBridge,
  BridgeClient,
  createMcpServer,
  MAX_ATTACHMENT_BYTES,
} from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertPrivatePath } from "./private-path-assertion.js";
const chat = "15550000001@s.whatsapp.net",
  other = "15550000002@s.whatsapp.net";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wa-attachment-api-"));
  const token = randomBytes(32).toString("hex");
  let events: any;
  const sends: any[] = [];
  const bridge = await startBridge({
    dataDir: directory,
    token,
    masterKey: randomBytes(32),
    providerFactory: (_id, _auth, e) => {
      events = e;
      return {
        connect: async () => {
          await e.connection({ state: "connected", identityIds: [other] });
        },
        close: async () => {},
        logout: async () => {},
        send: async (input) => {
          sends.push(input);
          return { messageId: input.messageId };
        },
      };
    },
  });
  await bridge.service.link("default");
  const base = `http://127.0.0.1:${bridge.port}`;
  const client = new BridgeClient(base, token);
  return {
    directory,
    bridge,
    client,
    base,
    token,
    sends,
    events,
    close: async () => {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("binary HTTP upload, scoped read/download and idempotent attachment send preserve bytes without descriptors", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 1, 2]);
    const { attachment } = await f.client.uploadAttachment(
      "default",
      chat,
      {
        kind: "document",
        mimeType: "application/octet-stream",
        fileName: "synthetic.bin",
      },
      bytes,
    );
    assert.equal(attachment.sizeBytes, 4);
    assert.deepEqual(
      await f.client.attachment("default", chat, attachment.attachmentId),
      { attachment },
    );
    assert.deepEqual(
      Buffer.from(
        await f.client.downloadAttachment(
          "default",
          chat,
          attachment.attachmentId,
        ),
      ),
      bytes,
    );
    assert.equal(
      (await f.client.attachments("default", chat)).attachments.length,
      1,
    );
    await assert.rejects(
      f.client.downloadAttachment("default", other, attachment.attachmentId),
    );
    const request = {
      accountId: "default",
      chatId: chat,
      text: "",
      attachmentId: attachment.attachmentId,
      idempotencyKey: "synthetic-attachment-send",
    };
    const first = await f.client.send(request),
      second = await f.client.send(request);
    assert.equal(first.send.messageId, second.send.messageId);
    assert.equal(f.sends.length, 1);
    assert.deepEqual(Buffer.from(f.sends[0].attachment.bytes), bytes);
    const response = await fetch(
      `${f.base}/v1/chats/${chat}/attachments/${attachment.attachmentId}/content`,
      { headers: { authorization: `Bearer ${f.token}` } },
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-disposition"), "attachment");
  } finally {
    await f.close();
  }
});
test("binary HTTP boundaries reject missing auth, hostile Origin/Host and oversized declarations before reading content", async () => {
  const f = await fixture();
  try {
    const path = `${f.base}/v1/chats/${chat}/attachments?accountId=default&kind=document`;
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: Buffer.from([1]),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            origin: "https://evil.test",
            "content-type": "application/octet-stream",
          },
          body: Buffer.from([1]),
        })
      ).status,
      403,
    );
    const { request } = await import("node:http");
    const hostileHost = await new Promise<number>((resolve) => {
      const req = request(
        path,
        { headers: { authorization: `Bearer ${f.token}`, host: "evil.test" } },
        (res) => {
          resolve(res.statusCode!);
          res.resume();
        },
      );
      req.end();
    });
    assert.equal(hostileHost, 403);
    const status = await new Promise<number>((resolve) => {
      const req = request(
        path,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/octet-stream",
            "content-length": MAX_ATTACHMENT_BYTES + 1,
          },
        },
        (res) => {
          resolve(res.statusCode!);
          res.resume();
        },
      );
      req.on("error", () => {});
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await f.close();
  }
});
test("MCP uploads a local regular file, lists metadata, sends by attachmentId and downloads private unique paths", async () => {
  const f = await fixture();
  const server = createMcpServer(f.client, { chatId: chat });
  const client = new Client({
    name: "synthetic-attachment-test",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const downloads: string[] = [];
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const source = join(f.directory, "fixture.txt");
    await writeFile(source, "synthetic attachment", { mode: 0o600 });
    const uploaded = await client.callTool({
      name: "attachment.upload",
      arguments: { filePath: source },
    });
    assert.equal(uploaded.isError, undefined);
    const attachment = (uploaded.structuredContent as any).attachment;
    const listed = await client.callTool({
      name: "attachments.list",
      arguments: {},
    });
    assert.equal((listed.structuredContent as any).attachments.length, 1);
    const sent = await client.callTool({
      name: "conversation.send",
      arguments: {
        text: "",
        attachmentId: attachment.attachmentId,
        idempotencyKey: "synthetic-mcp-send",
      },
    });
    assert.equal(sent.isError, undefined);
    for (let n = 0; n < 2; n++) {
      const result = await client.callTool({
        name: "attachment.download",
        arguments: { attachmentId: attachment.attachmentId },
      });
      assert.equal(result.isError, undefined);
      const output = result.structuredContent as any;
      downloads.push(output.filePath);
      assert.equal(
        (await readFile(output.filePath)).toString(),
        "synthetic attachment",
      );
      assertPrivatePath(output.filePath);
      assertPrivatePath(dirname(output.filePath), true);
      assert.equal(
        JSON.stringify(output).includes("synthetic attachment"),
        false,
      );
    }
    assert.notEqual(downloads[0], downloads[1]);
    const forbidden = await client.callTool({
      name: "attachment.download",
      arguments: { chatId: other, attachmentId: attachment.attachmentId },
    });
    assert.equal(forbidden.isError, true);
    await symlink(source, join(f.directory, "symlink.txt"));
    for (const filePath of [f.directory, join(f.directory, "symlink.txt")])
      assert.equal(
        (
          await client.callTool({
            name: "attachment.upload",
            arguments: { filePath },
          })
        ).isError,
        true,
      );
    const large = await open(join(f.directory, "large.bin"), "w");
    await large.truncate(MAX_ATTACHMENT_BYTES + 1);
    await large.close();
    assert.equal(
      (
        await client.callTool({
          name: "attachment.upload",
          arguments: { filePath: join(f.directory, "large.bin") },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await server.close();
    for (const path of downloads)
      await rm(dirname(path), { recursive: true, force: true });
    await f.close();
  }
});

test("MCP rejects files replaced during upload before reading any bytes", async (t) => {
  const f = await fixture();
  const server = createMcpServer(f.client, { chatId: chat });
  const client = new Client({ name: "synthetic-race-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const originalOpen = fileSystem.open.bind(fileSystem);
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    for (const boundary of ["before-open", "after-open"]) {
      const source = join(f.directory, `synthetic-${boundary}.txt`);
      await writeFile(source, "synthetic original");
      let reads = 0;
      const replace = async () => {
        await fileSystem.rename(source, `${source}.original`);
        await writeFile(source, "synthetic replacement");
      };
      t.mock.method(
        fileSystem,
        "open",
        async (...args: Parameters<typeof originalOpen>) => {
          if (args[0] === source && boundary === "before-open") await replace();
          const handle = await originalOpen(...args);
          if (args[0] === source) {
            if (boundary === "after-open") await replace();
            const read = handle.read.bind(handle);
            t.mock.method(handle, "read", (...input: any[]) => {
              reads++;
              return (read as any)(...input);
            });
          }
          return handle;
        },
      );
      const output = await client.callTool({
        name: "attachment.upload",
        arguments: { filePath: source },
      });
      assert.equal(output.isError, true, boundary);
      assert.equal(reads, 0, boundary);
      t.mock.restoreAll();
    }
    assert.equal(
      (await f.client.attachments("default", chat)).attachments.length,
      0,
    );
  } finally {
    t.mock.restoreAll();
    await client.close();
    await server.close();
    await f.close();
  }
});
