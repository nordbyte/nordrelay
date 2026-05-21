import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { ConnectorConfig } from "../../core/config.js";
import type { AgentApprovalChoice, AgentApprovalRequest } from "../shared/agent.js";

export interface CodexExternalApprovalResult {
  ok: boolean;
  status: "submitted" | "disabled" | "unsupported" | "not-found" | "blocked" | "failed";
  message: string;
  ttyPath?: string;
  pid?: number;
}

interface CodexRolloutProcess {
  pid: number;
  ttyPath: string;
}

const TIOCSTI_LEGACY_PATH = "/proc/sys/dev/tty/legacy_tiocsti";

export function respondToCodexExternalApproval(
  approval: AgentApprovalRequest,
  config: ConnectorConfig,
  choice: AgentApprovalChoice,
): CodexExternalApprovalResult {
  if (!config.codexExternalApprovalControl) {
    return {
      ok: false,
      status: "disabled",
      message: "External CLI approval control is disabled. Set CODEX_EXTERNAL_APPROVAL_CONTROL=true and restart NordRelay to allow local TTY approval input.",
    };
  }
  if (process.platform !== "linux") {
    return {
      ok: false,
      status: "unsupported",
      message: "External CLI approval control is currently supported only for local Linux Codex CLI terminals.",
    };
  }

  const target = findCodexProcessForRollout(approval.sourcePath);
  if (!target) {
    return {
      ok: false,
      status: "not-found",
      message: "Could not find the local Codex CLI terminal for this pending approval.",
    };
  }

  const tiocstiStatus = readTiocstiStatus();
  if (tiocstiStatus === "0") {
    return {
      ok: false,
      status: "blocked",
      pid: target.pid,
      ttyPath: target.ttyPath,
      message: "The OS blocks terminal input injection (/proc/sys/dev/tty/legacy_tiocsti=0). Approve this request in the Codex CLI terminal or enable a managed PTY workflow.",
    };
  }

  const injected = injectChoiceIntoTty(target.ttyPath, choice);
  if (!injected.ok) {
    return {
      ok: false,
      status: "failed",
      pid: target.pid,
      ttyPath: target.ttyPath,
      message: injected.message,
    };
  }

  return {
    ok: true,
    status: "submitted",
    pid: target.pid,
    ttyPath: target.ttyPath,
    message: approvalChoiceLabel(choice),
  };
}

function findCodexProcessForRollout(rolloutPath: string): CodexRolloutProcess | null {
  const normalizedRollout = normalizeProcPath(rolloutPath);
  if (!existsSync(normalizedRollout)) {
    return null;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates: CodexRolloutProcess[] = [];
  for (const name of safeReaddir("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number.parseInt(name, 10);
    const procDir = `/proc/${name}`;
    if (uid !== null && readProcessUid(procDir) !== uid) {
      continue;
    }
    const commandLine = readProcessCommandLine(procDir);
    if (!/\bcodex\b/i.test(commandLine)) {
      continue;
    }
    if (!processHasRolloutOpen(procDir, normalizedRollout)) {
      continue;
    }
    const ttyPath = readProcessStdinTty(procDir);
    if (!ttyPath) {
      continue;
    }
    candidates.push({ pid, ttyPath });
  }

  candidates.sort((left, right) => left.pid - right.pid);
  return candidates[0] ?? null;
}

function processHasRolloutOpen(procDir: string, rolloutPath: string): boolean {
  const fdDir = `${procDir}/fd`;
  for (const fd of safeReaddir(fdDir)) {
    const target = safeReadlink(`${fdDir}/${fd}`);
    if (target && normalizeProcPath(target) === rolloutPath) {
      return true;
    }
  }
  return false;
}

function readProcessStdinTty(procDir: string): string | null {
  const target = safeReadlink(`${procDir}/fd/0`);
  if (!target) {
    return null;
  }
  return /^\/dev\/(?:pts\/\d+|tty\d*)$/.test(target) ? target : null;
}

function readProcessCommandLine(procDir: string): string {
  try {
    return readFileSync(`${procDir}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function readProcessUid(procDir: string): number | null {
  try {
    const status = readFileSync(`${procDir}/status`, "utf8");
    const match = status.match(/^Uid:\s+(\d+)/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function readTiocstiStatus(): string | null {
  try {
    return existsSync(TIOCSTI_LEGACY_PATH) ? readFileSync(TIOCSTI_LEGACY_PATH, "utf8").trim() : null;
  } catch {
    return null;
  }
}

function injectChoiceIntoTty(ttyPath: string, choice: AgentApprovalChoice): { ok: boolean; message: string } {
  const script = [
    "import os, sys, termios, fcntl",
    "tty, choice = sys.argv[1], sys.argv[2]",
    "payload = {'yes': b'y', 'persist': b'p', 'no': b'\\x1b'}[choice]",
    "fd = os.open(tty, os.O_RDWR | os.O_NOCTTY)",
    "try:",
    "    for byte in payload:",
    "        fcntl.ioctl(fd, termios.TIOCSTI, bytes([byte]))",
    "finally:",
    "    os.close(fd)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, ttyPath, choice], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    return {
      ok: false,
      message: stderr ? `Failed to send approval input to Codex CLI: ${stderr}` : "Failed to send approval input to Codex CLI.",
    };
  }
  return { ok: true, message: approvalChoiceLabel(choice) };
}

function approvalChoiceLabel(choice: AgentApprovalChoice): string {
  if (choice === "persist") {
    return "Approval submitted and Codex was asked to remember this command prefix.";
  }
  if (choice === "no") {
    return "Denial submitted to Codex CLI.";
  }
  return "Approval submitted to Codex CLI.";
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadlink(filePath: string): string | null {
  try {
    return readlinkSync(filePath);
  } catch {
    return null;
  }
}

function normalizeProcPath(value: string): string {
  const cleaned = value.replace(/ \(deleted\)$/u, "");
  try {
    return realpathSync(cleaned);
  } catch {
    return cleaned;
  }
}
