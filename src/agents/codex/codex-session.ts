import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";

import type { ConnectorConfig } from "../../core/config.js";
import { resolveCodexCli } from "./codex-cli.js";
import { readCodexFastMode, writeCodexFastMode } from "./codex-config.js";
import {
  getThread,
  getThreadRolloutSnapshot,
  getThreadUsage,
  listModels,
  listThreads,
  listWorkspaces,
  type CodexSessionUsage,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  createLaunchProfile,
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";
import {
  CODEX_AGENT_CAPABILITIES,
  type AgentFastModeResult,
  type AgentLaunchProfileRecord,
  type AgentModelRecord,
  type AgentPromptInput,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionInfoOptions,
  type AgentSettingResult,
  type AgentSyncResult,
  type AgentThreadRecord,
} from "../shared/agent.js";

export type FastModeResult = AgentFastModeResult;

export type SessionSettingResult<TValue extends string = string> = AgentSettingResult<TValue>;

export interface CodexSyncResult extends AgentSyncResult {
  threadId: string | null;
  changed: boolean;
  reattached: boolean;
  changedFields: string[];
  info: CodexSessionInfo;
}

export type CodexSessionCallbacks = AgentSessionCallbacks;

export interface CodexSessionInfo extends AgentSessionInfo {
  agentId: "codex";
  agentLabel: "Codex";
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
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  activeLaunchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput = AgentPromptInput;

export class CodexSessionService {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: ModelReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private activeThreadLaunchProfileOverride: { threadId: string; profile: CodexLaunchProfile } | null = null;
  private sessionTokens = { input: 0, cached: 0, output: 0 };
  private lastObservedFastMode: boolean | null = null;

  private constructor(private readonly config: ConnectorConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: ConnectorConfig, options?: CreateOptions): Promise<CodexSessionService> {
    const service = new CodexSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.codexModel;
    service.currentReasoningEffort = options?.reasoningEffort as ModelReasoningEffort | undefined;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );
    service.resetCodexClient();

    if (options?.resumeThreadId) {
      if (options.activeLaunchProfileId) {
        service.activeThreadLaunchProfileOverride = {
          threadId: options.resumeThreadId,
          profile: getLaunchProfile(config, options.activeLaunchProfileId),
        };
      }
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(options: AgentSessionInfoOptions = {}): CodexSessionInfo {
    const activeThreadId = this.thread?.id ?? this.currentThreadId;
    if (activeThreadId && !this.abortController) {
      this.refreshActiveThreadMetadata(activeThreadId);
    }

    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const codexFastMode = readCodexFastMode();
    const effectiveFastMode = codexFastMode ?? this.lastObservedFastMode ?? false;
    this.lastObservedFastMode = effectiveFastMode;
    const info: CodexSessionInfo = {
      agentId: "codex",
      agentLabel: "Codex",
      threadId: activeThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      fastMode: effectiveFastMode,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
      capabilities: CODEX_AGENT_CAPABILITIES,
    };
    Object.defineProperties(info, {
      agentId: { value: "codex", enumerable: false },
      agentLabel: { value: "Codex", enumerable: false },
      capabilities: { value: CODEX_AGENT_CAPABILITIES, enumerable: false },
    });

    if (this.currentReasoningEffort) {
      info.reasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    const threadId = info.threadId;
    if (options.includeUsage && threadId) {
      const codexUsage = getThreadUsage(threadId);
      if (codexUsage) {
        info.codexUsage = codexUsage;
      }
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null;
  }

  getActiveThreadId(): string | null {
    return this.thread?.id ?? this.currentThreadId;
  }

  hasActiveThread(): boolean {
    return this.thread !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let lastAgentText = "";

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of events) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                lastAgentText = item.text;
                callbacks.onTextDelta(delta);
              } else {
                lastAgentText = item.text;
              }
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                callbacks.onTextDelta(delta);
              }
              lastAgentText = item.text;
            } else if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "turn.completed": {
            // Accumulate and deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            this.sessionTokens.input += u.input_tokens;
            this.sessionTokens.cached += u.cached_input_tokens;
            this.sessionTokens.output += u.output_tokens;
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = workspace ?? this.currentWorkspace;
    const effectiveModel = model ?? this.currentModel;
    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.activeThreadLaunchProfileOverride = null;
    this.currentWorkspace = effectiveWorkspace;
    this.currentThreadId = this.thread.id ?? null;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || this.currentModel;
    const launchProfile = this.launchProfileOverrideFor(threadId) ?? this.resolveThreadLaunchProfile(record);
    if (record) {
      this.currentReasoningEffort = record.reasoningEffort
        ? record.reasoningEffort as ModelReasoningEffort
        : undefined;
    }

    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(workspace, model, launchProfile),
    );
    this.activeThreadLaunchProfile = launchProfile;
    this.currentThreadId = threadId;
    this.currentWorkspace = workspace;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = record?.cwd ?? this.currentWorkspace;
    const model = record?.model || undefined;
    const reasoningEffort = record?.reasoningEffort || undefined;
    const launchProfile = this.resolveThreadLaunchProfile(record);
    this.currentReasoningEffort = reasoningEffort as ModelReasoningEffort | undefined;

    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model, launchProfile));
    this.activeThreadLaunchProfile = launchProfile;
    this.activeThreadLaunchProfileOverride = null;
    this.currentWorkspace = workspace;
    this.currentThreadId = threadId;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  listAllSessions(limit?: number): AgentThreadRecord[] {
    return listThreads(limit ?? 20).map(toAgentThreadRecord);
  }

  listWorkspaces(): string[] {
    return listWorkspaces();
  }

  async refreshModels(): Promise<void> {
    // Codex models are read from local state on each listModels() call.
  }

  listModels(): AgentModelRecord[] {
    return listModels();
  }

  listLaunchProfiles(): AgentLaunchProfileRecord[] {
    return this.config.launchProfiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      behavior: formatLaunchProfileBehavior(profile),
      unsafe: profile.unsafe,
    }));
  }

  getSessionRecord(threadId: string): AgentThreadRecord | null {
    const record = getThread(threadId);
    return record ? toAgentThreadRecord(record) : null;
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setModelForCurrentSession(slug: string): SessionSettingResult {
    this.ensureIdle("change model");
    this.currentModel = slug;
    const appliedToActiveThread = this.reattachActiveThread();
    return { value: slug, appliedToActiveThread };
  }

  setReasoningEffort(effort: string): void {
    this.currentReasoningEffort = effort as ModelReasoningEffort;
  }

  setReasoningEffortForCurrentSession(effort: string): SessionSettingResult {
    this.ensureIdle("change reasoning effort");
    this.currentReasoningEffort = effort as ModelReasoningEffort;
    const appliedToActiveThread = this.reattachActiveThread();
    return { value: effort, appliedToActiveThread };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  setLaunchProfileForCurrentSession(profileId: string): SessionSettingResult {
    this.ensureIdle("change launch profile");
    const profile = getLaunchProfile(this.config, profileId);
    this.currentLaunchProfile = profile;
    this.resetCodexClient();
    const appliedToActiveThread = this.reattachActiveThread(profile);
    if (appliedToActiveThread && this.currentThreadId) {
      this.activeThreadLaunchProfileOverride = { threadId: this.currentThreadId, profile };
    }
    return { value: profile.id, appliedToActiveThread };
  }

  setFastMode(enabled: boolean): FastModeResult {
    this.ensureIdle("change fast mode");

    writeCodexFastMode(enabled);
    this.lastObservedFastMode = enabled;
    this.resetCodexClient();

    const profile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    let appliedToActiveThread = false;
    if (this.thread) {
      if (this.currentThreadId) {
        this.thread = this.getCodex().resumeThread(
          this.currentThreadId,
          this.buildThreadOptions(this.currentWorkspace, this.currentModel, profile),
        );
      } else {
        this.thread = this.getCodex().startThread(
          this.buildThreadOptions(this.currentWorkspace, this.currentModel, profile),
        );
      }
      this.activeThreadLaunchProfile = profile;
      if (this.currentThreadId) {
        this.activeThreadLaunchProfileOverride = { threadId: this.currentThreadId, profile };
      }
      appliedToActiveThread = true;
    }

    return { enabled, profile, appliedToActiveThread };
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  syncFromAgentState(options: { reattach?: boolean } = {}): CodexSyncResult {
    const activeThreadId = this.thread?.id ?? this.currentThreadId;
    const before = {
      workspace: this.currentWorkspace,
      model: this.currentModel,
      reasoningEffort: this.currentReasoningEffort,
      activeLaunchProfileId: this.activeThreadLaunchProfile?.id,
      selectedLaunchProfileId: this.currentLaunchProfile.id,
    };
    const changedFields = new Set<string>();

    if (activeThreadId && !this.abortController) {
      const record = getThread(activeThreadId);
      if (record) {
        if (record.cwd && record.cwd !== this.currentWorkspace) changedFields.add("workspace");
        if ((record.model || undefined) !== this.currentModel) changedFields.add("model");
        if ((record.reasoningEffort || undefined) !== this.currentReasoningEffort) changedFields.add("reasoning");
        const resolvedLaunchProfile = this.launchProfileOverrideFor(activeThreadId) ?? this.resolveThreadLaunchProfile(record);
        if (resolvedLaunchProfile.id !== this.activeThreadLaunchProfile?.id) changedFields.add("launch");
        this.currentWorkspace = record.cwd || this.currentWorkspace;
        this.currentModel = record.model || this.currentModel;
        this.currentReasoningEffort = record.reasoningEffort
          ? record.reasoningEffort as ModelReasoningEffort
          : undefined;
        this.activeThreadLaunchProfile = resolvedLaunchProfile;
      }
    }

    const codexFastMode = readCodexFastMode();
    if (codexFastMode !== null && codexFastMode !== this.lastObservedFastMode) {
      changedFields.add("fast");
      this.lastObservedFastMode = codexFastMode;
    }
    const changed = changedFields.size > 0 ||
      before.workspace !== this.currentWorkspace ||
      before.model !== this.currentModel ||
      before.reasoningEffort !== this.currentReasoningEffort ||
      before.activeLaunchProfileId !== this.activeThreadLaunchProfile?.id ||
      before.selectedLaunchProfileId !== this.currentLaunchProfile.id;
    let reattached = false;
    if (changed && options.reattach && !this.abortController && this.thread) {
      reattached = this.reattachActiveThread();
    }

    return {
      threadId: activeThreadId,
      changed,
      reattached,
      changedFields: [...changedFields],
      info: this.getInfo(),
    };
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.activeThreadLaunchProfileOverride = null;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    this.activeThreadLaunchProfileOverride = null;
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    if (typeof input === "string") {
      return input;
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildThreadOptions(workspace: string, model?: string, launchProfile = this.currentLaunchProfile): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
    modelReasoningEffort?: ModelReasoningEffort;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const options = {
      model: effectiveModel,
      sandboxMode: launchProfile.sandboxMode,
      workingDirectory: workspace,
      approvalPolicy: launchProfile.approvalPolicy,
      skipGitRepoCheck: true as const,
    };

    if (this.currentReasoningEffort) {
      return {
        ...options,
        modelReasoningEffort: this.currentReasoningEffort,
      };
    }

    return options;
  }

  private ensureIdle(action: string): void {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
  }

  private resetCodexClient(): void {
    const cli = resolveCodexCli();
    const options: CodexOptions = {
      apiKey: this.config.codexApiKey,
      config: {
        approval_policy: this.currentLaunchProfile.approvalPolicy,
      },
      env: buildCodexEnv(this.config.codexApiKey),
    };

    if (cli.path) {
      options.codexPathOverride = cli.path;
    }

    this.codex = new Codex(options);
  }

  private resolveThreadLaunchProfile(record: CodexThreadRecord | null): CodexLaunchProfile {
    const rolloutSnapshot = record?.id
      ? getThreadRolloutSnapshot(record.id, { maxEvents: 0 })
      : null;
    const sandboxMode = rolloutSnapshot?.sandboxMode ?? record?.sandboxMode ?? null;
    const approvalPolicy = rolloutSnapshot?.approvalPolicy ?? record?.approvalPolicy ?? null;
    if (!sandboxMode || !approvalPolicy) {
      return this.currentLaunchProfile;
    }

    const matchingProfile = this.config.launchProfiles.find(
      (profile) =>
        profile.sandboxMode === sandboxMode && profile.approvalPolicy === approvalPolicy,
    );

    if (matchingProfile) {
      return matchingProfile;
    }

    return createLaunchProfile({
      id: "attached-thread",
      label: "Attached Thread",
      sandboxMode,
      approvalPolicy,
    });
  }

  private refreshActiveThreadMetadata(threadId: string): void {
    const record = getThread(threadId);
    if (!record) {
      return;
    }

    this.currentWorkspace = record.cwd || this.currentWorkspace;
    this.currentModel = record.model || this.currentModel;
    this.currentReasoningEffort = record.reasoningEffort
      ? record.reasoningEffort as ModelReasoningEffort
      : undefined;
    this.activeThreadLaunchProfile = this.launchProfileOverrideFor(threadId) ?? this.resolveThreadLaunchProfile(record);
  }

  private reattachActiveThread(launchProfileOverride?: CodexLaunchProfile): boolean {
    if (!this.thread) {
      this.resetCodexClient();
      return false;
    }

    const launchProfile = launchProfileOverride ?? this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    if (this.currentThreadId) {
      this.thread = this.getCodex().resumeThread(
        this.currentThreadId,
        this.buildThreadOptions(this.currentWorkspace, this.currentModel, launchProfile),
      );
    } else {
      this.thread = this.getCodex().startThread(
        this.buildThreadOptions(this.currentWorkspace, this.currentModel, launchProfile),
      );
      this.currentThreadId = this.thread.id ?? null;
    }
    this.activeThreadLaunchProfile = launchProfile;
    return true;
  }

  private launchProfileOverrideFor(threadId: string | null | undefined): CodexLaunchProfile | null {
    if (!threadId || this.activeThreadLaunchProfileOverride?.threadId !== threadId) {
      return null;
    }
    return this.activeThreadLaunchProfileOverride.profile;
  }

}

function getLaunchProfile(config: ConnectorConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    if (profileId === "full-access") {
      return createLaunchProfile({
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });
    }
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function toAgentThreadRecord(record: CodexThreadRecord): AgentThreadRecord {
  return {
    ...record,
    agentId: "codex",
  };
}

function buildCodexEnv(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
