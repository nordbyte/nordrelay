export type PluginSourceType = "local" | "github";

export type PluginInstallStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "error";

export const PLUGIN_RUNTIME_PERMISSIONS = [
  "runtime.read",
  "sessions.read",
  "activity.read",
  "artifacts.read",
  "artifacts.write",
  "files.read",
  "files.write",
  "workflows.read",
  "peers.read",
  "diagnostics.read",
  "settings.read",
  "system.metrics.read",
  "network",
] as const;

export type PluginRuntimePermission = typeof PLUGIN_RUNTIME_PERMISSIONS[number];

export type PluginCapabilityType =
  | "workflow-action"
  | "command"
  | "web-panel"
  | "artifact-handler"
  | "diagnostics"
  | "collector";

export interface PluginCommandManifest {
  name: string;
  title?: string;
  description?: string;
  permission?: string;
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface PluginWorkflowActionManifest {
  id: string;
  title: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputVariables?: Record<string, string>;
  timeoutMs?: number;
}

export interface PluginWebPanelManifest {
  id: string;
  title: string;
  path?: string;
  permission?: string;
  inputSchema?: Record<string, unknown>;
  aggregateCommand?: string;
  placement?: "plugins" | "monitor" | "nav";
  timeoutMs?: number;
}

export interface PluginCollectorManifest {
  id: string;
  title: string;
  description?: string;
  intervalMs?: number;
  runOnStart?: boolean;
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface PluginAdapterManifest {
  id: string;
  title: string;
  description?: string;
  entry?: string;
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface PluginCapabilitiesManifest {
  commands?: PluginCommandManifest[];
  workflowActions?: PluginWorkflowActionManifest[];
  webPanels?: PluginWebPanelManifest[];
  agentAdapters?: PluginAdapterManifest[];
  chatAdapters?: PluginAdapterManifest[];
  artifactHandlers?: PluginAdapterManifest[];
  diagnostics?: boolean;
  collectors?: PluginCollectorManifest[];
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

export interface PluginRuntimeMetrics {
  invocations: number;
  failures: number;
  totalDurationMs: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastStatus?: "ok" | "failed";
  lastError?: string;
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
  metrics?: PluginRuntimeMetrics;
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

export interface PluginHostContext {
  runtime?: Record<string, unknown>;
  session?: unknown;
  sessions?: unknown[];
  activity?: unknown[];
  artifacts?: unknown[];
  workflows?: Record<string, unknown>;
  peers?: unknown[];
  diagnostics?: unknown;
  settings?: Record<string, unknown>;
}

export interface PluginInvokeRequest {
  protocolVersion: 1;
  type: PluginCapabilityType;
  pluginId: string;
  capabilityId?: string;
  actionId?: string;
  command?: string;
  panelId?: string;
  handlerId?: string;
  collectorId?: string;
  input: Record<string, unknown>;
  settings: Record<string, unknown>;
  dataDir: string;
  permissions: PluginRuntimePermission[];
  context: PluginHostContext;
}

export interface PluginInvokeResult {
  ok: boolean;
  output?: unknown;
  stdout?: string;
  stderr?: string;
  variables?: Record<string, string>;
  html?: string;
  text?: string;
  artifacts?: unknown[];
  diagnostics?: unknown;
  durationMs?: number;
  timedOut?: boolean;
  exitCode?: number | null;
}

export interface PluginUpdateCheckResult {
  id: string;
  sourceType: PluginSourceType;
  currentVersion: string;
  latestVersion?: string;
  currentRevision?: string;
  latestRevision?: string;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
}

export const PLUGIN_MANIFEST_FILE = "nordrelay.plugin.json";
