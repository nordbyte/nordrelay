import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const PASSWORD_KEYLEN = 64;

export function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, ms);
}

export function hashPassword(password: string): { salt: string; hash: string } {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, PASSWORD_KEYLEN).toString("hex");
  return { salt, hash };
}

export function verifyPasswordHash(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, PASSWORD_KEYLEN);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function randomLinkCode(): string {
  return `NR-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function randomSessionToken(): string {
  return randomBytes(32).toString("hex");
}
