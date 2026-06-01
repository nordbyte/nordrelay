import type { ChannelContextKey } from "./context-key.js";

export function remotePeerThreadSourceContextKey(baseContextKey: ChannelContextKey, threadId?: string | null): ChannelContextKey {
  const thread = contextPart(threadId);
  return thread ? `${baseContextKey}:thread:${thread}` : baseContextKey;
}

function contextPart(value?: string | null): string {
  return String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}
