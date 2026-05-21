import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readJsonFileWithBackup, StatePersistenceError, updateJsonFileAtomic } from "../src/state/persistence.js";

describe("state persistence", () => {
  it("does not normalize corrupt state files to empty data", () => {
    const filePath = tempStateFile();
    writeFileSync(filePath, "{broken", "utf8");

    expect(() => readJsonFileWithBackup(filePath)).toThrow(StatePersistenceError);
    expect(readFileSync(filePath, "utf8")).toBe("{broken");
    expect(() => updateJsonFileAtomic(filePath, () => ({ version: 1, items: [] }))).toThrow(StatePersistenceError);
    expect(readFileSync(filePath, "utf8")).toBe("{broken");
  });

  it("recovers corrupt state from a valid backup but rejects unknown versions", () => {
    const filePath = tempStateFile();
    writeFileSync(filePath, "{broken", "utf8");
    writeFileSync(`${filePath}.bak`, JSON.stringify({ version: 1, items: ["backup"] }), "utf8");

    expect(readJsonFileWithBackup<{ version: 1; items: string[] }>(filePath)).toMatchObject({
      recoveredFromBackup: true,
      value: { version: 1, items: ["backup"] },
    });

    writeFileSync(filePath, JSON.stringify({ version: 99, items: ["future"] }), "utf8");

    expect(() => readJsonFileWithBackup(filePath)).toThrow(/Unsupported state payload version/);
    expect(existsSync(filePath)).toBe(true);
  });

  it("preserves the valid backup when updating from backup recovery", () => {
    const filePath = tempStateFile();
    writeFileSync(filePath, "{broken", "utf8");
    writeFileSync(`${filePath}.bak`, JSON.stringify({ version: 1, items: ["backup"] }), "utf8");

    const next = updateJsonFileAtomic<{ version: 1; items: string[] }>(filePath, (current) => ({
      version: 1,
      items: [...(current?.items ?? []), "next"],
    }));

    expect(next).toEqual({ version: 1, items: ["backup", "next"] });
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ version: 1, items: ["backup", "next"] });
    expect(JSON.parse(readFileSync(`${filePath}.bak`, "utf8"))).toEqual({ version: 1, items: ["backup"] });
  });

  it("writes state files with private file permissions where supported", () => {
    const filePath = tempStateFile();

    updateJsonFileAtomic(filePath, () => ({ version: 1, items: ["private"] }));

    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    }
  });
});

function tempStateFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "nordrelay-state-")), "state.json");
}
