import { execFile } from "node:child_process";

import type { LoginResult } from "./codex-auth.js";
import { HermesApiClient } from "./hermes-api.js";

export interface HermesAuthStatus {
  authenticated: boolean;
  method: string;
  detail: string;
}

const COMMAND_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function checkHermesAuthStatus(options: {
  baseUrl: string;
  apiKey?: string;
}): Promise<HermesAuthStatus> {
  const client = new HermesApiClient(options);
  try {
    await client.capabilities();
    return {
      authenticated: true,
      method: options.apiKey ? "api-key" : "local-api",
      detail: `Hermes API server reachable at ${options.baseUrl}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authenticated: false,
      method: options.apiKey ? "api-key" : "local-api",
      detail: message,
    };
  }
}

export async function startHermesLogin(cliPath?: string): Promise<LoginResult> {
  try {
    const { stdout, stderr } = await runHermesCommand(cliPath ?? "hermes", ["login", "--no-browser"], LOGIN_TIMEOUT_MS);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      message: output || "Hermes login completed.",
    };
  } catch (error) {
    return {
      success: false,
      message: extractCommandError(error) || "Hermes login failed. Run 'hermes login --no-browser' on the host.",
    };
  }
}

export async function startHermesLogout(cliPath?: string): Promise<LoginResult> {
  try {
    const { stdout, stderr } = await runHermesCommand(cliPath ?? "hermes", ["logout"], COMMAND_TIMEOUT_MS);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      message: output || "Logged out from Hermes.",
    };
  } catch (error) {
    return {
      success: false,
      message: extractCommandError(error) || "Hermes logout failed. Run 'hermes logout' on the host.",
    };
  }
}

function runHermesCommand(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
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
    if (enriched.code === "ENOENT") return "Hermes CLI not found. Install Hermes or set HERMES_CLI_PATH.";
    if (enriched.signal) return `Command terminated with signal ${enriched.signal}.`;
    if (enriched.message) return enriched.message;
  }
  return error instanceof Error ? error.message : String(error);
}
