import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Child process timed out")),
      10_000,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function observe(child: ChildProcess) {
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdin!.on("error", () => {});
  child.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    },
  );
  // Node can omit ChildProcess "close" after parent-initiated IPC disconnect.
  // Await exit plus both output pipes so assertions still include final output.
  const closed = Promise.all([
    exited,
    new Promise<void>((resolve) => child.stdout!.once("close", resolve)),
    new Promise<void>((resolve) => child.stderr!.once("close", resolve)),
  ]).then(([result]) => result);
  return {
    child,
    closed,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async ready() {
      let onData: () => void;
      const line = new Promise<void>((resolve) => {
        onData = () => {
          if (stdout.includes("\n")) resolve();
        };
        child.stdout!.on("data", onData);
        onData();
      });
      try {
        await bounded(
          Promise.race([
            line,
            closed.then(() => {
              throw new Error("Child process exited before readiness");
            }),
          ]),
        );
        return JSON.parse(stdout.split("\n")[0]!) as { port: number };
      } finally {
        child.stdout!.off("data", onData!);
      }
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await bounded(closed);
    },
  };
}

async function launchCli(
  t: TestContext,
  options: { ipc?: boolean; invalidConfiguration?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wa-cli-test-"));
  const token = randomBytes(32).toString("base64url");
  const masterKey = randomBytes(32).toString("base64");
  const cli = observe(
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "serve",
        "--port",
        "0",
        "--data-dir",
        directory,
      ],
      {
        cwd: new URL("..", import.meta.url),
        stdio:
          options.ipc === false
            ? ["pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe", "ipc"],
      },
    ),
  );
  t.after(async () => {
    await cli.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  cli.child.stdin!.end(
    JSON.stringify({
      token,
      masterKey: options.invalidConfiguration ? "invalid" : masterKey,
    }) + "\n",
  );
  return { cli, token, masterKey };
}

function send(child: ChildProcess, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    child.send(message as object, (error) => {
      if (error) reject(new Error("Private supervisor channel unavailable"));
      else resolve();
    });
  });
}

test("CLI survives configuration EOF, ignores malformed IPC and closes idempotently through the private supervisor channel", async (t) => {
  const { cli, token, masterKey } = await launchCli(t);
  const ready = await cli.ready();
  assert.deepEqual(Object.keys(ready), ["port"]);
  for (const invalid of [
    { type: "shutdown", extra: true },
    { type: "other" },
    "shutdown",
    ["shutdown"],
    null,
  ])
    await send(cli.child, invalid);
  await delay(30);
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/accounts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const value = await response.json();
  assert.equal(value.accounts[0].state, "disconnected");
  assert.equal(value.accounts[0].identityId, undefined);
  await send(cli.child, { type: "shutdown" });
  await send(cli.child, { type: "shutdown" }).catch(() => {});
  assert.deepEqual(await bounded(cli.closed), { code: 0, signal: null });
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  for (const secret of [token, masterKey]) {
    assert.equal(cli.stdout.includes(secret), false);
    assert.equal(cli.stderr.includes(secret), false);
  }
});

test("CLI closes gracefully when its private supervisor IPC connection disappears", async (t) => {
  const { cli } = await launchCli(t);
  await cli.ready();
  cli.child.disconnect();
  assert.deepEqual(await bounded(cli.closed), { code: 0, signal: null });
});

test("CLI honors a supervisor shutdown requested during startup", async (t) => {
  const { cli } = await launchCli(t);
  await send(cli.child, { type: "shutdown" });
  assert.deepEqual(await bounded(cli.closed), { code: 0, signal: null });
});

test("CLI honors a supervisor disconnect during startup", async (t) => {
  const { cli } = await launchCli(t);
  cli.child.disconnect();
  assert.deepEqual(await bounded(cli.closed), { code: 0, signal: null });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `standalone CLI preserves graceful ${signal} shutdown on Unix`,
    {
      skip: process.platform === "win32",
    },
    async (t) => {
      const { cli } = await launchCli(t, { ipc: false });
      await cli.ready();
      cli.child.kill(signal);
      assert.deepEqual(await bounded(cli.closed), { code: 0, signal: null });
    },
  );
}

test("CLI startup failure rejects readiness promptly instead of leaving an unresolved wait", async (t) => {
  const { cli } = await launchCli(t, { invalidConfiguration: true });
  await assert.rejects(cli.ready(), /exited before readiness/u);
  assert.deepEqual(await bounded(cli.closed), { code: 1, signal: null });
  assert.equal(cli.stdout, "");
  assert.deepEqual(JSON.parse(cli.stderr.trim()), {
    error: "configuration_invalid",
  });
});

async function launchExample(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), "wa-example-test-"));
  await mkdir(join(directory, "examples"));
  await mkdir(join(directory, "dist"));
  await copyFile(
    new URL("../examples/serve-from-env.mjs", import.meta.url),
    join(directory, "examples", "serve-from-env.mjs"),
  );
  await writeFile(join(directory, "dist", "cli.js"), source);
  const wrapper = observe(
    spawn(
      process.execPath,
      [join(directory, "examples", "serve-from-env.mjs")],
      {
        env: {
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          WHATSAPP_BRIDGE_TOKEN: "synthetic-token",
          WHATSAPP_BRIDGE_MASTER_KEY: "synthetic-master-key",
          whatsapp_bridge_token: "synthetic-lowercase-token",
          WhatsApp_Bridge_Master_Key: "synthetic-mixedcase-master-key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
  t.after(async () => {
    await wrapper.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  return wrapper;
}

test("example supervisor removes configuration names case-insensitively from the child's environment", async (t) => {
  const wrapper = await launchExample(
    t,
    String.raw`
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const config = JSON.parse(input);
      const names = new Set(["WHATSAPP_BRIDGE_TOKEN", "WHATSAPP_BRIDGE_MASTER_KEY"]);
      process.stdout.write(JSON.stringify({
        hasConfiguration: typeof config.token === "string" && typeof config.masterKey === "string",
        inheritedConfiguration: Object.keys(process.env).some(key => names.has(key.toUpperCase())),
        privateSupervisorChannel: typeof process.send === "function"
      }) + "\n");
      if (process.connected) process.disconnect();
    });
  `,
  );
  assert.deepEqual(await bounded(wrapper.closed), { code: 0, signal: null });
  assert.deepEqual(JSON.parse(wrapper.stdout.trim()), {
    hasConfiguration: true,
    inheritedConfiguration: false,
    privateSupervisorChannel: true,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `example supervisor forwards ${signal} as a private IPC shutdown command`,
    {
      skip: process.platform === "win32",
    },
    async (t) => {
      const wrapper = await launchExample(
        t,
        String.raw`
      process.on("message", message => {
        if (message?.type === "shutdown" && Object.keys(message).length === 1)
          process.disconnect();
      });
      process.stdin.resume();
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({port: 0}) + "\n");
      });
    `,
      );
      await wrapper.ready();
      wrapper.child.kill(signal);
      assert.deepEqual(await bounded(wrapper.closed), {
        code: 0,
        signal: null,
      });
    },
  );
}
