import type { Context } from "grammy";

import type { AgentSessionService } from "../../agents/shared/agent.js";
import type { TelegramContextKey } from "../shared/context-key.js";

export interface TelegramContextSession {
  contextKey: TelegramContextKey;
  session: AgentSessionService;
}

export type GetTelegramContextSession = (
  ctx: Context,
  options?: { deferThreadStart?: boolean },
) => Promise<TelegramContextSession | null>;
