import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveCodexDir } from "./codex-home.js";

const FAST_OPT_OUT_RE = /^(\s*fast_default_opt_out\s*=\s*)(true|false)(\s*(?:#.*)?)$/m;
const SERVICE_TIER_RE = /^(\s*service_tier\s*=\s*)("[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_-]+)(\s*(?:#.*)?)$/m;
const TABLE_HEADER_RE = /^\s*\[/m;
const NOTICE_HEADER_RE = /^(\[notice\]\s*)$/m;

export function readCodexFastMode(): boolean | null {
  const configPath = getCodexConfigPath();
  if (!configPath || !existsSync(configPath)) {
    return null;
  }

  try {
    const contents = readFileSync(configPath, "utf8");
    const serviceTier = readTopLevelServiceTier(contents);
    if (serviceTier !== null) {
      return serviceTier === "fast";
    }
    const match = contents.match(FAST_OPT_OUT_RE);
    if (!match) {
      return null;
    }
    return match[2] === "false";
  } catch {
    return null;
  }
}

export function normalizeCodexServiceTier(): boolean {
  const configPath = getCodexConfigPath();
  if (!configPath || !existsSync(configPath)) {
    return false;
  }

  try {
    const currentContents = readFileSync(configPath, "utf8");
    const [topLevel, rest] = splitTopLevel(currentContents);
    const match = topLevel.match(SERVICE_TIER_RE);
    if (!match || unquoteTomlValue(match[2]).toLowerCase() !== "default") {
      return false;
    }
    writeFileSync(configPath, `${topLevel.replace(SERVICE_TIER_RE, `$1"flex"$3`)}${rest}`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function writeCodexFastMode(enabled: boolean): void {
  const configPath = getCodexConfigPath();
  if (!configPath) {
    return;
  }

  const codexDir = path.dirname(configPath);
  mkdirSync(codexDir, { recursive: true });

  const optOutValue = enabled ? "false" : "true";
  const currentContents = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const withServiceTier = writeTopLevelServiceTier(currentContents, enabled ? "fast" : "flex");
  const nextContents = writeLegacyFastOptOut(withServiceTier, optOutValue);

  writeFileSync(configPath, nextContents, "utf8");
}

function readTopLevelServiceTier(contents: string): string | null {
  const [topLevel] = splitTopLevel(contents);
  const match = topLevel.match(SERVICE_TIER_RE);
  if (!match) {
    return null;
  }
  return unquoteTomlValue(match[2]).toLowerCase();
}

function writeTopLevelServiceTier(contents: string, value: "fast" | "flex"): string {
  const [topLevel, rest] = splitTopLevel(contents);
  if (SERVICE_TIER_RE.test(topLevel)) {
    return `${topLevel.replace(SERVICE_TIER_RE, `$1"${value}"$3`)}${rest}`;
  }

  const line = `service_tier = "${value}"`;
  if (topLevel.length === 0) {
    return `${line}\n${rest}`;
  }
  return `${topLevel.endsWith("\n") ? topLevel : `${topLevel}\n`}${line}\n${rest}`;
}

function writeLegacyFastOptOut(contents: string, optOutValue: "true" | "false"): string {
  const line = `fast_default_opt_out = ${optOutValue}`;

  if (FAST_OPT_OUT_RE.test(contents)) {
    return contents.replace(FAST_OPT_OUT_RE, `$1${optOutValue}$3`);
  }

  if (NOTICE_HEADER_RE.test(contents)) {
    return contents.replace(NOTICE_HEADER_RE, `$1\n${line}`);
  }

  const prefix =
    contents.length === 0
      ? ""
      : contents.endsWith("\n")
        ? `${contents}\n`
        : `${contents}\n\n`;
  return `${prefix}[notice]\n${line}\n`;
}

function splitTopLevel(contents: string): [string, string] {
  const match = contents.match(TABLE_HEADER_RE);
  if (!match || match.index === undefined) {
    return [contents, ""];
  }
  return [contents.slice(0, match.index), contents.slice(match.index)];
}

function unquoteTomlValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getCodexConfigPath(): string | null {
  const codexDir = resolveCodexDir();
  return codexDir ? path.join(codexDir, "config.toml") : null;
}
