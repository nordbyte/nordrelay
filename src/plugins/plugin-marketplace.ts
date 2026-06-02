import { detectLatestNpmVersion } from "../support/operations.js";
import type { PluginTrustLevel } from "./plugin-types.js";

export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  ref?: string;
  category: string;
  official: boolean;
  approved: boolean;
  trustLevel: PluginTrustLevel;
  signatureRequired?: boolean;
  verifiedSource?: string;
  expectedManifestHash?: string;
  expectedPackageHash?: string;
  signaturePublicKeyId?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  packageName?: string;
  license?: string;
  tags?: string[];
  permissions?: string[];
  capabilities?: string[];
  latestVersion?: string;
  latestVersionError?: string;
  latestVersionCheckedAt?: string;
}

export interface PluginMarketplaceResponse {
  entries: PluginMarketplaceEntry[];
}

export interface PluginMarketplaceVersionOptions {
  forceRefresh?: boolean;
}

const MARKETPLACE_ENTRIES: PluginMarketplaceEntry[] = [
  {
    id: "system-monitor",
    name: "System Monitor",
    description: "Tracks CPU, memory, disk, and network usage across nodes and renders a peer-aware monitoring panel.",
    source: "github:nordbyte/nordrelay-plugin-system-monitor",
    category: "Monitoring",
    official: true,
    approved: true,
    trustLevel: "official",
    signatureRequired: false,
    verifiedSource: "github:nordbyte/nordrelay-plugin-system-monitor",
    author: "Ricardo <github@nordbyte.de>",
    homepage: "https://github.com/nordbyte/nordrelay-plugin-system-monitor",
    repository: "https://github.com/nordbyte/nordrelay-plugin-system-monitor",
    packageName: "@nordbyte/nordrelay-system-monitor",
    license: "MIT",
    tags: ["metrics", "peers", "monitoring"],
    permissions: ["runtime.read", "peers.read", "system.metrics.read"],
    capabilities: ["collector", "commands", "web panel", "diagnostics"],
  },
  {
    id: "auto-updater",
    name: "Auto Updater",
    description: "Checks Linux/macOS package-manager updates and global npm package versions across peers.",
    source: "github:nordbyte/nordrelay-plugin-auto-updater",
    category: "Operations",
    official: true,
    approved: true,
    trustLevel: "official",
    signatureRequired: false,
    verifiedSource: "github:nordbyte/nordrelay-plugin-auto-updater",
    author: "Ricardo <github@nordbyte.de>",
    homepage: "https://github.com/nordbyte/nordrelay-plugin-auto-updater",
    repository: "https://github.com/nordbyte/nordrelay-plugin-auto-updater",
    packageName: "@nordbyte/nordrelay-auto-updater",
    license: "MIT",
    tags: ["updates", "npm", "package-manager", "peers"],
    permissions: ["runtime.read", "peers.read", "system.packages.read", "system.packages.write", "system.updates.read", "system.updates.write", "network"],
    capabilities: ["collector", "commands", "web panel", "diagnostics"],
  },
  {
    id: "repovista",
    name: "RepoVista",
    description: "Runs RepoVista scans, tracks live status, and browses generated audit reports across peers.",
    source: "npm:@nordbyte/nordrelay-repovista",
    category: "Code Quality",
    official: true,
    approved: true,
    trustLevel: "official",
    signatureRequired: false,
    verifiedSource: "npm:@nordbyte/nordrelay-repovista",
    author: "Ricardo <github@nordbyte.de>",
    homepage: "https://github.com/nordbyte/nordrelay-plugin-repovista",
    repository: "https://github.com/nordbyte/nordrelay-plugin-repovista",
    packageName: "@nordbyte/nordrelay-repovista",
    license: "MIT",
    tags: ["repovista", "reports", "audit", "code-quality"],
    permissions: ["runtime.read", "peers.read", "files.read", "files.write", "network"],
    capabilities: ["commands", "web panel", "diagnostics"],
  },
  {
    id: "usage-insights",
    name: "Usage Insights",
    description: "Tracks token usage and estimated model costs across sessions, providers, models, and peers.",
    source: "github:nordbyte/nordrelay-plugin-usage-insights",
    category: "Analytics",
    official: true,
    approved: true,
    trustLevel: "official",
    signatureRequired: false,
    verifiedSource: "github:nordbyte/nordrelay-plugin-usage-insights",
    author: "Ricardo <github@nordbyte.de>",
    homepage: "https://github.com/nordbyte/nordrelay-plugin-usage-insights",
    repository: "https://github.com/nordbyte/nordrelay-plugin-usage-insights",
    packageName: "@nordbyte/nordrelay-usage-insights",
    license: "MIT",
    tags: ["usage", "tokens", "costs", "analytics", "peers"],
    permissions: ["runtime.read", "usage.read", "peers.read", "network"],
    capabilities: ["collector", "commands", "web panel", "diagnostics"],
  },
];

export function pluginMarketplaceEntries(): PluginMarketplaceEntry[] {
  return MARKETPLACE_ENTRIES.map((entry) => ({
    ...entry,
    tags: [...(entry.tags ?? [])],
    permissions: [...(entry.permissions ?? [])],
    capabilities: [...(entry.capabilities ?? [])],
  }));
}

export async function pluginMarketplaceEntriesWithVersions(
  options: PluginMarketplaceVersionOptions = {},
): Promise<PluginMarketplaceEntry[]> {
  const checkedAt = new Date().toISOString();
  return Promise.all(pluginMarketplaceEntries().map(async (entry) => {
    if (!entry.packageName) {
      return entry;
    }
    const latest = await detectLatestNpmVersion(entry.packageName, {
      forceRefresh: options.forceRefresh,
    });
    return {
      ...entry,
      latestVersion: latest.version ?? undefined,
      latestVersionError: latest.error,
      latestVersionCheckedAt: checkedAt,
    };
  }));
}
