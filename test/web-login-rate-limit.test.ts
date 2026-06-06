import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { UserStore } from "../src/access/user-management.js";
import { handleLogin } from "../src/web/web-dashboard-auth-routes.js";
import type { RateLimitBucket } from "../src/web/web-rate-limit.js";

describe("WebUI login rate limiting", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("limits failed login attempts per IP across email combinations", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "nordrelay-login-limit-"));
    homes.push(home);
    const users = new UserStore(home);
    users.createAdmin({
      email: "admin@example.com",
      displayName: "Admin",
      password: "correct-password-123",
    });
    const loginAttempts = new Map<string, RateLimitBucket>();

    for (let index = 0; index < 5; index += 1) {
      const response = await postLogin(users, loginAttempts, {
        email: `guess-${index}@example.com`,
        password: "wrong-password",
        ip: "203.0.113.10",
        forwardedIp: `198.51.100.${index + 1}`,
      });
      expect(response.status).toBe(401);
      expect(response.json.error).toBe("Invalid credentials");
    }

    const blocked = await postLogin(users, loginAttempts, {
      email: "another-guess@example.com",
      password: "wrong-password",
      ip: "203.0.113.10",
    });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toContain("Too many login attempts");

    const otherIp = await postLogin(users, loginAttempts, {
      email: "another-guess@example.com",
      password: "wrong-password",
      ip: "203.0.113.11",
    });
    expect(otherIp.status).toBe(401);
  });
});

async function postLogin(
  users: UserStore,
  loginAttempts: Map<string, RateLimitBucket>,
  input: { email: string; password: string; ip: string; forwardedIp?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify({ email: input.email, password: input.password }))]) as IncomingMessage;
  req.headers = {
    "content-type": "application/json",
    "x-forwarded-for": input.forwardedIp ?? input.ip,
    "user-agent": "NordRelay test",
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: input.ip }, configurable: true });
  const res = new MockResponse();
  await handleLogin(req, res as unknown as ServerResponse, {
    users,
    loginAttempts,
    webAuthnEnabled: false,
    webAuthnRp: () => ({}) as never,
    audit: () => {},
    recordActivity: () => {},
    currentUserDto: () => ({ ok: true }),
    setSessionCookie: () => {},
  });
  return { status: res.status, json: JSON.parse(res.body.toString("utf8")) as Record<string, unknown> };
}

class MockResponse extends Writable {
  body = Buffer.alloc(0);
  status = 0;

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body = Buffer.concat([this.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    callback();
  }
}
