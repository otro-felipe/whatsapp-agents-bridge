import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPrivateTemporaryDirectory,
  ensurePrivateDirectorySync,
} from "../src/private-files.js";
import { assertPrivatePath } from "./private-path-assertion.js";

test("private directories restrict permissions before creating plaintext, including literal Unicode paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wa-permissions-"));
  const directory = join(parent, "synthetic à [space] ' $value");
  try {
    ensurePrivateDirectorySync(directory);
    assertPrivatePath(directory, true);
    const file = join(directory, "synthetic.txt");
    await writeFile(file, "synthetic bytes", { mode: 0o600 });
    assertPrivatePath(file);
    assert.equal(await readFile(file, "utf8"), "synthetic bytes");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("private temporary directories are secure before returning to a caller", async () => {
  const directory = await createPrivateTemporaryDirectory("wa-private-test-");
  try {
    assertPrivatePath(directory, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "Windows refuses private storage when its ACL tool is unavailable",
  { skip: process.platform !== "win32" },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "wa-unavailable-acl-"));
    const originalRoot = process.env.SystemRoot;
    process.env.SystemRoot = join(parent, "missing-system-directory");
    try {
      assert.throws(() => ensurePrivateDirectorySync(join(parent, "store")), {
        message: "private_storage_permissions_failed",
      });
    } finally {
      if (originalRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalRoot;
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "an existing store directory removes explicit third-party Windows access on stored files",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-existing-acl-"));
    const nested = join(directory, "attachments");
    const file = join(nested, "synthetic.bin");
    try {
      await mkdir(nested);
      await writeFile(file, "synthetic bytes");
      execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)R"], {
        stdio: "ignore",
        windowsHide: true,
      });
      execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], {
        stdio: "ignore",
        windowsHide: true,
      });
      ensurePrivateDirectorySync(directory);
      assertPrivatePath(directory, true);
      assertPrivatePath(nested, true);
      assertPrivatePath(file);
      assert.equal(await readFile(file, "utf8"), "synthetic bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("private directory setup rejects a symlink or Windows junction without changing its target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wa-permissions-link-"));
  const target = join(parent, "target"),
    link = join(parent, "link");
  try {
    await mkdir(target);
    const original = (await stat(target)).mode;
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => ensurePrivateDirectorySync(link),
      /private_storage_permissions_failed/,
    );
    assert.equal((await stat(target)).mode, original);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
