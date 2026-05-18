import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/core/config.js";
import { SessionWorktreeStore } from "../src/worktrees/worktree-store.js";
import { SessionWorktreeService } from "../src/worktrees/worktree-service.js";

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

    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(committed.record.commitSha).toMatch(/[a-f0-9]{40}/);
    expect(integration.status).toBe("merged");
    expect(existsSync(path.join(integration.worktreePath, "feature-a.txt"))).toBe(true);
    expect(existsSync(path.join(integration.worktreePath, "feature-b.txt"))).toBe(true);
  });

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
    expect(readFileSync(path.join(fork.record.worktreePath, "README.md"), "utf8")).toBe("changed\n");
    expect(readFileSync(path.join(fork.record.worktreePath, "notes.txt"), "utf8")).toBe("untracked\n");
  });

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
