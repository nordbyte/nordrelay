#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const minifyAssets = process.env.NORDRELAY_WEBUI_MINIFY !== "false";
const uiRoot = path.join(root, "src", "web", "ui");
const manifest = JSON.parse(readFileSync(path.join(uiRoot, "asset-manifest.json"), "utf8"));

const assets = manifest.bundles || [];
const staticAssets = manifest.staticAssets || [];
const assetHash = createHash("sha256");
const bundleBodies = new Map();

for (const asset of assets) {
  const source = asset.sources
    .map((source) => readFileSync(path.join(uiRoot, source), "utf8").trimEnd())
    .join("\n\n") + "\n";
  const body = transformSync(source, {
    loader: asset.loader,
    format: asset.name.endsWith(".js") ? "iife" : undefined,
    legalComments: "none",
    minify: minifyAssets,
    sourcefile: asset.name,
    target: asset.name.endsWith(".js") ? "es2022" : "chrome100",
  }).code;

  if (!body.trim()) {
    throw new Error(`WebUI asset ${asset.name} is empty`);
  }
  assetHash.update(asset.name);
  assetHash.update("\0");
  assetHash.update(body);
  assetHash.update("\0");
  bundleBodies.set(asset.name, body);

  if (!checkOnly) {
    const outDir = path.join(root, "dist", "webui-assets");
    const outPath = path.join(outDir, asset.name);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, body, "utf8");
    writeFileSync(`${outPath}.gz`, gzipSync(body, { level: 9 }));
    writeFileSync(`${outPath}.br`, brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }));
  }
}

for (const asset of staticAssets) {
  const assetName = typeof asset === "string" ? asset : asset.name;
  const sourcePath = path.join(root, "src", "web", "ui", "assets", assetName);
  if (!existsSync(sourcePath)) {
    throw new Error(`WebUI static asset is missing: ${sourcePath}`);
  }
  const source = readFileSync(sourcePath);
  assetHash.update(assetName);
  assetHash.update("\0");
  assetHash.update(source);
  assetHash.update("\0");
  if (!checkOnly) {
    const outDir = path.join(root, "dist", "webui-assets");
    mkdirSync(outDir, { recursive: true });
    if (assetName === "service-worker.js") {
      const cacheVersion = assetHash.copy().digest("hex").slice(0, 16);
      const webuiAssetVersion = createHash("sha256")
        .update(bundleBodies.get("dashboard.css") || "")
        .update("\n")
        .update(bundleBodies.get("dashboard.js") || "")
        .digest("hex")
        .slice(0, 12);
      const serviceWorker = source.toString("utf8");
      if (!serviceWorker.includes("__NORDRELAY_WEBUI_CACHE_VERSION__")) {
        throw new Error("WebUI service worker is missing the cache version placeholder.");
      }
      if (!serviceWorker.includes("__NORDRELAY_WEBUI_ASSET_VERSION__")) {
        throw new Error("WebUI service worker is missing the asset version placeholder.");
      }
      writeFileSync(
        path.join(outDir, assetName),
        serviceWorker
          .replaceAll("__NORDRELAY_WEBUI_CACHE_VERSION__", cacheVersion)
          .replaceAll("__NORDRELAY_WEBUI_ASSET_VERSION__", webuiAssetVersion),
        "utf8",
      );
    } else {
      copyFileSync(sourcePath, path.join(outDir, assetName));
    }
  }
}

if (!checkOnly) {
  const outDir = path.join(root, "dist", "webui-assets");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Built ${minifyAssets ? "minified " : ""}WebUI assets.`);
}
