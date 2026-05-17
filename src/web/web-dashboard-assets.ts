import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const clientSources = [
  "client/core/api-routes.generated.js",
  "client/core/api-client.js",
  "client/core/runtime.js",
  "client/core/components.js",
  "client/profile.js",
  "client/overview.js",
  "client/events.js",
  "client/workflows.js",
  "client/jobs.js",
  "client/metrics.js",
  "client/admin.js",
  "client/queue-planner.js",
  "client/workflows-page.js",
  "client/users.js",
  "client/settings-wizard.js",
];

const styleSources = [
  "styles/theme.css",
  "styles/components.css",
  "styles/layout.css",
  "styles/responsive.css",
];

export function dashboardJs(): string {
  return readDashboardAsset("dashboard.js", clientSources);
}

export function dashboardCss(): string {
  return readDashboardAsset("dashboard.css", styleSources);
}

export function dashboardAssetVersion(): string {
  return createHash("sha256")
    .update(dashboardCss())
    .update("\n")
    .update(dashboardJs())
    .digest("hex")
    .slice(0, 12);
}

export interface DashboardStaticAsset {
  filePath: string;
  contentType: string;
}

const staticAssetTypes: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "favicon.png": "image/png",
  "logo.png": "image/png",
};

export function dashboardStaticAsset(assetName: string): DashboardStaticAsset | null {
  const contentType = staticAssetTypes[assetName];
  if (!contentType) {
    return null;
  }
  const filePath = dashboardStaticAssetPath(assetName);
  return filePath ? { filePath, contentType } : null;
}

function readDashboardAsset(assetName: string, sourceFiles: string[]): string {
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return readFileSync(builtAsset, "utf8");
  }

  const sourceDir = path.join(moduleDir, "ui");
  return sourceFiles
    .map((file) => readFileSync(path.join(sourceDir, file), "utf8"))
    .join("\n");
}

function dashboardStaticAssetPath(assetName: string): string | null {
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return builtAsset;
  }

  const sourceAsset = path.join(moduleDir, "ui", "assets", assetName);
  return existsSync(sourceAsset) ? sourceAsset : null;
}
