import type { Context } from "grammy";

import type { AgentSessionService } from "./agent.js";
import type { TelegramContextKey } from "./context-key.js";

export interface TelegramContextSession {
  contextKey: TelegramContextKey;
  session: AgentSessionService;
}

export type GetTelegramContextSession = (
  ctx: Context,
  options?: { deferThreadStart?: boolean },
) => Promise<TelegramContextSession | null>;
