import type { AgentSessionService } from "../../agents/shared/agent.js";
import { getAgentActivityLog, getExternalSnapshotForSession } from "../../agents/shared/agent-activity.js";
import type { ConnectorConfig } from "../../core/config.js";

const DEFAULT_LAST_MESSAGE_COUNT = 1;
const MAX_LAST_MESSAGE_COUNT = 5;

export interface LastAgentMessageOptions {
  count: number;
}

export interface LastAgentMessageResult {
  ok: boolean;
  text: string;
  count: number;
}

export function parseLastAgentMessageOptions(argument: string | undefined): LastAgentMessageOptions {
  const tokens = String(argument ?? "").trim().split(/\s+/).filter(Boolean);
  const numeric = tokens.find((token) => /^\d+$/.test(token));
  if (!numeric) {
    return { count: DEFAULT_LAST_MESSAGE_COUNT };
  }
  const parsed = Number.parseInt(numeric, 10);
  if (!Number.isFinite(parsed)) {
    return { count: DEFAULT_LAST_MESSAGE_COUNT };
  }
  return {
    count: Math.max(1, Math.min(MAX_LAST_MESSAGE_COUNT, parsed)),
  };
}

export function getLastAgentMessageText(
  session: AgentSessionService,
  config: ConnectorConfig,
  options: LastAgentMessageOptions = { count: DEFAULT_LAST_MESSAGE_COUNT },
): LastAgentMessageResult {
  const info = session.getInfo();
  const threadId = session.getActiveThreadId() ?? info.threadId;
  if (!threadId) {
    return {
      ok: false,
      text: `No active ${info.agentLabel} thread yet.`,
      count: 0,
    };
  }

  const messages = options.count > 1
    ? collectRecentAgentMessages(session, config, options.count)
    : [];
  if (messages.length === 0) {
    const snapshot = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
    const latest = cleanAgentMessage(snapshot?.latestAgentMessage);
    if (latest) {
      messages.push(latest);
    }
  }

  if (messages.length === 0) {
    return {
      ok: false,
      text: `No previous ${info.agentLabel} reply found for this thread.`,
      count: 0,
    };
  }

  return {
    ok: true,
    text: formatLastAgentMessages(messages),
    count: messages.length,
  };
}

function collectRecentAgentMessages(
  session: AgentSessionService,
  config: ConnectorConfig,
  count: number,
): string[] {
  const events = getAgentActivityLog(session, config, Math.max(50, count * 12));
  const messages: string[] = [];
  for (const event of events) {
    if (event.kind !== "agent") {
      continue;
    }
    const text = cleanAgentMessage(event.text);
    if (!text) {
      continue;
    }
    if (messages[messages.length - 1] === text) {
      continue;
    }
    messages.push(text);
  }
  return messages.slice(-count);
}

export function cleanAgentMessage(text: string | null | undefined): string | null {
  const cleaned = String(text ?? "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function formatLastAgentMessages(messages: string[]): string {
  if (messages.length === 1) {
    return messages[0] ?? "";
  }
  return messages
    .map((message, index) => `Last agent reply ${index + 1}/${messages.length}\n\n${message}`)
    .join("\n\n---\n\n");
}
