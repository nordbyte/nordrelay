import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { WEB_API_ROUTE_DEFINITIONS } from "../src/web/web-api-contract.js";
import { requiresWebCsrf } from "../src/web/web-dashboard-security.js";
import {
  isRequestBodyTooLargeError,
  minifyHtml,
  readJsonBody,
  registerWebResponseRequest,
  sendJson,
  sendStaticFile,
  sendText,
  webSecurityHeaders,
} from "../src/web/web-dashboard-http.js";
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

  it("allows same-origin microphone access for WebUI voice recording", () => {
    const policy = webSecurityHeaders()["permissions-policy"];

    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
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

  it("minifies HTML before sending text responses", () => {
    expect(minifyHtml("<main>\n  <section>ok</section>\n</main>\n")).toBe("<main><section>ok</section></main>");
  });

  it("compresses large JSON responses when the browser accepts Brotli", () => {
    const res = mockResponse();
    registerWebResponseRequest(mockRequest("br, gzip"), res as never);

    sendJson(res as never, 200, { value: "x".repeat(4096) });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(JSON.parse(brotliDecompressSync(res.body).toString("utf8")).value).toHaveLength(4096);
  });

  it("compresses and minifies HTML text responses", () => {
    const res = mockResponse();
    registerWebResponseRequest(mockRequest("gzip"), res as never);

    sendText(res as never, 200, `<main>\n  <section>${"x".repeat(2048)}</section>\n</main>`, "text/html; charset=utf-8");

    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.body).toString("utf8")).not.toContain(">\n  <");
  });

  it("serves precompressed static files with immutable cache headers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-http-"));
    try {
      const filePath = path.join(dir, "dashboard.js");
      const source = Buffer.from("console.log('ok');".repeat(256));
      writeFileSync(filePath, source);
      writeFileSync(`${filePath}.gz`, gzipSync(source));
      writeFileSync(`${filePath}.br`, brotliCompressSync(source));
      const res = mockResponse();
      registerWebResponseRequest(mockRequest("br, gzip"), res as never);

      sendStaticFile(res as never, filePath, "application/javascript", {
        brotliPath: `${filePath}.br`,
        cacheControl: "private, max-age=31536000, immutable",
        gzipPath: `${filePath}.gz`,
      });
      await new Promise<void>((resolve) => res.on("finish", () => resolve()));

      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBe("br");
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(brotliDecompressSync(res.body).toString("utf8")).toBe(source.toString("utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mockRequest(acceptEncoding = ""): { headers: Record<string, string> } {
  return { headers: { "accept-encoding": acceptEncoding } };
}

function mockResponse(): MockResponse {
  return new MockResponse();
}

class MockResponse extends Writable {
  body = Buffer.alloc(0);
  headers: Record<string, string | number> = {};
  status = 0;

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body = Buffer.concat([this.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    callback();
  }
}
