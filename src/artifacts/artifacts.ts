import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Artifact {
  name: string;
  relativePath: string;
  localPath: string;
  sizeBytes: number;
  modifiedAtMs?: number;
}

export interface ArtifactReport {
  artifacts: Artifact[];
  skippedCount: number;
  omittedCount?: number;
}

export interface ArtifactTurnReport extends ArtifactReport {
  turnId: string;
  outDir: string;
  updatedAt: Date;
  totalSizeBytes: number;
  source?: "turn" | "workspace";
}

export interface ArtifactZipOptions {
  bundleName?: string;
  maxFileSize?: number;
  zipCommand?: string;
}

export interface ArtifactRetentionOptions {
  maxAgeMs?: number;
  maxTurnDirs?: number;
  maxInboxDirs?: number;
  now?: number;
  maxTotalBytes?: number;
  keepLatestTurns?: number;
  keepLatestInboxDirs?: number;
}

export interface ArtifactPruneReport {
  removedTurnDirs: number;
  removedInboxDirs: number;
  removedBytes?: number;
  planned?: ArtifactCleanupCandidate[];
}

export interface ArtifactStorageUsage {
  workspace: string;
  managedBytes: number;
  referencedBytes: number;
  totalBytes: number;
  maxTotalBytes: number;
  usagePercent: number | null;
  warnPercent: number;
  status: "ok" | "warn" | "over";
  turnDirs: number;
  inboxDirs: number;
  indexedTurns: number;
  indexedFiles: number;
  skippedFiles: number;
  oldestUpdatedAt?: string;
  newestUpdatedAt?: string;
  largestTurn?: {
    turnId: string;
    sizeBytes: number;
    updatedAt: string;
  };
}

export interface ArtifactCleanupCandidate {
  kind: "turn" | "inbox";
  id: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
  reasons: string[];
}

export interface ArtifactCleanupPlan {
  workspace: string;
  dryRun: boolean;
  usageBefore: ArtifactStorageUsage;
  usageAfter: ArtifactStorageUsage;
  candidates: ArtifactCleanupCandidate[];
  removedTurnDirs: number;
  removedInboxDirs: number;
  removedBytes: number;
}

export interface WorkspaceArtifactScanOptions {
  since: Date;
  until?: Date;
  maxFileSize?: number;
  limit?: number;
  ignoreDirs?: string[];
  ignoreGlobs?: string[];
}

interface ArtifactTurnManifest {
  version: 1;
  source: "workspace";
  turnId: string;
  outDir: string;
  updatedAt: string;
  skippedCount: number;
  omittedCount?: number;
  artifacts: Artifact[];
}

const MAX_TELEGRAM_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TURN_DIRS = 30;
const DEFAULT_MAX_INBOX_DIRS = 30;
const MAX_ARTIFACT_DEPTH = 8;
const IGNORED_PATTERNS = [/^\./, /^__pycache__$/, /\.tmp$/i, /~$/];
const WORKSPACE_ARTIFACT_IGNORED_DIRS = new Set([
  ".git",
  ".nordrelay",
  ".cache",
  ".next",
  ".pytest_cache",
  ".turbo",
  ".venv",
  ".vite",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "tmp",
  "temp",
]);

type ManagedArtifactDir = ArtifactCleanupCandidate & { updatedAtMs: number };

export async function ensureOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
}

export async function collectArtifacts(outDir: string, maxFileSize?: number): Promise<Artifact[]> {
  return (await collectArtifactReport(outDir, maxFileSize)).artifacts;
}

export async function collectArtifactReport(outDir: string, maxFileSize?: number): Promise<ArtifactReport> {
  if (!existsSync(outDir)) {
    return { artifacts: [], skippedCount: 0 };
  }

  const maxSize = maxFileSize ?? MAX_TELEGRAM_FILE_SIZE;
  const report = await collectArtifactReportFromDir(outDir, outDir, maxSize, 0);
  report.artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return report;
}

export async function collectRecentWorkspaceArtifacts(
  workspace: string,
  options: WorkspaceArtifactScanOptions,
): Promise<ArtifactReport> {
  const workspaceStat = await stat(workspace).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return { artifacts: [], skippedCount: 0 };
  }

  const report = await collectRecentWorkspaceArtifactsFromDir(
    workspace,
    workspace,
    options.since.getTime(),
    options.until?.getTime() ?? Date.now() + 1000,
    options.maxFileSize ?? MAX_TELEGRAM_FILE_SIZE,
    new Set([...(options.ignoreDirs ?? [])]),
    options.ignoreGlobs ?? [],
    0,
  );
  report.artifacts.sort((left, right) => {
    const timeDelta = (right.modifiedAtMs ?? 0) - (left.modifiedAtMs ?? 0);
    return timeDelta !== 0 ? timeDelta : left.relativePath.localeCompare(right.relativePath);
  });
  const limit = options.limit ?? 5;
  return {
    artifacts: report.artifacts.slice(0, limit),
    skippedCount: report.skippedCount,
    omittedCount: Math.max(0, report.artifacts.length - limit),
  };
}

export async function persistWorkspaceArtifactReport(
  workspace: string,
  turnId: string,
  report: ArtifactReport,
): Promise<ArtifactTurnReport | null> {
  const safeTurnId = sanitizeTurnId(turnId);
  if (!safeTurnId || (report.artifacts.length === 0 && report.skippedCount === 0 && !report.omittedCount)) {
    return null;
  }

  const turnDir = artifactTurnDir(workspace, safeTurnId);
  await mkdir(turnDir, { recursive: true });
  const manifest: ArtifactTurnManifest = {
    version: 1,
    source: "workspace",
    turnId: safeTurnId,
    outDir: workspace,
    updatedAt: new Date().toISOString(),
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    artifacts: report.artifacts,
  };
  await writeFile(artifactManifestPath(workspace, safeTurnId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    turnId: safeTurnId,
    outDir: workspace,
    updatedAt: new Date(manifest.updatedAt),
    artifacts: report.artifacts,
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    totalSizeBytes: totalArtifactSize(report.artifacts),
    source: "workspace",
  };
}

export async function listRecentArtifactReports(
  workspace: string,
  limit = 5,
  maxFileSize?: number,
): Promise<ArtifactTurnReport[]> {
  const turnsDir = artifactTurnsDir(workspace);
  const entries = await readdir(turnsDir, { withFileTypes: true }).catch(() => []);
  const reports: ArtifactTurnReport[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldIgnoreEntry(entry.name)) {
      continue;
    }

    const manifestReport = await readWorkspaceArtifactManifest(workspace, entry.name, maxFileSize);
    if (manifestReport) {
      reports.push(manifestReport);
      continue;
    }

    const outDir = path.join(turnsDir, entry.name, "out");
    const fileStat = await stat(outDir).catch(() => null);
    if (!fileStat?.isDirectory()) {
      continue;
    }

    const report = await collectArtifactReport(outDir, maxFileSize);
    if (report.artifacts.length === 0 && report.skippedCount === 0) {
      continue;
    }

    reports.push({
      turnId: entry.name,
      outDir,
      updatedAt: fileStat.mtime,
      artifacts: report.artifacts,
      skippedCount: report.skippedCount,
      omittedCount: report.omittedCount,
      totalSizeBytes: totalArtifactSize(report.artifacts),
      source: "turn",
    });
  }

  reports.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return reports.slice(0, Math.max(0, limit));
}

export async function getArtifactTurnReport(
  workspace: string,
  turnId: string,
  maxFileSize?: number,
): Promise<ArtifactTurnReport | null> {
  const safeTurnId = sanitizeTurnId(turnId);
  if (!safeTurnId) {
    return null;
  }

  const manifestReport = await readWorkspaceArtifactManifest(workspace, safeTurnId, maxFileSize);
  if (manifestReport) {
    return manifestReport;
  }

  const outDir = artifactOutDirForTurn(workspace, safeTurnId);
  const fileStat = await stat(outDir).catch(() => null);
  if (!fileStat?.isDirectory()) {
    return null;
  }

  const report = await collectArtifactReport(outDir, maxFileSize);
  if (report.artifacts.length === 0 && report.skippedCount === 0) {
    return null;
  }

  return {
    turnId: safeTurnId,
    outDir,
    updatedAt: fileStat.mtime,
    artifacts: report.artifacts,
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    totalSizeBytes: totalArtifactSize(report.artifacts),
    source: "turn",
  };
}

export async function removeArtifactTurn(workspace: string, turnId: string): Promise<boolean> {
  const safeTurnId = sanitizeTurnId(turnId);
  if (!safeTurnId) {
    return false;
  }

  const turnDir = path.join(artifactTurnsDir(workspace), safeTurnId);
  const fileStat = await stat(turnDir).catch(() => null);
  if (!fileStat?.isDirectory()) {
    return false;
  }

  await rm(turnDir, { recursive: true, force: true });
  return true;
}

export function artifactOutDirForTurn(workspace: string, turnId: string): string {
  return path.join(artifactTurnsDir(workspace), sanitizeTurnId(turnId) ?? "", "out");
}

export async function createArtifactZipBundle(
  artifacts: Artifact[],
  outDir: string,
  options: ArtifactZipOptions = {},
): Promise<Artifact | null> {
  if (artifacts.length === 0) {
    return null;
  }

  const sourcePaths = artifacts
    .map((artifact) => artifact.relativePath)
    .filter((relativePath) => relativePath && !relativePath.includes("\n"));

  if (sourcePaths.length !== artifacts.length) {
    return null;
  }

  const bundleDir = path.join(outDir, ".telegram-artifacts");
  await mkdir(bundleDir, { recursive: true });

  const bundleName = options.bundleName ?? `nordrelay-artifacts-${sanitizeZipStem(path.basename(path.dirname(outDir)))}.zip`;
  const bundlePath = path.join(bundleDir, bundleName);
  await rm(bundlePath, { force: true }).catch(() => {});

  try {
    await runZip(options.zipCommand ?? "zip", bundlePath, sourcePaths, outDir);
  } catch {
    return null;
  }

  const fileStat = await stat(bundlePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return null;
  }

  const maxFileSize = options.maxFileSize ?? MAX_TELEGRAM_FILE_SIZE;
  if (fileStat.size > maxFileSize) {
    await rm(bundlePath, { force: true }).catch(() => {});
    return null;
  }

  return {
    name: bundleName,
    relativePath: path.relative(outDir, bundlePath).split(path.sep).join("/"),
    localPath: bundlePath,
    sizeBytes: fileStat.size,
  };
}

export async function pruneConnectorTurnDirs(
  workspace: string,
  options: ArtifactRetentionOptions = {},
): Promise<ArtifactPruneReport> {
  const plan = await cleanupArtifactStorage(workspace, options, false);
  return {
    removedTurnDirs: plan.removedTurnDirs,
    removedInboxDirs: plan.removedInboxDirs,
  };
}

export async function inspectArtifactStorage(
  workspace: string,
  options: { maxTotalBytes?: number; warnPercent?: number } = {},
): Promise<ArtifactStorageUsage> {
  const reports = await listRecentArtifactReports(workspace, Number.MAX_SAFE_INTEGER);
  const turnDirs = await listManagedDirs(artifactTurnsDir(workspace), "turn");
  const inboxDirs = await listManagedDirs(artifactInboxDir(workspace), "inbox");
  const managedBytes = sumBytes([...turnDirs, ...inboxDirs]);
  const referencedBytes = sumBytes(reports.flatMap((report) => report.artifacts));
  const maxTotalBytes = options.maxTotalBytes ?? 0;
  const warnPercent = options.warnPercent ?? 80;
  const usagePercent = maxTotalBytes > 0 ? managedBytes / maxTotalBytes * 100 : null;
  const largest = reports
    .map((report) => ({ turnId: report.turnId, sizeBytes: totalArtifactSize(report.artifacts), updatedAt: report.updatedAt.toISOString() }))
    .sort((left, right) => right.sizeBytes - left.sizeBytes)[0];
  const updated = reports.map((report) => report.updatedAt.getTime()).filter((value) => Number.isFinite(value));
  const status = usagePercent === null ? "ok" : usagePercent >= 100 ? "over" : usagePercent >= warnPercent ? "warn" : "ok";
  return {
    workspace,
    managedBytes,
    referencedBytes,
    totalBytes: managedBytes,
    maxTotalBytes,
    usagePercent,
    warnPercent,
    status,
    turnDirs: turnDirs.length,
    inboxDirs: inboxDirs.length,
    indexedTurns: reports.length,
    indexedFiles: reports.reduce((total, report) => total + report.artifacts.length, 0),
    skippedFiles: reports.reduce((total, report) => total + report.skippedCount + (report.omittedCount ?? 0), 0),
    oldestUpdatedAt: updated.length ? new Date(Math.min(...updated)).toISOString() : undefined,
    newestUpdatedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : undefined,
    largestTurn: largest,
  };
}

export async function planArtifactCleanup(
  workspace: string,
  options: ArtifactRetentionOptions = {},
): Promise<ArtifactCleanupPlan> {
  return cleanupArtifactStorage(workspace, options, true);
}

export async function cleanupArtifactStorage(
  workspace: string,
  options: ArtifactRetentionOptions = {},
  dryRun = false,
): Promise<ArtifactCleanupPlan> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RETENTION_AGE_MS;
  const maxTurnDirs = options.maxTurnDirs ?? DEFAULT_MAX_TURN_DIRS;
  const maxInboxDirs = options.maxInboxDirs ?? DEFAULT_MAX_INBOX_DIRS;
  const maxTotalBytes = options.maxTotalBytes ?? 0;
  const keepLatestTurns = options.keepLatestTurns ?? 1;
  const keepLatestInboxDirs = options.keepLatestInboxDirs ?? 0;
  const usageBefore = await inspectArtifactStorage(workspace, { maxTotalBytes });
  const turnDirs = await listManagedDirs(artifactTurnsDir(workspace), "turn");
  const inboxDirs = await listManagedDirs(artifactInboxDir(workspace), "inbox");
  const candidates = new Map<string, ArtifactCleanupCandidate>();

  markRetentionCandidates(candidates, turnDirs, maxAgeMs, maxTurnDirs, keepLatestTurns, now);
  markRetentionCandidates(candidates, inboxDirs, maxAgeMs, maxInboxDirs, keepLatestInboxDirs, now);

  if (maxTotalBytes > 0) {
    let projectedBytes = usageBefore.managedBytes - sumBytes([...candidates.values()]);
    const quotaCandidates = [...turnDirs, ...inboxDirs]
      .filter((entry) => !candidates.has(entry.path))
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs);
    for (const entry of quotaCandidates) {
      if (projectedBytes <= maxTotalBytes) {
        break;
      }
      if (entry.kind === "turn" && isProtectedLatest(entry, turnDirs, keepLatestTurns)) {
        continue;
      }
      if (entry.kind === "inbox" && isProtectedLatest(entry, inboxDirs, keepLatestInboxDirs)) {
        continue;
      }
      addCleanupReason(candidates, entry, "quota");
      projectedBytes -= entry.sizeBytes;
    }
  }

  const selected = [...candidates.values()].sort((left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime());
  if (!dryRun) {
    for (const candidate of selected) {
      await rm(candidate.path, { recursive: true, force: true }).catch(() => {});
    }
  }
  const removedTurnDirs = selected.filter((candidate) => candidate.kind === "turn").length;
  const removedInboxDirs = selected.filter((candidate) => candidate.kind === "inbox").length;
  const removedBytes = sumBytes(selected);
  const usageAfter = dryRun
    ? { ...usageBefore, managedBytes: Math.max(0, usageBefore.managedBytes - removedBytes), totalBytes: Math.max(0, usageBefore.totalBytes - removedBytes) }
    : await inspectArtifactStorage(workspace, { maxTotalBytes });
  if (dryRun && usageAfter.maxTotalBytes > 0) {
    usageAfter.usagePercent = usageAfter.managedBytes / usageAfter.maxTotalBytes * 100;
    usageAfter.status = usageAfter.usagePercent >= 100 ? "over" : usageAfter.usagePercent >= usageAfter.warnPercent ? "warn" : "ok";
  }
  return {
    workspace,
    dryRun,
    usageBefore,
    usageAfter,
    candidates: selected,
    removedTurnDirs,
    removedInboxDirs,
    removedBytes,
  };
}

export function formatArtifactSummary(artifacts: Artifact[], skippedCount: number, omittedCount = 0): string {
  if (artifacts.length === 0 && skippedCount === 0 && omittedCount === 0) {
    return "";
  }

  const lines: string[] = [];
  if (artifacts.length > 0) {
    lines.push(`📎 ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} generated (${formatBytes(totalArtifactSize(artifacts))})`);
    for (const artifact of artifacts.slice(0, 5)) {
      lines.push(`- ${artifact.name} (${formatBytes(artifact.sizeBytes)})`);
    }
    if (artifacts.length > 5) {
      lines.push(`- ${artifacts.length - 5} more`);
    }
  }
  if (skippedCount > 0) {
    lines.push(`⚠️ ${skippedCount} file${skippedCount === 1 ? "" : "s"} too large to send`);
  }
  if (omittedCount > 0) {
    lines.push(`- ${omittedCount} more not shown`);
  }

  return lines.join("\n");
}

export function totalArtifactSize(artifacts: Artifact[]): number {
  return artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
}

export function telegramArtifactFilename(artifact: Artifact): string {
  return artifact.name.replace(/[\\/]+/g, "__");
}

export function isTelegramImagePreview(artifact: Artifact): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(artifact.name);
}

async function collectArtifactReportFromDir(
  currentDir: string,
  rootDir: string,
  maxFileSize: number,
  depth: number,
): Promise<ArtifactReport> {
  if (depth > MAX_ARTIFACT_DEPTH) {
    return { artifacts: [], skippedCount: 0 };
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const artifacts: Artifact[] = [];
  let skippedCount = 0;

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectArtifactReportFromDir(fullPath, rootDir, maxFileSize, depth + 1);
      artifacts.push(...nested.artifacts);
      skippedCount += nested.skippedCount;
      continue;
    }

    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isFile()) {
      continue;
    }

    if (fileStat.size > maxFileSize) {
      skippedCount += 1;
      continue;
    }

    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    artifacts.push({
      name: relativePath,
      relativePath,
      localPath: fullPath,
      sizeBytes: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
    });
  }

  return { artifacts, skippedCount };
}

async function collectRecentWorkspaceArtifactsFromDir(
  currentDir: string,
  rootDir: string,
  sinceMs: number,
  untilMs: number,
  maxFileSize: number,
  ignoreDirs: Set<string>,
  ignoreGlobs: string[],
  depth: number,
): Promise<ArtifactReport> {
  if (depth > MAX_ARTIFACT_DEPTH) {
    return { artifacts: [], skippedCount: 0 };
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const artifacts: Artifact[] = [];
  let skippedCount = 0;

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relativeEntryPath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (WORKSPACE_ARTIFACT_IGNORED_DIRS.has(entry.name) || ignoreDirs.has(entry.name) || ignoreDirs.has(relativeEntryPath)) {
        continue;
      }
      const nested = await collectRecentWorkspaceArtifactsFromDir(fullPath, rootDir, sinceMs, untilMs, maxFileSize, ignoreDirs, ignoreGlobs, depth + 1);
      artifacts.push(...nested.artifacts);
      skippedCount += nested.skippedCount;
      continue;
    }

    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isFile()) {
      continue;
    }
    if (fileStat.mtimeMs < sinceMs || fileStat.mtimeMs > untilMs) {
      continue;
    }
    if (fileStat.size > maxFileSize) {
      skippedCount += 1;
      continue;
    }

    const relativePath = path.relative(rootDir, fullPath).split(path.sep).join("/");
    if (ignoreGlobs.some((pattern) => matchesGlob(relativePath, pattern))) {
      continue;
    }
    artifacts.push({
      name: relativePath,
      relativePath,
      localPath: fullPath,
      sizeBytes: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
    });
  }

  return { artifacts, skippedCount };
}

async function pruneChildDirs(
  rootDir: string,
  options: { maxAgeMs: number; maxDirs: number; now: number },
): Promise<number> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const dirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldIgnoreEntry(entry.name)) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    const fileStat = await stat(fullPath).catch(() => null);
    if (fileStat?.isDirectory()) {
      dirs.push({ fullPath, mtimeMs: fileStat.mtimeMs });
    }
  }

  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let removed = 0;

  for (const [index, dir] of dirs.entries()) {
    const expired = options.now - dir.mtimeMs > options.maxAgeMs;
    const aboveLimit = index >= options.maxDirs;
    if (!expired && !aboveLimit) {
      continue;
    }

    await rm(dir.fullPath, { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }

  return removed;
}

async function listManagedDirs(rootDir: string, kind: "turn" | "inbox"): Promise<ManagedArtifactDir[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const dirs: ManagedArtifactDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldIgnoreEntry(entry.name)) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isDirectory()) {
      continue;
    }
    dirs.push({
      kind,
      id: entry.name,
      path: fullPath,
      sizeBytes: await directorySize(fullPath),
      updatedAt: fileStat.mtime.toISOString(),
      updatedAtMs: fileStat.mtimeMs,
      reasons: [],
    });
  }
  dirs.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return dirs;
}

async function directorySize(rootDir: string): Promise<number> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat) {
      continue;
    }
    if (fileStat.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (fileStat.isFile()) {
      total += fileStat.size;
    }
  }
  return total;
}

function markRetentionCandidates(
  candidates: Map<string, ArtifactCleanupCandidate>,
  dirs: ManagedArtifactDir[],
  maxAgeMs: number,
  maxDirs: number,
  keepLatest: number,
  now: number,
): void {
  for (const [index, dir] of dirs.entries()) {
    if (index < keepLatest) {
      continue;
    }
    if (now - dir.updatedAtMs > maxAgeMs) {
      addCleanupReason(candidates, dir, "retention-age");
    }
    if (index >= maxDirs) {
      addCleanupReason(candidates, dir, "retention-count");
    }
  }
}

function addCleanupReason(
  candidates: Map<string, ArtifactCleanupCandidate>,
  dir: ManagedArtifactDir,
  reason: string,
): void {
  const existing = candidates.get(dir.path);
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
    return;
  }
  candidates.set(dir.path, {
    kind: dir.kind,
    id: dir.id,
    path: dir.path,
    sizeBytes: dir.sizeBytes,
    updatedAt: dir.updatedAt,
    reasons: [reason],
  });
}

function isProtectedLatest(dir: ManagedArtifactDir, dirs: ManagedArtifactDir[], keepLatest: number): boolean {
  return keepLatest > 0 && dirs.slice(0, keepLatest).some((candidate) => candidate.path === dir.path);
}

function sumBytes(values: Array<{ sizeBytes: number }>): number {
  return values.reduce((total, value) => total + value.sizeBytes, 0);
}

function shouldIgnoreEntry(name: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(name));
}

function artifactTurnsDir(workspace: string): string {
  return path.join(workspace, ".nordrelay", "turns");
}

function artifactInboxDir(workspace: string): string {
  return path.join(workspace, ".nordrelay", "inbox");
}

function artifactTurnDir(workspace: string, turnId: string): string {
  return path.join(artifactTurnsDir(workspace), turnId);
}

function artifactManifestPath(workspace: string, turnId: string): string {
  return path.join(artifactTurnDir(workspace, turnId), "manifest.json");
}

async function readWorkspaceArtifactManifest(
  workspace: string,
  turnId: string,
  maxFileSize?: number,
): Promise<ArtifactTurnReport | null> {
  const safeTurnId = sanitizeTurnId(turnId);
  if (!safeTurnId) {
    return null;
  }

  const manifest = await readArtifactTurnManifest(artifactManifestPath(workspace, safeTurnId)).catch(() => null);
  if (!manifest || manifest.source !== "workspace") {
    return null;
  }

  const normalized = await normalizeManifestArtifacts(workspace, manifest, maxFileSize ?? MAX_TELEGRAM_FILE_SIZE);
  if (normalized.artifacts.length === 0 && normalized.skippedCount === 0 && !normalized.omittedCount) {
    return null;
  }

  return {
    turnId: safeTurnId,
    outDir: workspace,
    updatedAt: parseDate(manifest.updatedAt) ?? new Date(0),
    artifacts: normalized.artifacts,
    skippedCount: normalized.skippedCount,
    omittedCount: normalized.omittedCount,
    totalSizeBytes: totalArtifactSize(normalized.artifacts),
    source: "workspace",
  };
}

async function readArtifactTurnManifest(filePath: string): Promise<ArtifactTurnManifest | null> {
  const payload = JSON.parse(await readFile(filePath, "utf8")) as Partial<ArtifactTurnManifest>;
  if (payload.version !== 1 || payload.source !== "workspace" || !Array.isArray(payload.artifacts)) {
    return null;
  }
  return {
    version: 1,
    source: "workspace",
    turnId: typeof payload.turnId === "string" ? payload.turnId : path.basename(path.dirname(filePath)),
    outDir: typeof payload.outDir === "string" ? payload.outDir : "",
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date(0).toISOString(),
    skippedCount: typeof payload.skippedCount === "number" ? payload.skippedCount : 0,
    omittedCount: typeof payload.omittedCount === "number" ? payload.omittedCount : 0,
    artifacts: payload.artifacts,
  };
}

async function normalizeManifestArtifacts(
  workspace: string,
  manifest: ArtifactTurnManifest,
  maxFileSize: number,
): Promise<ArtifactReport> {
  const workspaceRoot = path.resolve(workspace);
  const artifacts: Artifact[] = [];
  let skippedCount = manifest.skippedCount;

  for (const artifact of manifest.artifacts) {
    const relativePath = normalizeRelativePath(artifact.relativePath || artifact.name);
    if (!relativePath) {
      skippedCount += 1;
      continue;
    }

    const localPath = path.resolve(workspaceRoot, relativePath);
    if (!isPathInside(localPath, workspaceRoot)) {
      skippedCount += 1;
      continue;
    }

    const fileStat = await stat(localPath).catch(() => null);
    if (!fileStat?.isFile()) {
      skippedCount += 1;
      continue;
    }
    if (fileStat.size > maxFileSize) {
      skippedCount += 1;
      continue;
    }

    artifacts.push({
      name: relativePath,
      relativePath,
      localPath,
      sizeBytes: fileStat.size,
      modifiedAtMs: fileStat.mtimeMs,
    });
  }

  return {
    artifacts,
    skippedCount,
    omittedCount: manifest.omittedCount,
  };
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.split(/[\\/]+/).filter(Boolean).join("/");
  if (!normalized || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  return normalized;
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sanitizeTurnId(turnId: string): string | null {
  const trimmed = turnId.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function runZip(zipCommand: string, bundlePath: string, sourcePaths: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(zipCommand, ["-q", "-@", bundlePath], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `zip exited with code ${code}`));
      }
    });

    child.stdin.end(`${sourcePaths.join("\n")}\n`);
  });
}

function sanitizeZipStem(stem: string): string {
  const cleaned = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "turn";
}

function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
