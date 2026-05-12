export type HermesRunEvent = Record<string, unknown>;

export interface HermesModelRecord {
  id: string;
  ownedBy?: string;
}

export interface HermesApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface HermesRunRequest {
  input: unknown;
  session_id: string;
  model?: string;
  instructions?: string;
  reasoning_effort?: string;
  conversation_history?: Array<{ role: string; content: string }>;
}

export interface HermesRunResponse {
  run_id: string;
  status: string;
}

export interface HermesRunStatus {
  run_id?: string;
  status?: string;
  session_id?: string;
  model?: string;
  output?: string;
  usage?: unknown;
  error?: string;
}

export interface HermesCapabilities {
  platform?: string;
  model?: string;
  auth?: {
    required?: boolean;
    type?: string;
  };
  features?: Record<string, unknown>;
}

export class HermesApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HermesApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<Record<string, unknown>> {
    return this.getJson("/health");
  }

  async detailedHealth(): Promise<Record<string, unknown>> {
    return this.getJson("/health/detailed");
  }

  async capabilities(): Promise<HermesCapabilities> {
    return this.getJson("/v1/capabilities", true);
  }

  async models(): Promise<HermesModelRecord[]> {
    const payload = await this.getJson("/v1/models", true) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    return (payload.data ?? [])
      .map((model) => ({
        id: typeof model.id === "string" ? model.id : "",
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : undefined,
      }))
      .filter((model) => model.id);
  }

  async startRun(request: HermesRunRequest, sessionKey?: string): Promise<HermesRunResponse> {
    return this.postJson("/v1/runs", request, { sessionKey, expectStatus: [202] }) as Promise<HermesRunResponse>;
  }

  async getRun(runId: string): Promise<HermesRunStatus> {
    return this.getJson(`/v1/runs/${encodeURIComponent(runId)}`, true) as Promise<HermesRunStatus>;
  }

  async stopRun(runId: string): Promise<void> {
    await this.postJson(`/v1/runs/${encodeURIComponent(runId)}/stop`, {}, { expectStatus: [200, 202, 404] });
  }

  async approveRun(runId: string, choice: "once" | "session" | "always" | "deny"): Promise<void> {
    await this.postJson(`/v1/runs/${encodeURIComponent(runId)}/approval`, { choice }, { expectStatus: [200, 409, 404] });
  }

  async streamRunEvents(
    runId: string,
    onEvent: (event: HermesRunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: this.headers(true),
      signal,
    });
    if (!response.ok) {
      throw new Error(await this.formatHttpError(response));
    }
    if (!response.body) {
      throw new Error("Hermes run event stream is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = parseSseEvent(part);
          if (event) {
            onEvent(event);
          }
        }
      }
      buffer += decoder.decode();
      const trailing = parseSseEvent(buffer);
      if (trailing) {
        onEvent(trailing);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async getJson(path: string, authenticated = false): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(authenticated),
    });
    if (!response.ok) {
      throw new Error(await this.formatHttpError(response));
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async postJson(
    path: string,
    payload: unknown,
    options: { sessionKey?: string; expectStatus?: number[] } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(true, options.sessionKey),
      body: JSON.stringify(payload),
    });
    const expected = options.expectStatus ?? [200];
    if (!expected.includes(response.status)) {
      throw new Error(await this.formatHttpError(response));
    }
    const text = await response.text();
    return text.trim() ? JSON.parse(text) as unknown : {};
  }

  private headers(authenticated: boolean, sessionKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (authenticated && this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    if (sessionKey) {
      headers["x-hermes-session-key"] = sessionKey;
    }
    return headers;
  }

  private async formatHttpError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    if (!text.trim()) {
      return `Hermes API request failed: HTTP ${response.status}`;
    }
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
      const message = typeof parsed.error?.message === "string" ? parsed.error.message : text;
      const code = typeof parsed.error?.code === "string" ? ` (${parsed.error.code})` : "";
      return `Hermes API request failed: ${message}${code}`;
    } catch {
      return `Hermes API request failed: ${text}`;
    }
  }
}

function parseSseEvent(raw: string): HermesRunEvent | null {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? parsed as HermesRunEvent : null;
  } catch {
    return null;
  }
}
