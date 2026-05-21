import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface JsonReadResult<T> {
  value: T | undefined;
  recoveredFromBackup: boolean;
  error?: string;
}

export class StatePersistenceError extends Error {
  constructor(message: string, readonly filePath: string, readonly causeDetail?: string) {
    super(message);
    this.name = "StatePersistenceError";
  }
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function writeJsonFileAtomic(filePath: string, value: unknown, options: WriteTextFileAtomicOptions = {}): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function updateJsonFileAtomic<T>(filePath: string, updater: (current: T | undefined) => T): T {
  return withJsonFileLock(filePath, () => {
    const read = readJsonFileWithBackup<T>(filePath);
    const next = updater(read.value);
    writeJsonFileAtomic(filePath, next, { preserveExistingBackup: read.recoveredFromBackup });
    return next;
  });
}

export interface WriteTextFileAtomicOptions {
  preserveExistingBackup?: boolean;
}

export function writeTextFileAtomic(filePath: string, value: string, options: WriteTextFileAtomicOptions = {}): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);

  const backupPath = `${filePath}.bak`;
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);

  try {
    writeFileSync(tempPath, value, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    chmodPrivateFile(tempPath);
    if (existsSync(filePath) && !options.preserveExistingBackup) {
      copyFileSync(filePath, backupPath);
      chmodPrivateFile(backupPath);
    } else if (options.preserveExistingBackup && existsSync(backupPath)) {
      chmodPrivateFile(backupPath);
    }
    renameSync(tempPath, filePath);
    chmodPrivateFile(filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodPrivateDir(dir);
}

export function chmodPrivateFile(filePath: string): void {
  try {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // Best effort on filesystems/platforms that do not support POSIX modes.
  }
}

function chmodPrivateDir(dir: string): void {
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best effort on filesystems/platforms that do not support POSIX modes.
  }
}

export function readJsonFileWithBackup<T>(filePath: string): JsonReadResult<T> {
  const primary = readJsonFile<T>(filePath);
  const primaryReadError = primary.ok ? undefined : primary.error;
  const primaryVersionError = primary.ok ? unsupportedVersionError(primary.value) : undefined;
  if (primary.ok && !primaryVersionError) {
    return { value: primary.value, recoveredFromBackup: false };
  }
  if (primaryVersionError) {
    preserveUnreadableState(filePath);
    throw new StatePersistenceError(`Cannot read state file ${filePath}: ${primaryVersionError}`, filePath, primaryVersionError);
  }

  const backupPath = `${filePath}.bak`;
  const backup = readJsonFile<T>(backupPath);
  const backupReadError = backup.ok ? undefined : backup.error;
  const backupVersionError = backup.ok ? unsupportedVersionError(backup.value) : undefined;
  if (backup.ok && !backupVersionError) {
    return {
      value: backup.value,
      recoveredFromBackup: true,
      error: primaryReadError ?? primaryVersionError,
    };
  }

  const error = primaryReadError ?? primaryVersionError ?? backupReadError ?? backupVersionError;
  if (error && existsSync(filePath)) {
    preserveUnreadableState(filePath);
  }

  if (error && existsSync(filePath)) {
    throw new StatePersistenceError(`Cannot read state file ${filePath}: ${error}`, filePath, error);
  }

  return {
    value: undefined,
    recoveredFromBackup: false,
    error,
  };
}

function preserveUnreadableState(filePath: string): void {
  const corruptPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    copyFileSync(filePath, corruptPath);
  } catch {
    // Best-effort only. The original file remains untouched.
  }
}

export function assertSupportedStatePayload(value: unknown, filePath: string): void {
  const error = unsupportedVersionError(value);
  if (error) {
    throw new StatePersistenceError(`Cannot read state file ${filePath}: ${error}`, filePath, error);
  }
}

function unsupportedVersionError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("version" in value)) {
    return undefined;
  }
  return (value as { version?: unknown }).version === 1
    ? undefined
    : `Unsupported state payload version: ${String((value as { version?: unknown }).version)}`;
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
  ensurePrivateDir(dir);
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
