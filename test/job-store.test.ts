import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UnifiedJobStore } from "../src/job-store.js";
import type { UnifiedJobDto } from "../src/relay-runtime-types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("UnifiedJobStore", () => {
  it("persists and updates unified job snapshots", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "nordrelay-jobs-"));
    tmpDirs.push(workspace);
    const store = new UnifiedJobStore(workspace, "json", 10);
    const job = jobDto("job-1", "running");

    store.upsert(job);
    store.patch("job-1", { status: "completed", finishedAt: "2026-05-15T10:00:01.000Z" });

    const restored = new UnifiedJobStore(workspace, "json", 10);
    expect(restored.get("job-1")).toMatchObject({
      id: "job-1",
      status: "completed",
      finishedAt: "2026-05-15T10:00:01.000Z",
    });
  });
});

function jobDto(id: string, status: UnifiedJobDto["status"]): UnifiedJobDto {
  return {
    id,
    kind: "web-turn",
    title: "Test job",
    status,
    source: "web",
    threadId: "thread-1",
    startedAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
    canCancel: status === "running",
    canRetry: status !== "running",
    canReadLog: true,
  };
}
