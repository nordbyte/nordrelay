import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type ChannelMirrorMode = "off" | "status" | "final" | "full";
export type ChannelMirrorToggleMode = "off" | "on";
export type ChannelNotifyMode = "off" | "minimal" | "all";
export type TelegramMirrorMode = ChannelMirrorMode;
export type TelegramNotifyMode = ChannelNotifyMode;
export type VoiceBackendPreference = "auto" | "parakeet" | "faster-whisper" | "cohere-transcribe" | "openai";

export interface QuietHours {
  startHour: number;
  endHour: number;
}

export interface ContextPreferences {
  mirrorMode?: TelegramMirrorMode;
  notifyMode?: TelegramNotifyMode;
  quietHours?: QuietHours | null;
  voiceBackend?: VoiceBackendPreference;
  voiceLanguage?: string | null;
  voiceTranscribeOnly?: boolean;
  targetPeerId?: string | null;
  targetThreadId?: string | null;
  targetAgentId?: string | null;
}

interface PersistedPreferences {
  version: 1;
  contexts: Record<ChannelContextKey, ContextPreferences>;
}

export class BotPreferencesStore {
  private readonly store: DocumentStore<PersistedPreferences>;
  private readonly contexts = new Map<ChannelContextKey, ContextPreferences>();

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedPreferences>({
      workspace,
      fileName: "preferences.json",
      sqliteKey: "preferences",
      backend,
    });
    this.load();
  }

  get(contextKey: ChannelContextKey): ContextPreferences {
    this.load();
    return { ...(this.contexts.get(contextKey) ?? {}) };
  }

  list(): Array<{ contextKey: ChannelContextKey; preferences: ContextPreferences }> {
    this.load();
    return [...this.contexts.entries()].map(([contextKey, preferences]) => ({
      contextKey,
      preferences: { ...preferences },
    }));
  }

  update(contextKey: ChannelContextKey, patch: ContextPreferences): ContextPreferences {
    let updated: ContextPreferences = {};
    const payload = this.store.update((current) => {
      const payload = normalizePayload(current);
      const previous = payload.contexts[contextKey] ?? {};
      updated = pruneEmptyPreferences({
        ...previous,
        ...patch,
      });
      payload.contexts[contextKey] = updated;
      return payload;
    });
    this.replaceContexts(payload);
    return { ...updated };
  }

  clear(contextKey: ChannelContextKey): void {
    const payload = this.store.update((current) => {
      const payload = normalizePayload(current);
      delete payload.contexts[contextKey];
      return payload;
    });
    this.replaceContexts(payload);
  }

  private load(): void {
    this.replaceContexts(normalizePayload(this.store.read()));
  }

  private replaceContexts(payload: PersistedPreferences): void {
    this.contexts.clear();
    for (const [contextKey, rawPreferences] of Object.entries(payload.contexts)) {
      const preferences = normalizePreferences(rawPreferences);
      if (preferences) {
        this.contexts.set(contextKey, preferences);
      }
    }
  }
}

function normalizePayload(payload: PersistedPreferences | undefined): PersistedPreferences {
  if (!payload?.contexts || typeof payload.contexts !== "object") {
    return { version: 1, contexts: {} };
  }
  return {
    version: 1,
    contexts: Object.fromEntries(
      Object.entries(payload.contexts)
        .map(([contextKey, preferences]) => [contextKey, normalizePreferences(preferences)] as const)
        .filter((entry): entry is readonly [string, ContextPreferences] => Boolean(entry[1])),
    ),
  };
}

export function parseMirrorMode(value: string | undefined, fallback: TelegramMirrorMode): TelegramMirrorMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "on") {
    return "final";
  }
  if (normalized === "off" || normalized === "status" || normalized === "final" || normalized === "full") {
    return normalized;
  }
  return fallback;
}

export function parseMirrorToggleMode(value: string | undefined): ChannelMirrorMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "on") {
    return "final";
  }
  return null;
}

export function normalizeMirrorRuntimeMode(mode: ChannelMirrorMode | undefined): ChannelMirrorMode {
  return mode === "off" ? "off" : "final";
}

export function mirrorToggleMode(mode: ChannelMirrorMode | undefined): ChannelMirrorToggleMode {
  return normalizeMirrorRuntimeMode(mode) === "off" ? "off" : "on";
}

export function parseNotifyMode(value: string | undefined, fallback: TelegramNotifyMode): TelegramNotifyMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "minimal" || normalized === "all") {
    return normalized;
  }
  return fallback;
}

export function parseVoiceBackendPreference(value: string | undefined): VoiceBackendPreference {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "parakeet" ||
    normalized === "faster-whisper" ||
    normalized === "cohere-transcribe" ||
    normalized === "openai"
  ) {
    return normalized;
  }
  return "auto";
}

export function parseQuietHours(value: string | undefined): QuietHours | null {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) {
    throw new Error("Quiet hours must use HH-HH format, e.g. 22-7");
  }
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    throw new Error("Quiet hours must use hours from 0 to 23");
  }
  return { startHour, endHour };
}

export function isQuietNow(quietHours: QuietHours | null | undefined, now = new Date()): boolean {
  if (!quietHours) {
    return false;
  }
  const hour = now.getHours();
  if (quietHours.startHour === quietHours.endHour) {
    return true;
  }
  if (quietHours.startHour < quietHours.endHour) {
    return hour >= quietHours.startHour && hour < quietHours.endHour;
  }
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}

export function formatQuietHours(quietHours: QuietHours | null | undefined): string {
  if (!quietHours) {
    return "off";
  }
  return `${quietHours.startHour.toString().padStart(2, "0")}-${quietHours.endHour.toString().padStart(2, "0")}`;
}

function normalizePreferences(value: unknown): ContextPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as ContextPreferences;
  return pruneEmptyPreferences({
    mirrorMode: isMirrorMode(candidate.mirrorMode) ? candidate.mirrorMode : undefined,
    notifyMode: isNotifyMode(candidate.notifyMode) ? candidate.notifyMode : undefined,
    quietHours: normalizeQuietHours(candidate.quietHours),
    voiceBackend: isVoiceBackendPreference(candidate.voiceBackend) ? candidate.voiceBackend : undefined,
    voiceLanguage: typeof candidate.voiceLanguage === "string" ? candidate.voiceLanguage : candidate.voiceLanguage === null ? null : undefined,
    voiceTranscribeOnly: typeof candidate.voiceTranscribeOnly === "boolean" ? candidate.voiceTranscribeOnly : undefined,
    targetPeerId: typeof candidate.targetPeerId === "string" ? candidate.targetPeerId : candidate.targetPeerId === null ? null : undefined,
    targetThreadId: typeof candidate.targetThreadId === "string" ? candidate.targetThreadId : candidate.targetThreadId === null ? null : undefined,
    targetAgentId: typeof candidate.targetAgentId === "string" ? candidate.targetAgentId : candidate.targetAgentId === null ? null : undefined,
  });
}

function pruneEmptyPreferences(preferences: ContextPreferences): ContextPreferences {
  return Object.fromEntries(
    Object.entries(preferences).filter(([, value]) => value !== undefined),
  ) as ContextPreferences;
}

function normalizeQuietHours(value: unknown): QuietHours | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as QuietHours;
  return Number.isInteger(candidate.startHour) &&
    Number.isInteger(candidate.endHour) &&
    candidate.startHour >= 0 &&
    candidate.startHour <= 23 &&
    candidate.endHour >= 0 &&
    candidate.endHour <= 23
    ? { startHour: candidate.startHour, endHour: candidate.endHour }
    : undefined;
}

function isMirrorMode(value: unknown): value is TelegramMirrorMode {
  return value === "off" || value === "status" || value === "final" || value === "full";
}

function isNotifyMode(value: unknown): value is TelegramNotifyMode {
  return value === "off" || value === "minimal" || value === "all";
}

function isVoiceBackendPreference(value: unknown): value is VoiceBackendPreference {
  return value === "auto" || value === "parakeet" || value === "faster-whisper" || value === "cohere-transcribe" || value === "openai";
}
