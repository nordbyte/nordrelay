import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectSelfUpdateMethod, readFormattedLogTail } from "../src/operations.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-ops-"));
  tempDirs.push(dir);
  return dir;
}

describe("operations", () => {
  const originalEnv = process.env;

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  it("formats log tails with timestamps, levels, and legacy line markers", async () => {
    const dir = createTempDir();
    const file = path.join(dir, "nordrelay.log");
    writeFileSync(file, [
      "legacy startup line",
      "[2026-05-12T12:30:00.000Z] Starting git connector self-update",
      "[2026-05-12 14:30:01 +02:00] WARN token=secret-value",
      JSON.stringify({ ts: "2026-05-12T12:30:02.000Z", level: "error", event: "console", message: "failed" }),
    ].join("\n"));

    const tail = await readFormattedLogTail(10, file);

    expect(tail.filePath).toBe(file);
    expect(tail.lineCount).toBe(4);
    expect(tail.plain).toContain("no timestamp");
    expect(tail.plain).toContain("Starting git connector self-update");
    expect(tail.plain).not.toContain("+02:00");
    expect(tail.plain).toContain("WARN");
    expect(tail.plain).toContain("token=[redacted]");
    expect(tail.plain).toContain("ERROR");
    expect(tail.plain).toContain("failed");
  });

  it("detects git checkouts and npm installs for self-update", () => {
    const gitRoot = createTempDir();
    mkdirSync(path.join(gitRoot, ".git"));
    const packageRoot = createTempDir();

    expect(detectSelfUpdateMethod(gitRoot)).toBe("git");
    expect(detectSelfUpdateMethod(packageRoot)).toBe("npm");

    process.env = { ...originalEnv, NORDRELAY_UPDATE_METHOD: "npm" };
    expect(detectSelfUpdateMethod(gitRoot)).toBe("npm");
  });
});
