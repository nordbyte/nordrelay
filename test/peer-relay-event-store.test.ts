import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PeerRelayEventStore } from "../src/peers/peer-relay-event-store.js";
import type { PeerEventEnvelope } from "../src/peers/peer-types.js";

describe("PeerRelayEventStore", () => {
  it("notifies subscribers when events arrive for their peer", () => {
    const home = mkdtempSync(path.join(tmpdir(), "nordrelay-peer-relay-events-"));
    try {
      const store = new PeerRelayEventStore(home);
      const listener = vi.fn();
      const unsubscribe = store.subscribe("peer-1", listener);

      store.append("peer-1", [eventEnvelope("status", "hello")]);

      expect(listener).toHaveBeenCalledOnce();
      listener.mockClear();

      store.append("peer-2", [eventEnvelope("status", "ignored")]);

      expect(listener).not.toHaveBeenCalled();

      unsubscribe();
      store.append("peer-1", [eventEnvelope("status", "after unsubscribe")]);

      expect(listener).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function eventEnvelope(type: string, message: string): PeerEventEnvelope {
  return {
    type,
    message,
    at: "2026-06-09T00:00:00.000Z",
  } as PeerEventEnvelope;
}
