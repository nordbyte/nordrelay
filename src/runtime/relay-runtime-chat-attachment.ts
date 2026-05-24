import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { inboxPath } from "../artifacts/attachments.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { WebChatAttachmentFileDto } from "./relay-runtime-types.js";

export async function relayRuntimeChatAttachment(
  runtime: RelayRuntimeDelegate,
  messageId: string,
  attachmentId: string,
): Promise<WebChatAttachmentFileDto | null> {
  const session = await runtime.getSession(true);
  const info = runtime.publicInfo(session);
  if (!info.threadId) return null;
  const message = runtime.chatStore.list(info.threadId, 500).find((item) => item.id === messageId);
  const attachment = message?.attachments?.find((item) => item.id === attachmentId);
  if (!attachment || !isSafeAttachmentSegment(attachment.turnId) || !isSafeAttachmentSegment(attachment.name)) return null;
  const inboxDir = inboxPath(info.workspace, attachment.turnId);
  const localPath = path.join(inboxDir, attachment.name);
  const relative = path.relative(inboxDir, localPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const fileStat = await stat(localPath).catch(() => null);
  if (!fileStat?.isFile()) return null;
  const data = await readFile(localPath);
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType || "application/octet-stream",
    sizeBytes: fileStat.size,
    dataBase64: data.toString("base64"),
  };
}

function isSafeAttachmentSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value) && !value.includes("..");
}
