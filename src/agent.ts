import type { CodexLaunchProfile } from "./codex-launch.js";
import type { CodexSessionUsage } from "./codex-state.js";

export const AGENT_IDS = ["codex", "pi", "hermes", "openclaw"] as const;
export type AgentId = typeof AGENT_IDS[number];

export type AgentReasoningEffort = "off" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const CODEX_REASONING_EFFORTS: AgentReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const PI_THINKING_LEVELS: AgentReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const HERMES_REASONING_EFFORTS: AgentReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const OPENCLAW_THINKING_LEVELS: AgentReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface AgentCapabilities {
  launchProfiles: boolean;
  fastMode: boolean;
  externalActivity: boolean;
  cliMirror: boolean;
  activityLog: boolean;
  auth: boolean;
  login: boolean;
  logout: boolean;
  usageLimits: boolean;
  workspaces: boolean;
  attachments: boolean;
  modelSelection: boolean;
  reasoningSelection: boolean;
  handback: boolean;
}

export const CODEX_AGENT_CAPABILITIES: AgentCapabilities = {
  launchProfiles: true,
  fastMode: true,
  externalActivity: true,
  cliMirror: true,
  activityLog: true,
  auth: true,
  login: true,
  logout: true,
  usageLimits: true,
  workspaces: true,
  attachments: true,
  modelSelection: true,
  reasoningSelection: true,
  handback: true,
};

export const PI_AGENT_CAPABILITIES: AgentCapabilities = {
  launchProfiles: true,
  fastMode: false,
  externalActivity: true,
  cliMirror: true,
  activityLog: true,
  auth: true,
  login: false,
  logout: false,
  usageLimits: true,
  workspaces: true,
  attachments: true,
  modelSelection: true,
  reasoningSelection: true,
  handback: true,
};

export const HERMES_AGENT_CAPABILITIES: AgentCapabilities = {
  launchProfiles: true,
  fastMode: false,
  externalActivity: true,
  cliMirror: true,
  activityLog: true,
  auth: true,
  login: false,
  logout: false,
  usageLimits: true,
  workspaces: true,
  attachments: true,
  modelSelection: true,
  reasoningSelection: true,
  handback: true,
};

export const OPENCLAW_AGENT_CAPABILITIES: AgentCapabilities = {
  launchProfiles: true,
  fastMode: false,
  externalActivity: true,
  cliMirror: true,
  activityLog: true,
  auth: true,
  login: false,
  logout: false,
  usageLimits: true,
  workspaces: true,
  attachments: true,
  modelSelection: true,
  reasoningSelection: true,
  handback: true,
};

export interface AgentSessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

export interface AgentContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface AgentSessionInfo {
  agentId: AgentId;
  agentLabel: string;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  fastMode: boolean;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: {
    input: number;
    cached: number;
    output: number;
  };
  codexUsage?: CodexSessionUsage;
  sessionUsage?: AgentSessionUsage;
  contextUsage?: AgentContextUsage;
  sessionPath?: string;
  capabilities: AgentCapabilities;
}

export interface AgentPromptObject {
  text?: string;
  imagePaths?: string[];
  stagedFileInstructions?: string;
}

export type AgentPromptInput = string | AgentPromptObject;

export interface AgentSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface AgentModelRecord {
  slug: string;
  displayName: string;
  maxInputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsImages?: boolean;
}

export interface AgentLaunchProfileRecord {
  id: string;
  label: string;
  behavior: string;
  unsafe: boolean;
}

export interface AgentThreadRecord {
  id: string;
  title: string | null;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string | null;
  agentId: AgentId;
  sessionPath?: string;
}

export interface AgentFastModeResult {
  enabled: boolean;
  profile: CodexLaunchProfile;
  appliedToActiveThread: boolean;
}

export interface AgentSettingResult<TValue extends string = string> {
  value: TValue;
  appliedToActiveThread: boolean;
}

export interface AgentSyncResult {
  threadId: string | null;
  changed: boolean;
  reattached: boolean;
  changedFields: string[];
  info: AgentSessionInfo;
}

export interface AgentHandbackResult {
  threadId: string | null;
  workspace: string;
  command?: string;
  label?: string;
}

export type AgentActivityEventKind = "task" | "user" | "agent" | "tool";

export interface AgentActivityEvent {
  lineNumber: number;
  kind: AgentActivityEventKind;
  timestamp: Date | null;
  type: string;
  turnId: string | null;
  status: string | null;
  text: string | null;
  toolName: string | null;
  phase: string | null;
}

export interface AgentExternalActivity {
  agentId: AgentId;
  agentLabel: string;
  threadId: string;
  sourcePath: string;
  sourceLabel: string;
  active: boolean;
  stale: boolean;
  turnId: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
}

export interface AgentExternalSnapshot {
  agentId: AgentId;
  agentLabel: string;
  threadId: string;
  sourcePath: string;
  sourceLabel: string;
  lineCount: number;
  activity: AgentExternalActivity;
  events: AgentActivityEvent[];
  latestAgentMessage: string | null;
  latestUserMessage: string | null;
  latestToolName: string | null;
}

export interface AgentDiagnostics {
  agentId: AgentId;
  agentLabel: string;
  lines: Array<{ label: string; value: string }>;
}

export interface AgentCreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
  sessionPath?: string;
}

export interface AgentSessionService {
  getInfo(): AgentSessionInfo;
  isProcessing(): boolean;
  getActiveThreadId(): string | null;
  hasActiveThread(): boolean;
  getCurrentWorkspace(): string;
  prompt(input: AgentPromptInput, callbacks: AgentSessionCallbacks): Promise<void>;
  abort(): Promise<void>;
  newThread(workspace?: string, model?: string): Promise<AgentSessionInfo>;
  resumeThread(threadId: string): Promise<AgentSessionInfo>;
  switchSession(threadId: string): Promise<AgentSessionInfo>;
  listAllSessions(limit?: number): AgentThreadRecord[];
  listWorkspaces(): string[];
  listModels(): AgentModelRecord[];
  listLaunchProfiles(): AgentLaunchProfileRecord[];
  getSessionRecord(threadId: string): AgentThreadRecord | null;
  setModel(slug: string): string;
  setModelForCurrentSession(slug: string): AgentSettingResult | Promise<AgentSettingResult>;
  setReasoningEffort(effort: string): void;
  setReasoningEffortForCurrentSession(effort: string): AgentSettingResult | Promise<AgentSettingResult>;
  setLaunchProfile(profileId: string): CodexLaunchProfile;
  setFastMode(enabled: boolean): AgentFastModeResult;
  getSelectedLaunchProfile(): CodexLaunchProfile;
  syncFromCodexState(options?: { reattach?: boolean }): AgentSyncResult;
  handback(): AgentHandbackResult;
  dispose(): void;
}

export function isAgentId(value: string | undefined): value is AgentId {
  return value === "codex" || value === "pi" || value === "hermes" || value === "openclaw";
}

export function agentLabel(agentId: AgentId): string {
  if (agentId === "pi") {
    return "Pi";
  }
  if (agentId === "hermes") {
    return "Hermes";
  }
  if (agentId === "openclaw") {
    return "OpenClaw";
  }
  return "Codex";
}

export function agentReasoningLabel(agentId: AgentId): string {
  return agentId === "pi" || agentId === "openclaw" ? "Thinking" : "Reasoning";
}

export function agentReasoningOptions(agentId: AgentId): AgentReasoningEffort[] {
  if (agentId === "pi") {
    return PI_THINKING_LEVELS;
  }
  if (agentId === "hermes") {
    return HERMES_REASONING_EFFORTS;
  }
  if (agentId === "openclaw") {
    return OPENCLAW_THINKING_LEVELS;
  }
  return CODEX_REASONING_EFFORTS;
}
