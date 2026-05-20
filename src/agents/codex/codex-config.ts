import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveCodexDir } from "./codex-home.js";

const FAST_OPT_OUT_RE = /^(\s*fast_default_opt_out\s*=\s*)(true|false)(\s*(?:#.*)?)$/m;
const NOTICE_HEADER_RE = /^(\[notice\]\s*)$/m;

export function readCodexFastMode(): boolean | null {
  const configPath = getCodexConfigPath();
  if (!configPath || !existsSync(configPath)) {
    return null;
  }

  try {
    const contents = readFileSync(configPath, "utf8");
    const match = contents.match(FAST_OPT_OUT_RE);
    if (!match) {
      return null;
    }
    return match[2] === "false";
  } catch {
    return null;
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
  const line = `fast_default_opt_out = ${optOutValue}`;
  const currentContents = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  if (FAST_OPT_OUT_RE.test(currentContents)) {
    writeFileSync(
      configPath,
      currentContents.replace(FAST_OPT_OUT_RE, `$1${optOutValue}$3`),
      "utf8",
    );
    return;
  }

  if (NOTICE_HEADER_RE.test(currentContents)) {
    writeFileSync(
      configPath,
      currentContents.replace(NOTICE_HEADER_RE, `$1\n${line}`),
      "utf8",
    );
    return;
  }

  const prefix =
    currentContents.length === 0
      ? ""
      : currentContents.endsWith("\n")
        ? `${currentContents}\n`
        : `${currentContents}\n\n`;
  writeFileSync(configPath, `${prefix}[notice]\n${line}\n`, "utf8");
}

function getCodexConfigPath(): string | null {
  const codexDir = resolveCodexDir();
  return codexDir ? path.join(codexDir, "config.toml") : null;
}
