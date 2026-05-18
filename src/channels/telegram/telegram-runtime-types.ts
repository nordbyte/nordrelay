import type { Context } from "grammy";

import type { AgentExternalActivity, AgentSessionService } from "../../agents/shared/agent.js";
import type { StagedFile } from "../../artifacts/attachments.js";
import type {
  ChannelBusyReason,
  ChannelBusyState,
  ChannelExternalMirrorState,
  ChannelQueueStatusState,
} from "../shared/channel-bridge-state.js";
import type { TelegramContextKey } from "../shared/context-key.js";
import type { RenderedText, TelegramChatId } from "./telegram-output.js";

export const EDIT_DEBOUNCE_MS = 1500;
export const TYPING_INTERVAL_MS = 4500;
export const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
export const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
export const MEDIA_GROUP_FLUSH_MS = 1200;
export const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

export interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

export type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

export type MediaGroupPart =
  | {
      kind: "photo";
      fileId: string;
      fileName: string;
      mimeType: string;
      caption?: string;
    }
  | {
      kind: "document";
      fileId: string;
      fileName: string;
      mimeType: string;
      fileSize?: number;
      caption?: string;
    };

export type PendingMediaGroup = {
  ctx: Context;
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  session: AgentSessionService;
  messageThreadId?: number;
  parts: MediaGroupPart[];
  timer: NodeJS.Timeout;
};

export type TelegramBusyState = ChannelBusyState & {
  transcribing: boolean;
  approving: boolean;
  external?: boolean;
};

export type TelegramBusyReason = ChannelBusyReason<{ activity: AgentExternalActivity }>;
export type TelegramExternalMirrorState = ChannelExternalMirrorState<number>;
export type TelegramQueueStatusState = ChannelQueueStatusState<number>;

export interface PendingVoiceTranscription {
  fileName: string;
  filePath: string;
  stagedFile?: StagedFile;
}
