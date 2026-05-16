import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface JsonReadResult<T> {
  value: T | undefined;
  recoveredFromBackup: boolean;
  error?: string;
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextFileAtomic(filePath: string, value: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const backupPath = `${filePath}.bak`;
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  try {
    if (existsSync(filePath)) {
      copyFileSync(filePath, backupPath);
    }
    writeFileSync(tempPath, value, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function readJsonFileWithBackup<T>(filePath: string): JsonReadResult<T> {
  const primary = readJsonFile<T>(filePath);
  if (primary.ok) {
    return { value: primary.value, recoveredFromBackup: false };
  }

  const backupPath = `${filePath}.bak`;
  const backup = readJsonFile<T>(backupPath);
  if (backup.ok) {
    return {
      value: backup.value,
      recoveredFromBackup: true,
      error: primary.error,
    };
  }

  if (primary.error && existsSync(filePath)) {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      copyFileSync(filePath, corruptPath);
    } catch {
      // Best-effort only. The original file remains untouched.
    }
  }

  return {
    value: undefined,
    recoveredFromBackup: false,
    error: primary.error ?? backup.error,
  };
}

function readJsonFile<T>(filePath: string): { ok: true; value: T } | { ok: false; error?: string } {
  if (!existsSync(filePath)) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
