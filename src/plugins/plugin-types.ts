export type PluginSourceType = "local" | "github";

export type PluginInstallStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "error";

export interface PluginCommandManifest {
  name: string;
  description?: string;
  permission?: string;
}

export interface PluginWorkflowActionManifest {
  id: string;
  title: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PluginWebPanelManifest {
  id: string;
  title: string;
  path?: string;
  permission?: string;
}

export interface PluginAdapterManifest {
  id: string;
  title: string;
  description?: string;
  entry?: string;
}

export interface PluginCapabilitiesManifest {
  commands?: PluginCommandManifest[];
  workflowActions?: PluginWorkflowActionManifest[];
  webPanels?: PluginWebPanelManifest[];
  agentAdapters?: PluginAdapterManifest[];
  chatAdapters?: PluginAdapterManifest[];
  artifactHandlers?: PluginAdapterManifest[];
  diagnostics?: boolean;
}

export interface PluginSettingManifest {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "select";
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ label: string; value: string }>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  nordrelay?: string;
  entry?: string;
  permissions?: string[];
  capabilities?: PluginCapabilitiesManifest;
  settings?: PluginSettingManifest[];
}

export interface InstalledPluginSource {
  type: PluginSourceType;
  value: string;
  ref?: string;
  revision?: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  nordrelay?: string;
  entry?: string;
  installPath: string;
  manifestPath: string;
  source: InstalledPluginSource;
  enabled: boolean;
  status: PluginInstallStatus;
  lastError?: string;
  permissions: string[];
  approvedPermissions: string[];
  capabilities: PluginCapabilitiesManifest;
  settingsSchema: PluginSettingManifest[];
  settings: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
}

export interface PublicPluginRecord extends Omit<InstalledPluginRecord, "settings"> {
  settings: Record<string, unknown>;
  settingsSummary: Record<string, "configured" | "empty" | unknown>;
}

export interface PluginValidationIssue {
  level: "error" | "warning";
  message: string;
}

export interface PluginValidationResult {
  ok: boolean;
  manifest?: PluginManifest;
  issues: PluginValidationIssue[];
}

export interface PluginInstallRequest {
  source: string;
  ref?: string;
  enable?: boolean;
  approvePermissions?: boolean;
  force?: boolean;
}

export interface PluginScaffoldRequest {
  targetDir: string;
  id: string;
  name?: string;
  description?: string;
}

export interface PluginRegistryPayload {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export const PLUGIN_MANIFEST_FILE = "nordrelay.plugin.json";

