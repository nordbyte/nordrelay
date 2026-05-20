import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface JsonReadResult<T> {
  value: T | undefined;
  recoveredFromBackup: boolean;
  error?: string;
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function updateJsonFileAtomic<T>(filePath: string, updater: (current: T | undefined) => T): T {
  return withJsonFileLock(filePath, () => {
    const current = readJsonFileWithBackup<T>(filePath).value;
    const next = updater(current);
    writeJsonFileAtomic(filePath, next);
    return next;
  });
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

function withJsonFileLock<T>(filePath: string, fn: () => T): T {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      removeStaleLock(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for state file lock: ${filePath}`);
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > 30_000) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {
    // The lock may have disappeared between attempts.
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
