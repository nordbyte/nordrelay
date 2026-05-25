import { beforeEach, describe, expect, it } from "vitest";

import { getObservabilityRegistry } from "../src/observability/observability-registry.js";
import { RuntimeSnapshotCache } from "../src/runtime/runtime-cache.js";

describe("observability registry", () => {
  beforeEach(() => {
    getObservabilityRegistry().reset();
  });

  it("tracks poller lifecycle and SSE connections", () => {
    const registry = getObservabilityRegistry();
    const poller = registry.registerPoller({
      id: "test:poller",
      owner: "test",
      kind: "poll",
      currentDelayMs: 1000,
      nextRunAt: Date.now() + 1000,
    });

    const finish = poller.start();
    finish();
    poller.skip("idle");

    const sse = registry.openSseConnection({ route: "/api/events", target: "local", user: "user@example.test" });
    sse.event(32);
    sse.heartbeat(12);

    const snapshot = registry.snapshot();
    expect(snapshot.summary.pollers.total).toBe(1);
    expect(snapshot.pollers[0]).toMatchObject({ id: "test:poller", runCount: 1, successCount: 1, skipCount: 1 });
    expect(snapshot.sse.active[0]).toMatchObject({ route: "/api/events", eventsSent: 1, heartbeatCount: 1, bytesSent: 44 });

    sse.close();
    expect(registry.snapshot().sse.active).toHaveLength(0);
  });

  it("collects runtime cache hit, stale and miss metrics", async () => {
    const cache = new RuntimeSnapshotCache();
    let value = 0;

    await cache.get("diagnostics", 1, async () => ++value);
    await cache.get("diagnostics", 1000, async () => ++value);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.get("diagnostics", 1, async () => ++value);
    cache.warm(["diagnostics"]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const cacheMetric = getObservabilityRegistry().snapshot().caches.find((item) => item.key === "diagnostics");
    expect(cacheMetric).toMatchObject({
      key: "diagnostics",
      gets: 3,
      hitsFresh: 1,
      hitsStale: 1,
      misses: 1,
      warmups: 1,
    });
  });

  it("aggregates peer roundtrip metrics", () => {
    const registry = getObservabilityRegistry();
    registry.recordPeerRoundtrip({ peerId: "peer-1", method: "web.proxy", durationMs: 25, ok: true, transport: "direct" });
    registry.recordPeerRoundtrip({ peerId: "peer-1", method: "web.proxy", durationMs: 100, ok: false, error: "Peer request timed out.", transport: "direct" });

    const peer = registry.snapshot().peerRoundtrips[0];
    expect(peer).toMatchObject({
      peerId: "peer-1",
      method: "web.proxy",
      count: 2,
      success: 1,
      failed: 1,
      timeouts: 1,
      lastStatus: "error",
    });
    expect(peer.averageMs).toBe(62.5);
  });
});
