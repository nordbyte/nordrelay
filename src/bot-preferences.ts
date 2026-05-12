import path from "node:path";

import type { TelegramContextKey } from "./context-key.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";

export type TelegramMirrorMode = "off" | "status" | "final" | "full";
export type TelegramNotifyMode = "off" | "minimal" | "all";
export type VoiceBackendPreference = "auto" | "parakeet" | "faster-whisper" | "openai";

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
}

interface PersistedPreferences {
  version: 1;
  contexts: Record<TelegramContextKey, ContextPreferences>;
}

export class BotPreferencesStore {
  private readonly persistPath: string;
  private readonly contexts = new Map<TelegramContextKey, ContextPreferences>();

  constructor(workspace: string) {
    this.persistPath = path.join(workspace, ".nordrelay", "preferences.json");
    this.load();
  }

  get(contextKey: TelegramContextKey): ContextPreferences {
    return { ...(this.contexts.get(contextKey) ?? {}) };
  }

  update(contextKey: TelegramContextKey, patch: ContextPreferences): ContextPreferences {
    const current = this.contexts.get(contextKey) ?? {};
    const next = pruneEmptyPreferences({
      ...current,
      ...patch,
    });
    this.contexts.set(contextKey, next);
    this.persist();
    return { ...next };
  }

  clear(contextKey: TelegramContextKey): void {
    this.contexts.delete(contextKey);
    this.persist();
  }

  private persist(): void {
    const payload: PersistedPreferences = {
      version: 1,
      contexts: Object.fromEntries(this.contexts.entries()),
    };
    writeJsonFileAtomic(this.persistPath, payload);
  }

  private load(): void {
    const result = readJsonFileWithBackup<Partial<PersistedPreferences>>(this.persistPath);
    if (!result.value?.contexts || typeof result.value.contexts !== "object") {
      return;
    }
    for (const [contextKey, rawPreferences] of Object.entries(result.value.contexts)) {
      const preferences = normalizePreferences(rawPreferences);
      if (preferences) {
        this.contexts.set(contextKey, preferences);
      }
    }
  }
}

export function parseMirrorMode(value: string | undefined, fallback: TelegramMirrorMode): TelegramMirrorMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "status" || normalized === "final" || normalized === "full") {
    return normalized;
  }
  return fallback;
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
  return value === "auto" || value === "parakeet" || value === "faster-whisper" || value === "openai";
}
