import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { WEB_API_ROUTE_DEFINITIONS } from "../src/web/web-api-contract.js";
import { requiresWebCsrf } from "../src/web/web-dashboard-security.js";
import { isRequestBodyTooLargeError, readJsonBody, webSecurityHeaders } from "../src/web/web-dashboard-http.js";
import { consumeRateLimit } from "../src/web/web-rate-limit.js";

describe("web dashboard HTTP helpers", () => {
  it("limits JSON request bodies and reports 413-compatible errors", async () => {
    const req = Readable.from([Buffer.from("{\"value\":\"too large\"}")]);

    await expect(readJsonBody(req as never, 8)).rejects.toSatisfy(isRequestBodyTooLargeError);
  });

  it("parses JSON bodies within the configured limit", async () => {
    const req = Readable.from([Buffer.from("{\"value\":42}")]);

    await expect(readJsonBody(req as never, 1024)).resolves.toEqual({ value: 42 });
  });

  it("uses nonce-based CSP without unsafe inline allowances", () => {
    const csp = webSecurityHeaders("abc123")["content-security-policy"];

    expect(csp).toContain("'nonce-abc123'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it("requires CSRF for every mutating Web API route", () => {
    for (const route of WEB_API_ROUTE_DEFINITIONS) {
      for (const method of route.methods) {
        const expected = method !== "GET";
        expect(requiresWebCsrf(method, route.path), `${method} ${route.path}`).toBe(expected);
      }
    }
  });

  it("rate limits repeated mutating API attempts", () => {
    const buckets = new Map();

    expect(consumeRateLimit(buckets, "user-1", 2, 1000, 5000, 100).limited).toBe(false);
    expect(consumeRateLimit(buckets, "user-1", 2, 1000, 5000, 200).limited).toBe(false);
    const limited = consumeRateLimit(buckets, "user-1", 2, 1000, 5000, 300);
    expect(limited.limited).toBe(true);
    expect(limited.retryAfterMs).toBe(5000);
  });
});
