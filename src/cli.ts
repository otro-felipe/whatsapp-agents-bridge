#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { BridgeError } from "./types.js";
import { createCliShutdown } from "./cli-shutdown.js";

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new BridgeError("node_24_required");
  const [mode, ...argv] = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      port: { type: "string" },
      "data-dir": { type: "string" },
      "retention-days": { type: "string" },
      "history-retention-days": { type: "string" },
      url: { type: "string" },
      account: { type: "string" },
      chat: { type: "string" },
    },
  });
  if (mode === "serve") {
    // libsignal contains direct console calls with session objects. This is a
    // dedicated transport process: suppress third-party console entirely.
    for (const name of [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "dir",
      "trace",
    ] as const)
      console[name] = () => undefined;
    const shutdown = createCliShutdown();
    try {
      const config = await readConfiguration();
      const token = config.token,
        encoded = config.masterKey;
      if (
        typeof token !== "string" ||
        typeof encoded !== "string" ||
        !/^([A-Za-z0-9+/]{43}=)$/u.test(encoded)
      )
        throw new BridgeError("configuration_invalid");
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32 || key.toString("base64") !== encoded)
        throw new BridgeError("configuration_invalid");
      const port = Number(values.port ?? 0),
        retentionDays = Number(values["retention-days"] ?? 7);
      if (
        !Number.isInteger(port) ||
        port < 0 ||
        port > 65535 ||
        !values["data-dir"]
      )
        throw new BridgeError("arguments_invalid");
      const historyDays = values["history-retention-days"] ?? "forever";
      const historyRetentionDays =
        historyDays === "forever" ? null : Number(historyDays);
      const { startBridge } = await import("./index.js");
      const bridge = await startBridge({
        dataDir: resolve(values["data-dir"]),
        token,
        masterKey: key,
        port,
        retentionDays,
        historyRetentionDays,
      });
      key.fill(0);
      shutdown.setCloseHandler(() => bridge.close());
      if (!shutdown.requested)
        process.stdout.write(JSON.stringify({ port: bridge.port }) + "\n");
    } catch (error) {
      shutdown.dispose();
      throw error;
    }
    return;
  }
  if (mode === "mcp") {
    const token = process.env.WHATSAPP_BRIDGE_TOKEN;
    if (!token || !values.url) throw new BridgeError("configuration_required");
    const [{ BridgeClient }, { serveMcp }] = await Promise.all([
      import("./client.js"),
      import("./mcp.js"),
    ]);
    await serveMcp(new BridgeClient(values.url, token), {
      ...(values.account ? { accountId: values.account } : {}),
      ...(values.chat ? { chatId: values.chat } : {}),
    });
    return;
  }
  if (mode === "help" || mode === "--help" || mode === undefined) {
    process.stdout.write(
      "whatsapp-agents-bridge serve --port 0 --data-dir PATH [--retention-days 7] [--history-retention-days forever|N]\nConfiguration: one stdin JSON line with token and base64 masterKey; never command arguments.\nwhatsapp-agents-bridge mcp --url http://127.0.0.1:PORT [--account default] [--chat JID]\nMCP authentication: WHATSAPP_BRIDGE_TOKEN in child environment.\n",
    );
    return;
  }
  throw new BridgeError("unknown_command");
}
function readConfiguration(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off("data", data);
      process.stdin.off("end", end);
      process.stdin.off("error", fail);
      process.stdin.pause();
    };
    const fail = () => {
      cleanup();
      reject(new BridgeError("configuration_invalid"));
    };
    const end = () => fail();
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16_384) return fail();
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const value: unknown = JSON.parse(
          buffer.subarray(0, newline).toString(),
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          return fail();
        cleanup();
        buffer.fill(0);
        resolve(value as Record<string, unknown>);
      } catch {
        fail();
      }
    };
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", fail);
    process.stdin.resume();
  });
}
void main().catch((error) => {
  const code = error instanceof BridgeError ? error.code : "startup_failed";
  process.stderr.write(JSON.stringify({ error: code }) + "\n");
  process.exitCode = 1;
});
