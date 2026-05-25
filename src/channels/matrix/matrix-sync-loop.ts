import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { getObservabilityRegistry } from "../../observability/observability-registry.js";
import type { MatrixClient } from "./matrix-client.js";
import type { MatrixMessageEvent } from "./matrix-types.js";

export interface MatrixSyncLoop {
  start(): void;
  stop(): void;
}

export interface MatrixSyncLoopOptions {
  client: MatrixClient;
  config: ConnectorConfig;
  handleMessage(event: MatrixMessageEvent): Promise<void>;
}

export function createMatrixSyncLoop(options: MatrixSyncLoopOptions): MatrixSyncLoop {
  let running = false;
  let syncToken: string | undefined;
  const poller = getObservabilityRegistry().registerPoller({
    id: "matrix:sync-loop",
    owner: "matrix",
    kind: "matrix-sync",
    intervalMs: options.config.matrixSyncTimeoutMs,
    currentDelayMs: options.config.matrixSyncTimeoutMs,
  });

  const loop = async (): Promise<void> => {
    while (running) {
      poller.update({ currentDelayMs: options.config.matrixSyncTimeoutMs, nextRunAt: Date.now() });
      const finish = poller.start();
      try {
        const response = await options.client.sync(syncToken);
        syncToken = response.next_batch ?? syncToken;
        if (options.config.matrixAutojoinInvites) {
          for (const roomId of Object.keys(response.rooms?.invite ?? {})) {
            await options.client.joinRoom(roomId).catch((error) => {
              console.warn(`Failed to join Matrix invite ${roomId}: ${friendlyErrorText(error)}`);
            });
          }
        }
        for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            if (event.type !== "m.room.message" || !event.event_id || !event.sender) {
              continue;
            }
            await options.handleMessage({
              ...event,
              type: "m.room.message",
              event_id: event.event_id,
              room_id: event.room_id || roomId,
              sender: event.sender,
              content: event.content ?? {},
            } as MatrixMessageEvent).catch((error) => {
              console.error("Failed to handle Matrix message:", friendlyErrorText(error));
            });
          }
        }
        finish();
      } catch (error) {
        finish(error);
        if (running) {
          console.warn(`Matrix sync failed: ${friendlyErrorText(error)}`);
          poller.update({ currentDelayMs: 5_000, nextRunAt: Date.now() + 5_000 });
          await delay(5_000);
        }
      }
    }
  };

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      void loop();
    },
    stop() {
      running = false;
      poller.close();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
