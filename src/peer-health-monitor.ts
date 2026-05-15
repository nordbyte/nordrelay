import type { ConnectorConfig } from "./config.js";
import { RemoteRelayClient } from "./peer-client.js";
import { PeerStore } from "./peer-store.js";

export interface PeerHealthMonitorHandle {
  checkNow(): Promise<void>;
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

  async function checkNow(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      const peers = store.list().filter((peer) => peer.enabled && peer.url);
      await Promise.all(peers.map(async (peer) => {
        try {
          await client.rpc(peer.id, "peer.ping");
        } catch (error) {
          store.markError(peer.id, error instanceof Error ? error.message : String(error));
        }
      }));
    } finally {
      running = false;
    }
  }

  if (options.config.peerHealthCheckMs > 0) {
    timer = setInterval(() => void checkNow().catch(() => {}), options.config.peerHealthCheckMs);
    timer.unref?.();
    setTimeout(() => void checkNow().catch(() => {}), 2_000).unref?.();
  }

  return {
    checkNow,
    close() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
