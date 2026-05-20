import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { friendlyErrorText } from "../../core/error-messages.js";

export interface MatrixClientOptions {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId?: string;
  syncTimeoutMs: number;
  pollTimeoutMs: number;
}

export interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    invite?: Record<string, MatrixInviteRoom>;
    join?: Record<string, MatrixJoinedRoom>;
  };
}

export interface MatrixInviteRoom {
  invite_state?: {
    events?: MatrixEvent[];
  };
}

export interface MatrixJoinedRoom {
  timeline?: {
    events?: MatrixEvent[];
  };
}

export interface MatrixEvent {
  type?: string;
  event_id?: string;
  sender?: string;
  room_id?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface MatrixWhoami {
  user_id: string;
  device_id?: string;
  is_guest?: boolean;
}

export class MatrixApiError extends Error {
  retryAfterMs?: number;

  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    if (body && typeof body === "object") {
      const retry = (body as { retry_after_ms?: unknown }).retry_after_ms;
      if (typeof retry === "number" && Number.isFinite(retry)) {
        this.retryAfterMs = retry;
      }
    }
  }
}

export class MatrixClient {
  readonly homeserverUrl: string;
  readonly accessToken: string;
  readonly userId: string;
  readonly deviceId?: string;
  readonly syncTimeoutMs: number;
  readonly pollTimeoutMs: number;

  constructor(options: MatrixClientOptions) {
    this.homeserverUrl = options.homeserverUrl.replace(/\/+$/, "");
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.syncTimeoutMs = options.syncTimeoutMs;
    this.pollTimeoutMs = options.pollTimeoutMs;
  }

  homeserverName(): string | undefined {
    const match = this.userId.match(/^@[^:]+:(.+)$/);
    return match?.[1];
  }

  async whoami(): Promise<MatrixWhoami> {
    return this.request<MatrixWhoami>("/_matrix/client/v3/account/whoami");
  }

  async joinedRooms(): Promise<string[]> {
    const response = await this.request<{ joined_rooms?: string[] }>("/_matrix/client/v3/joined_rooms");
    return response.joined_rooms ?? [];
  }

  async sync(since?: string): Promise<MatrixSyncResponse> {
    const params = new URLSearchParams({ timeout: String(this.syncTimeoutMs) });
    if (since) params.set("since", since);
    return this.request<MatrixSyncResponse>(`/_matrix/client/v3/sync?${params.toString()}`, {
      signal: AbortSignal.timeout(Math.max(this.pollTimeoutMs, this.syncTimeoutMs + 1_000)),
    });
  }

  async joinRoom(roomIdOrAlias: string): Promise<void> {
    await this.request(`/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async sendText(roomId: string, input: {
    body: string;
    formattedBody?: string;
    threadId?: string;
    msgtype?: "m.text" | "m.notice";
  }): Promise<string> {
    return this.sendRoomEvent(roomId, "m.room.message", matrixTextContent(input));
  }

  async editText(roomId: string, eventId: string, input: { body: string; formattedBody?: string }): Promise<string> {
    return this.sendRoomEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: `* ${input.body}`,
      ...(input.formattedBody ? { format: "org.matrix.custom.html", formatted_body: `* ${input.formattedBody}` } : {}),
      "m.new_content": matrixTextContent(input),
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: eventId,
      },
    });
  }

  async sendFile(roomId: string, input: { localPath: string; name?: string; caption?: string; mimeType?: string; threadId?: string }): Promise<string> {
    const name = input.name || path.basename(input.localPath);
    const size = (await stat(input.localPath)).size;
    const contentUri = await this.upload(input.localPath, name, input.mimeType);
    const isImage = input.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name);
    return this.sendRoomEvent(roomId, "m.room.message", {
      msgtype: isImage ? "m.image" : "m.file",
      body: input.caption || name,
      filename: name,
      url: contentUri,
      info: {
        mimetype: input.mimeType ?? "application/octet-stream",
        size,
      },
      ...(input.threadId ? threadRelation(input.threadId) : {}),
    });
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 10_000): Promise<void> {
    await this.request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`, {
      method: "PUT",
      body: JSON.stringify({ typing, timeout: timeoutMs }),
    });
  }

  async getMedia(mxcUri: string): Promise<{ buffer: Buffer; contentType?: string; filename?: string }> {
    const parsed = parseMxcUri(mxcUri);
    const response = await this.rawRequest(`/_matrix/client/v1/media/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`);
    if (!response.ok) {
      throw new MatrixApiError(`Matrix media download failed: ${response.status}`, response.status);
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    const disposition = response.headers.get("content-disposition") ?? undefined;
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType,
      filename: filenameFromDisposition(disposition),
    };
  }

  private async upload(localPath: string, filename: string, mimeType?: string): Promise<string> {
    const params = new URLSearchParams({ filename });
    const response = await this.rawRequest(`/_matrix/media/v3/upload?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": mimeType ?? "application/octet-stream" },
      body: createReadStream(localPath) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      throw await matrixError(response);
    }
    const body = await response.json() as { content_uri?: string };
    if (!body.content_uri) {
      throw new Error("Matrix media upload response did not include content_uri.");
    }
    return body.content_uri;
  }

  private async sendRoomEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string> {
    const txnId = randomUUID();
    const response = await this.request<{ event_id?: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
      {
        method: "PUT",
        body: JSON.stringify(content),
      },
    );
    if (!response.event_id) {
      throw new Error("Matrix send response did not include event_id.");
    }
    return response.event_id;
  }

  private async request<T = unknown>(pathName: string, init: RequestInit = {}): Promise<T> {
    const response = await this.rawRequest(pathName, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw await matrixError(response);
    }
    return response.json() as Promise<T>;
  }

  private rawRequest(pathName: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.homeserverUrl}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
    return fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(init.headers ?? {}),
      },
    });
  }
}

export function matrixTextContent(input: {
  body: string;
  formattedBody?: string;
  threadId?: string;
  msgtype?: "m.text" | "m.notice";
}): Record<string, unknown> {
  return {
    msgtype: input.msgtype ?? "m.text",
    body: input.body || ".",
    ...(input.formattedBody ? { format: "org.matrix.custom.html", formatted_body: input.formattedBody } : {}),
    ...(input.threadId ? threadRelation(input.threadId) : {}),
  };
}

function threadRelation(threadId: string): Record<string, unknown> {
  return {
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: threadId,
      is_falling_back: true,
    },
  };
}

async function matrixError(response: Response): Promise<MatrixApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => undefined);
  }
  const detail = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : friendlyErrorText(body);
  return new MatrixApiError(`Matrix API ${response.status}: ${detail}`, response.status, body);
}

function parseMxcUri(uri: string): { serverName: string; mediaId: string } {
  const match = uri.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid Matrix media URI: ${uri}`);
  }
  return { serverName: match[1], mediaId: match[2] };
}

function filenameFromDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  return match?.[1] ? decodeURIComponent(match[1].replace(/"$/, "")) : undefined;
}
