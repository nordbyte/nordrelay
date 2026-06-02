import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const INIT_MARKETPLACE_PLUGINS = [
  {
    id: "system-monitor",
    name: "System Monitor",
    description: "CPU, memory, disk, network, and peer-aware metrics dashboard.",
  },
  {
    id: "auto-updater",
    name: "Auto Updater",
    description: "OS and global npm package update checks across peers.",
  },
  {
    id: "repovista",
    name: "RepoVista",
    description: "Run RepoVista scans and browse audit reports from the WebUI.",
  },
  {
    id: "usage-insights",
    name: "Usage Insights",
    description: "Track token usage and estimated model costs across peers.",
  },
];

let activeMarketplacePlugins = INIT_MARKETPLACE_PLUGINS;

export function setInitMarketplaceEntries(entries) {
  activeMarketplacePlugins = normalizeMarketplacePluginEntries(entries);
}

export function marketplacePluginChoices() {
  return activeMarketplacePlugins.map((entry) => ({
    value: entry.id,
    label: `${entry.name} (${entry.id})`,
    description: entry.description,
  }));
}

export function normalizeMarketplacePluginSelection(value) {
  const known = new Set(activeMarketplacePlugins.map((entry) => entry.id));
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(raw.map((item) => String(item).trim()).filter((item) => item && (!known.size || known.has(item))))];
}

export function marketplacePluginDisplay(value) {
  const selected = normalizeMarketplacePluginSelection(value);
  if (!selected.length) return "(empty)";
  const byId = new Map(activeMarketplacePlugins.map((entry) => [entry.id, entry.name || entry.id]));
  return selected.map((id) => byId.get(id) || id).join(", ");
}

export async function loadInitMarketplaceEntries(runtimeRoot) {
  const modulePath = path.join(runtimeRoot, "dist", "plugins", "plugin-marketplace.js");
  if (!fs.existsSync(modulePath)) return [];
  const mod = await import(pathToFileURL(modulePath).href);
  return typeof mod.pluginMarketplaceEntries === "function" ? mod.pluginMarketplaceEntries() : [];
}

export async function installInitialMarketplacePlugins(home, selectedIds, entries, runtimeRoot) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  if (!ids.length) return;
  const byId = new Map((entries || []).map((entry) => [entry.id, entry]));
  const service = await createPluginService(home, runtimeRoot);
  console.log(`Installing marketplace plugins: ${ids.join(", ")}`);
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) {
      console.warn(`⚠️ Marketplace plugin not found: ${id}`);
      continue;
    }
    try {
      const plugin = await service.install({
        source: entry.source,
        ref: entry.ref,
        enable: true,
        approvePermissions: entry.approved !== false,
        force: true,
      });
      console.log(`Installed and enabled marketplace plugin ${plugin.id}@${plugin.version}.`);
    } catch (error) {
      console.warn(`⚠️ Failed to install marketplace plugin ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function normalizeMarketplacePluginEntries(entries) {
  const list = Array.isArray(entries) && entries.length ? entries : INIT_MARKETPLACE_PLUGINS;
  return list
    .map((entry) => ({
      id: String(entry.id || "").trim(),
      name: String(entry.name || entry.id || "").trim(),
      description: String(entry.description || "").trim(),
    }))
    .filter((entry) => entry.id);
}

async function createPluginService(home, runtimeRoot) {
  const modulePath = path.join(runtimeRoot, "dist", "plugins", "plugin-service.js");
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing plugin runtime. Run \`npm run build\` in ${runtimeRoot}.`);
  }
  const mod = await import(pathToFileURL(modulePath).href);
  return new mod.PluginService(home, { enabled: true });
}
