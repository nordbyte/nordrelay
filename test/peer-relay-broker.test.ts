import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PeerRelayBroker } from "../src/peers/peer-relay-broker.js";
import type { PeerRpcRequest, PeerRpcResult } from "../src/peers/peer-types.js";

describe("PeerRelayBroker", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists pending relay requests across broker instances", async () => {
    const home = tempRoot();
    const request: PeerRpcRequest = { protocolVersion: 1, type: "peer.ping" };
    const first = new PeerRelayBroker(home);
    const pending = first.enqueue("peer-1", request, 30_000);
    pending.catch(() => {});

    const restored = new PeerRelayBroker(home);
    const envelope = await restored.poll("peer-1", 1);
    expect(envelope?.request).toEqual(request);
    expect(restored.stats("peer-1").inFlight).toBe(1);

    const result: PeerRpcResult = { ok: true, data: { status: "online" } };
    expect(restored.resolve("peer-1", envelope!.id, result)).toBe(true);
    expect(restored.stats("peer-1").completed).toBe(1);
  });

  function tempRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "nordrelay-relay-"));
    roots.push(root);
    return root;
  }
});
