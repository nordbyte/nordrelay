import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectRecentWorkspaceArtifacts,
  createArtifactZipBundle,
  getArtifactTurnReport,
  listRecentArtifactReports,
  persistWorkspaceArtifactReport,
  removeArtifactTurn,
  totalArtifactSize,
  type ArtifactTurnReport,
} from "../artifacts/artifacts.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ArtifactPreviewDto, ArtifactReportDto } from "./relay-runtime-types.js";

const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

export class RelayArtifactService {
  constructor(private readonly config: ConnectorConfig) {}

  async list(workspace: string, limit = 20): Promise<ArtifactReportDto[]> {
    return (await listRecentArtifactReports(workspace, limit, this.config.maxFileSize)).map(artifactDto);
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
    const bundle = await createArtifactZipBundle(report.artifacts, report.outDir, {
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
    const extension = path.extname(artifact.name).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
      return {
        kind: "image",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
      };
    }
    if (!isPreviewableTextFile(extension, artifact.sizeBytes)) {
      return {
        kind: "unsupported",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        detail: artifact.sizeBytes > MAX_TEXT_PREVIEW_BYTES ? "File is too large for inline preview." : "File type is not previewable.",
      };
    }
    const buffer = await readFile(artifact.localPath);
    const truncated = buffer.byteLength > MAX_TEXT_PREVIEW_BYTES;
    return {
      kind: "text",
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      truncated,
      text: buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString("utf8"),
    };
  }

  async persistWorkspaceArtifactsForTurn(workspace: string, turnId: string, startedAt: Date): Promise<void> {
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
    await persistWorkspaceArtifactReport(workspace, turnId, report);
  }
}

function artifactDto(report: ArtifactTurnReport): ArtifactReportDto {
  return {
    turnId: report.turnId,
    updatedAt: report.updatedAt.toISOString(),
    source: report.source,
    fileCount: report.artifacts.length,
    totalSizeBytes: totalArtifactSize(report.artifacts),
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    artifacts: report.artifacts.map((artifact) => ({
      name: artifact.name,
      relativePath: artifact.relativePath.split(path.sep).join("/"),
      sizeBytes: artifact.sizeBytes,
    })),
  };
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
