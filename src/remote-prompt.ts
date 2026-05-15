import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PeerWebProxyPayload } from "./peer-types.js";
import type { PromptEnvelope } from "./prompt-store.js";

interface RemoteUploadFile {
  name: string;
  mimeType?: string;
  dataBase64: string;
}

export async function peerPromptProxyPayload(prompt: PromptEnvelope): Promise<PeerWebProxyPayload> {
  if (typeof prompt.input === "string") {
    return {
      method: "POST",
      path: "/api/prompt",
      body: { text: prompt.input },
    };
  }

  const files = await remoteUploadFiles(prompt);
  if (files.length > 0) {
    return {
      method: "POST",
      path: "/api/prompt/upload",
      body: {
        text: prompt.input.text ?? "",
        files,
      },
    };
  }

  return {
    method: "POST",
    path: "/api/prompt",
    body: { text: prompt.input.text || prompt.description },
  };
}

async function remoteUploadFiles(prompt: PromptEnvelope): Promise<RemoteUploadFile[]> {
  if (typeof prompt.input === "string") {
    return [];
  }
  const candidates = new Map<string, { name: string; mimeType?: string; localPath: string }>();
  for (const imagePath of prompt.input.imagePaths ?? []) {
    candidates.set(imagePath, {
      name: path.basename(imagePath),
      mimeType: mimeTypeFromPath(imagePath),
      localPath: imagePath,
    });
  }
  for (const file of parseStagedFileInstructions(prompt.input.stagedFileInstructions)) {
    candidates.set(file.localPath, file);
  }

  const files: RemoteUploadFile[] = [];
  for (const file of candidates.values()) {
    const data = await readFile(file.localPath);
    files.push({
      name: file.name,
      mimeType: file.mimeType,
      dataBase64: data.toString("base64"),
    });
  }
  return files;
}

function parseStagedFileInstructions(text: string | undefined): Array<{ name: string; mimeType?: string; localPath: string }> {
  if (!text) {
    return [];
  }
  const files: Array<{ name: string; mimeType?: string; localPath: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- (.+?) \(([^,]+), [^)]+\) → (.+)$/);
    if (!match) continue;
    files.push({
      name: match[1] || path.basename(match[3] ?? "upload"),
      mimeType: match[2],
      localPath: match[3] ?? "",
    });
  }
  return files.filter((file) => file.localPath);
}

function mimeTypeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt" || ext === ".md" || ext === ".log") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return undefined;
}
