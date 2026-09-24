import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startBridge } from "../src/index.js";
import type { ProviderEvents, ProviderPort } from "../src/types.js";

const path = "/v1/accounts/default/pairing-code";
const phone = "15551234567";
async function fixture(requestTimeoutMs = 1000) {
  const directory = await mkdtemp(join(tmpdir(), "wa-code-test-"));
  const token = randomBytes(32).toString("base64url");
  let now = new Date("2026-09-05T12:00:00Z");
  let created = 0,
    requested = 0;
  let events!: ProviderEvents;
  let operation: () => Promise<string> = async () => "TEST1234";
  let closeCount = 0;
  const bridge = await startBridge({
    dataDir: directory,
    token,
    masterKey: randomBytes(32),
    now: () => now,
    pairingRequestTimeoutMs: requestTimeoutMs,
    providerFactory: (_id, _auth, callbacks) => {
      created++;
      events = callbacks;
      return {
        connect: async () => {
          await events.connection({
            state: "linking",
            qr: "synthetic-qr-only",
          });
        },
        requestPairingCode: async (value: string) => {
          assert.equal(value, phone);
          requested++;
          await callbacks.connection({
            state: "linking",
            qr: "synthetic-qr-only",
          });
          return operation();
        },
        close: async () => {
          closeCount++;
        },
        logout: async () => {},
        send: async () => {
          throw new Error("must_not_send");
        },
      } as ProviderPort;
    },
  });
  const request = (
    route: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`http://127.0.0.1:${bridge.port}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    bridge,
    request,
    get created() {
      return created;
    },
    get requested() {
      return requested;
    },
    get events() {
      return events;
    },
    get closeCount() {
      return closeCount;
    },
    setOperation(next: typeof operation) {
      operation = next;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("pairing code endpoint validates international digits before constructing a provider", async () => {
  const f = await fixture();
  try {
    for (const phoneNumber of [
      undefined,
      null,
      15551234567,
      "+15551234567",
      "012345678",
      "123456",
      "1".repeat(16),
      "1 5551234567",
    ]) {
      const response = await f.request(path, { phoneNumber });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_phone_number");
    }
    assert.equal(f.created, 0);
    assert.equal(f.requested, 0);
  } finally {
    await f.close();
  }
});

test("code is returned once through explicit POST and never accounts, GET link, events or QR state", async () => {
  const f = await fixture();
  try {
    const response = await f.request(path, { phoneNumber: phone });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, {
      state: "linking",
      code: "TEST1234",
      expiresAt: "2026-09-05T12:01:00.000Z",
    });
    const state = await (await f.request("/v1/accounts/default/link")).json();
    assert.deepEqual(state, { state: "linking" });
    assert.equal(
      JSON.stringify(await (await f.request("/v1/accounts")).json()).includes(
        "TEST1234",
      ),
      false,
    );
    assert.equal(f.bridge.store.eventsAfter("0").length, 0);
    assert.equal((await f.request(path)).status, 404);
    assert.equal((await f.request(path, { phoneNumber: phone })).status, 409);
    assert.equal(f.requested, 1);
  } finally {
    await f.close();
  }
});

test("already linked accounts reject code generation without a provider request", async () => {
  const f = await fixture();
  try {
    f.bridge.store.setAccount("default", "connected", [
      phone + "@s.whatsapp.net",
    ]);
    const response = await f.request(path, { phoneNumber: phone });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "already_linked");
    assert.equal(f.created, 0);
  } finally {
    await f.close();
  }
});

test("cancel invalidates a pending request and late completion, cooldown survives cancellation", async () => {
  const f = await fixture();
  try {
    let release!: (code: string) => void, started!: () => void;
    const invoked = new Promise<void>((resolve) => (started = resolve));
    f.setOperation(() => {
      started();
      return new Promise((resolve) => (release = resolve));
    });
    const pending = f.request(path, { phoneNumber: phone });
    await invoked;
    assert.equal((await f.request(path, { phoneNumber: phone })).status, 409);
    await f.request("/v1/accounts/default/link", undefined, "DELETE");
    const cancelled = await pending;
    assert.equal(cancelled.status, 409);
    assert.equal((await cancelled.json()).error.code, "pairing_cancelled");
    release("LATE1234");
    await f.events.connection({ state: "linking", qr: "late-qr" });
    assert.equal(
      (await (await f.request("/v1/accounts/default/link")).json()).qr,
      undefined,
    );
    assert.equal((await f.request(path, { phoneNumber: phone })).status, 429);
    assert.equal(f.bridge.store.account("default").state, "logged_out");
  } finally {
    await f.close();
  }
});

test("expired pairing permits a fresh explicit request, provider errors stay generic, and timeout never retries", async () => {
  const f = await fixture(20);
  try {
    assert.equal((await f.request(path, { phoneNumber: phone })).status, 200);
    f.advance(60_001);
    f.setOperation(async () => {
      throw new Error("synthetic-provider-private-detail");
    });
    const rejected = await f.request(path, { phoneNumber: phone });
    assert.equal(rejected.status, 502);
    assert.deepEqual(await rejected.json(), {
      error: { code: "pairing_failed" },
    });
    assert.equal((await f.request(path, { phoneNumber: phone })).status, 429);
    f.advance(60_001);
    f.setOperation(() => new Promise(() => {}));
    const timeout = await f.request(path, { phoneNumber: phone });
    assert.equal(timeout.status, 504);
    assert.equal((await timeout.json()).error.code, "pairing_timeout");
    assert.equal(f.requested, 3);
    assert.ok(f.closeCount >= 3);
  } finally {
    await f.close();
  }
});
