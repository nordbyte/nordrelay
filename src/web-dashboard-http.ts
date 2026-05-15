import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import type { AgentUpdateOperation } from "./agent-updates.js";

const DEFAULT_JSON_BODY_LIMIT = 64 * 1024 * 1024;
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
const JSON_HEADERS = { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export type WebLogTarget = "connector" | "update" | "agent-updates";

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(valueParts.join("=") ?? "");
  }
  return cookies;
}

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
}

export function isRequestBodyTooLargeError(error: unknown): error is RequestBodyTooLargeError {
  return error instanceof RequestBodyTooLargeError;
}

export async function readJsonBody(req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new RequestBodyTooLargeError(`Request body is too large. Max ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(`${JSON.stringify(value)}\n`);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

export function sendFile(res: ServerResponse, filePath: string, filename: string): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  });
  createReadStream(filePath).pipe(res);
}

export function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`${key} is required`);
  }
  return field.trim();
}

export function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

export function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

export function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  const parsed = typeof field === "number" ? field : typeof field === "string" ? Number(field) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

export function optionalNumberField(value: Record<string, unknown>, key: string): number | undefined {
  if (value[key] === undefined || value[key] === "") {
    return undefined;
  }
  return numberField(value, key);
}

export function arrayStringField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (field === undefined || field === null || field === "") {
    return [];
  }
  if (Array.isArray(field)) {
    return field.filter((item): item is string => typeof item === "string");
  }
  if (typeof field === "string") {
    return field.split(",").map((item) => item.trim()).filter(Boolean);
  }
  throw new Error(`${key} must be a string list`);
}

export function arrayNumberField(value: Record<string, unknown>, key: string): number[] {
  const field = value[key];
  if (field === undefined || field === null || field === "") {
    return [];
  }
  if (Array.isArray(field)) {
    return field.map((item) => typeof item === "number" ? item : Number(item)).filter((item) => Number.isInteger(item));
  }
  if (typeof field === "string") {
    return field.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item));
  }
  throw new Error(`${key} must be a number list`);
}

export function parseAgentUpdateOperation(value: string | undefined): AgentUpdateOperation {
  if (!value || value === "update") {
    return "update";
  }
  if (value === "install") {
    return "install";
  }
  throw new Error(`Invalid agent update operation: ${value}`);
}

export function parseLogTarget(value: string | undefined): WebLogTarget {
  return value === "update" || value === "agent-updates" ? value : "connector";
}

export function objectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, string>;
}

export function parseUploadFiles(value: unknown): Array<{ name: string; mimeType?: string; data: Buffer }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : `upload-${index + 1}`;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : undefined;
    const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
    if (!dataBase64) {
      throw new Error(`files[${index}].dataBase64 is required`);
    }
    return { name, mimeType, data: Buffer.from(stripDataUrlPrefix(dataBase64), "base64") };
  });
}

export function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function requiredSearch(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma !== -1 ? value.slice(comma + 1) : value;
}
