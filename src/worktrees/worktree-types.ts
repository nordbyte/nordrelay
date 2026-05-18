import type { AgentId } from "../agents/shared/agent.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";

export const SESSION_WORKSPACE_MODES = ["shared", "worktree", "attached"] as const;
export type SessionWorkspaceMode = typeof SESSION_WORKSPACE_MODES[number];

export type SessionWorktreeStatus =
  | "active"
  | "committed"
  | "merged"
  | "conflict"
  | "removed"
  | "failed";

export interface SessionWorktreeRecord {
  id: string;
  mode: "worktree";
  status: SessionWorktreeStatus;
  agentId?: AgentId;
  contextKey?: ChannelContextKey;
  threadId?: string | null;
  sourceWorkspace: string;
  repoRoot: string;
  repoName: string;
  baseSha: string;
  baseBranch?: string;
  branchName: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  committedAt?: string;
  commitSha?: string;
  commitMessage?: string;
  mergedAt?: string;
  integrationRunId?: string;
  copiedUntrackedFiles?: string[];
  skippedUntrackedFiles?: string[];
  lastError?: string;
}

export interface SessionWorktreeStatusSnapshot extends SessionWorktreeRecord {
  exists: boolean;
  dirty: boolean;
  statusText: string;
  gitStatus: string[];
  headSha?: string;
}

export interface WorktreeIntegrationRun {
  id: string;
  status: "running" | "merged" | "conflict" | "failed";
  repoRoot: string;
  repoName: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  worktreeIds: string[];
  mergedCommitShas: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastError?: string;
}

export interface WorktreeConflictWarning {
  repoRoot: string;
  sourceWorkspace: string;
  sessions: Array<{
    agentId?: AgentId;
    threadId: string | null;
    contextKey?: ChannelContextKey;
    workspace: string;
  }>;
}

export interface WorktreeDashboardSnapshot {
  defaultMode: SessionWorkspaceMode;
  worktreeRoot: string;
  records: SessionWorktreeStatusSnapshot[];
  integrations: WorktreeIntegrationRun[];
  sharedWarnings: WorktreeConflictWarning[];
  updatedAt: string;
}
