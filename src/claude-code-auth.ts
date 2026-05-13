import { spawnSync } from "node:child_process";

import type { AuthStatus } from "./codex-auth.js";

const COMMAND_TIMEOUT_MS = 10_000;
const AUTH_CACHE_TTL_MS = 30_000;

let cachedAuthStatus: { key: string; status: AuthStatus; expiresAt: number } | undefined;

export async function checkClaudeCodeAuthStatus(cliPath?: string): Promise<AuthStatus> {
  const command = cliPath ?? "claude";
  const cacheKey = cliPath ?? "bundled-or-path";
  if (cachedAuthStatus?.key === cacheKey && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  const status = checkWithCli(command);
  cachedAuthStatus = { key: cacheKey, status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
  return status;
}

export function clearClaudeCodeAuthCache(): void {
  cachedAuthStatus = undefined;
}

function checkWithCli(command: string): AuthStatus {
  const result = spawnSync(command, ["auth", "status"], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    env: process.env,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!result.error && result.status === 0) {
    return {
      authenticated: true,
      method: "cli",
      detail: output || "Authenticated via Claude Code CLI.",
    };
  }

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      authenticated: true,
      method: "cli",
      detail: "Claude Code CLI was not found on PATH; the Claude Agent SDK bundled runtime will perform its own auth check when a turn starts.",
    };
  }

  return {
    authenticated: false,
    method: "none",
    detail: output || result.error?.message || `Claude Code auth status failed with exit ${result.status ?? "unknown"}. Run "claude auth login" on the host.`,
  };
}
