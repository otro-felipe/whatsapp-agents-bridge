import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const token = process.env.WHATSAPP_BRIDGE_TOKEN;
const masterKey = process.env.WHATSAPP_BRIDGE_MASTER_KEY;
if (!token || !masterKey) {
  process.stderr.write("Protected environment configuration is required.\n");
  process.exitCode = 1;
} else {
  const privateNames = new Set([
    "WHATSAPP_BRIDGE_TOKEN",
    "WHATSAPP_BRIDGE_MASTER_KEY",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !privateNames.has(name.toUpperCase()),
    ),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "serve",
      ...process.argv.slice(2),
    ],
    { env, stdio: ["pipe", "inherit", "inherit", "ipc"] },
  );
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ token, masterKey }) + "\n");
  let stopping = false;
  const stop = () => {
    if (stopping || !child.connected) return;
    stopping = true;
    child.send({ type: "shutdown" }, () => {});
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("error", () => {
    process.stderr.write("Bridge process could not start.\n");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.exitCode = code ?? 1;
  });
}
