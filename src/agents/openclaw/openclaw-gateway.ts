import { randomUUID } from "node:crypto";

type WebSocketConstructor = new (url: string) => WebSocketLike;

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void, options?: { once?: boolean }): void;
}

type PendingRequest = {
  method: string;
  expectFinal: boolean;
  resolve: (value: OpenClawGatewayResponse) => void;
  reject: (error: Error) => void;
  onAccepted?: (payload: Record<string, unknown>) => void;
  timeout: NodeJS.Timeout;
};

export type OpenClawGatewayEvent = Record<string, unknown>;
export type OpenClawGatewayResponse = Record<string, unknown>;

export interface OpenClawGatewayClientOptions {
  url: string;
  token?: string;
  password?: string;
  timeoutMs?: number;
  clientName?: string;
  webSocketFactory?: WebSocketConstructor;
}

export interface OpenClawAgentRunRequest {
  message: string;
  sessionId: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  workspace?: string;
  local?: boolean;
  deliver?: boolean;
  instructions?: string;
  attachments?: unknown[];
  onRunId?: (runId: string) => void;
}

export interface OpenClawAgentRunResult {
  runId: string | null;
  status: string;
  text: string | null;
  usage?: unknown;
  payload: OpenClawGatewayResponse;
}

export class OpenClawGatewayClient {
  private socket: WebSocketLike | null = null;
  private connected = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: OpenClawGatewayEvent) => void>();
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenClawGatewayClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async connect(): Promise<OpenClawGatewayResponse> {
    if (this.socket && this.connected) {
      return {};
    }

    const WebSocketClass = this.options.webSocketFactory ?? getGlobalWebSocket();
    const socket = new WebSocketClass(this.options.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.rejectAll(new Error("OpenClaw Gateway connection closed")));
    socket.addEventListener("error", () => this.rejectAll(new Error("OpenClaw Gateway connection failed")));

    await waitForOpen(socket, this.timeoutMs);
    const hello = await this.sendConnect();
    this.connected = true;
    return hello;
  }

  async health(): Promise<OpenClawGatewayResponse> {
    await this.connect();
    return this.request("health", {}, { timeoutMs: 10_000 }).catch(() =>
      this.request("status", {}, { timeoutMs: 10_000 }),
    );
  }

  async listSessions(params: Record<string, unknown> = {}): Promise<OpenClawGatewayResponse> {
    await this.connect();
    return this.request("sessions.list", params, { timeoutMs: 10_000 });
  }

  async listModels(params: Record<string, unknown> = {}): Promise<OpenClawGatewayResponse> {
    await this.connect();
    return this.request("models.list", params, { timeoutMs: 10_000 });
  }

  async runAgent(
    request: OpenClawAgentRunRequest,
    onEvent: (event: OpenClawGatewayEvent) => void,
    signal?: AbortSignal,
  ): Promise<OpenClawAgentRunResult> {
    await this.connect();
    const runState = { runId: null as string | null };
    const off = this.onEvent((event) => {
      if (eventMatchesRun(event, runState.runId, request.sessionId)) {
        onEvent(event);
      }
    });
    const abort = () => {
      if (runState.runId) {
        void this.cancelRun(runState.runId).catch(() => {});
      }
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const payload = await this.request("agent", buildAgentParams(request), {
        expectFinal: true,
        timeoutMs: 0,
        onAccepted: (accepted) => {
          runState.runId = stringValue(accepted.runId) ?? stringValue(accepted.run_id) ?? stringValue(accepted.id);
          if (runState.runId) {
            request.onRunId?.(runState.runId);
          }
        },
      });
      const text = extractOpenClawOutputText(payload);
      return {
        runId: runState.runId ?? stringValue(payload.runId) ?? stringValue(payload.run_id),
        status: stringValue(payload.status) ?? "ok",
        text,
        usage: payload.usage,
        payload,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      off();
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await this.connect();
    await this.request("agent.cancel", { runId }, { timeoutMs: 5_000 }).catch(() =>
      this.request("tasks.cancel", { runId }, { timeoutMs: 5_000 }),
    ).catch(() => {});
  }

  async respondApproval(params: {
    runId?: string | null;
    sessionId: string;
    approvalId: string;
    choice: "allow-once" | "allow-always" | "deny";
  }): Promise<void> {
    await this.connect();
    const payload = {
      runId: params.runId ?? undefined,
      run_id: params.runId ?? undefined,
      sessionId: params.sessionId,
      session_id: params.sessionId,
      approvalId: params.approvalId,
      approval_id: params.approvalId,
      choice: params.choice,
      decision: params.choice,
    };
    await this.request("agent.approval.respond", payload, { timeoutMs: 10_000 }).catch(() =>
      this.request("approval.respond", payload, { timeoutMs: 10_000 }),
    ).catch(() =>
      this.request("exec.approval.respond", payload, { timeoutMs: 10_000 }),
    );
  }

  onEvent(listener: (event: OpenClawGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.connected = false;
    this.rejectAll(new Error("OpenClaw Gateway connection closed"));
    this.socket?.close();
    this.socket = null;
  }

  private sendConnect(): Promise<OpenClawGatewayResponse> {
    const params: Record<string, unknown> = {
      client: {
        name: this.options.clientName ?? "NordRelay",
        deviceFamily: "nordrelay",
      },
      role: "operator",
      subscribe: ["agent", "session.message", "session.tool", "approval", "exec.approval", "sessions.changed", "health"],
    };
    const auth: Record<string, string> = {};
    if (this.options.token) auth.token = this.options.token;
    if (this.options.password) auth.password = this.options.password;
    if (Object.keys(auth).length > 0) {
      params.auth = auth;
    }
    return this.sendFrameAndWait("connect", "connect", params, { timeoutMs: this.timeoutMs });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options: { expectFinal?: boolean; timeoutMs?: number; onAccepted?: (payload: Record<string, unknown>) => void } = {},
  ): Promise<OpenClawGatewayResponse> {
    return this.sendFrameAndWait("req", method, params, options);
  }

  private sendFrameAndWait(
    type: "connect" | "req",
    method: string,
    params: Record<string, unknown>,
    options: { expectFinal?: boolean; timeoutMs?: number; onAccepted?: (payload: Record<string, unknown>) => void } = {},
  ): Promise<OpenClawGatewayResponse> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("OpenClaw Gateway is not connected"));
    }
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const frame = type === "connect"
      ? { type, id, params }
      : { type, id, method, params, idempotencyKey: randomUUID() };

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`OpenClaw Gateway ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined as unknown as NodeJS.Timeout;
      if (timeout?.unref) timeout.unref();
      this.pending.set(id, {
        method,
        expectFinal: Boolean(options.expectFinal),
        resolve,
        reject,
        onAccepted: options.onAccepted,
        timeout,
      });
      socket.send(JSON.stringify(frame));
    });
  }

  private handleMessage(event: unknown): void {
    const data = (event as { data?: unknown }).data;
    const raw = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data ?? "");
    const frame = parseFrame(raw);
    if (!frame) {
      return;
    }

    if (frame.type === "event") {
      for (const listener of this.listeners) {
        try {
          listener(frame);
        } catch {
          this.listeners.delete(listener);
        }
      }
      return;
    }

    const id = stringValue(frame.id);
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    if (frame.ok === false || frame.error) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new Error(formatGatewayError(frame.error ?? frame.payload ?? frame)));
      return;
    }

    const payload = objectValue(frame.payload) ?? objectValue(frame.result) ?? frame;
    const status = stringValue(payload.status);
    if (pending.expectFinal && status === "accepted") {
      pending.onAccepted?.(payload);
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeout);
    pending.resolve(payload);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function extractOpenClawOutputText(payload: unknown): string | null {
  const object = objectValue(payload);
  if (!object) {
    return typeof payload === "string" && payload.trim() ? payload : null;
  }
  const direct = stringValue(object.text)
    ?? stringValue(object.output)
    ?? stringValue(object.summary)
    ?? stringValue(object.message)
    ?? stringValue(object.content);
  if (direct) {
    return direct;
  }
  const result = objectValue(object.result);
  if (result) {
    return extractOpenClawOutputText(result);
  }
  const payloads = Array.isArray(object.payloads) ? object.payloads : [];
  const textParts = payloads
    .map((entry) => stringValue(objectValue(entry)?.text) ?? stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

function buildAgentParams(request: OpenClawAgentRunRequest): Record<string, unknown> {
  return {
    message: request.message,
    sessionId: request.sessionId,
    session_id: request.sessionId,
    agent: request.agentId,
    agentId: request.agentId,
    model: request.model,
    thinking: request.thinking,
    workspace: request.workspace,
    local: request.local,
    deliver: request.deliver,
    instructions: request.instructions,
    attachments: request.attachments,
  };
}

function eventMatchesRun(event: OpenClawGatewayEvent, runId: string | null, sessionId: string): boolean {
  const payload = objectValue(event.payload) ?? event;
  const eventRunId = stringValue(payload.runId) ?? stringValue(payload.run_id) ?? stringValue(payload.id);
  const eventSessionId = stringValue(payload.sessionId) ?? stringValue(payload.session_id) ?? stringValue(payload.sessionKey);
  if (runId && eventRunId) {
    return eventRunId === runId;
  }
  return !eventSessionId || eventSessionId === sessionId;
}

function getGlobalWebSocket(): WebSocketConstructor {
  const WebSocketClass = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocketClass) {
    throw new Error("OpenClaw Gateway requires a WebSocket-capable Node runtime.");
  }
  return WebSocketClass;
}

function waitForOpen(socket: WebSocketLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`OpenClaw Gateway connection timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("OpenClaw Gateway connection failed"));
    }, { once: true });
  });
}

function parseFrame(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function formatGatewayError(value: unknown): string {
  const object = objectValue(value);
  if (!object) {
    return typeof value === "string" ? value : "OpenClaw Gateway request failed";
  }
  return stringValue(object.message) ?? stringValue(object.error) ?? JSON.stringify(object);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
