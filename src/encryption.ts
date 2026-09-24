import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BridgeError } from "./types.js";
/** Every record authenticates its logical location to prevent ciphertext swaps. */
export class Encryption {
  private readonly key: Buffer;
  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new BridgeError("master_key_invalid");
    this.key = Buffer.from(key);
  }
  seal(value: unknown, aad: string): Buffer {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const plaintext = Buffer.from(JSON.stringify(value));
    try {
      return Buffer.concat([
        nonce,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    } finally {
      plaintext.fill(0);
    }
  }
  open<T>(data: Uint8Array, aad: string): T {
    let plaintext: Buffer | undefined;
    try {
      const bytes = Buffer.from(data);
      if (bytes.length < 28) throw new Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(bytes.subarray(-16));
      plaintext = Buffer.concat([
        cipher.update(bytes.subarray(12, -16)),
        cipher.final(),
      ]);
      return JSON.parse(plaintext.toString()) as T;
    } catch {
      throw new BridgeError("master_key_invalid", 500);
    } finally {
      plaintext?.fill(0);
    }
  }
  close() {
    this.key.fill(0);
  }
}
