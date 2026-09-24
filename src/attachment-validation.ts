import {
  BridgeError,
  requireId,
  type Attachment,
  type AttachmentUpload,
} from "./types.js";

export function attachmentMetadata(value: Attachment): Attachment {
  if (!value || typeof value !== "object")
    throw new BridgeError("invalid_attachment");
  const attachmentId = requireId(value.attachmentId);
  const { kind, mimeType, fileName, sizeBytes } = value;
  if (!["image", "video", "audio", "document", "sticker"].includes(kind))
    throw new BridgeError("invalid_attachment_kind");
  if (
    typeof mimeType !== "string" ||
    mimeType.length > 127 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
      mimeType,
    ) ||
    (kind !== "document" &&
      !mimeType.startsWith(`${kind === "sticker" ? "image" : kind}/`))
  )
    throw new BridgeError("invalid_attachment_mime");
  if (
    fileName !== undefined &&
    (typeof fileName !== "string" ||
      !fileName.trim() ||
      fileName.length > 255 ||
      /[/\\\u0000-\u001f\u007f]/u.test(fileName) ||
      fileName === "." ||
      fileName === "..")
  )
    throw new BridgeError("invalid_attachment_filename");
  if (
    sizeBytes !== undefined &&
    (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
  )
    throw new BridgeError("invalid_attachment_size");
  return {
    attachmentId,
    kind,
    mimeType,
    ...(fileName !== undefined ? { fileName } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}
export function attachmentList(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10)
    throw new BridgeError("invalid_attachments");
  const attachments = value.map((item) =>
    attachmentMetadata(item as Attachment),
  );
  if (
    new Set(attachments.map((item) => item.attachmentId)).size !==
    attachments.length
  )
    throw new BridgeError("invalid_attachments");
  return attachments;
}
export function validateAttachmentBytes(bytes: Uint8Array, limit: number) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new BridgeError("invalid_attachment_bytes");
  if (bytes.byteLength > limit)
    throw new BridgeError("attachment_too_large", 413);
}
export function uploadMetadata(
  id: string,
  metadata: AttachmentUpload,
  bytes: Uint8Array,
  limit: number,
) {
  validateAttachmentBytes(bytes, limit);
  return attachmentMetadata({
    ...metadata,
    attachmentId: id,
    sizeBytes: bytes.byteLength,
  });
}
