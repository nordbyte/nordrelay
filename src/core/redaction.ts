import { SECRET_KEYS } from "./config-metadata.js";

const SECRET_VALUE_PATTERN = "(?:\"[^\"]*\"|'[^']*'|`[^`]*`|[^\\s\"'`]+)";
const REDACTED = "[REDACTED]";
const GENERIC_SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|app[_-]?token|token|secret|password|authorization|credential)/i;

const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{24,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  secretKeysPattern(),
  quotedSecretKeysPattern(),
  quotedGenericSecretKeyPattern(),
  new RegExp("\\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)\\s*=\\s*" + SECRET_VALUE_PATTERN, "gi"),
  new RegExp("\\bAuthorization\\s*:\\s*(?:Bearer\\s+)?" + SECRET_VALUE_PATTERN, "gi"),
  new RegExp("\\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\\s*[:=]\\s*" + SECRET_VALUE_PATTERN, "gi"),
];

let configuredPatterns: RegExp[] = [];

export function configureRedaction(rawPatterns: string[]): void {
  configuredPatterns = rawPatterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "gi");
      } catch {
        return null;
      }
    })
    .filter((pattern): pattern is RegExp => Boolean(pattern));
}

export function redactText(text: string): string {
  let redacted = text;
  for (const pattern of [...DEFAULT_SECRET_PATTERNS, ...configuredPatterns]) {
    redacted = redacted.replace(pattern, (match) => redactMatch(match));
  }
  return redacted;
}

export function redactUnknown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${redactText(value.message)}`;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  try {
    const serialized = JSON.stringify(redactStructuredValue(value));
    return serialized === undefined ? redactText(String(value)) : redactText(serialized);
  } catch {
    return redactText(String(value));
  }
}

function redactMatch(match: string): string {
  const separator = match.match(/^((?:"[^"]+"|'[^']+'|`[^`]+`|[^:=]+?)\s*[:=]\s*)/);
  if (separator?.[1]) {
    const quotedJsonKey = separator[1].trimStart().startsWith("\"");
    return `${separator[1]}${quotedJsonKey ? JSON.stringify(REDACTED) : REDACTED}`;
  }
  return REDACTED;
}

function redactStructuredValue(value: unknown, key?: string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (key && isSecretKey(key)) {
    return REDACTED;
  }
  if (value instanceof Error) {
    return `${value.name}: ${redactText(value.message)}`;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactStructuredValue(item, undefined, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactStructuredValue(entryValue, entryKey, seen);
  }
  seen.delete(value);
  return output;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || GENERIC_SECRET_KEY_PATTERN.test(key);
}

function secretKeysPattern(): RegExp {
  const keys = [...SECRET_KEYS].map(escapeRegExp).join("|");
  return new RegExp("\\b(?:" + keys + ")\\s*[:=]\\s*" + SECRET_VALUE_PATTERN, "gi");
}

function quotedSecretKeysPattern(): RegExp {
  const keys = [...SECRET_KEYS].map(escapeRegExp).join("|");
  return new RegExp("\"(?:" + keys + ")\"\\s*:\\s*" + SECRET_VALUE_PATTERN, "gi");
}

function quotedGenericSecretKeyPattern(): RegExp {
  return new RegExp("\"[^\"]*(?:api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|bot[_-]?token|app[_-]?token|token|secret|password|authorization|credential)[^\"]*\"\\s*:\\s*" + SECRET_VALUE_PATTERN, "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
