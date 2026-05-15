import type { AgentId } from "./agent.js";
import type { BotPreferencesStore, ChannelMirrorMode } from "./bot-preferences.js";
import type { ConnectorConfig } from "./config.js";
import { channelIdForContextKey, type ChannelContextKey } from "./context-key.js";
import type { PromptStore } from "./prompt-store.js";
import type { ActiveSessionMirrorDto, ActiveSessionSource } from "./relay-runtime-types.js";
import type { ContextMetadata } from "./session-registry.js";

export interface ChannelMirrorState extends ActiveSessionMirrorDto {
  agentId: AgentId;
  threadId: string;
  updatedAt: string;
}

export class ChannelMirrorRegistry {
  private readonly states = new Map<string, ChannelMirrorState>();

  constructor(
    private readonly config: ConnectorConfig,
    private readonly promptStore: PromptStore,
  ) {}

  activeMirrorsForThread(
    agentId: AgentId,
    threadId: string,
    knownContexts: ContextMetadata[],
    preferences: BotPreferencesStore,
  ): ActiveSessionMirrorDto[] {
    const mirrors: ActiveSessionMirrorDto[] = [];
    const seen = new Set<ChannelContextKey>();
    for (const meta of knownContexts) {
      const metaAgentId = meta.agentId ?? this.config.defaultAgent;
      if (meta.threadId !== threadId || metaAgentId !== agentId) {
        continue;
      }

      const source = activeSessionSourceForContextKey(meta.contextKey);
      if (!isMirrorChannelSource(source) || seen.has(meta.contextKey)) {
        continue;
      }

      const mode = this.effectiveMirrorMode(meta.contextKey, source, preferences);
      if (mode === "off") {
        this.states.delete(this.stateKey(source, meta.contextKey, agentId, threadId));
        continue;
      }

      seen.add(meta.contextKey);
      const mirror: ActiveSessionMirrorDto = {
        source,
        contextKey: meta.contextKey,
        mode,
        queueLength: this.promptStore.list(meta.contextKey).length,
        queuePaused: this.promptStore.isPaused(meta.contextKey),
      };
      mirrors.push(mirror);
      this.states.set(this.stateKey(source, meta.contextKey, agentId, threadId), {
        ...mirror,
        agentId,
        threadId,
        updatedAt: new Date().toISOString(),
      });
    }
    return mirrors;
  }

  queueLengthForExternalSource(sourceContextKey: ChannelContextKey, mirrors: ActiveSessionMirrorDto[]): number {
    return mirrors.reduce((sum, mirror) => sum + mirror.queueLength, this.promptStore.list(sourceContextKey).length);
  }

  queuePausedForExternalSource(sourceContextKey: ChannelContextKey, mirrors: ActiveSessionMirrorDto[]): boolean {
    return mirrors.some((mirror) => mirror.queuePaused) || this.promptStore.isPaused(sourceContextKey);
  }

  effectiveMirrorMode(
    contextKey: ChannelContextKey,
    source: "telegram" | "discord" | "slack" | "web",
    preferences: BotPreferencesStore,
  ): Exclude<ChannelMirrorMode, "off"> | "off" {
    const configured = configuredMirrorMode(this.config, source);
    return preferences.get(contextKey).mirrorMode ?? configured;
  }

  snapshot(): ChannelMirrorState[] {
    return [...this.states.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  private stateKey(source: ActiveSessionMirrorDto["source"], contextKey: ChannelContextKey, agentId: AgentId, threadId: string): string {
    return `${source}:${contextKey}:${agentId}:${threadId}`;
  }
}

export function activeSessionSourceForContextKey(contextKey: ChannelContextKey): ActiveSessionSource {
  const channelId = channelIdForContextKey(contextKey);
  if (channelId === "telegram") {
    return "telegram";
  }
  if (channelId === "discord") {
    return "discord";
  }
  if (channelId === "slack") {
    return "slack";
  }
  if (channelId === "web") {
    return "web";
  }
  return "cli";
}

export function isMirrorChannelSource(source: ActiveSessionSource): source is "telegram" | "discord" | "slack" | "web" {
  return source === "telegram" || source === "discord" || source === "slack" || source === "web";
}

function configuredMirrorMode(config: ConnectorConfig, source: "telegram" | "discord" | "slack" | "web"): ChannelMirrorMode {
  if (source === "telegram") {
    return config.telegramMirrorMode;
  }
  if (source === "discord") {
    return config.discordMirrorMode;
  }
  if (source === "slack") {
    return config.slackMirrorMode;
  }
  return config.webMirrorMode;
}
