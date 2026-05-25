import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface DashboardAssetBundle {
  name: "dashboard.css" | "dashboard.js";
  loader: "css" | "ts";
  sources: string[];
}

interface DashboardStaticAssetManifestEntry {
  name: string;
  contentType: string;
}

interface DashboardAssetManifest {
  bundles: DashboardAssetBundle[];
  staticAssets: DashboardStaticAssetManifestEntry[];
}

const assetManifest = readDashboardAssetManifest();
const bundleSources = new Map(assetManifest.bundles.map((bundle) => [bundle.name, bundle.sources]));

export function dashboardJs(): string {
  return readDashboardAsset("dashboard.js");
}

export function dashboardCss(): string {
  return readDashboardAsset("dashboard.css");
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

const staticAssetTypes: Record<string, string> = Object.fromEntries(
  assetManifest.staticAssets.map((asset) => [asset.name, asset.contentType]),
);

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

function readDashboardAsset(assetName: "dashboard.css" | "dashboard.js"): string {
  const builtAsset = path.resolve(moduleDir, "..", "webui-assets", assetName);
  if (existsSync(builtAsset)) {
    return readFileSync(builtAsset, "utf8");
  }

  const sourceFiles = bundleSources.get(assetName);
  if (!sourceFiles) {
    throw new Error(`Dashboard asset manifest does not define ${assetName}`);
  }
  const sourceDir = path.join(moduleDir, "ui");
  const source = sourceFiles
    .map((file) => readFileSync(path.join(sourceDir, file), "utf8"))
    .join("\n");
  return assetName === "dashboard.js" ? transformDashboardJsSource(source) : source;
}

function readDashboardAssetManifest(): DashboardAssetManifest {
  const builtManifest = path.resolve(moduleDir, "..", "webui-assets", "asset-manifest.json");
  const sourceManifest = path.join(moduleDir, "ui", "asset-manifest.json");
  const manifestPath = existsSync(builtManifest) ? builtManifest : sourceManifest;
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as DashboardAssetManifest;
  if (!Array.isArray(parsed.bundles) || !Array.isArray(parsed.staticAssets)) {
    throw new Error(`Invalid dashboard asset manifest: ${manifestPath}`);
  }
  return parsed;
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
