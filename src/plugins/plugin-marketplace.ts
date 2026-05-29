export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  ref?: string;
  category: string;
  official: boolean;
  approved: boolean;
  author?: string;
  homepage?: string;
  repository?: string;
  packageName?: string;
  license?: string;
  tags?: string[];
  permissions?: string[];
  capabilities?: string[];
}

export interface PluginMarketplaceResponse {
  entries: PluginMarketplaceEntry[];
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
    author: "Ricardo <github@nordbyte.de>",
    homepage: "https://github.com/nordbyte/nordrelay-plugin-auto-updater",
    repository: "https://github.com/nordbyte/nordrelay-plugin-auto-updater",
    packageName: "@nordbyte/nordrelay-auto-updater",
    license: "MIT",
    tags: ["updates", "npm", "package-manager", "peers"],
    permissions: ["runtime.read", "peers.read", "system.packages.read", "system.updates.read", "network"],
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
