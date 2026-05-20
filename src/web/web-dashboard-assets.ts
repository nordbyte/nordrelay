import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const clientSources = [
  "client/core/api-routes.generated.js",
  "client/core/api-client.ts",
  "client/core/runtime.ts",
  "client/core/components.ts",
  "client/core/pagers.ts",
  "client/profile.ts",
  "client/header-target.ts",
  "client/overview.ts",
  "client/events.ts",
  "client/workflows.ts",
  "client/jobs.ts",
  "client/metrics.ts",
  "client/settings-panel.ts",
  "client/admin-core.ts",
  "client/admin-monitor.ts",
  "client/admin-access.ts",
  "client/admin-logs.ts",
  "client/admin-adapters.ts",
  "client/admin-version.ts",
  "client/admin-peers.ts",
  "client/diagnostics.ts",
  "client/queue-planner.ts",
  "client/workflow-builder.ts",
  "client/workflows-page.ts",
  "client/users.ts",
  "client/settings-wizard.ts",
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
  brotliPath?: string;
  gzipPath?: string;
}

const staticAssetTypes: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "favicon.png": "image/png",
  "logo.png": "image/png",
  "manifest.webmanifest": "application/manifest+json; charset=utf-8",
  "service-worker.js": "application/javascript; charset=utf-8",
};

export function dashboardStaticAsset(assetName: string): DashboardStaticAsset | null {
  const contentType = staticAssetTypes[assetName];
  if (!contentType) {
    return null;
  }
  const filePath = dashboardStaticAssetPath(assetName);
  return filePath ? { filePath, contentType } : null;
}

export function dashboardBundleAsset(assetName: "dashboard.css" | "dashboard.js"): DashboardStaticAsset | null {
  const contentType = assetName === "dashboard.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  return existsSync(builtAsset) ? { filePath: builtAsset, contentType, ...compressedAssetPaths(builtAsset) } : null;
}

function readDashboardAsset(assetName: string, sourceFiles: string[]): string {
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return readFileSync(builtAsset, "utf8");
  }

  const sourceDir = path.join(moduleDir, "ui");
  const source = sourceFiles
    .map((file) => readFileSync(path.join(sourceDir, file), "utf8"))
    .join("\n");
  return assetName === "dashboard.js" ? transformDashboardJsSource(source) : source;
}

function transformDashboardJsSource(source: string): string {
  try {
    const { transformSync } = require("esbuild") as typeof import("esbuild");
    const transformed = transformSync(source, {
      loader: "ts",
      format: "iife",
      legalComments: "none",
      minify: false,
      sourcefile: "dashboard.js",
      target: "es2022",
    }).code;
    return `${transformed}\n/* NordRelay dashboard source snapshot\n${source.replaceAll("*/", "* /")}\n*/\n`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Dashboard source fallback requires esbuild. Run npm run build first. ${detail}`);
  }
}

function dashboardStaticAssetPath(assetName: string): string | null {
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return builtAsset;
  }

  const sourceAsset = path.join(moduleDir, "ui", "assets", assetName);
  return existsSync(sourceAsset) ? sourceAsset : null;
}

function compressedAssetPaths(filePath: string): Pick<DashboardStaticAsset, "brotliPath" | "gzipPath"> {
  return {
    brotliPath: existsSync(`${filePath}.br`) ? `${filePath}.br` : undefined,
    gzipPath: existsSync(`${filePath}.gz`) ? `${filePath}.gz` : undefined,
  };
}
