import { execFile, spawnSync } from "node:child_process";

import type { AuthStatus, LoginResult } from "./codex-auth.js";

const COMMAND_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
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

export async function startClaudeCodeLogin(cliPath?: string): Promise<LoginResult> {
  clearClaudeCodeAuthCache();
  try {
    const { stdout, stderr } = await runClaudeCodeCommand(cliPath ?? "claude", ["auth", "login"], LOGIN_TIMEOUT_MS);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      message: output || "Claude Code login completed.",
    };
  } catch (error) {
    return {
      success: false,
      message: extractCommandError(error) || "Claude Code login failed. Run 'claude auth login' on the host.",
    };
  }
}

export async function startClaudeCodeLogout(cliPath?: string): Promise<LoginResult> {
  clearClaudeCodeAuthCache();
  try {
    const { stdout, stderr } = await runClaudeCodeCommand(cliPath ?? "claude", ["auth", "logout"], COMMAND_TIMEOUT_MS);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      message: output || "Logged out from Claude Code.",
    };
  } catch (error) {
    return {
      success: false,
      message: extractCommandError(error) || "Claude Code logout failed. Run 'claude auth logout' on the host.",
    };
  }
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

function runClaudeCodeCommand(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        env: { ...process.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = typeof stdout === "string" ? stdout : "";
          enriched.stderr = typeof stderr === "string" ? stderr : "";
          reject(enriched);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

function extractCommandError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const enriched = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string };
    const stderr = enriched.stderr?.trim();
    if (stderr) return stderr;
    const stdout = enriched.stdout?.trim();
    if (stdout) return stdout;
    if (enriched.code === "ENOENT") return "Claude Code CLI not found. Install Claude Code or set CLAUDE_CODE_CLI_PATH.";
    if (enriched.signal) return `Command terminated with signal ${enriched.signal}.`;
    if (enriched.message) return enriched.message;
  }
  return error instanceof Error ? error.message : String(error);
}
