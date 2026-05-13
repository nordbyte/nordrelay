import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentId } from "./agent.js";
import { agentLabel } from "./agent.js";
import { resolveClaudeCodeCli } from "./claude-code-cli.js";
import { resolveCodexCli } from "./codex-cli.js";
import { resolveHermesCli } from "./hermes-cli.js";
import { resolveOpenClawCli } from "./openclaw-cli.js";
import { getAgentUpdateLogPath, getConnectorHome } from "./operations.js";
import { resolvePiCli } from "./pi-cli.js";
import { redactText } from "./redaction.js";

export type AgentUpdateStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentUpdateContext {
  piCliPath?: string;
  hermesCliPath?: string;
  openClawCliPath?: string;
  claudeCodeCliPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentUpdatePlan {
  agentId: AgentId;
  agentLabel: string;
  method: string;
  command: string;
  args: string[];
  cwd: string;
  summary: string;
  interactive: boolean;
}

export interface AgentUpdateJobSnapshot {
  id: string;
  agentId: AgentId;
  agentLabel: string;
  status: AgentUpdateStatus;
  method: string;
  command: string;
  args: string[];
  cwd: string;
  summary: string;
  interactive: boolean;
  canInput: boolean;
  needsInput: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  logPath: string;
  logDeletedAt?: string;
  outputTail: string;
  ownerPid?: number;
}

interface AgentUpdateJob extends AgentUpdateJobSnapshot {
  child?: ChildProcessWithoutNullStreams;
  output: string;
}

export class AgentUpdateManager {
  private readonly jobs = new Map<string, AgentUpdateJob>();
  private readonly home: string;
  private readonly manifestPath: string;
  private readonly aggregateLogPath: string;

  constructor(
    private readonly options: {
      home?: string;
      env?: NodeJS.ProcessEnv;
      onUpdate?: (job: AgentUpdateJobSnapshot) => void;
    } = {},
  ) {
    this.home = options.home ?? getConnectorHome();
    this.manifestPath = path.join(this.home, "updates", "jobs.json");
    this.aggregateLogPath = getAgentUpdateLogPath(this.home);
    this.loadPersistedJobs();
  }

  list(): AgentUpdateJobSnapshot[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((job) => this.snapshot(job));
  }

  get(id: string): AgentUpdateJobSnapshot | null {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  readLog(id: string): { job: AgentUpdateJobSnapshot; plain: string } {
    const job = this.requireJob(id);
    if (job.logDeletedAt) {
      return { job: this.snapshot(job), plain: `Update log was deleted at ${job.logDeletedAt}.` };
    }
    try {
      return { job: this.snapshot(job), plain: redactText(readFileSync(job.logPath, "utf8")) };
    } catch (error) {
      return {
        job: this.snapshot(job),
        plain: `Cannot read update log: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  deleteLog(id: string): AgentUpdateJobSnapshot {
    const job = this.requireJob(id);
    if (job.status === "running") {
      throw new Error("Cannot delete the update log while the update job is still running.");
    }
    const snapshot = this.snapshot(job);
    rmSync(job.logPath, { force: true });
    this.jobs.delete(id);
    this.persistJobs();
    return snapshot;
  }

  start(agentId: AgentId, context: AgentUpdateContext = {}): AgentUpdateJobSnapshot {
    const running = [...this.jobs.values()].find((job) => job.agentId === agentId && job.status === "running");
    if (running) {
      throw new Error(`${agentLabel(agentId)} update is already running.`);
    }

    const plan = resolveAgentUpdatePlan(agentId, { ...context, env: context.env ?? this.options.env });
    const now = new Date().toISOString();
    const id = `${agentId.replace(/[^a-z0-9]/gi, "")}-${Date.now().toString(36)}`;
    const logPath = path.join(this.home, "updates", `${id}.log`);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const job: AgentUpdateJob = {
      id,
      agentId,
      agentLabel: plan.agentLabel,
      status: "running",
      method: plan.method,
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      summary: plan.summary,
      interactive: plan.interactive,
      canInput: true,
      needsInput: false,
      startedAt: now,
      updatedAt: now,
      logPath,
      ownerPid: process.pid,
      output: "",
      outputTail: "",
    };
    this.jobs.set(id, job);
    this.persistJobs();
    this.append(job, [
      `[${now}] Starting ${job.agentLabel} update`,
      `Method: ${job.method}`,
      `Command: ${[job.command, ...job.args].join(" ")}`,
      `Working directory: ${job.cwd}`,
      "",
    ].join("\n"));

    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...(this.options.env ?? {}), ...(context.env ?? {}) },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: "pipe",
    });
    job.child = child;
    child.stdin.setDefaultEncoding("utf8");

    child.stdout.on("data", (chunk) => this.append(job, chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => this.append(job, chunk.toString("utf8")));
    child.on("error", (error) => {
      this.finish(job, "failed", null, null, error.message);
    });
    child.on("close", (code, signal) => {
      if (job.status !== "running") {
        return;
      }
      this.finish(job, code === 0 ? "completed" : "failed", code, signal, code === 0 ? undefined : `Update exited with code ${code ?? "unknown"}`);
    });

    this.emit(job);
    return this.snapshot(job);
  }

  sendInput(id: string, input: string): AgentUpdateJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== "running" || !job.child?.stdin.writable) {
      throw new Error("Update job is not accepting input.");
    }
    const line = input.endsWith("\n") ? input : `${input}\n`;
    job.child.stdin.write(line);
    job.needsInput = false;
    this.append(job, `[${new Date().toISOString()}] Input sent from dashboard.\n`);
    return this.snapshot(job);
  }

  cancel(id: string): AgentUpdateJobSnapshot {
    const job = this.requireJob(id);
    if (job.status !== "running") {
      return this.snapshot(job);
    }
    job.child?.kill("SIGTERM");
    this.finish(job, "cancelled", null, "SIGTERM", "Cancelled from dashboard.");
    return this.snapshot(job);
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.child?.kill("SIGTERM");
      }
    }
  }

  private requireJob(id: string): AgentUpdateJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Unknown update job: ${id}`);
    }
    return job;
  }

  private append(job: AgentUpdateJob, text: string): void {
    const redacted = redactText(text);
    job.output += redacted;
    if (job.output.length > 120_000) {
      job.output = job.output.slice(-120_000);
    }
    job.outputTail = job.output.slice(-16_000);
    job.updatedAt = new Date().toISOString();
    job.needsInput = job.status === "running" && looksLikePrompt(job.outputTail);
    writeFileSync(job.logPath, redacted, { flag: "a", encoding: "utf8" });
    this.appendAggregate(job, redacted);
    this.persistJobs();
    this.emit(job);
  }

  private finish(job: AgentUpdateJob, status: Exclude<AgentUpdateStatus, "running">, code: number | null, signal: string | null, error?: string): void {
    job.status = status;
    job.canInput = false;
    job.needsInput = false;
    job.exitCode = code;
    job.signal = signal;
    job.error = error ? redactText(error) : undefined;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.child = undefined;
    this.append(job, `\n[${job.finishedAt}] ${job.agentLabel} update ${status}${error ? `: ${job.error}` : ""}\n`);
  }

  private emit(job: AgentUpdateJob): void {
    this.options.onUpdate?.(this.snapshot(job));
  }

  private snapshot(job: AgentUpdateJob): AgentUpdateJobSnapshot {
    const { child: _child, output: _output, ...snapshot } = job;
    return { ...snapshot };
  }

  private loadPersistedJobs(): void {
    if (!existsSync(this.manifestPath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as AgentUpdateJobSnapshot[];
      let changed = false;
      for (const snapshot of parsed) {
        if (snapshot.logDeletedAt) {
          changed = true;
          continue;
        }
        const staleRunning = snapshot.status === "running" && !isProcessRunning(snapshot.ownerPid);
        if (staleRunning) {
          changed = true;
        }
        const job: AgentUpdateJob = {
          ...snapshot,
          status: staleRunning ? "failed" : snapshot.status,
          canInput: false,
          needsInput: false,
          error: staleRunning
            ? "Update process was still running when NordRelay restarted; inspect the agent update log before retrying."
            : snapshot.error,
          finishedAt: staleRunning ? new Date().toISOString() : snapshot.finishedAt,
          updatedAt: staleRunning ? new Date().toISOString() : snapshot.updatedAt,
          output: snapshot.outputTail ?? "",
          outputTail: snapshot.outputTail ?? "",
        };
        this.jobs.set(job.id, job);
      }
      if (changed) {
        this.persistJobs();
      }
    } catch {
      this.jobs.clear();
    }
  }

  private persistJobs(): void {
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    const snapshots = this.list().slice(0, 100);
    writeFileSync(this.manifestPath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
  }

  private appendAggregate(job: AgentUpdateJob, text: string): void {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return;
    }
    mkdirSync(path.dirname(this.aggregateLogPath), { recursive: true });
    const now = new Date().toISOString();
    const prefix = `[${now}] INFO [${job.id}]`;
    appendFileSync(this.aggregateLogPath, `${lines.map((line) => `${prefix} ${line}`).join("\n")}\n`, "utf8");
  }
}

function isProcessRunning(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgentUpdatePlan(agentId: AgentId, context: AgentUpdateContext = {}): AgentUpdatePlan {
  const env = context.env ?? process.env;
  switch (agentId) {
    case "codex": {
      const cli = resolveCodexCli(env);
      if (!cli.path) {
        throw new Error("Codex CLI is not installed on PATH. Install or update it with npm i -g @openai/codex@latest.");
      }
      return plan(agentId, "codex update", cli.path, ["update"], "Runs the Codex CLI self-updater. If this install cannot self-update, use npm i -g @openai/codex@latest.", env);
    }
    case "pi": {
      const cli = resolvePiCli(env, context.piCliPath);
      if (!cli.path) {
        throw new Error("Pi CLI is not installed on PATH. Install or update it with npm install -g @earendil-works/pi-coding-agent@latest.");
      }
      return plan(agentId, "pi update pi", cli.path, ["update", "pi"], "Updates only the Pi coding agent, not installed Pi extensions.", env);
    }
    case "hermes": {
      const cli = resolveHermesCli(env, context.hermesCliPath);
      if (!cli.path) {
        throw new Error("Hermes CLI is not installed on PATH. Install Hermes with the official installer before updating.");
      }
      return plan(agentId, "hermes update --yes", cli.path, ["update", "--yes"], "Runs the Hermes git/dependency updater with confirmation prompts accepted where supported.", env);
    }
    case "openclaw": {
      const cli = resolveOpenClawCli(env, context.openClawCliPath);
      if (!cli.path) {
        throw new Error("OpenClaw CLI is not installed on PATH. Install OpenClaw before updating.");
      }
      return plan(agentId, "openclaw update --yes", cli.path, ["update", "--yes"], "Runs the OpenClaw updater, which detects npm/git installs and may restart the Gateway.", env);
    }
    case "claude-code": {
      const cli = resolveClaudeCodeCli(env, context.claudeCodeCliPath);
      if (!cli.path) {
        throw new Error("Claude Code host CLI is not installed on PATH. Bundled SDK updates arrive with NordRelay releases.");
      }
      return plan(agentId, "claude update", cli.path, ["update"], "Runs the Claude Code updater. Some package-manager installs may print a manual command instead.", env);
    }
  }
}

function plan(agentId: AgentId, method: string, command: string, args: string[], summary: string, env: NodeJS.ProcessEnv): AgentUpdatePlan {
  return {
    agentId,
    agentLabel: agentLabel(agentId),
    method,
    command,
    args,
    cwd: env.HOME || os.homedir(),
    summary,
    interactive: true,
  };
}

function looksLikePrompt(text: string): boolean {
  const tail = text.split(/\r?\n/).slice(-4).join("\n");
  return /\b(y\/n|yes\/no|continue|proceed|confirm|password|passphrase|token|api key|enter|select)\b|[?>]\s*$/i.test(tail);
}
