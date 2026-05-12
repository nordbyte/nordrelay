const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{24,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:OPENAI|CODEX|TELEGRAM|ANTHROPIC|GITHUB|GITLAB|NPM)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"'`]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s"'`]+/gi,
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
