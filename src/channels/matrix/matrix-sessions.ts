import type { AgentThreadRecord } from "../../agents/shared/agent.js";
import type { ChannelActionButton } from "../shared/channel-actions.js";
import type { ChannelContextKey } from "../shared/context-key.js";
import { formatRelativeTime, getWorkspaceShortName, trimLine } from "../shared/bot-rendering.js";

export const MATRIX_SESSION_PAGE_SIZE = 6;

const MATRIX_SESSION_TITLE_LIMIT = 120;
const MATRIX_SESSION_ID_LIMIT = 96;
const MATRIX_SESSION_WORKSPACE_LIMIT = 140;

export type MatrixSessionListRecord = Pick<AgentThreadRecord, "id" | "title" | "cwd" | "firstUserMessage" | "model" | "updatedAt">;
export type MatrixSessionPageSource = "sessions" | "pinned";

export interface MatrixSessionPageState {
  contextKey: ChannelContextKey;
  source: MatrixSessionPageSource;
  query: string;
  title?: string;
  records: MatrixSessionListRecord[];
  activeThreadId?: string | null;
  pinnedThreadIds: string[];
  page: number;
  pageSize: number;
  createdAt: number;
}

export function renderMatrixSessionList(
  title: string,
  records: MatrixSessionListRecord[],
  options: {
    startIndex?: number;
    total?: number;
    page?: number;
    totalPages?: number;
    activeThreadId?: string | null;
    pinnedThreadIds?: string[];
  } = {},
): string {
  const startIndex = options.startIndex ?? 0;
  const header = options.total !== undefined
    ? `${title} (${records.length ? `${startIndex + 1}-${startIndex + records.length}` : "0"} of ${options.total}${options.totalPages ? `, page ${(options.page ?? 0) + 1}/${options.totalPages}` : ""}):`
    : `${title}:`;
  const pinnedSet = new Set(options.pinnedThreadIds ?? []);
  return [
    header,
    ...records.map((record, index) => {
      const label = formatMatrixSessionLabel(record, {
        isActive: record.id === options.activeThreadId,
        isPinned: pinnedSet.has(record.id),
      });
      const id = trimLine(record.id, MATRIX_SESSION_ID_LIMIT);
      const workspace = trimLine(record.cwd || "-", MATRIX_SESSION_WORKSPACE_LIMIT);
      return `${startIndex + index + 1}. ${label}\n   ${id}\n   ${workspace}`;
    }),
    "",
    "Send one of the listed actions to switch pages or select a session.",
  ].join("\n");
}

export function renderMatrixSessionPageAction(
  title: string,
  records: MatrixSessionListRecord[],
  pickId: string,
  options: {
    page?: number;
    pageSize?: number;
    activeThreadId?: string | null;
    pinnedThreadIds?: string[];
  } = {},
): { text: string; buttons: ChannelActionButton[][]; page: number; totalPages: number } {
  const pageSize = options.pageSize ?? MATRIX_SESSION_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(Math.max(0, options.page ?? 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageRecords = records.slice(startIndex, startIndex + pageSize);
  const pinnedSet = new Set(options.pinnedThreadIds ?? []);
  const rows = pageRecords.map((record, index) => [{
    label: formatMatrixSessionLabel(record, {
      isActive: record.id === options.activeThreadId,
      isPinned: pinnedSet.has(record.id),
      limit: 70,
    }),
    action: `matrix_pick:${pickId}:${startIndex + index}`,
  }]);
  if (totalPages > 1) {
    const nav: ChannelActionButton[] = [];
    if (safePage > 0) nav.push({ label: "Previous", action: `matrix_sessions_page:${pickId}:prev` });
    nav.push({ label: `${safePage + 1}/${totalPages}`, action: `matrix_sessions_page:${pickId}:refresh` });
    if (safePage < totalPages - 1) nav.push({ label: "Next", action: `matrix_sessions_page:${pickId}:next` });
    rows.push(nav);
  }
  return {
    text: renderMatrixSessionList(title, pageRecords, {
      startIndex,
      total: records.length,
      page: safePage,
      totalPages,
      activeThreadId: options.activeThreadId,
      pinnedThreadIds: options.pinnedThreadIds,
    }),
    buttons: rows,
    page: safePage,
    totalPages,
  };
}

function formatMatrixSessionLabel(record: MatrixSessionListRecord, options: { isActive?: boolean; isPinned?: boolean; limit?: number }): string {
  const prefix = options.isActive ? "active" : options.isPinned ? "pinned" : "session";
  const workspace = getWorkspaceShortName(record.cwd || "-") || "(unknown)";
  const title = record.title || record.firstUserMessage || record.id;
  const time = formatRelativeTime(record.updatedAt);
  const model = record.model ? ` · ${trimLine(record.model, 10)}` : "";
  return trimLine(`${prefix} · ${workspace} · ${title} · ${time}${model}`, options.limit ?? MATRIX_SESSION_TITLE_LIMIT);
}
