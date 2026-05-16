import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildFileInstructions, type StagedFile } from "../src/artifacts/attachments.js";
import { peerPromptProxyPayload } from "../src/runtime/remote-prompt.js";
import { toPromptEnvelope } from "../src/state/prompt-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("peerPromptProxyPayload", () => {
  it("sends plain text prompts through the prompt endpoint", async () => {
    const envelope = { ...toPromptEnvelope("hello"), correlationId: "cid-peer-1" };

    await expect(peerPromptProxyPayload(envelope)).resolves.toEqual({
      method: "POST",
      path: "/api/prompt",
      body: { text: "hello", correlationId: "cid-peer-1" },
    });
  });

  it("transfers staged files as remote upload prompts", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-remote-prompt-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "notes.txt");
    writeFileSync(filePath, "hello file", "utf8");
    const staged: StagedFile = {
      originalName: "notes.txt",
      safeName: "notes.txt",
      localPath: filePath,
      mimeType: "text/plain",
      sizeBytes: 10,
    };

    const payload = await peerPromptProxyPayload({
      ...toPromptEnvelope({
      text: "Summarize this file",
      stagedFileInstructions: buildFileInstructions([staged], path.join(dir, "out")),
      }),
      correlationId: "cid-upload-1",
    });

    expect(payload.path).toBe("/api/prompt/upload");
    expect(payload.body).toMatchObject({
      text: "Summarize this file",
      correlationId: "cid-upload-1",
      files: [{ name: "notes.txt", mimeType: "text/plain", dataBase64: Buffer.from("hello file").toString("base64") }],
    });
  });
});
