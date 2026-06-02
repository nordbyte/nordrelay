export type PluginSourceType = "local" | "github" | "npm";

export type PluginTrustLevel =
  | "official"
  | "verified"
  | "community"
  | "local"
  | "untrusted";

export type PluginSignatureStatus =
  | "verified"
  | "unsigned"
  | "invalid"
  | "not-required";

export type PluginInstallStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "error";

export const PLUGIN_RUNTIME_PERMISSIONS = [
  "runtime.read",
  "sessions.read",
  "usage.read",
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
  "system.packages.read",
  "system.packages.write",
  "system.updates.read",
  "system.updates.write",
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
  allowClientScript?: boolean;
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
  signature?: {
    keyId?: string;
    algorithm?: "ed25519";
    value?: string;
  };
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
  packageName?: string;
  resolvedRef?: string;
  integrity?: PluginIntegrity;
}

export interface PluginIntegrity {
  algorithm: "sha256" | "sha512";
  value: string;
}

export interface PluginSignatureVerification {
  status: PluginSignatureStatus;
  keyId?: string;
  message?: string;
}

export interface PluginPermissionDiff {
  addedPermissions: string[];
  removedPermissions: string[];
  unchangedPermissions: string[];
  addedCapabilities: string[];
  removedCapabilities: string[];
  changedCapabilities: string[];
  riskyChanges: string[];
  hasEscalation: boolean;
}

export interface PluginLockRecord {
  id: string;
  version: string;
  source: InstalledPluginSource;
  manifestHash: PluginIntegrity;
  packageHash: PluginIntegrity;
  permissions: string[];
  approvedPermissions: string[];
  capabilities: PluginCapabilitiesManifest;
  trustLevel: PluginTrustLevel;
  signature: PluginSignatureVerification;
  signaturePublicKey?: string;
  installedAt: string;
  updatedAt: string;
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
  manifestHash: PluginIntegrity;
  packageHash: PluginIntegrity;
  trustLevel: PluginTrustLevel;
  signature: PluginSignatureVerification;
  signaturePublicKey?: string;
  permissionDiff?: PluginPermissionDiff;
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
  approvePermissionDiff?: boolean;
  force?: boolean;
  trustLevel?: PluginTrustLevel;
  expectedManifestHash?: string;
  expectedPackageHash?: string;
  signaturePublicKey?: string;
  requireSignature?: boolean;
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

export interface PluginLockPayload {
  version: 1;
  plugins: PluginLockRecord[];
}

export interface PluginHostContext {
  runtime?: Record<string, unknown>;
  session?: unknown;
  sessions?: unknown[];
  usage?: PluginUsageSnapshot;
  activity?: unknown[];
  artifacts?: unknown[];
  workflows?: Record<string, unknown>;
  peers?: unknown[];
  diagnostics?: unknown;
  settings?: Record<string, unknown>;
}

export interface PluginUsageSnapshot {
  generatedAt: string;
  node: {
    id?: string;
    name?: string;
    platform?: string;
    workspace?: string;
  };
  sessions: PluginUsageSession[];
}

export interface PluginUsageSession {
  nodeId?: string;
  nodeName?: string;
  platform?: string;
  agentId: string;
  agentLabel: string;
  provider: string;
  model: string | null;
  threadId: string;
  sessionName?: string;
  workspace: string;
  sessionPath?: string;
  source: "web" | "telegram" | "discord" | "slack" | "matrix" | "cli" | "unknown";
  createdAt: string;
  updatedAt: string;
  usage: PluginUsageTokenUsage;
  costUsd?: number;
  confidence: "exact" | "reported" | "delta" | "estimated";
}

export interface PluginUsageTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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
  panel?: {
    html?: string;
    script?: string;
    styles?: string;
    ui?: PluginPanelUiNode | PluginPanelUiNode[];
  };
  html?: string;
  text?: string;
  artifacts?: unknown[];
  diagnostics?: unknown;
  durationMs?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  exitCode?: number | null;
}

export interface PluginUpdateCheckResult {
  id: string;
  sourceType: PluginSourceType;
  currentVersion: string;
  latestVersion?: string;
  currentRevision?: string;
  latestRevision?: string;
  permissionDiff?: PluginPermissionDiff;
  manifestHash?: PluginIntegrity;
  packageHash?: PluginIntegrity;
  trustLevel?: PluginTrustLevel;
  signature?: PluginSignatureVerification;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
}

export interface PluginJobRecord {
  id: string;
  pluginId: string;
  title: string;
  command?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  input: Record<string, unknown>;
  result?: PluginInvokeResult;
  logs: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
  progress?: { current?: number; total?: number; label?: string };
  cancelRequested?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PluginJobsPayload {
  version: 1;
  jobs: PluginJobRecord[];
}

export interface PluginPanelUiNode {
  type: string;
  props?: Record<string, unknown>;
  children?: string | PluginPanelUiNode | PluginPanelUiNode[];
}

export interface PluginEventRecord {
  id: string;
  pluginId: string;
  type: string;
  timestamp: string;
  payload: unknown;
}

export const PLUGIN_MANIFEST_FILE = "nordrelay.plugin.json";
