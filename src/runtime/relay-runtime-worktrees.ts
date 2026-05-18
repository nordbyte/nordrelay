import type { AgentSessionInfo } from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import type { WebActivityActor } from "../web/web-state.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type {
  SessionWorktreeDiffSnapshot,
  SessionWorktreeRecord,
  SessionWorktreeUpdateResult,
  WorktreeCleanupResult,
  WorktreeDashboardSnapshot,
  WorktreeIntegrationRun,
  WorktreeIntegrationOptions,
  WorktreeIntegrationPatchExport,
  WorktreeIntegrationPreview,
} from "../worktrees/worktree-types.js";

export async function relayRuntimeSessionWorktrees(runtime: RelayRuntimeDelegate): Promise<WorktreeDashboardSnapshot> {
  const contexts = runtime.listKnownContextMetadata()
    .filter((meta) => meta.threadId || meta.workspace)
    .map((meta) => ({
      agentId: meta.agentId,
      threadId: meta.threadId,
      contextKey: meta.contextKey,
      workspace: meta.workspace,
    }));
  return runtime.worktreeService.listDashboardSnapshot(contexts);
}

export async function relayRuntimeCommitSessionWorktree(
  runtime: RelayRuntimeDelegate,
  id: string,
  message?: string,
  actor?: WebActivityActor,
): Promise<{ record: SessionWorktreeRecord; clean: boolean; status: string[] }> {
  const result = runtime.worktreeService.commit(id, message);
  runtime.appendActivity({
    source: "web",
    status: "completed",
    type: "worktree_committed",
    threadId: result.record.threadId ?? null,
    workspace: result.record.worktreePath,
    agentId: result.record.agentId,
    actor,
    detail: result.clean ? "No changes; recorded current HEAD." : `Committed ${result.record.commitSha ?? result.record.branchName}.`,
  });
  return result;
}

export async function relayRuntimeSessionWorktreeDiff(
  runtime: RelayRuntimeDelegate,
  id: string,
): Promise<SessionWorktreeDiffSnapshot> {
  return runtime.worktreeService.diff(id);
}

export async function relayRuntimePreviewSessionWorktreeIntegration(
  runtime: RelayRuntimeDelegate,
  ids: string[],
): Promise<WorktreeIntegrationPreview> {
  return runtime.worktreeService.previewIntegration(ids);
}

export async function relayRuntimeExportSessionWorktreeIntegrationPatch(
  runtime: RelayRuntimeDelegate,
  ids: string[],
): Promise<WorktreeIntegrationPatchExport> {
  return runtime.worktreeService.exportIntegrationPatch(ids);
}

export async function relayRuntimeUpdateSessionWorktreeFromBase(
  runtime: RelayRuntimeDelegate,
  id: string,
  actor?: WebActivityActor,
): Promise<SessionWorktreeUpdateResult> {
  const result = runtime.worktreeService.updateFromBase(id);
  runtime.appendActivity({
    source: "web",
    status: result.record.status === "conflict" ? "failed" : "info",
    type: "worktree_updated_from_base",
    threadId: result.record.threadId ?? null,
    workspace: result.record.worktreePath,
    agentId: result.record.agentId,
    actor,
    detail: result.rebased ? `Rebased ${result.record.branchName} onto ${result.newBaseSha}.` : "Worktree already used the latest base.",
  });
  return result;
}

export async function relayRuntimeCleanupSessionWorktrees(
  runtime: RelayRuntimeDelegate,
  actor?: WebActivityActor,
): Promise<WorktreeCleanupResult> {
  const result = runtime.worktreeService.cleanup();
  runtime.appendActivity({
    source: "web",
    status: "info",
    type: "worktree_cleanup",
    threadId: null,
    workspace: runtime.config.workspace,
    actor,
    detail: `${result.removedRecords.length} records removed, ${result.prunedRepositories.length} repos pruned.`,
  });
  return result;
}

export async function relayRuntimeIntegrateSessionWorktrees(
  runtime: RelayRuntimeDelegate,
  ids: string[],
  options: WorktreeIntegrationOptions = {},
  actor?: WebActivityActor,
): Promise<WorktreeIntegrationRun> {
  const run = runtime.worktreeService.integrate(ids, options);
  runtime.appendActivity({
    source: "web",
    status: run.status === "merged" ? "completed" : run.status === "conflict" ? "failed" : "info",
    type: "worktree_integrated",
    threadId: null,
    workspace: run.worktreePath,
    actor,
    detail: run.status === "merged" ? `Integration branch ${run.branchName} created${run.resolvedConflicts?.length ? ` with ${run.resolvedConflicts.length} resolved conflict(s)` : ""}.` : run.lastError ?? run.status,
  });
  return run;
}

export async function relayRuntimeForkCurrentSessionToWorktree(
  runtime: RelayRuntimeDelegate,
  options: { includeUncommitted?: boolean } = {},
  actor?: WebActivityActor,
): Promise<{ session: AgentSessionInfo; record: SessionWorktreeRecord; copiedUntrackedFiles: string[]; skippedUntrackedFiles: string[]; patchApplied: boolean }> {
  const session = await runtime.getSession(true);
  runtime.ensureIdle(session);
  const current = runtime.publicInfo(session);
  const external = getExternalSnapshotForSession(session, runtime.config, { maxEvents: 0 });
  if (external?.activity.active) {
    throw new Error(`Cannot fork while the external ${external.agentLabel} CLI task is still running.`);
  }
  const fork = runtime.worktreeService.fork({
    agentId: current.agentId,
    contextKey: runtime.contextKey,
    threadId: current.threadId,
    sourceWorkspace: current.workspace,
    includeUncommitted: options.includeUncommitted,
  });
  const info = await session.newThread(fork.record.worktreePath, current.model);
  const record = runtime.worktreeService.linkThread(fork.record.id, info.threadId, info.agentId, runtime.contextKey);
  runtime.updateSession(session);
  runtime.appendActivity({
    source: "web",
    status: "info",
    type: "session_forked_worktree",
    threadId: info.threadId,
    workspace: info.workspace,
    agentId: info.agentId,
    actor,
    detail: `Forked session into ${record.branchName}.`,
  });
  return { session: runtime.publicInfo(session), record, copiedUntrackedFiles: fork.copiedUntrackedFiles, skippedUntrackedFiles: fork.skippedUntrackedFiles, patchApplied: fork.patchApplied };
}

export async function relayRuntimeRemoveSessionWorktree(
  runtime: RelayRuntimeDelegate,
  id: string,
  force: boolean,
  actor?: WebActivityActor,
): Promise<SessionWorktreeRecord> {
  const record = runtime.worktreeService.remove(id, { force });
  runtime.appendActivity({
    source: "web",
    status: "info",
    type: "worktree_removed",
    threadId: record.threadId ?? null,
    workspace: record.worktreePath,
    agentId: record.agentId,
    actor,
    detail: force ? "Removed worktree with force." : "Removed worktree.",
  });
  return record;
}
