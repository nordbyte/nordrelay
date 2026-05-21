import type { AgentThreadRecord } from "../../agents/shared/agent.js";
import type { ChannelActionButton } from "../shared/channel-actions.js";
import type { ChannelContextKey } from "../shared/context-key.js";
import { trimLine } from "../shared/bot-rendering.js";
import { trimDiscordMessage } from "./discord-channel-runtime.js";

const MAX_DISCORD_COMMAND_REPLY_CHUNKS = 5;
export const DISCORD_SESSION_PAGE_SIZE = 10;
const DISCORD_SESSION_TITLE_LIMIT = 120;
const DISCORD_SESSION_ID_LIMIT = 96;
const DISCORD_SESSION_WORKSPACE_LIMIT = 140;

export type DiscordSessionListRecord = Pick<AgentThreadRecord, "id" | "title" | "cwd" | "firstUserMessage">;
export type DiscordSessionPageSource = "sessions" | "pinned";

export interface DiscordSessionPageState {
  contextKey: ChannelContextKey;
  source: DiscordSessionPageSource;
  query: string;
  title?: string;
  records: DiscordSessionListRecord[];
  page: number;
  pageSize: number;
  createdAt: number;
}

export function renderDiscordSessionList(title: string, records: DiscordSessionListRecord[], options: { startIndex?: number; total?: number; page?: number; totalPages?: number } = {}): string {
  const startIndex = options.startIndex ?? 0;
  const header = options.total !== undefined
    ? `${title} (${records.length ? `${startIndex + 1}-${startIndex + records.length}` : "0"} of ${options.total}${options.totalPages ? `, page ${(options.page ?? 0) + 1}/${options.totalPages}` : ""}):`
    : `${title}:`;
  return [
    header,
    ...records.map((record, index) => {
      const label = trimLine(record.title || record.firstUserMessage || record.id, DISCORD_SESSION_TITLE_LIMIT) || trimLine(record.id, DISCORD_SESSION_TITLE_LIMIT);
      const id = trimLine(record.id, DISCORD_SESSION_ID_LIMIT);
      const workspace = trimLine(record.cwd || "-", DISCORD_SESSION_WORKSPACE_LIMIT);
      return `${startIndex + index + 1}. ${label}\n   ${id}\n   ${workspace}`;
    }),
  ].join("\n");
}

export function renderDiscordSessionPageAction(title: string, records: DiscordSessionListRecord[], pickId: string, page = 0, pageSize = DISCORD_SESSION_PAGE_SIZE): { text: string; buttons: ChannelActionButton[][]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageRecords = records.slice(startIndex, startIndex + pageSize);
  const selectionButtons = pageRecords.map((record, index) => ({
    label: trimLine(record.title || record.firstUserMessage || record.id, 70) || trimLine(record.id, 70),
    action: `discord_pick:${pickId}:${startIndex + index}`,
  }));
  const rows = chunkDiscordButtons(selectionButtons, 5);
  if (totalPages > 1) {
    const nav: ChannelActionButton[] = [];
    if (safePage > 0) nav.push({ label: "Previous", action: `discord_sessions_page:${pickId}:prev` });
    nav.push({ label: "Refresh", action: `discord_sessions_page:${pickId}:refresh` });
    if (safePage < totalPages - 1) nav.push({ label: "Next", action: `discord_sessions_page:${pickId}:next` });
    rows.push(nav);
  }
  return {
    text: renderDiscordSessionList(title, pageRecords, { startIndex, total: records.length, page: safePage, totalPages }),
    buttons: rows.slice(0, 5),
    page: safePage,
    totalPages,
  };
}

export function capDiscordCommandReplyChunks(chunks: string[], maxChunks = MAX_DISCORD_COMMAND_REPLY_CHUNKS): string[] {
  const effectiveMax = Math.max(1, maxChunks);
  if (chunks.length <= effectiveMax) {
    return chunks;
  }
  const capped = chunks.slice(0, effectiveMax);
  const omitted = chunks.length - effectiveMax;
  capped[capped.length - 1] = trimDiscordMessage(`${capped[capped.length - 1]}\n\n[Output truncated: ${omitted} additional Discord message${omitted === 1 ? "" : "s"} omitted.]`);
  return capped;
}

function chunkDiscordButtons(buttons: ChannelActionButton[], size: number): ChannelActionButton[][] {
  const rows: ChannelActionButton[][] = [];
  for (let index = 0; index < buttons.length; index += size) {
    rows.push(buttons.slice(index, index + size));
  }
  return rows;
}
