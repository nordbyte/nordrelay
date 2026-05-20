export interface CursorPageMeta {
  limit: number;
  nextCursor: string | null;
  hasNext: boolean;
  total: number;
}

export interface CursorPage<T> {
  items: T[];
  pagination: CursorPageMeta;
}

export function normalizeCursorLimit(value: number | string | null | undefined, fallback = 100, max = 500): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  const selected = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(max, selected));
}

export function cursorPage<T>(
  items: T[],
  cursor: string | null | undefined,
  limit: number,
  cursorOf: (item: T) => string | null | undefined,
): CursorPage<T> {
  const normalizedLimit = normalizeCursorLimit(limit, limit);
  const startIndex = cursor ? Math.max(0, items.findIndex((item) => cursorOf(item) === cursor) + 1) : 0;
  const window = items.slice(startIndex, startIndex + normalizedLimit + 1);
  const pageItems = window.slice(0, normalizedLimit);
  const hasNext = window.length > normalizedLimit;
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    pagination: {
      limit: normalizedLimit,
      nextCursor: hasNext && last ? cursorOf(last) ?? null : null,
      hasNext,
      total: items.length,
    },
  };
}
