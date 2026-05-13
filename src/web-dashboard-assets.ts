import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const clientSources = [
  "client/foundation.js",
  "client/events.js",
  "client/workflows.js",
  "client/admin.js",
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

function readDashboardAsset(assetName: string, sourceFiles: string[]): string {
  const builtAsset = path.join(moduleDir, "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return readFileSync(builtAsset, "utf8");
  }

  const sourceDir = path.join(moduleDir, "webui");
  return sourceFiles
    .map((file) => readFileSync(path.join(sourceDir, file), "utf8"))
    .join("\n");
}
