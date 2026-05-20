import { SECRET_KEYS } from "./config-metadata.js";

const SECRET_VALUE_PATTERN = "(?:\"[^\"]*\"|'[^']*'|`[^`]*`|[^\\s\"'`]+)";

const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{24,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  secretKeysPattern(),
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
    return redactText(JSON.stringify(value));
  } catch {
    return redactText(String(value));
  }
}

function redactMatch(match: string): string {
  const separator = match.match(/^([^:=]+[:=]\s*)/);
  if (separator?.[1]) {
    return `${separator[1]}[REDACTED]`;
  }
  return "[REDACTED]";
}

function secretKeysPattern(): RegExp {
  const keys = [...SECRET_KEYS].map(escapeRegExp).join("|");
  return new RegExp("\\b(?:" + keys + ")\\s*[:=]\\s*" + SECRET_VALUE_PATTERN, "gi");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
