import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { AgentId } from "../agents/shared/agent.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import type { ConnectorConfig } from "../core/config.js";
import { SessionWorktreeStore } from "./worktree-store.js";
import type {
  SessionWorktreeDiffSnapshot,
  SessionWorktreeRecord,
  SessionWorktreeStatusSnapshot,
  SessionWorktreeUpdateResult,
  WorktreeChangedFile,
  WorktreeConflictReviewItem,
  WorktreeConflictWarning,
  WorktreeCleanupResult,
  WorktreeDashboardSnapshot,
  WorktreeIntegrationRun,
  WorktreeIntegrationPreview,
  WorktreeIntegrationPreviewSource,
} from "./worktree-types.js";

const MAX_GIT_BUFFER = 10 * 1024 * 1024;
const DEFAULT_DIFF_LIMIT_BYTES = 256 * 1024;

export interface CreateWorktreeOptions {
  agentId?: AgentId;
  contextKey?: ChannelContextKey;
  threadId?: string | null;
  sourceWorkspace: string;
}

export interface ForkWorktreeOptions extends CreateWorktreeOptions {
  includeUncommitted?: boolean;
}

export interface CommitWorktreeResult {
  record: SessionWorktreeRecord;
  clean: boolean;
  status: string[];
}

export interface ForkWorktreeResult {
  record: SessionWorktreeRecord;
  copiedUntrackedFiles: string[];
  skippedUntrackedFiles: string[];
  patchApplied: boolean;
}

export class SessionWorktreeService {
  constructor(
    private readonly config: ConnectorConfig,
    private readonly store: SessionWorktreeStore,
  ) {}

  static defaultRoot(): string {
    return path.join(os.homedir(), ".nordrelay", "worktrees");
  }

  listDashboardSnapshot(sharedSessions: WorktreeConflictWarning["sessions"] = []): WorktreeDashboardSnapshot {
    const records = this.store.list().map((record) => this.snapshot(record));
    return {
      defaultMode: this.config.sessionWorkspaceMode,
      worktreeRoot: this.config.sessionWorktreeRoot,
      records,
      integrations: this.store.listIntegrations(),
      sharedWarnings: this.sharedWarnings(sharedSessions),
      updatedAt: new Date().toISOString(),
    };
  }

  create(options: CreateWorktreeOptions): SessionWorktreeRecord {
    const repo = this.inspectRepo(options.sourceWorkspace);
    const id = shortId();
    const repoName = safeSegment(path.basename(repo.root) || "repo");
    const branchName = `${this.config.sessionWorktreeBranchPrefix}/${repoName}/${id}`;
    const worktreePath = path.join(this.config.sessionWorktreeRoot, repoName, id);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    runGit(["worktree", "add", "-b", branchName, worktreePath, repo.headSha], repo.root);
    const now = new Date().toISOString();
    const record: SessionWorktreeRecord = {
      id,
      mode: "worktree",
      status: "active",
      agentId: options.agentId,
      contextKey: options.contextKey,
      threadId: options.threadId ?? null,
      sourceWorkspace: path.resolve(options.sourceWorkspace),
      repoRoot: repo.root,
      repoName,
      baseSha: repo.headSha,
      baseBranch: repo.branch,
      branchName,
      worktreePath,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.upsert(record);
  }

  fork(options: ForkWorktreeOptions): ForkWorktreeResult {
    const record = this.create(options);
    let patchApplied = false;
    let copiedUntrackedFiles: string[] = [];
    let skippedUntrackedFiles: string[] = [];
    try {
      if (options.includeUncommitted) {
        patchApplied = this.applyTrackedDiff(record);
        const copied = this.copyUntrackedFiles(record);
        copiedUntrackedFiles = copied.copied;
        skippedUntrackedFiles = copied.skipped;
        this.store.patch(record.id, { copiedUntrackedFiles, skippedUntrackedFiles });
      }
      return {
        record: this.store.get(record.id) ?? record,
        copiedUntrackedFiles,
        skippedUntrackedFiles,
        patchApplied,
      };
    } catch (error) {
      this.store.patch(record.id, {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  linkThread(id: string, threadId: string | null | undefined, agentId?: AgentId, contextKey?: ChannelContextKey): SessionWorktreeRecord {
    return this.store.patch(id, {
      threadId: threadId ?? null,
      agentId,
      contextKey,
    });
  }

  getByThreadId(threadId: string | null | undefined): SessionWorktreeRecord | undefined {
    return this.store.findByThreadId(threadId);
  }

  getByWorkspace(workspace: string | undefined): SessionWorktreeRecord | undefined {
    return this.store.findByWorkspace(workspace);
  }

  commit(id: string, message?: string): CommitWorktreeResult {
    const record = this.requireRecord(id);
    const status = gitStatus(record.worktreePath);
    if (status.length === 0) {
      const headSha = gitOutput(["rev-parse", "HEAD"], record.worktreePath);
      return {
        record: this.store.patch(id, {
          status: record.status === "merged" ? "merged" : "committed",
          commitSha: headSha,
          committedAt: record.committedAt ?? new Date().toISOString(),
          commitMessage: record.commitMessage ?? message,
          lastError: undefined,
        }),
        clean: true,
        status,
      };
    }
    runGit(["add", "-A"], record.worktreePath);
    const commitMessage = message?.trim() || defaultCommitMessage(record);
    runGit(["commit", "-m", commitMessage], record.worktreePath);
    const commitSha = gitOutput(["rev-parse", "HEAD"], record.worktreePath);
    return {
      record: this.store.patch(id, {
        status: "committed",
        commitSha,
        committedAt: new Date().toISOString(),
        commitMessage,
        lastError: undefined,
      }),
      clean: false,
      status,
    };
  }

  diff(id: string, limitBytes = DEFAULT_DIFF_LIMIT_BYTES): SessionWorktreeDiffSnapshot {
    const record = this.requireRecord(id);
    const exists = existsSync(record.worktreePath);
    if (!exists) {
      throw new Error(`Worktree path does not exist: ${record.worktreePath}`);
    }
    const diff = this.diffText(record);
    const limited = truncateUtf8(diff, Math.max(1_024, limitBytes));
    return {
      record,
      files: this.changedFiles(record),
      diff: limited.text,
      truncated: limited.truncated,
      byteLength: Buffer.byteLength(diff, "utf8"),
      generatedAt: new Date().toISOString(),
    };
  }

  previewIntegration(ids: string[]): WorktreeIntegrationPreview {
    const generatedAt = new Date().toISOString();
    const records = ids.map((id) => this.requireRecord(id));
    const warnings: string[] = [];
    if (records.length === 0) {
      return { ids, canIntegrate: false, sourceWorktrees: [], files: [], conflictCandidates: [], conflictReview: [], warnings: ["Select at least one worktree."], generatedAt };
    }
    const repoRoot = records[0]!.repoRoot;
    const repoName = records[0]!.repoName;
    const baseSha = records[0]!.baseSha;
    for (const record of records) {
      if (record.repoRoot !== repoRoot || record.baseSha !== baseSha) {
        warnings.push("All selected worktrees must use the same repository and base commit.");
        break;
      }
      if (!record.commitSha) {
        warnings.push(`Worktree ${record.id} has no session commit yet.`);
      }
      if (!existsSync(record.worktreePath)) {
        warnings.push(`Worktree ${record.id} is missing on disk.`);
      }
    }
    const fileMap = new Map<string, WorktreeChangedFile>();
    for (const record of records) {
      for (const file of this.changedFiles(record)) {
        const existing = fileMap.get(file.path);
        if (existing) {
          existing.sourceWorktreeIds = [...new Set([...existing.sourceWorktreeIds, record.id])];
          if (existing.status !== file.status) existing.status = "conflict";
        } else {
          fileMap.set(file.path, { ...file, sourceWorktreeIds: [record.id] });
        }
      }
    }
    const files = [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path));
    const conflictCandidates = files.filter((file) => file.sourceWorktreeIds.length > 1 || file.status === "conflict");
    if (conflictCandidates.length) {
      warnings.push(`${conflictCandidates.length} file(s) are changed by more than one selected worktree.`);
    }
    const sourceWorktrees = records.map(previewSource);
    return {
      ids,
      canIntegrate: warnings.length === 0,
      repoRoot,
      repoName,
      baseSha,
      sourceWorktrees,
      files,
      conflictCandidates,
      conflictReview: files.map((file) => conflictReviewItem(file, sourceWorktrees)),
      warnings,
      generatedAt,
    };
  }

  updateFromBase(id: string): SessionWorktreeUpdateResult {
    const record = this.requireRecord(id);
    if (!existsSync(record.worktreePath)) {
      throw new Error(`Worktree path does not exist: ${record.worktreePath}`);
    }
    const status = gitStatus(record.worktreePath);
    if (status.length > 0) {
      throw new Error("Commit or clean the worktree before updating it from the base branch.");
    }
    const previousBaseSha = record.baseSha;
    const baseRef = record.baseBranch || "HEAD";
    const newBaseSha = gitOutput(["rev-parse", baseRef], record.repoRoot);
    if (newBaseSha === previousBaseSha) {
      return { record, previousBaseSha, newBaseSha, rebased: false, status };
    }
    try {
      runGit(["rebase", newBaseSha], record.worktreePath, undefined, true);
      const headSha = gitOutput(["rev-parse", "HEAD"], record.worktreePath);
      const next = this.store.patch(id, {
        baseSha: newBaseSha,
        commitSha: headSha === newBaseSha ? undefined : headSha,
        status: headSha === newBaseSha ? "active" : "committed",
        lastError: undefined,
      });
      return { record: next, previousBaseSha, newBaseSha, rebased: true, status: gitStatus(record.worktreePath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = this.store.patch(id, { status: "conflict", lastError: message });
      return { record: next, previousBaseSha, newBaseSha, rebased: false, status: gitStatus(record.worktreePath) };
    }
  }

  integrate(ids: string[]): WorktreeIntegrationRun {
    const records = ids.map((id) => this.requireRecord(id));
    if (records.length === 0) {
      throw new Error("Select at least one worktree to integrate.");
    }
    const repoRoot = records[0]!.repoRoot;
    const baseSha = records[0]!.baseSha;
    const incompatible = records.find((record) => record.repoRoot !== repoRoot || record.baseSha !== baseSha);
    if (incompatible) {
      throw new Error("All selected worktrees must use the same repository and base commit.");
    }
    const missingCommit = records.find((record) => !record.commitSha);
    if (missingCommit) {
      throw new Error(`Worktree ${missingCommit.id} has no session commit yet.`);
    }

    const id = `int-${shortId()}`;
    const repoName = records[0]!.repoName;
    const branchName = `${this.config.sessionWorktreeBranchPrefix}/integration/${repoName}/${id}`;
    const worktreePath = path.join(this.config.sessionWorktreeRoot, repoName, "integrations", id);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    const now = new Date().toISOString();
    const run: WorktreeIntegrationRun = {
      id,
      status: "running",
      repoRoot,
      repoName,
      baseSha,
      branchName,
      worktreePath,
      worktreeIds: records.map((record) => record.id),
      mergedCommitShas: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertIntegration(run);

    try {
      runGit(["worktree", "add", "-b", branchName, worktreePath, baseSha], repoRoot);
      const mergedCommitShas: string[] = [];
      for (const record of records) {
        runGit(["merge", "--no-ff", "--no-edit", record.commitSha!], worktreePath);
        mergedCommitShas.push(record.commitSha!);
        this.store.patch(record.id, {
          status: "merged",
          mergedAt: new Date().toISOString(),
          integrationRunId: id,
          lastError: undefined,
        });
      }
      return this.store.patchIntegration(id, {
        status: "merged",
        mergedCommitShas,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = gitStatus(worktreePath);
      const conflict = status.some((line) => /^([A-Z?U]{2})\s/.test(line) && line.includes("U"));
      const nextStatus = conflict ? "conflict" : "failed";
      for (const record of records) {
        this.store.patch(record.id, {
          status: nextStatus,
          integrationRunId: id,
          lastError: message,
        });
      }
      return this.store.patchIntegration(id, {
        status: nextStatus,
        lastError: message,
        finishedAt: new Date().toISOString(),
      });
    }
  }

  remove(id: string, options: { force?: boolean } = {}): SessionWorktreeRecord {
    const record = this.requireRecord(id);
    try {
      runGit(["worktree", "remove", options.force ? "--force" : "", record.worktreePath].filter(Boolean), record.repoRoot);
    } catch (error) {
      if (!options.force) {
        throw error;
      }
      rmSync(record.worktreePath, { recursive: true, force: true });
    }
    return this.store.patch(id, { status: "removed" });
  }

  cleanup(): WorktreeCleanupResult {
    const removedRecords: string[] = [];
    const removedIntegrations: string[] = [];
    const prunedRepositories: string[] = [];
    const warnings: string[] = [];
    const repositories = new Set<string>();
    for (const record of this.store.list()) {
      repositories.add(record.repoRoot);
      const missing = !existsSync(record.worktreePath);
      if (record.status === "removed" || missing) {
        if (missing && record.status !== "removed") {
          warnings.push(`Removed stale record for missing worktree ${record.id}.`);
        }
        if (this.store.delete(record.id)) removedRecords.push(record.id);
      }
    }
    for (const run of this.store.listIntegrations()) {
      repositories.add(run.repoRoot);
      const terminal = run.status === "merged" || run.status === "failed";
      if (terminal && !existsSync(run.worktreePath)) {
        if (this.store.deleteIntegration(run.id)) removedIntegrations.push(run.id);
      }
    }
    for (const repoRoot of repositories) {
      try {
        runGit(["worktree", "prune"], repoRoot);
        prunedRepositories.push(repoRoot);
      } catch (error) {
        warnings.push(`Failed to prune ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      removedRecords,
      removedIntegrations,
      prunedRepositories,
      warnings,
      cleanedAt: new Date().toISOString(),
    };
  }

  snapshot(record: SessionWorktreeRecord): SessionWorktreeStatusSnapshot {
    const exists = existsSync(record.worktreePath);
    const status = exists ? gitStatus(record.worktreePath) : [];
    const headSha = exists ? gitOutputSafe(["rev-parse", "HEAD"], record.worktreePath) : undefined;
    const dirty = status.length > 0;
    return {
      ...record,
      exists,
      dirty,
      headSha,
      gitStatus: status,
      statusText: statusText(record, exists, dirty),
    };
  }

  private requireRecord(id: string): SessionWorktreeRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new Error(`Unknown session worktree: ${id}`);
    }
    return record;
  }

  private inspectRepo(workspace: string): { root: string; headSha: string; branch?: string } {
    const cwd = path.resolve(workspace);
    const root = gitOutput(["rev-parse", "--show-toplevel"], cwd);
    const headSha = gitOutput(["rev-parse", "HEAD"], root);
    const branch = gitOutputSafe(["rev-parse", "--abbrev-ref", "HEAD"], root);
    return {
      root,
      headSha,
      branch: branch && branch !== "HEAD" ? branch : undefined,
    };
  }

  private applyTrackedDiff(record: SessionWorktreeRecord): boolean {
    const patch = gitRawOutput(["diff", "--binary", "HEAD", "--"], record.repoRoot, true);
    if (!patch.trim()) {
      return false;
    }
    runGit(["apply", "--3way", "--whitespace=nowarn"], record.worktreePath, patch);
    return true;
  }

  private diffText(record: SessionWorktreeRecord): string {
    const baseDiff = gitRawOutput(["diff", "--stat", "--patch", `${record.baseSha}...HEAD`, "--"], record.worktreePath, true);
    const workingDiff = gitRawOutput(["diff", "--stat", "--patch", "HEAD", "--"], record.worktreePath, true);
    const untracked = gitRawOutput(["ls-files", "--others", "--exclude-standard"], record.worktreePath, true).trim();
    return [
      baseDiff.trim() ? `# Branch diff (${record.baseSha.slice(0, 12)}...HEAD)\n${baseDiff.trimEnd()}` : "",
      workingDiff.trim() ? `# Uncommitted diff (HEAD)\n${workingDiff.trimEnd()}` : "",
      untracked ? `# Untracked files\n${untracked}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private changedFiles(record: SessionWorktreeRecord): WorktreeChangedFile[] {
    if (!existsSync(record.worktreePath)) {
      return [];
    }
    const byPath = new Map<string, WorktreeChangedFile>();
    const add = (relativePath: string, statusCode: string) => {
      if (!relativePath || !isSafeRelativePath(relativePath)) return;
      const status = gitStatusCodeToChangedStatus(statusCode);
      const existing = byPath.get(relativePath);
      if (existing) {
        if (existing.status !== status) existing.status = "conflict";
        return;
      }
      byPath.set(relativePath, { path: relativePath, status, sourceWorktreeIds: [record.id] });
    };
    const committed = gitRawOutput(["diff", "--name-status", `${record.baseSha}...HEAD`, "--"], record.worktreePath, true);
    for (const line of committed.split(/\r?\n/).filter(Boolean)) {
      const [statusCode = "", firstPath = "", secondPath = ""] = line.split(/\t+/);
      add(secondPath || firstPath, statusCode);
    }
    const status = gitRawOutput(["status", "--porcelain"], record.worktreePath, true);
    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
      add(renamedPath.replace(/^"|"$/g, ""), code);
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private copyUntrackedFiles(record: SessionWorktreeRecord): { copied: string[]; skipped: string[] } {
    const raw = gitRawOutput(["ls-files", "--others", "--exclude-standard", "-z"], record.repoRoot, true);
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const relative of raw.split("\0").filter(Boolean)) {
      if (!isSafeRelativePath(relative)) {
        skipped.push(relative);
        continue;
      }
      const source = path.join(record.repoRoot, relative);
      const target = path.join(record.worktreePath, relative);
      const stat = safeStat(source);
      if (!stat || !stat.isFile()) {
        skipped.push(relative);
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push(relative);
    }
    return { copied, skipped };
  }

  private sharedWarnings(sessions: WorktreeConflictWarning["sessions"]): WorktreeConflictWarning[] {
    const byRepo = new Map<string, WorktreeConflictWarning>();
    for (const session of sessions) {
      const workspace = session.workspace;
      if (!workspace || this.getByWorkspace(workspace)) {
        continue;
      }
      const repoRoot = gitOutputSafe(["rev-parse", "--show-toplevel"], workspace);
      if (!repoRoot) {
        continue;
      }
      const warning = byRepo.get(repoRoot) ?? {
        repoRoot,
        sourceWorkspace: workspace,
        sessions: [],
      };
      warning.sessions.push(session);
      byRepo.set(repoRoot, warning);
    }
    return [...byRepo.values()].filter((warning) => warning.sessions.length > 1);
  }
}

function previewSource(record: SessionWorktreeRecord): WorktreeIntegrationPreviewSource {
  return {
    id: record.id,
    branchName: record.branchName,
    status: record.status,
    threadId: record.threadId,
    agentId: record.agentId,
    worktreePath: record.worktreePath,
    commitSha: record.commitSha,
  };
}

function conflictReviewItem(file: WorktreeChangedFile, sources: WorktreeIntegrationPreviewSource[]): WorktreeConflictReviewItem {
  const sourceWorktrees = sources.filter((source) => file.sourceWorktreeIds.includes(source.id));
  const sameFile = sourceWorktrees.length > 1;
  const risk = file.status === "conflict" ? "status-mismatch" : sameFile ? "same-file" : "none";
  const recommendation = risk === "none"
    ? "No conflict candidate detected for this file."
    : risk === "status-mismatch"
      ? "Review the file before merging because selected worktrees report different change types."
      : "Review side-by-side diffs before merging because multiple worktrees changed this file.";
  return {
    path: file.path,
    status: file.status,
    sourceWorktrees,
    risk,
    recommendation,
  };
}

export function createSessionWorktreeStore(config: ConnectorConfig): SessionWorktreeStore {
  return new SessionWorktreeStore(config.workspace, config.stateBackend);
}

function defaultCommitMessage(record: SessionWorktreeRecord): string {
  const suffix = record.threadId ? ` ${record.threadId}` : ` ${record.id}`;
  return `NordRelay session${suffix}`;
}

function statusText(record: SessionWorktreeRecord, exists: boolean, dirty: boolean): string {
  if (!exists) {
    return "missing";
  }
  if (record.status === "merged") {
    return "merged";
  }
  if (record.status === "conflict") {
    return "merge conflict";
  }
  if (dirty) {
    return "dirty";
  }
  if (record.commitSha) {
    return "committed";
  }
  return record.status;
}

function gitStatus(cwd: string): string[] {
  if (!existsSync(cwd)) {
    return [];
  }
  return gitOutputSafe(["status", "--porcelain"], cwd, true)?.split(/\r?\n/).filter(Boolean) ?? [];
}

function gitOutput(args: string[], cwd: string, allowLarge = false): string {
  return gitRawOutput(args, cwd, allowLarge).trim();
}

function gitRawOutput(args: string[], cwd: string, allowLarge = false): string {
  const { stdout } = runGit(args, cwd, undefined, allowLarge);
  return stdout;
}

function gitOutputSafe(args: string[], cwd: string, allowLarge = false): string | undefined {
  try {
    return gitOutput(args, cwd, allowLarge);
  } catch {
    return undefined;
  }
}

function runGit(args: string[], cwd: string, input?: string, allowLarge = false): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      maxBuffer: allowLarge ? MAX_GIT_BUFFER : 1024 * 1024,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "" };
  } catch (error) {
    const err = error as { message?: string; stderr?: string; stdout?: string };
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim();
    throw new Error(detail || "git command failed");
  }
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "repo";
}

function isSafeRelativePath(relative: string): boolean {
  return Boolean(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]+/).includes(".."));
}

function safeStat(filePath: string) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function truncateUtf8(text: string, limitBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limitBytes) {
    return { text, truncated: false };
  }
  let end = Math.min(text.length, limitBytes);
  while (Buffer.byteLength(text.slice(0, end), "utf8") > limitBytes && end > 0) {
    end -= 1;
  }
  return { text: `${text.slice(0, end)}\n\n[diff truncated]`, truncated: true };
}

function gitStatusCodeToChangedStatus(code: string): WorktreeChangedFile["status"] {
  const normalized = code.trim();
  if (normalized === "??") return "untracked";
  if (normalized.includes("U")) return "conflict";
  const first = normalized[0] ?? "";
  if (first === "A") return "added";
  if (first === "D") return "deleted";
  if (first === "R") return "renamed";
  if (first === "C") return "copied";
  if (first === "M") return "modified";
  return "unknown";
}
