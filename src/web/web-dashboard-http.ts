import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import type { AgentUpdateOperation } from "../agents/shared/agent-updates.js";

const DEFAULT_JSON_BODY_LIMIT = 64 * 1024 * 1024;
const TEXT_COMPRESSION_THRESHOLD_BYTES = 1024;
const JSON_COMPRESSION_THRESHOLD_BYTES = 2048;
const DYNAMIC_GZIP_LEVEL = 6;
const DYNAMIC_BROTLI_QUALITY = 4;
const BASE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(self), geolocation=()",
};
const JSON_HEADERS = { ...webSecurityHeaders(), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const responseRequests = new WeakMap<ServerResponse, IncomingMessage>();

export type WebLogTarget = "connector" | "update" | "agent-updates";

export interface SendTextOptions {
  cacheControl?: string;
  cspNonce?: string;
}

export interface SendStaticFileOptions {
  brotliPath?: string;
  cacheControl?: string;
  gzipPath?: string;
}

type ResponseEncoding = "br" | "gzip";

interface EncodedBody {
  body: Buffer;
  encoding?: ResponseEncoding;
}

export function registerWebResponseRequest(req: IncomingMessage, res: ServerResponse): void {
  responseRequests.set(res, req);
}

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
  sendBuffer(
    res,
    status,
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    JSON_HEADERS,
    { compressionThresholdBytes: JSON_COMPRESSION_THRESHOLD_BYTES },
  );
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string, options: SendTextOptions = {}): void {
  const body = isHtmlContentType(contentType) ? minifyHtml(text) : text;
  sendBuffer(
    res,
    status,
    Buffer.from(body, "utf8"),
    {
      ...webSecurityHeaders(options.cspNonce),
      "content-type": contentType,
      "cache-control": options.cacheControl ?? "no-store",
    },
    { compressionThresholdBytes: TEXT_COMPRESSION_THRESHOLD_BYTES },
  );
}

export function sendFile(res: ServerResponse, filePath: string, filename: string): void {
  res.writeHead(200, {
    ...webSecurityHeaders(),
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  });
  createReadStream(filePath).pipe(res);
}

export function sendStaticFile(res: ServerResponse, filePath: string, contentType: string, options: SendStaticFileOptions = {}): void {
  const req = responseRequests.get(res);
  const selected = selectPrecompressedFile(req, {
    br: options.brotliPath,
    gzip: options.gzipPath,
  });
  const selectedPath = selected?.filePath ?? filePath;
  const headers: Record<string, string | number> = {
    ...webSecurityHeaders(),
    "content-type": contentType,
    "cache-control": options.cacheControl ?? "public, max-age=86400",
    "content-length": statSync(selectedPath).size,
  };
  if (selected?.encoding) {
    headers["content-encoding"] = selected.encoding;
  }
  if (options.brotliPath || options.gzipPath) {
    headers.vary = "Accept-Encoding";
  }
  res.writeHead(200, headers);
  createReadStream(selectedPath).pipe(res);
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

export function webSecurityHeaders(cspNonce?: string): Record<string, string> {
  const scriptSrc = cspNonce ? `'self' 'nonce-${cspNonce}'` : "'self'";
  const styleSrc = cspNonce ? `'self' 'nonce-${cspNonce}'` : "'self'";
  return {
    ...BASE_SECURITY_HEADERS,
    "content-security-policy": `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  };
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Record<string, string>,
  options: { compressionThresholdBytes: number },
): void {
  const req = responseRequests.get(res);
  const encoded = encodeBodyForRequest(req, body, options.compressionThresholdBytes);
  const responseHeaders: Record<string, string | number> = {
    ...headers,
    "content-length": encoded.body.length,
  };
  if (req) {
    responseHeaders.vary = "Accept-Encoding";
  }
  if (encoded.encoding) {
    responseHeaders["content-encoding"] = encoded.encoding;
  }
  res.writeHead(status, responseHeaders);
  res.end(encoded.body);
}

function encodeBodyForRequest(req: IncomingMessage | undefined, body: Buffer, thresholdBytes: number): EncodedBody {
  if (!req || body.length < thresholdBytes) {
    return { body };
  }
  const encoding = preferredResponseEncoding(req, { br: true, gzip: true });
  if (encoding === "br") {
    return {
      body: brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY } }),
      encoding,
    };
  }
  if (encoding === "gzip") {
    return { body: gzipSync(body, { level: DYNAMIC_GZIP_LEVEL }), encoding };
  }
  return { body };
}

function selectPrecompressedFile(req: IncomingMessage | undefined, paths: { br?: string; gzip?: string }): { encoding: ResponseEncoding; filePath: string } | null {
  const encoding = preferredResponseEncoding(req, { br: Boolean(paths.br), gzip: Boolean(paths.gzip) });
  if (encoding === "br" && paths.br) {
    return { encoding, filePath: paths.br };
  }
  if (encoding === "gzip" && paths.gzip) {
    return { encoding, filePath: paths.gzip };
  }
  return null;
}

function preferredResponseEncoding(req: IncomingMessage | undefined, available: Record<ResponseEncoding, boolean>): ResponseEncoding | null {
  if (!req) {
    return null;
  }
  const brQ = available.br ? acceptedEncodingQ(req, "br") : 0;
  const gzipQ = available.gzip ? acceptedEncodingQ(req, "gzip") : 0;
  if (brQ <= 0 && gzipQ <= 0) {
    return null;
  }
  return brQ >= gzipQ ? "br" : "gzip";
}

function acceptedEncodingQ(req: IncomingMessage, encoding: ResponseEncoding): number {
  const header = req.headers["accept-encoding"];
  const value = Array.isArray(header) ? header.join(",") : header ?? "";
  let wildcardQ = 0;
  for (const part of value.split(",")) {
    const [rawName, ...rawParams] = part.trim().split(";").map((item) => item.trim());
    if (!rawName) {
      continue;
    }
    const q = rawParams.reduce((current, param) => {
      const match = /^q=([0-9.]+)$/i.exec(param);
      return match ? Number(match[1]) : current;
    }, 1);
    if (rawName.toLowerCase() === encoding) {
      return Number.isFinite(q) ? q : 0;
    }
    if (rawName === "*") {
      wildcardQ = Number.isFinite(q) ? q : 0;
    }
  }
  return wildcardQ;
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("text/html");
}

export function minifyHtml(html: string): string {
  return html.replace(/>\s+</g, "><").trim();
}
