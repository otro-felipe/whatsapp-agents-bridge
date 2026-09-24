import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BridgeError } from "./types.js";
import { validateAttachmentBytes } from "./attachment-validation.js";
import { ensurePrivateDirectorySync } from "./private-files.js";

/** Binary-only AES-GCM cache: paths derive from internal scope, never filenames. */
export class AttachmentFiles {
  private readonly key: Buffer;
  private readonly directory: string;
  constructor(
    directory: string,
    key: Uint8Array,
    private readonly limit: number,
  ) {
    this.key = Buffer.from(key);
    this.directory = join(directory, "attachments");
    ensurePrivateDirectorySync(this.directory);
  }
  private path(scope: string) {
    return join(
      this.directory,
      `${createHash("sha256").update(scope).digest("hex")}.bin`,
    );
  }
  write(scope: string, bytes: Uint8Array) {
    validateAttachmentBytes(bytes, this.limit);
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(scope));
    const ciphertext = Buffer.concat([
      nonce,
      cipher.update(bytes),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const path = this.path(scope),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, ciphertext, {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      renameSync(temporary, path);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {}
      throw new BridgeError("attachment_storage_failed", 500);
    }
  }
  read(scope: string): Uint8Array | undefined {
    let encrypted: Buffer;
    try {
      const path = this.path(scope),
        size = statSync(path).size;
      if (size > this.limit + 28)
        throw new BridgeError("attachment_too_large", 413);
      encrypted = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("attachment_storage_failed", 500);
    }
    try {
      if (encrypted.byteLength < 28) throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        encrypted.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(scope));
      decipher.setAuthTag(encrypted.subarray(-16));
      return Buffer.concat([
        decipher.update(encrypted.subarray(12, -16)),
        decipher.final(),
      ]);
    } catch {
      throw new BridgeError("attachment_corrupt", 500);
    }
  }
  close() {
    this.key.fill(0);
  }
}
