import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  cleanupArtifactStorage,
  collectRecentWorkspaceArtifacts,
  createArtifactZipBundle,
  getArtifactTurnReport,
  inspectArtifactStorage,
  listRecentArtifactReports,
  planArtifactCleanup,
  persistWorkspaceArtifactReport,
  removeArtifactTurn,
  totalArtifactSize,
  type ArtifactCleanupPlan,
  type ArtifactProvenance,
  type ArtifactStorageUsage,
  type ArtifactTurnReport,
} from "../artifacts/artifacts.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ArtifactCleanupDto, ArtifactDiffDto, ArtifactPreviewDto, ArtifactReportDto, ArtifactUsageDto } from "./relay-runtime-types.js";

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_DIFF_PREVIEW_BYTES = 256 * 1024;

export class RelayArtifactService {
  constructor(private readonly config: ConnectorConfig) {}

  async list(workspace: string, limit = 20): Promise<ArtifactReportDto[]> {
    return (await listRecentArtifactReports(workspace, limit, this.config.maxFileSize)).map((report) => artifactDto(report, this.config));
  }

  async get(workspace: string, turnId: string): Promise<ArtifactTurnReport | null> {
    return getArtifactTurnReport(workspace, turnId, this.config.maxFileSize);
  }

  async delete(workspace: string, turnId: string): Promise<boolean> {
    return removeArtifactTurn(workspace, turnId);
  }

  async createZip(workspace: string, turnId: string): Promise<{ path: string; name: string } | null> {
    const report = await this.get(workspace, turnId);
    if (!report) {
      return null;
    }
    const artifacts = report.artifacts.filter((artifact) => safeAssessment(artifact.relativePath, this.config.artifactSafeFilePolicy).safeStatus !== "blocked");
    if (artifacts.length === 0) {
      return null;
    }
    const bundle = await createArtifactZipBundle(artifacts, report.outDir, {
      maxFileSize: this.config.maxFileSize,
      bundleName: `nordrelay-artifacts-${turnId}.zip`,
    });
    return bundle ? { path: bundle.localPath, name: bundle.name } : null;
  }

  async preview(workspace: string, turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> {
    const report = await this.get(workspace, turnId);
    const artifact = report?.artifacts.find((candidate) => candidate.relativePath.split(path.sep).join("/") === relativePath);
    if (!artifact) {
      return null;
    }
    const safe = safeAssessment(artifact.relativePath, this.config.artifactSafeFilePolicy);
    if (safe.safeStatus === "blocked") {
      return {
        kind: "unsupported",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        language: languageForExtension(path.extname(artifact.name).toLowerCase()),
        detail: "Safe-file policy blocks inline preview for this artifact.",
        ...safe,
      };
    }
    const extension = path.extname(artifact.name).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
      return {
        kind: "image",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        language: languageForExtension(extension),
        ...safe,
      };
    }
    if (!isPreviewableTextFile(extension, artifact.sizeBytes)) {
      return {
        kind: "unsupported",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        language: languageForExtension(extension),
        ...safe,
        detail: artifact.sizeBytes > MAX_TEXT_PREVIEW_BYTES ? "File is too large for inline preview." : "File type is not previewable.",
      };
    }
    const buffer = await readFile(artifact.localPath);
    const truncated = buffer.byteLength > MAX_TEXT_PREVIEW_BYTES;
    const text = buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString("utf8");
    return {
      kind: "text",
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      language: languageForExtension(extension),
      lineCount: text.split("\n").length,
      truncated,
      text,
      ...safe,
    };
  }

  async diff(workspace: string, turnId: string, relativePath: string): Promise<ArtifactDiffDto | null> {
    const report = await this.get(workspace, turnId);
    const artifact = report?.artifacts.find((candidate) => candidate.relativePath.split(path.sep).join("/") === relativePath);
    if (!artifact) {
      return null;
    }
    if (report?.source !== "workspace") {
      return {
        kind: "unavailable",
        name: artifact.name,
        relativePath,
        detail: "Diffs are available for workspace artifacts tracked by Git.",
      };
    }
    const diff = await gitDiff(workspace, relativePath);
    if (!diff.trim()) {
      return {
        kind: "unavailable",
        name: artifact.name,
        relativePath,
        detail: "No Git diff is available for this file.",
      };
    }
    const truncated = Buffer.byteLength(diff) > MAX_DIFF_PREVIEW_BYTES;
    return {
      kind: "diff",
      name: artifact.name,
      relativePath,
      text: diff.slice(0, MAX_DIFF_PREVIEW_BYTES),
      truncated,
    };
  }

  async usage(workspace: string): Promise<ArtifactUsageDto> {
    return artifactUsageDto(await inspectArtifactStorage(workspace, {
      maxTotalBytes: this.config.artifactMaxTotalBytes,
      warnPercent: this.config.artifactWarnPercent,
    }));
  }

  async cleanupPreview(workspace: string): Promise<ArtifactCleanupDto> {
    return artifactCleanupDto(await planArtifactCleanup(workspace, this.cleanupOptions()));
  }

  async cleanupRun(workspace: string): Promise<ArtifactCleanupDto> {
    return artifactCleanupDto(await cleanupArtifactStorage(workspace, this.cleanupOptions(), false));
  }

  async persistWorkspaceArtifactsForTurn(workspace: string, turnId: string, startedAt: Date, provenance?: ArtifactProvenance): Promise<void> {
    const report = await collectRecentWorkspaceArtifacts(workspace, {
      since: startedAt,
      until: new Date(),
      maxFileSize: this.config.maxFileSize,
      limit: 20,
      ignoreDirs: this.config.artifactIgnoreDirs,
      ignoreGlobs: this.config.artifactIgnoreGlobs,
    });
    if (report.artifacts.length === 0 && report.skippedCount === 0 && !report.omittedCount) {
      return;
    }
    await persistWorkspaceArtifactReport(workspace, turnId, report, {
      ...provenance,
      workspace: provenance?.workspace ?? workspace,
      turnStartedAt: provenance?.turnStartedAt ?? startedAt.toISOString(),
    });
    if (this.config.artifactMaxTotalBytes > 0 || this.config.artifactRetentionDays > 0) {
      await cleanupArtifactStorage(workspace, this.cleanupOptions(), false);
    }
  }

  private cleanupOptions() {
    return {
      maxAgeMs: this.config.artifactRetentionDays * 24 * 60 * 60 * 1000,
      maxTurnDirs: this.config.artifactMaxTurnDirs,
      maxInboxDirs: this.config.artifactMaxInboxDirs,
      maxTotalBytes: this.config.artifactMaxTotalBytes,
    };
  }
}

function artifactDto(report: ArtifactTurnReport, config: ConnectorConfig): ArtifactReportDto {
  const provenance = report.provenance ?? {
    source: report.source,
    threadId: report.turnId,
    workspace: report.outDir,
  };
  return {
    turnId: report.turnId,
    updatedAt: report.updatedAt.toISOString(),
    source: report.source,
    fileCount: report.artifacts.length,
    totalSizeBytes: totalArtifactSize(report.artifacts),
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    artifacts: report.artifacts.map((artifact) => {
      const relativePath = artifact.relativePath.split(path.sep).join("/");
      return {
        name: artifact.name,
        relativePath,
        sizeBytes: artifact.sizeBytes,
        ...safeAssessment(relativePath, config.artifactSafeFilePolicy),
      };
    }),
    provenance,
  };
}

function safeAssessment(relativePath: string, policy: ConnectorConfig["artifactSafeFilePolicy"]): { safeStatus: "ok" | "warn" | "blocked"; safeWarnings?: string[] } {
  if (policy === "off") return { safeStatus: "ok" };
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  const warnings = [];
  if (/(^|\/)\.env(\.|$|\/)/.test(normalized) || normalized.endsWith("/.env")) warnings.push("environment file");
  if (/(^|\/)(id_rsa|id_dsa|id_ed25519|known_hosts)$/.test(normalized)) warnings.push("SSH credential path");
  if (/\.(pem|key|p12|pfx|kdbx)$/.test(normalized)) warnings.push("key or certificate file");
  if (/(secret|secrets|credential|credentials|token|tokens)/.test(normalized)) warnings.push("secret-like path");
  if (warnings.length === 0) return { safeStatus: "ok" };
  return { safeStatus: policy === "block" ? "blocked" : "warn", safeWarnings: warnings };
}

function isPreviewableTextFile(extension: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_TEXT_PREVIEW_BYTES * 4) {
    return false;
  }
  return [
    "",
    ".c",
    ".conf",
    ".cpp",
    ".css",
    ".csv",
    ".env",
    ".go",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ].includes(extension);
}

function languageForExtension(extension: string): string | undefined {
  const map: Record<string, string> = {
    ".c": "c",
    ".conf": "conf",
    ".cpp": "cpp",
    ".css": "css",
    ".csv": "csv",
    ".env": "dotenv",
    ".go": "go",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".log": "log",
    ".md": "markdown",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sh": "shell",
    ".sql": "sql",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".txt": "text",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
  };
  return map[extension];
}

function artifactUsageDto(usage: ArtifactStorageUsage): ArtifactUsageDto {
  return usage;
}

function artifactCleanupDto(plan: ArtifactCleanupPlan): ArtifactCleanupDto {
  return plan;
}

function gitDiff(workspace: string, relativePath: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--", relativePath], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
  });
}
