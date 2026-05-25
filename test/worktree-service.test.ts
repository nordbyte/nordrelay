import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/core/config.js";
import { SessionWorktreeStore } from "../src/worktrees/worktree-store.js";
import { SessionWorktreeService } from "../src/worktrees/worktree-service.js";

const GIT_WORKTREE_TEST_TIMEOUT_MS = 30_000;

describe("SessionWorktreeService", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates isolated session worktrees, commits them, and integrates committed branches", () => {
    const root = tempRoot();
    const repo = initRepo(root);
    const service = worktreeService(root);

    const first = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(first.worktreePath, "feature-a.txt"), "a\n");
    const committed = service.commit(first.id, "session a");

    const second = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(second.worktreePath, "feature-b.txt"), "b\n");
    const committedSecond = service.commit(second.id, "session b");

    const integration = service.integrate([committed.record.id, committedSecond.record.id]);
    const diff = service.diff(committed.record.id);
    const preview = service.previewIntegration([committed.record.id, committedSecond.record.id]);

    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(committed.record.commitSha).toMatch(/[a-f0-9]{40}/);
    expect(diff.files.map((file) => file.path)).toContain("feature-a.txt");
    expect(diff.structuredFiles?.map((file) => file.path)).toContain("feature-a.txt");
    expect(diff.structuredFiles?.find((file) => file.path === "feature-a.txt")?.additions).toBeGreaterThan(0);
    expect(preview.canIntegrate).toBe(true);
    expect(preview.riskSummary?.label).toBe("low");
    expect(integration.status).toBe("merged");
    expect(existsSync(path.join(integration.worktreePath, "feature-a.txt"))).toBe(true);
    expect(existsSync(path.join(integration.worktreePath, "feature-b.txt"))).toBe(true);
  }, GIT_WORKTREE_TEST_TIMEOUT_MS);

  it("finalizes a merged integration back into the source repository and cleans up worktrees", () => {
    const root = tempRoot();
    const repo = initRepo(root);
    const service = worktreeService(root);

    const first = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(first.worktreePath, "feature-a.txt"), "a\n");
    const committed = service.commit(first.id, "session a");
    const integration = service.integrate([committed.record.id]);

    const result = service.finalizeIntegration(integration.id, {
      removeIntegrationWorktree: true,
      removeSourceWorktrees: true,
      deleteIntegrationBranch: true,
    });

    expect(result.run.status).toBe("applied");
    expect(result.run.appliedCommitSha).toMatch(/[a-f0-9]{40}/);
    expect(result.removedIntegrationWorktree).toBe(true);
    expect(result.deletedIntegrationBranch).toBe(true);
    expect(result.removedSourceWorktrees.map((record) => record.id)).toEqual([committed.record.id]);
    expect(existsSync(path.join(repo, "feature-a.txt"))).toBe(true);
    expect(existsSync(integration.worktreePath)).toBe(false);
    expect(existsSync(first.worktreePath)).toBe(false);
  }, GIT_WORKTREE_TEST_TIMEOUT_MS);

  it("previews file conflicts and updates a clean worktree from the base branch", () => {
    const root = tempRoot();
    const repo = initRepo(root);
    const service = worktreeService(root);

    const first = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(first.worktreePath, "README.md"), "session one\n");
    const committedFirst = service.commit(first.id, "session one");

    const second = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(second.worktreePath, "README.md"), "session two\n");
    const committedSecond = service.commit(second.id, "session two");

    const preview = service.previewIntegration([committedFirst.record.id, committedSecond.record.id]);
    expect(preview.canIntegrate).toBe(false);
    expect(preview.riskSummary?.label).toBe("high");
    expect(preview.riskSummary?.high).toBeGreaterThan(0);
    expect(preview.conflictCandidates.map((file) => file.path)).toContain("README.md");
    const review = preview.conflictReview.find((file) => file.path === "README.md");
    expect(review?.riskLevel).toBe("high");
    expect(review?.hasLineOverlap).toBe(true);
    expect(review?.baseContent?.content).toBe("base");
    expect(review?.sourceVersions?.map((version) => normalizeLineEndings(version.content ?? ""))).toEqual(["session one", "session two"]);

    const comparison = service.compare([committedFirst.record.id, committedSecond.record.id]);
    expect(comparison.preview.riskSummary?.label).toBe("high");
    expect(comparison.diffs).toHaveLength(2);
    expect(comparison.diffs[0]?.structuredFiles?.some((file) => file.path === "README.md")).toBe(true);

    const patch = service.exportIntegrationPatch([committedFirst.record.id, committedSecond.record.id]);
    expect(patch.fileName).toMatch(/nordrelay-worktree-patches-.*\.patch$/);
    expect(patch.worktreeIds).toEqual([committedFirst.record.id, committedSecond.record.id]);
    expect(patch.summary).toContain("NordRelay Worktree Integration Export");
    expect(patch.riskReportJson).toContain("\"riskSummary\"");
    expect(patch.prCommands?.some((command) => command.includes("gh pr create"))).toBe(true);
    expect(patch.content).toContain("session one");
    expect(patch.content).toContain("session two");
    expect(patch.content).toContain("README.md");

    writeFileSync(path.join(repo, "base.txt"), "base update\n");
    execFileSync("git", ["add", "base.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base update"], { cwd: repo });
    const clean = service.create({ sourceWorkspace: repo, agentId: "codex", contextKey: "web:test" });
    writeFileSync(path.join(repo, "base-2.txt"), "base update 2\n");
    execFileSync("git", ["add", "base-2.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base update 2"], { cwd: repo });

    const updated = service.updateFromBase(clean.id);
    expect(updated.rebased).toBe(true);
    expect(updated.record.baseSha).toMatch(/[a-f0-9]{40}/);
    expect(existsSync(path.join(clean.worktreePath, "base-2.txt"))).toBe(true);
  }, GIT_WORKTREE_TEST_TIMEOUT_MS);

  it("can fork tracked and untracked pending changes into a new worktree", () => {
    const root = tempRoot();
    const repo = initRepo(root);
    const service = worktreeService(root);

    writeFileSync(path.join(repo, "README.md"), "changed\n");
    writeFileSync(path.join(repo, "notes.txt"), "untracked\n");

    const fork = service.fork({
      sourceWorkspace: repo,
      agentId: "codex",
      contextKey: "web:test",
      includeUncommitted: true,
    });

    expect(fork.patchApplied).toBe(true);
    expect(fork.copiedUntrackedFiles).toContain("notes.txt");
    expect(normalizeLineEndings(readFileSync(path.join(fork.record.worktreePath, "README.md"), "utf8"))).toBe("changed\n");
    expect(normalizeLineEndings(readFileSync(path.join(fork.record.worktreePath, "notes.txt"), "utf8"))).toBe("untracked\n");
  }, GIT_WORKTREE_TEST_TIMEOUT_MS);

  function tempRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "nordrelay-worktrees-"));
    roots.push(root);
    return root;
  }
});

function initRepo(root: string): string {
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["config", "user.name", "NordRelay Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "nordrelay@example.invalid"], { cwd: repo });
  writeFileSync(path.join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  return repo;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function worktreeService(root: string): SessionWorktreeService {
  const state = path.join(root, "state");
  const config = {
    workspace: state,
    stateBackend: "json",
    sessionWorkspaceMode: "worktree",
    sessionWorktreeRoot: path.join(root, "worktrees"),
    sessionWorktreeBranchPrefix: "nr/test",
  } as ConnectorConfig;
  return new SessionWorktreeService(config, new SessionWorktreeStore(state, "json"));
}
