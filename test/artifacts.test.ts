import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  collectArtifactReport,
  collectArtifacts,
  collectRecentWorkspaceArtifacts,
  createArtifactZipBundle,
  ensureOutDir,
  formatArtifactSummary,
  getArtifactTurnReport,
  listRecentArtifactReports,
  persistWorkspaceArtifactReport,
  pruneConnectorTurnDirs,
  removeArtifactTurn,
  telegramArtifactFilename,
} from "../src/artifacts/artifacts.js";
import type { ConnectorConfig } from "../src/core/config.js";
import { RelayArtifactService } from "../src/runtime/relay-artifact-service.js";

describe("ensureOutDir", () => {
  const testDir = path.join(tmpdir(), `nordrelay-art-${randomUUID()}`);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates the output directory", async () => {
    const dir = path.join(testDir, "out");
    await ensureOutDir(dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("collectArtifacts", () => {
  const testDir = path.join(tmpdir(), `nordrelay-collect-${randomUUID()}`);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns empty array for nonexistent directory", async () => {
    const missingDir = path.join(testDir, "missing");
    expect(await collectArtifacts(missingDir)).toEqual([]);
  });

  it("collects files from the output directory", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "output.txt"), "result");
    writeFileSync(path.join(testDir, "data.json"), '{"key": "value"}');

    const artifacts = await collectArtifacts(testDir);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["data.json", "output.txt"]);
  });

  it("collects nested artifacts with relative paths", async () => {
    mkdirSync(path.join(testDir, "nested"), { recursive: true });
    writeFileSync(path.join(testDir, "nested", "output.txt"), "result");
    writeFileSync(path.join(testDir, "root.txt"), "result");

    const artifacts = await collectArtifacts(testDir);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["nested/output.txt", "root.txt"]);
    expect(artifacts[0]?.relativePath).toBe("nested/output.txt");
  });

  it("skips hidden files and temp files", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, ".hidden"), "nope");
    writeFileSync(path.join(testDir, "backup.tmp"), "nope");
    writeFileSync(path.join(testDir, "backup~"), "nope");
    writeFileSync(path.join(testDir, "good.txt"), "yes");
    writeFileSync(path.join(testDir, "__init__.py"), "yes");

    const artifacts = await collectArtifacts(testDir);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => a.name)).toEqual(["__init__.py", "good.txt"]);
  });

  it("skips files exceeding max size", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "small.txt"), "ok");
    writeFileSync(path.join(testDir, "big.bin"), Buffer.alloc(1024));

    const artifacts = await collectArtifacts(testDir, 512);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("small.txt");
  });

  it("tracks skipped oversize files in the artifact report", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "small.txt"), "ok");
    writeFileSync(path.join(testDir, "big.bin"), Buffer.alloc(1024));

    const report = await collectArtifactReport(testDir, 512);
    expect(report.artifacts).toHaveLength(1);
    expect(report.skippedCount).toBe(1);
  });

  it("collects recent workspace artifacts while ignoring internal directories", async () => {
    const since = new Date("2026-05-12T04:00:00.000Z");
    const recent = new Date("2026-05-12T04:01:00.000Z");
    const old = new Date("2026-05-12T03:59:00.000Z");
    mkdirSync(path.join(testDir, "out"), { recursive: true });
    mkdirSync(path.join(testDir, ".git"), { recursive: true });
    writeFileSync(path.join(testDir, "out", "result.txt"), "ok");
    writeFileSync(path.join(testDir, "old.txt"), "old");
    writeFileSync(path.join(testDir, ".git", "ignored.txt"), "ignored");
    utimesSync(path.join(testDir, "out", "result.txt"), recent, recent);
    utimesSync(path.join(testDir, "old.txt"), old, old);
    utimesSync(path.join(testDir, ".git", "ignored.txt"), recent, recent);

    const report = await collectRecentWorkspaceArtifacts(testDir, { since, until: new Date("2026-05-12T04:02:00.000Z") });

    expect(report.artifacts.map((artifact) => artifact.relativePath)).toEqual(["out/result.txt"]);
  });

  it("tracks omitted recent workspace artifacts separately from oversize files", async () => {
    const since = new Date("2026-05-12T04:00:00.000Z");
    const recent = new Date("2026-05-12T04:01:00.000Z");
    mkdirSync(testDir, { recursive: true });
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(path.join(testDir, name), name);
      utimesSync(path.join(testDir, name), recent, recent);
    }
    writeFileSync(path.join(testDir, "big.bin"), Buffer.alloc(1024));
    utimesSync(path.join(testDir, "big.bin"), recent, recent);

    const report = await collectRecentWorkspaceArtifacts(testDir, {
      since,
      until: new Date("2026-05-12T04:02:00.000Z"),
      maxFileSize: 512,
      limit: 2,
    });

    expect(report.artifacts).toHaveLength(2);
    expect(report.skippedCount).toBe(1);
    expect(report.omittedCount).toBe(1);
  });

  it("lists recent artifact turns for a workspace", async () => {
    const outDir = path.join(testDir, ".nordrelay", "turns", "turn-a", "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "result.txt"), "ok");

    const reports = await listRecentArtifactReports(testDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.objectContaining({
      turnId: "turn-a",
      artifacts: [expect.objectContaining({ name: "result.txt" })],
      totalSizeBytes: 2,
    }));
  });

  it("loads and removes a specific artifact turn", async () => {
    const outDir = path.join(testDir, ".nordrelay", "turns", "turn-a", "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "result.txt"), "ok");

    const report = await getArtifactTurnReport(testDir, "turn-a");

    expect(report).toEqual(expect.objectContaining({
      turnId: "turn-a",
      artifacts: [expect.objectContaining({ name: "result.txt" })],
    }));
    expect(await removeArtifactTurn(testDir, "turn-a")).toBe(true);
    expect(await getArtifactTurnReport(testDir, "turn-a")).toBeNull();
  });

  it("persists workspace-scanned artifact turns for /artifacts", async () => {
    mkdirSync(path.join(testDir, "test"), { recursive: true });
    writeFileSync(path.join(testDir, "test", "result.txt"), "ok");
    const artifact = {
      name: "test/result.txt",
      relativePath: "test/result.txt",
      localPath: path.join(testDir, "test", "result.txt"),
      sizeBytes: 2,
    };

    await persistWorkspaceArtifactReport(testDir, "turn-cli", {
      artifacts: [artifact],
      skippedCount: 1,
      omittedCount: 2,
    }, {
      source: "cli",
      agentId: "codex",
      threadId: "thread-1",
      workspace: testDir,
      contextKey: "cli:thread-1",
      correlationId: "corr-1",
      prompt: "Generate artifact",
      actor: { channel: "cli", id: "local-cli", label: "Codex CLI" },
      turnStartedAt: "2026-05-12T04:00:00.000Z",
    });

    const reports = await listRecentArtifactReports(testDir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.objectContaining({
      turnId: "turn-cli",
      outDir: testDir,
      source: "workspace",
      skippedCount: 1,
      omittedCount: 2,
      provenance: expect.objectContaining({
        source: "cli",
        agentId: "codex",
        threadId: "thread-1",
        contextKey: "cli:thread-1",
        correlationId: "corr-1",
        prompt: "Generate artifact",
        actor: expect.objectContaining({ channel: "cli", label: "Codex CLI" }),
        turnStartedAt: "2026-05-12T04:00:00.000Z",
      }),
      artifacts: [expect.objectContaining({ name: "test/result.txt" })],
    }));
    await expect(getArtifactTurnReport(testDir, "turn-cli")).resolves.toEqual(expect.objectContaining({
      turnId: "turn-cli",
      source: "workspace",
      provenance: expect.objectContaining({
        source: "cli",
        agentId: "codex",
        threadId: "thread-1",
      }),
    }));
  });

  it("does not generate workspace artifact reports when artifact tracking is disabled", async () => {
    const since = new Date("2026-05-12T04:00:00.000Z");
    const recent = new Date("2026-05-12T04:01:00.000Z");
    mkdirSync(path.join(testDir, "out"), { recursive: true });
    writeFileSync(path.join(testDir, "out", "result.txt"), "ok");
    utimesSync(path.join(testDir, "out", "result.txt"), recent, recent);

    const service = new RelayArtifactService({
      artifactsEnabled: false,
      maxFileSize: 20 * 1024 * 1024,
      artifactMaxTotalBytes: 0,
      artifactRetentionDays: 7,
      artifactMaxTurnDirs: 30,
      artifactMaxInboxDirs: 30,
      artifactWarnPercent: 80,
      artifactSafeFilePolicy: "warn",
      artifactIgnoreDirs: [],
      artifactIgnoreGlobs: [],
    } as ConnectorConfig);

    await service.persistWorkspaceArtifactsForTurn(testDir, "turn-disabled", since);

    await expect(listRecentArtifactReports(testDir)).resolves.toEqual([]);
  });

  it("rejects unsafe artifact turn ids", async () => {
    expect(await getArtifactTurnReport(testDir, "../bad")).toBeNull();
    expect(await removeArtifactTurn(testDir, "../bad")).toBe(false);
  });

  it("prunes old turn and inbox directories", async () => {
    const now = new Date("2026-05-11T00:00:00.000Z").getTime();
    const oldDate = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const oldTurn = path.join(testDir, ".nordrelay", "turns", "old-turn");
    const newTurn = path.join(testDir, ".nordrelay", "turns", "new-turn");
    const oldInbox = path.join(testDir, ".nordrelay", "inbox", "old-inbox");
    mkdirSync(oldTurn, { recursive: true });
    mkdirSync(newTurn, { recursive: true });
    mkdirSync(oldInbox, { recursive: true });
    utimesSync(oldTurn, oldDate, oldDate);
    utimesSync(oldInbox, oldDate, oldDate);

    const report = await pruneConnectorTurnDirs(testDir, { now, maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(report).toEqual({ removedTurnDirs: 1, removedInboxDirs: 1 });
    expect(existsSync(oldTurn)).toBe(false);
    expect(existsSync(newTurn)).toBe(true);
    expect(existsSync(oldInbox)).toBe(false);
  });

  it("returns null when a zip bundle cannot be created", async () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "output.txt"), "result");
    const artifacts = await collectArtifacts(testDir);

    await expect(createArtifactZipBundle(artifacts, testDir, { zipCommand: "missing-zip-command" })).resolves.toBeNull();
  });

  it("flattens nested names for Telegram filenames", () => {
    expect(telegramArtifactFilename({
      name: "nested/output.txt",
      relativePath: "nested/output.txt",
      localPath: "/tmp/output.txt",
      sizeBytes: 1,
    })).toBe("nested__output.txt");
  });
});

describe("formatArtifactSummary", () => {
  it("returns empty string when no artifacts", () => {
    expect(formatArtifactSummary([], 0)).toBe("");
  });

  it("formats single artifact", () => {
    const artifacts = [{ name: "out.txt", relativePath: "out.txt", localPath: "/tmp/out.txt", sizeBytes: 100 }];
    expect(formatArtifactSummary(artifacts, 0)).toContain("1 artifact generated");
  });

  it("formats multiple artifacts", () => {
    const artifacts = [
      { name: "a.txt", relativePath: "a.txt", localPath: "/tmp/a.txt", sizeBytes: 100 },
      { name: "b.txt", relativePath: "b.txt", localPath: "/tmp/b.txt", sizeBytes: 200 },
    ];
    expect(formatArtifactSummary(artifacts, 0)).toContain("2 artifacts generated");
  });

  it("reports skipped files", () => {
    expect(formatArtifactSummary([], 3)).toContain("3 files too large to send");
  });

  it("reports omitted files separately", () => {
    expect(formatArtifactSummary([], 0, 3)).toContain("3 more not shown");
  });
});
