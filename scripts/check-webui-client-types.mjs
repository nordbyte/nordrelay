#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const globals = read("src/web/ui/client/webui-globals.d.ts");
const coreTypes = read("src/web/ui/client/core/webui-types.d.ts");
assert(!globals.includes("declare const state: any"), "WebUI state must use DashboardState, not any.");
assert(!/declare const \w+Pager: any/.test(globals), "WebUI pagers must use WebuiPager, not any.");
assert(!/declare var \w+: \(\.\.\.args: any\[\]\)/.test(globals), "WebUI globals should not expose broad (...args: any[]) declarations.");
assert(!/\bany\b/.test(globals), "WebUI global declarations should avoid any.");
assert(coreTypes.includes("interface DashboardState"), "WebUI core types must declare DashboardState.");

const buildScript = read("scripts/build-web-assets.mjs");
const runtimeAssets = read("src/web/web-dashboard-assets.ts");
const expectedSources = [
  "admin-core.ts",
  "admin-monitor.ts",
  "admin-access.ts",
  "admin-logs.ts",
  "admin-adapters.ts",
  "admin-version.ts",
  "admin-peers.ts",
];

for (const source of expectedSources) {
  assert(buildScript.includes(source), `WebUI build is missing ${source}.`);
  assert(runtimeAssets.includes(source), `WebUI runtime asset list is missing ${source}.`);
}

const adminMarker = read("src/web/ui/client/admin.ts").trim();
assert(adminMarker.length < 120, "src/web/ui/client/admin.ts should remain a split-module marker only.");

for (const file of [
  "src/web/ui/client/core/runtime.ts",
  "src/web/ui/client/admin-core.ts",
  "src/web/ui/client/admin-monitor.ts",
  "src/web/ui/client/admin-access.ts",
  "src/web/ui/client/admin-logs.ts",
  "src/web/ui/client/admin-adapters.ts",
  "src/web/ui/client/admin-version.ts",
  "src/web/ui/client/admin-peers.ts",
]) {
  assert(!read(file).includes("@ts-nocheck"), `${file} must not disable TypeScript checking.`);
}
