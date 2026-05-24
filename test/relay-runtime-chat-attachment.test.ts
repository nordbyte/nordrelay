import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { inboxPath } from "../src/artifacts/attachments.js";
import { relayRuntimeChatAttachment } from "../src/runtime/relay-runtime-chat-attachment.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";

describe("relayRuntimeChatAttachment", () => {
  it("returns a staged chat attachment by message id", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-chat-attachment-"));
    try {
      const turnId = "turn-1";
      const fileName = "screenshot.png";
      const dir = inboxPath(workspace, turnId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, fileName), Buffer.from("image-bytes"));

      const runtime = {
        getSession: async () => ({}),
        publicInfo: () => ({ threadId: "thread-1", workspace }),
        chatStore: {
          list: () => [{
            id: "message-1",
            threadId: "thread-1",
            role: "user",
            text: "look",
            timestamp: new Date().toISOString(),
            source: "telegram",
            attachments: [{
              id: fileName,
              kind: "image",
              name: fileName,
              mimeType: "image/png",
              sizeBytes: 11,
              turnId,
            }],
          }],
        },
      } as unknown as RelayRuntimeDelegate;

      await expect(relayRuntimeChatAttachment(runtime, "message-1", fileName)).resolves.toMatchObject({
        id: fileName,
        name: fileName,
        mimeType: "image/png",
        sizeBytes: 11,
        dataBase64: Buffer.from("image-bytes").toString("base64"),
      });
      await expect(relayRuntimeChatAttachment(runtime, "message-1", "../secret")).resolves.toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
