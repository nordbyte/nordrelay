import { randomBytes } from "node:crypto";

import { routeForWebRequest } from "./web-api-contract.js";

export function createCspNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function requiresWebCsrf(method: string | undefined, pathname: string): boolean {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") {
    return false;
  }
  if (routeForWebRequest(verb, pathname)?.auth === "anonymous-token") {
    return false;
  }
  return pathname.startsWith("/api/");
}

export function isMutatingWebApiRequest(method: string | undefined, pathname: string): boolean {
  if (!requiresWebCsrf(method, pathname)) {
    return false;
  }
  return !isPeerProxyTransportRequest(method, pathname);
}

function isPeerProxyTransportRequest(method: string | undefined, pathname: string): boolean {
  const verb = (method ?? "GET").toUpperCase();
  return verb === "POST" && /^\/api\/peers\/[^/]+\/proxy$/.test(pathname);
}
