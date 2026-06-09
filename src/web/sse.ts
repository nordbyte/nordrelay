import type { RelayEvent } from "../runtime/relay-runtime-types.js";

export function sseFrame(eventName: string, data: unknown, id?: string | number | null): string {
  const lines: string[] = [];
  const cleanId = sanitizeSseId(id);
  if (cleanId) {
    lines.push(`id: ${cleanId}`);
  }
  lines.push(`event: ${sanitizeSseEventName(eventName)}`);
  const payload = JSON.stringify(data);
  for (const line of payload.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }
  lines.push("", "");
  return lines.join("\n");
}

export function relayEventSseFrame(event: RelayEvent): string {
  return sseFrame(event.type, event, event.eventId ?? event.seq);
}

export function parseLastEventId(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function sanitizeSseId(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[\r\n]/g, "").trim();
}

function sanitizeSseEventName(value: string): string {
  return value.replace(/[\r\n:]/g, "").trim() || "message";
}
