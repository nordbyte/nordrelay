import type { AgentSessionService } from "../../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../../agents/shared/agent-activity.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { PromptStore } from "../../state/prompt-store.js";
import type { SessionRegistry } from "../../state/session-registry.js";
import { capabilitiesOf } from "./bot-rendering.js";
import type { ChannelContext } from "./channel-adapter.js";
import type { ChannelContextKey } from "./context-key.js";

export interface ChannelExternalMonitorOptions<Key extends ChannelContextKey> {
  config: ConnectorConfig;
  registry: SessionRegistry;
  promptStore: PromptStore;
  isContextKey(value: string): boolean;
  canSendSystemMessages(contextKey: Key): boolean;
  isAllowed?(contextKey: Key): boolean;
  contextForKey(contextKey: Key): ChannelContext | null;
  previousLastLine(contextKey: Key): number | undefined;
  mirrorSnapshot(
    contextKey: Key,
    context: ChannelContext,
    session: AgentSessionService,
    snapshot: NonNullable<ReturnType<typeof getExternalSnapshotForSession>>,
  ): Promise<void>;
  updateQueueStatus(contextKey: Key, context: ChannelContext, text: string): Promise<void>;
  drainQueue(contextKey: Key, context: ChannelContext, session: AgentSessionService): Promise<void>;
}

export async function monitorChannelExternalContexts<Key extends ChannelContextKey>(
  options: ChannelExternalMonitorOptions<Key>,
): Promise<void> {
  const contextKeys = new Set<Key>([
    ...options.registry.listContexts().map((context) => context.contextKey),
    ...options.promptStore.listContextKeys(),
  ].filter(options.isContextKey) as Key[]);

  for (const contextKey of contextKeys) {
    await monitorChannelExternalContext(options, contextKey);
  }
}

async function monitorChannelExternalContext<Key extends ChannelContextKey>(
  options: ChannelExternalMonitorOptions<Key>,
  contextKey: Key,
): Promise<void> {
  if (!options.canSendSystemMessages(contextKey) || options.isAllowed?.(contextKey) === false) {
    return;
  }

  const session = await options.registry.getOrCreate(contextKey, { deferThreadStart: true }).catch(() => null);
  const context = options.contextForKey(contextKey);
  if (!session || !context) {
    return;
  }

  const queueLength = options.promptStore.list(contextKey).length;
  const paused = options.promptStore.isPaused(contextKey);
  const shouldDrain = queueLength > 0 && !paused && !session.isProcessing();
  if (!capabilitiesOf(session.getInfo()).externalActivity || !session.getActiveThreadId()) {
    if (shouldDrain) {
      await options.drainQueue(contextKey, context, session);
    }
    return;
  }

  const snapshot = getExternalSnapshotForSession(session, options.config, {
    afterLine: options.previousLastLine(contextKey) ?? Number.MAX_SAFE_INTEGER,
  }) ?? getExternalSnapshotForSession(session, options.config, { maxEvents: 1 });

  if (!snapshot) {
    if (shouldDrain) {
      await options.drainQueue(contextKey, context, session);
    }
    return;
  }

  if (!session.isProcessing()) {
    await options.mirrorSnapshot(contextKey, context, session, snapshot);
  }

  if (snapshot.activity.active) {
    if (queueLength > 0) {
      await options.updateQueueStatus(
        contextKey,
        context,
        `Waiting for ${snapshot.agentLabel} CLI task... ${queueLength} queued${paused ? " (paused)" : ""}.`,
      ).catch(() => {});
    }
    return;
  }

  if (shouldDrain) {
    await options.updateQueueStatus(contextKey, context, `CLI task finished, running queued prompt 1/${queueLength}.`).catch(() => {});
    await options.drainQueue(contextKey, context, session);
  }
}
