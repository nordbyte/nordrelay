import type { ConnectorConfig } from "../core/config.js";
import { RemoteRelayClient } from "./peer-client.js";
import { PeerStore } from "./peer-store.js";
import { getObservabilityRegistry } from "../observability/observability-registry.js";

export interface PeerHealthMonitorHandle {
  checkNow(): Promise<{ checked: number; failed: number }>;
  close(): void;
}

export function startPeerHealthMonitor(options: {
  config: ConnectorConfig;
  home?: string;
}): PeerHealthMonitorHandle {
  const store = new PeerStore(options.home);
  const client = new RemoteRelayClient(store);
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let idleChecks = 0;
  const poller = getObservabilityRegistry().registerPoller({
    id: "peers:health-monitor",
    owner: "peers",
    kind: "peer-health",
    intervalMs: options.config.peerHealthCheckMs,
    currentDelayMs: options.config.peerHealthCheckMs,
  });

  async function checkNow(): Promise<{ checked: number; failed: number }> {
    if (running) {
      poller.skip("previous check still running");
      return { checked: 0, failed: 0 };
    }
    running = true;
    const finish = poller.start();
    let failed = 0;
    try {
      const peers = store.list().filter((peer) => peer.enabled && peer.url);
      if (peers.length === 0) {
        finish();
        return { checked: 0, failed: 0 };
      }
      await Promise.all(peers.map(async (peer) => {
        try {
          const startedAt = Date.now();
          const result = await client.rpc(peer.id, "peer.ping");
          const record = result && typeof result === "object" ? result as { version?: unknown; status?: unknown } : {};
          store.markSeen(peer.id, {
            check: "health-monitor",
            code: "peer.ok",
            latencyMs: Date.now() - startedAt,
            remoteVersion: typeof record.version === "string" ? record.version : undefined,
            remoteStatus: typeof record.status === "string" ? record.status : "online",
            detail: "Scheduled peer health check completed.",
          });
        } catch (error) {
          failed += 1;
          store.markError(peer.id, error instanceof Error ? error.message : String(error), {
            check: "health-monitor",
            detail: "Scheduled peer health check failed.",
          });
        }
      }));
      const result = { checked: peers.length, failed };
      finish(failed === peers.length && peers.length > 0 ? "all peer health checks failed" : undefined);
      return result;
    } catch (error) {
      finish(error);
      throw error;
    } finally {
      running = false;
    }
  }

  if (options.config.peerHealthCheckMs > 0) {
    const schedule = (delayMs: number) => {
      if (closed) return;
      poller.update({ currentDelayMs: delayMs, nextRunAt: Date.now() + delayMs });
      timer = setTimeout(async () => {
        try {
          const result = await checkNow();
          idleChecks = result.checked === 0 || result.failed === result.checked ? Math.min(idleChecks + 1, 5) : 0;
        } catch {
          idleChecks = Math.min(idleChecks + 1, 5);
        } finally {
          const base = options.config.peerHealthCheckMs;
          const nextDelay = idleChecks > 0 ? Math.min(base * (idleChecks + 1), Math.max(base, 5 * 60_000)) : base;
          schedule(nextDelay);
        }
      }, delayMs);
      timer.unref?.();
    };
    schedule(2_000);
  }

  return {
    checkNow,
    close() {
      closed = true;
      poller.close();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
