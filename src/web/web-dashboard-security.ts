import { randomBytes } from "node:crypto";

export function createCspNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function requiresWebCsrf(method: string | undefined, pathname: string): boolean {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") {
    return false;
  }
  return pathname.startsWith("/api/");
}

export function isMutatingWebApiRequest(method: string | undefined, pathname: string): boolean {
  return requiresWebCsrf(method, pathname);
}
