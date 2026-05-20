import { describe, expect, it } from "vitest";

import { OpenClawGatewayClient } from "../src/agents/openclaw/openclaw-gateway.js";

describe("openclaw-gateway", () => {
  it("connects, streams agent events, and returns the final response", async () => {
    const sent: unknown[] = [];
    class FakeSocket {
      readyState = 1;
      private listeners = new Map<string, Array<(event: unknown) => void>>();

      constructor(readonly url: string) {
        setTimeout(() => this.emit("open", {}), 0);
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(data: string): void {
        const frame = JSON.parse(data) as { id: string; type: string; method?: string; params?: Record<string, unknown> };
        sent.push(frame);
        if (frame.type === "connect") {
          this.emitMessage({ type: "res", id: frame.id, ok: true, payload: { status: "hello-ok" } });
          return;
        }
        if (frame.method === "agent") {
          this.emitMessage({ type: "res", id: frame.id, ok: true, payload: { status: "accepted", runId: "run-1" } });
          this.emitMessage({ type: "event", event: "agent.delta", payload: { runId: "run-1", delta: "Hel" } });
          this.emitMessage({ type: "event", event: "agent.delta", payload: { runId: "run-1", delta: "lo" } });
          this.emitMessage({ type: "res", id: frame.id, ok: true, payload: { status: "ok", runId: "run-1", summary: "Hello" } });
        }
      }

      close(): void {}

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      private emitMessage(frame: unknown): void {
        this.emit("message", { data: JSON.stringify(frame) });
      }
    }

    const client = new OpenClawGatewayClient({
      url: "ws://127.0.0.1:18789",
      token: "secret",
      webSocketFactory: FakeSocket as never,
    });
    const deltas: string[] = [];
    const result = await client.runAgent({
      sessionId: "session-1",
      agentId: "main",
      message: "hello",
    }, (event) => {
      const payload = event.payload as { delta?: string } | undefined;
      if (payload?.delta) deltas.push(payload.delta);
    });

    expect(result).toMatchObject({
      runId: "run-1",
      status: "ok",
      text: "Hello",
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(sent).toEqual([
      expect.objectContaining({ type: "connect" }),
      expect.objectContaining({
        type: "req",
        method: "agent",
        params: expect.objectContaining({ sessionId: "session-1", agent: "main", message: "hello" }),
      }),
    ]);
  });
});
