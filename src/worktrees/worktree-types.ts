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

export type WorktreeChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "unknown";

export interface WorktreeChangedFile {
  path: string;
  status: WorktreeChangedFileStatus;
  sourceWorktreeIds: string[];
}

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
  status: "running" | "merged" | "applied" | "conflict" | "failed";
  repoRoot: string;
  repoName: string;
  baseSha: string;
  baseBranch?: string;
  branchName: string;
  worktreePath: string;
  worktreeIds: string[];
  mergedCommitShas: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  appliedAt?: string;
  appliedCommitSha?: string;
  targetBranch?: string;
  cleanup?: {
    removedIntegrationWorktree?: boolean;
    deletedIntegrationBranch?: boolean;
    removedSourceWorktrees?: string[];
    warnings?: string[];
  };
  lastError?: string;
  resolvedConflicts?: string[];
}

export interface SessionWorktreeDiffSnapshot {
  record: SessionWorktreeRecord;
  files: WorktreeChangedFile[];
  diff: string;
  structuredFiles?: WorktreeStructuredDiffFile[];
  truncated: boolean;
  byteLength: number;
  generatedAt: string;
}

export type WorktreeStructuredDiffLineKind = "context" | "add" | "delete" | "hunk" | "meta";

export interface WorktreeStructuredDiffLine {
  kind: WorktreeStructuredDiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface WorktreeStructuredDiffFile {
  path: string;
  oldPath?: string;
  status: WorktreeChangedFileStatus;
  binary?: boolean;
  additions: number;
  deletions: number;
  lines: WorktreeStructuredDiffLine[];
}

export interface WorktreeIntegrationPreview {
  ids: string[];
  canIntegrate: boolean;
  repoRoot?: string;
  repoName?: string;
  baseSha?: string;
  sourceWorktrees: WorktreeIntegrationPreviewSource[];
  files: WorktreeChangedFile[];
  conflictCandidates: WorktreeChangedFile[];
  conflictReview: WorktreeConflictReviewItem[];
  riskSummary?: WorktreeRiskSummary;
  warnings: string[];
  generatedAt: string;
}

export interface WorktreeIntegrationPreviewSource {
  id: string;
  branchName: string;
  status: SessionWorktreeStatus;
  threadId?: string | null;
  agentId?: AgentId;
  worktreePath: string;
  commitSha?: string;
}

export interface WorktreeConflictReviewItem {
  path: string;
  status: WorktreeChangedFileStatus;
  sourceWorktrees: WorktreeIntegrationPreviewSource[];
  risk: "none" | "same-file" | "status-mismatch";
  riskLevel?: WorktreeRiskLevel;
  riskReasons?: string[];
  hasLineOverlap?: boolean;
  changedRanges?: WorktreeChangedRangeSource[];
  recommendation: string;
  baseContent?: WorktreeFileContentPreview;
  sourceVersions?: WorktreeFileVersionPreview[];
}

export type WorktreeRiskLevel = "low" | "medium" | "high" | "blocked";

export interface WorktreeRiskSummary {
  label: WorktreeRiskLevel;
  low: number;
  medium: number;
  high: number;
  blocked: number;
  totalFiles: number;
  riskyFiles: number;
  canMerge: boolean;
}

export interface WorktreeChangedRange {
  start: number;
  end: number;
}

export interface WorktreeChangedRangeSource {
  worktreeId: string;
  branchName: string;
  ranges: WorktreeChangedRange[];
}

export interface WorktreeFileContentPreview {
  label: string;
  content?: string;
  truncated?: boolean;
  unavailable?: string;
}

export interface WorktreeFileVersionPreview extends WorktreeFileContentPreview {
  worktreeId: string;
  branchName: string;
  commitSha?: string;
}

export type WorktreeConflictResolutionChoice = "auto" | "ours" | "theirs" | "both" | "manual";

export interface WorktreeConflictResolution {
  path: string;
  choice: WorktreeConflictResolutionChoice;
  sourceWorktreeId?: string;
  content?: string;
}

export interface WorktreeIntegrationOptions {
  resolutions?: WorktreeConflictResolution[];
}

export interface WorktreeFinalizeIntegrationOptions {
  targetBranch?: string;
  removeIntegrationWorktree?: boolean;
  removeSourceWorktrees?: boolean;
  deleteIntegrationBranch?: boolean;
}

export interface WorktreeFinalizeIntegrationResult {
  run: WorktreeIntegrationRun;
  removedIntegrationWorktree: boolean;
  deletedIntegrationBranch: boolean;
  removedSourceWorktrees: SessionWorktreeRecord[];
}

export interface WorktreeIntegrationPatchExport {
  fileName: string;
  content: string;
  worktreeIds: string[];
  summaryFileName?: string;
  summary?: string;
  riskReportFileName?: string;
  riskReportJson?: string;
  prTitle?: string;
  prBody?: string;
  prCommands?: string[];
  generatedAt: string;
}

export interface WorktreeComparisonSnapshot {
  ids: string[];
  preview: WorktreeIntegrationPreview;
  diffs: SessionWorktreeDiffSnapshot[];
  generatedAt: string;
}

export interface SessionWorktreeUpdateResult {
  record: SessionWorktreeRecord;
  previousBaseSha: string;
  newBaseSha: string;
  rebased: boolean;
  status: string[];
}

export interface WorktreeCleanupResult {
  removedRecords: string[];
  removedIntegrations: string[];
  prunedRepositories: string[];
  warnings: string[];
  cleanedAt: string;
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
