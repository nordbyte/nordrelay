import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});

function tempStateFile(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "nordrelay-state-")), "state.json");
}
