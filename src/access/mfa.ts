import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(input: { issuer: string; accountName: string; secret: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(`${input.issuer}:${input.accountName}`);
  return `otpauth://totp/${account}?secret=${encodeURIComponent(input.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

export function verifyTotpCode(input: { secret: string; code: string; window?: number; nowMs?: number; lastUsedStep?: number }): { ok: boolean; step?: number } {
  const normalized = normalizeTotpCode(input.code);
  if (!normalized) return { ok: false };
  const window = Math.max(0, input.window ?? 1);
  const nowStep = Math.floor((input.nowMs ?? Date.now()) / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = nowStep + offset;
    if (input.lastUsedStep !== undefined && step <= input.lastUsedStep) continue;
    if (safeEqual(normalized, hotp(input.secret, step))) {
      return { ok: true, step };
    }
  }
  return { ok: false };
}

export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  return hotp(secret, Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS));
}

export function normalizeTotpCode(code: string): string {
  const normalized = String(code ?? "").replace(/\s+/g, "");
  return /^\d{6}$/.test(normalized) ? normalized : "";
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10).padEnd(10, "0");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const cleaned = String(input ?? "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid TOTP secret.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
