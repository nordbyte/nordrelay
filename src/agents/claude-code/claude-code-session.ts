import { query, type CanUseTool, type EffortLevel, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CLAUDE_CODE_AGENT_CAPABILITIES,
  CLAUDE_CODE_EFFORT_LEVELS,
  type AgentCreateOptions,
  type AgentFastModeResult,
  type AgentHandbackResult,
  type AgentLaunchProfileRecord,
  type AgentModelRecord,
  type AgentPromptInput,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentSettingResult,
  type AgentSyncResult,
  type AgentThreadRecord,
  type AgentApprovalChoice,
} from "../shared/agent.js";
import {
  clearPendingAgentApprovals,
  registerPendingAgentApproval,
  removePendingAgentApproval,
} from "../shared/agent-approval-registry.js";
import { resolveClaudeCodeCli } from "./claude-code-cli.js";
import {
  claudeCodeProfileAsLaunchProfile,
  findClaudeCodeLaunchProfile,
  listClaudeCodeLaunchProfiles,
  type ClaudeCodeLaunchProfile,
} from "./claude-code-launch.js";
import {
  getClaudeCodeSession,
  listClaudeCodeSessions,
  listClaudeCodeWorkspaces,
  type ClaudeCodeSessionRecord,
} from "./claude-code-state.js";
import type { CodexLaunchProfile } from "../codex/codex-launch.js";
import type { ConnectorConfig } from "../../core/config.js";

type JsonObject = Record<string, unknown>;

type OpenTool = {
  id: string;
  name: string;
};

export class ClaudeCodeSessionService implements AgentSessionService {
  private readonly cliPath?: string;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentEffort: string | undefined;
  private currentLaunchProfile: ClaudeCodeLaunchProfile;
  private cachedModels: AgentModelRecord[] = [];
  private cachedUsage: AgentSessionInfo["sessionUsage"];
  private processing = false;
  private abortController: AbortController | null = null;
  private currentQuery: Query | null = null;
  private lastStateRefreshAt = 0;

  private static readonly STATE_CACHE_TTL_MS = 5_000;

  private constructor(private readonly config: ConnectorConfig) {
    this.cliPath = resolveClaudeCodeCli(process.env, config.claudeCodeCliPath).path;
    this.currentWorkspace = config.workspace;
    this.currentModel = config.claudeCodeDefaultModel;
    this.currentEffort = normalizeClaudeCodeEffort(config.claudeCodeDefaultEffort);
    this.currentLaunchProfile = findClaudeCodeLaunchProfile(
      config.claudeCodeDefaultLaunchProfileId,
      allowsClaudeCodeUnsafeProfile(config.claudeCodeDefaultLaunchProfileId, config.enableUnsafeLaunchProfiles),
    );
    this.cachedModels = defaultClaudeCodeModels(this.currentModel);
  }

  static async create(config: ConnectorConfig, options?: AgentCreateOptions): Promise<ClaudeCodeSessionService> {
    const service = new ClaudeCodeSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.claudeCodeDefaultModel;
    service.currentEffort = normalizeClaudeCodeEffort(options?.reasoningEffort ?? config.claudeCodeDefaultEffort);
    service.currentLaunchProfile = findClaudeCodeLaunchProfile(
      options?.launchProfileId ?? config.claudeCodeDefaultLaunchProfileId,
      allowsClaudeCodeUnsafeProfile(options?.launchProfileId ?? config.claudeCodeDefaultLaunchProfileId, config.enableUnsafeLaunchProfiles),
    );
    await service.refreshModels().catch(() => {});

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }
    if (!options?.deferThreadStart) {
      await service.newThread(service.currentWorkspace, service.currentModel);
    }
    return service;
  }

  getInfo(): AgentSessionInfo {
    this.refreshFromState();
    return {
      agentId: "claude-code",
      agentLabel: "Claude Code",
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel,
      reasoningEffort: this.currentEffort,
      launchProfileId: this.currentLaunchProfile.id,
      launchProfileLabel: this.currentLaunchProfile.label,
      launchProfileBehavior: this.currentLaunchProfile.behavior,
      sandboxMode: "host",
      approvalPolicy: this.currentLaunchProfile.permissionMode,
      fastMode: false,
      unsafeLaunch: this.currentLaunchProfile.unsafe,
      sessionUsage: this.cachedUsage,
      sessionPath: this.currentThreadId ? this.getRecord(this.currentThreadId)?.sessionPath : undefined,
      capabilities: CLAUDE_CODE_AGENT_CAPABILITIES,
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getActiveThreadId(): string | null {
    return this.currentThreadId;
  }

  hasActiveThread(): boolean {
    return Boolean(this.currentThreadId);
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: AgentPromptInput, callbacks: AgentSessionCallbacks): Promise<void> {
    if (this.processing) {
      throw new Error("A Claude Code turn is already in progress");
    }

    const prompt = await this.buildPrompt(input);
    const abortController = new AbortController();
    const stream = query({
      prompt,
      options: this.queryOptions(abortController),
    });
    const openTools = new Map<string, OpenTool>();
    const contentBlockTools = new Map<number, OpenTool>();
    let streamedOutput = "";
    let assistantOutputHandled = false;
    let didEnd = false;
    let toolCounter = 0;

    this.processing = true;
    this.abortController = abortController;
    this.currentQuery = stream;

    try {
      for await (const message of stream) {
        const sessionId = sessionIdOf(message);
        if (sessionId) {
          this.currentThreadId = sessionId;
        }
        const type = stringValue((message as JsonObject).type);
        if (type === "system") {
          this.handleSystemMessage(message);
          this.handleTaskSystemMessage(message, callbacks, openTools);
          continue;
        }
        if (type === "stream_event") {
          const result = handleStreamEvent(message, callbacks, contentBlockTools, openTools, this.currentThreadId ?? "claude", ++toolCounter);
          toolCounter = result.toolCounter;
          if (result.delta) {
            streamedOutput += result.delta;
          }
          continue;
        }
        if (type === "assistant") {
          const handledText = handleAssistantMessage(message, callbacks, openTools, streamedOutput);
          assistantOutputHandled = assistantOutputHandled || handledText;
          continue;
        }
        if (type === "tool_progress") {
          handleToolProgress(message, callbacks, openTools);
          continue;
        }
        if (type === "tool_use_summary") {
          handleToolSummary(message, callbacks, openTools);
          continue;
        }
        if (type === "result") {
          const text = this.handleResultMessage(message, callbacks);
          if (text && !streamedOutput && !assistantOutputHandled) {
            callbacks.onTextDelta(text);
          }
          didEnd = true;
          callbacks.onAgentEnd();
          continue;
        }
        if (type === "rate_limit_event") {
          const info = objectValue((message as JsonObject).rate_limit_info);
          const toolId = `claude-rate-limit-${this.currentThreadId ?? "session"}`;
          callbacks.onToolStart("rate_limit", toolId);
          callbacks.onToolUpdate(toolId, stringifyPreview(info) ?? "Rate limit update");
          callbacks.onToolEnd(toolId, false);
        }
      }
      if (!didEnd) {
        callbacks.onAgentEnd();
      }
      this.refreshFromState({ force: true });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("Claude Code run was aborted");
      }
      throw error;
    } finally {
      for (const tool of openTools.values()) {
        callbacks.onToolEnd(tool.id, false);
      }
      this.currentQuery?.close();
      this.currentQuery = null;
      this.abortController = null;
      if (this.currentThreadId) clearPendingAgentApprovals("claude-code", this.currentThreadId);
      this.processing = false;
    }
  }

  async abort(): Promise<void> {
    await this.currentQuery?.interrupt().catch(() => {});
    this.abortController?.abort();
    this.currentQuery?.close();
    if (this.currentThreadId) clearPendingAgentApprovals("claude-code", this.currentThreadId);
    this.processing = false;
  }

  async newThread(workspace?: string, model?: string): Promise<AgentSessionInfo> {
    this.ensureIdle("start a new Claude Code session");
    this.currentWorkspace = workspace ?? this.currentWorkspace;
    if (model) {
      this.currentModel = model;
    }
    this.currentThreadId = null;
    this.cachedUsage = undefined;
    this.lastStateRefreshAt = Date.now();
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<AgentSessionInfo> {
    this.ensureIdle("resume Claude Code session");
    const record = this.getRecord(threadId);
    if (record) {
      this.applyRecord(record);
    } else {
      this.currentThreadId = threadId.trim();
    }
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    this.ensureIdle("switch Claude Code session");
    const record = this.getRecord(threadId);
    if (!record) {
      throw new Error(`Unknown Claude Code session: ${threadId}`);
    }
    this.applyRecord(record);
    this.lastStateRefreshAt = Date.now();
    return this.getInfo();
  }

  listAllSessions(limit?: number): AgentThreadRecord[] {
    return listClaudeCodeSessions(limit ?? 20, this.stateOptions());
  }

  listWorkspaces(): string[] {
    const workspaces = new Set(listClaudeCodeWorkspaces(this.stateOptions()));
    workspaces.add(this.currentWorkspace);
    workspaces.add(this.config.workspace);
    return [...workspaces].sort((left, right) => left.localeCompare(right));
  }

  async refreshModels(): Promise<void> {
    this.cachedModels = defaultClaudeCodeModels(this.currentModel);
  }

  listModels(): AgentModelRecord[] {
    const models = [...this.cachedModels];
    if (this.currentModel && !models.some((model) => model.slug === this.currentModel)) {
      models.unshift({ slug: this.currentModel, displayName: this.currentModel, supportsThinking: true, supportsImages: true });
    }
    return models;
  }

  listLaunchProfiles(): AgentLaunchProfileRecord[] {
    return listClaudeCodeLaunchProfiles(this.config.enableUnsafeLaunchProfiles);
  }

  getSessionRecord(threadId: string): AgentThreadRecord | null {
    return this.getRecord(threadId);
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setModelForCurrentSession(slug: string): AgentSettingResult {
    this.ensureIdle("change Claude Code model");
    this.currentModel = slug;
    return { value: slug, appliedToActiveThread: Boolean(this.currentThreadId) };
  }

  setReasoningEffort(effort: string): void {
    this.currentEffort = normalizeClaudeCodeEffort(effort);
  }

  setReasoningEffortForCurrentSession(effort: string): AgentSettingResult {
    this.ensureIdle("change Claude Code effort");
    const value = normalizeClaudeCodeEffort(effort);
    if (!value) {
      throw new Error("Claude Code effort is empty");
    }
    this.currentEffort = value;
    return { value, appliedToActiveThread: Boolean(this.currentThreadId) };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change Claude Code profile");
    this.currentLaunchProfile = findClaudeCodeLaunchProfile(
      profileId,
      allowsClaudeCodeUnsafeProfile(profileId, this.config.enableUnsafeLaunchProfiles),
    );
    return claudeCodeProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  setFastMode(): AgentFastModeResult {
    throw new Error("Fast mode is only supported by Codex sessions");
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return claudeCodeProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  syncFromAgentState(): AgentSyncResult {
    const before = this.getInfo();
    this.refreshFromState({ force: true });
    const after = this.getInfo();
    const changedFields: string[] = [];
    if (before.threadId !== after.threadId) changedFields.push("thread");
    if (before.workspace !== after.workspace) changedFields.push("workspace");
    if (before.model !== after.model) changedFields.push("model");
    if (before.reasoningEffort !== after.reasoningEffort) changedFields.push("effort");
    return {
      threadId: this.currentThreadId,
      changed: changedFields.length > 0,
      reattached: false,
      changedFields,
      info: after,
    };
  }

  handback(): AgentHandbackResult {
    const threadId = this.currentThreadId;
    const workspace = this.currentWorkspace;
    this.currentQuery?.close();
    this.currentThreadId = null;
    return {
      threadId,
      workspace,
      command: threadId
        ? `cd ${shellQuote(workspace)} && ${shellQuote(this.cliPath ?? "claude")} --resume ${shellQuote(threadId)}`
        : undefined,
      label: "Claude Code CLI",
    };
  }

  dispose(): void {
    this.currentQuery?.close();
    this.abortController?.abort();
    if (this.currentThreadId) clearPendingAgentApprovals("claude-code", this.currentThreadId);
    this.processing = false;
  }

  private queryOptions(abortController: AbortController): Options {
    const options: Options = {
      abortController,
      cwd: this.currentWorkspace,
      includePartialMessages: true,
      includeHookEvents: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      maxTurns: this.config.claudeCodeMaxTurns,
      resume: this.currentThreadId ?? undefined,
      model: this.currentModel,
      permissionMode: this.currentLaunchProfile.permissionMode,
      allowDangerouslySkipPermissions: this.currentLaunchProfile.allowDangerouslySkipPermissions,
      pathToClaudeCodeExecutable: this.cliPath,
      canUseTool: this.canUseToolHandler(),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: `nordrelay/${process.env.npm_package_version ?? "local"}`,
      },
    };
    if (this.currentLaunchProfile.tools !== undefined) {
      options.tools = this.currentLaunchProfile.tools;
    }
    if (this.currentLaunchProfile.allowedTools) {
      options.allowedTools = this.currentLaunchProfile.allowedTools;
    }
    if (this.currentLaunchProfile.disallowedTools) {
      options.disallowedTools = this.currentLaunchProfile.disallowedTools;
    }
    if (this.currentLaunchProfile.instructions && this.currentLaunchProfile.permissionMode === "plan") {
      options.planModeInstructions = this.currentLaunchProfile.instructions;
    }
    if (this.currentEffort === "off") {
      options.thinking = { type: "disabled" } satisfies ThinkingConfig;
    } else if (this.currentEffort && isClaudeEffortLevel(this.currentEffort)) {
      options.effort = this.currentEffort;
      options.thinking = { type: "adaptive", display: "summarized" } satisfies ThinkingConfig;
    }
    return options;
  }

  private canUseToolHandler(): CanUseTool {
    return async (toolName, input, permissionOptions) => {
      const policy = claudeToolApprovalPolicy(this.currentLaunchProfile.permissionMode, toolName);
      if (policy === "allow") {
        return {
          behavior: "allow",
          toolUseID: permissionOptions.toolUseID,
          decisionClassification: "user_temporary",
        } satisfies PermissionResult;
      }
      if (policy === "deny") {
        return {
          behavior: "deny",
          message: `${toolName} is not allowed by the current Claude Code launch profile.`,
          toolUseID: permissionOptions.toolUseID,
          decisionClassification: "user_reject",
        } satisfies PermissionResult;
      }
      return this.requestClaudeToolApproval(toolName, input, permissionOptions);
    };
  }

  private async requestClaudeToolApproval(
    toolName: string,
    input: Record<string, unknown>,
    permissionOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const threadId = this.currentThreadId ?? "pending";
    const toolUseId = permissionOptions.toolUseID || `${toolName}-${Date.now()}`;
    const command = permissionOptions.title
      ?? permissionOptions.description
      ?? stringifyPreview(input)
      ?? `${toolName} requested permission`;
    const reason = [
      permissionOptions.decisionReason,
      permissionOptions.blockedPath ? `Blocked path: ${permissionOptions.blockedPath}` : undefined,
      permissionOptions.description,
    ].filter((part): part is string => Boolean(part?.trim())).join("\n") || null;

    return new Promise<PermissionResult>((resolve) => {
      let approvalId: string | undefined;
      const abort = () => {
        removePendingAgentApproval(approvalId);
        resolve({
          behavior: "deny",
          message: "Claude Code approval request was aborted.",
          toolUseID: permissionOptions.toolUseID,
          decisionClassification: "user_reject",
        });
      };
      const approval = registerPendingAgentApproval({
        agentId: "claude-code",
        agentLabel: "Claude Code",
        threadId,
        callId: `claude-code:${toolUseId}`,
        toolName,
        command,
        workdir: this.currentWorkspace,
        reason,
        prefixRule: permissionPrefixRule(permissionOptions.suggestions),
        sandboxPermissions: this.currentLaunchProfile.permissionMode,
        turnId: this.currentThreadId,
        sourcePath: this.getRecord(this.currentThreadId ?? "")?.sessionPath ?? `memory:claude-code:${threadId}`,
        respond: (choice) => {
          permissionOptions.signal.removeEventListener("abort", abort);
          const result = claudePermissionResult(choice, permissionOptions.toolUseID, permissionOptions.suggestions);
          resolve(result);
          return {
            ok: true,
            status: "submitted",
            message: approvalChoiceLabel(choice),
          };
        },
      });
      approvalId = approval.id;

      permissionOptions.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private handleSystemMessage(message: SDKMessage): void {
    const object = message as unknown as JsonObject;
    const subtype = stringValue(object.subtype);
    if (subtype === "init") {
      this.currentWorkspace = stringValue(object.cwd) ?? this.currentWorkspace;
      this.currentModel = stringValue(object.model) ?? this.currentModel;
    }
  }

  private handleTaskSystemMessage(
    message: SDKMessage,
    callbacks: AgentSessionCallbacks,
    openTools: Map<string, OpenTool>,
  ): void {
    const object = message as unknown as JsonObject;
    const subtype = stringValue(object.subtype);
    if (subtype === "task_started") {
      const taskId = stringValue(object.task_id) ?? `task-${openTools.size + 1}`;
      const toolName = stringValue(object.task_type) ?? stringValue(object.workflow_name) ?? "task";
      const tool = { id: taskId, name: toolName };
      openTools.set(taskId, tool);
      callbacks.onToolStart(toolName, taskId);
      const description = stringValue(object.description) ?? stringValue(object.prompt);
      if (description) callbacks.onToolUpdate(taskId, description);
      return;
    }
    if (subtype === "task_progress") {
      const taskId = stringValue(object.task_id);
      if (taskId) {
        const tool = openTools.get(taskId) ?? { id: taskId, name: stringValue(object.last_tool_name) ?? "task" };
        openTools.set(taskId, tool);
        callbacks.onToolUpdate(taskId, stringValue(object.summary) ?? stringValue(object.description) ?? "Task progress");
      }
      return;
    }
    if (subtype === "task_notification") {
      const taskId = stringValue(object.task_id);
      if (taskId) {
        const tool = openTools.get(taskId) ?? { id: taskId, name: "task" };
        callbacks.onToolUpdate(tool.id, stringValue(object.summary) ?? stringValue(object.output_file) ?? "Task completed");
        callbacks.onToolEnd(tool.id, stringValue(object.status) === "failed");
        openTools.delete(tool.id);
      }
      return;
    }
    if (subtype === "permission_denied") {
      const toolId = stringValue(object.tool_use_id) ?? `permission-${openTools.size + 1}`;
      const toolName = stringValue(object.tool_name) ?? "permission";
      callbacks.onToolStart(toolName, toolId);
      callbacks.onToolUpdate(toolId, stringValue(object.message) ?? stringValue(object.decision_reason) ?? "Permission denied");
      callbacks.onToolEnd(toolId, true);
    }
  }

  private handleResultMessage(message: SDKMessage, callbacks: AgentSessionCallbacks): string | null {
    const object = message as unknown as JsonObject;
    const usage = objectValue(object.usage);
    const input = numberValue(usage?.input_tokens) ?? numberValue(usage?.inputTokens) ?? 0;
    const output = numberValue(usage?.output_tokens) ?? numberValue(usage?.outputTokens) ?? 0;
    const cacheRead = numberValue(usage?.cache_read_input_tokens) ?? numberValue(usage?.cacheReadInputTokens) ?? numberValue(usage?.cache_read_tokens) ?? 0;
    const cacheWrite = numberValue(usage?.cache_creation_input_tokens) ?? numberValue(usage?.cacheCreationInputTokens) ?? numberValue(usage?.cache_write_tokens) ?? 0;
    const total = input + output + cacheRead + cacheWrite;
    if (total > 0) {
      this.cachedUsage = {
        input,
        output,
        cacheRead,
        cacheWrite,
        total,
        cost: numberValue(object.total_cost_usd) ?? undefined,
      };
      callbacks.onTurnComplete?.({
        inputTokens: input,
        cachedInputTokens: cacheRead,
        outputTokens: output,
      });
    }
    const errors = arrayValue(object.errors).map(stringValue).filter((value): value is string => Boolean(value));
    if (errors.length > 0) {
      const toolId = `claude-result-${this.currentThreadId ?? "session"}`;
      callbacks.onToolStart("result_error", toolId);
      callbacks.onToolUpdate(toolId, errors.join("\n"));
      callbacks.onToolEnd(toolId, true);
    }
    return stringValue(object.result);
  }

  private refreshFromState(options: { force?: boolean } = {}): void {
    if (!this.currentThreadId) {
      return;
    }
    const now = Date.now();
    if (!options.force && now - this.lastStateRefreshAt < ClaudeCodeSessionService.STATE_CACHE_TTL_MS) {
      return;
    }
    this.lastStateRefreshAt = now;
    const record = this.getRecord(this.currentThreadId);
    if (record) {
      this.applyRecord(record);
    }
  }

  private applyRecord(record: ClaudeCodeSessionRecord): void {
    this.currentThreadId = record.id;
    this.currentWorkspace = record.cwd || this.currentWorkspace;
    this.currentModel = record.model ?? this.currentModel;
    this.currentEffort = normalizeClaudeCodeEffort(record.reasoningEffort ?? this.currentEffort);
    this.cachedUsage = record.usage ?? this.cachedUsage;
  }

  private getRecord(threadId: string): ClaudeCodeSessionRecord | null {
    return getClaudeCodeSession(threadId, this.stateOptions());
  }

  private stateOptions() {
    return {
      configDir: this.config.claudeCodeConfigDir,
      workspace: this.currentWorkspace || this.config.workspace,
    };
  }

  private ensureIdle(action: string): void {
    if (this.processing) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private async buildPrompt(input: AgentPromptInput): Promise<string> {
    if (typeof input === "string") {
      return input;
    }
    const parts = [input.stagedFileInstructions, input.text].filter((part): part is string => Boolean(part?.trim()));
    const imagePaths = input.imagePaths ?? [];
    if (imagePaths.length > 0) {
      const attachments = await Promise.all(imagePaths.map(async (imagePath) => {
        const data = await readFile(imagePath);
        return `- ${imagePath} (${mimeTypeForImage(imagePath)}, ${data.byteLength} bytes)`;
      }));
      parts.push([
        "Attached image files are available on disk. Inspect them if needed:",
        ...attachments,
      ].join("\n"));
    }
    return parts.join("\n\n").trim() || "Please inspect the attached file(s).";
  }
}

function handleStreamEvent(
  message: SDKMessage,
  callbacks: AgentSessionCallbacks,
  contentBlockTools: Map<number, OpenTool>,
  openTools: Map<string, OpenTool>,
  fallbackId: string,
  toolCounter: number,
): { delta: string; toolCounter: number } {
  const event = objectValue((message as unknown as JsonObject).event);
  const eventType = stringValue(event?.type);
  if (eventType === "content_block_delta") {
    const delta = objectValue(event?.delta);
    const text = stringValue(delta?.text) ?? stringValue(delta?.partial_json) ?? "";
    if (text && stringValue(delta?.type) !== "input_json_delta") {
      callbacks.onTextDelta(text);
      return { delta: text, toolCounter };
    }
    const index = numberValue(event?.index);
    if (index !== null && text) {
      const tool = contentBlockTools.get(index);
      if (tool) callbacks.onToolUpdate(tool.id, text);
    }
    return { delta: "", toolCounter };
  }
  if (eventType === "content_block_start") {
    const index = numberValue(event?.index);
    const block = objectValue(event?.content_block);
    if (stringValue(block?.type) === "tool_use") {
      const toolName = stringValue(block?.name) ?? "tool";
      const toolId = stringValue(block?.id) ?? `${fallbackId}-${toolName}-${toolCounter}`;
      const tool = { id: toolId, name: toolName };
      if (index !== null) contentBlockTools.set(index, tool);
      openTools.set(tool.id, tool);
      callbacks.onToolStart(tool.name, tool.id);
    }
    return { delta: "", toolCounter };
  }
  if (eventType === "content_block_stop") {
    const index = numberValue(event?.index);
    const tool = index !== null ? contentBlockTools.get(index) : undefined;
    if (tool) {
      contentBlockTools.delete(index!);
      callbacks.onToolEnd(tool.id, false);
      openTools.delete(tool.id);
    }
  }
  return { delta: "", toolCounter };
}

function handleAssistantMessage(
  message: SDKMessage,
  callbacks: AgentSessionCallbacks,
  openTools: Map<string, OpenTool>,
  alreadyStreamedText: string,
): boolean {
  const root = message as unknown as JsonObject;
  const assistant = objectValue(root.message);
  const content = arrayValue(assistant?.content);
  let text = "";
  for (const part of content) {
    const block = objectValue(part);
    if (!block) continue;
    const blockType = stringValue(block.type);
    if (blockType === "text") {
      text += stringValue(block.text) ?? "";
    } else if (blockType === "tool_use") {
      const toolName = stringValue(block.name) ?? "tool";
      const toolId = stringValue(block.id) ?? `${toolName}-${openTools.size + 1}`;
      if (!openTools.has(toolId)) {
        const tool = { id: toolId, name: toolName };
        openTools.set(toolId, tool);
        callbacks.onToolStart(toolName, toolId);
      }
      const preview = stringifyPreview(block.input);
      if (preview) callbacks.onToolUpdate(toolId, preview);
    }
  }
  const delta = text && !alreadyStreamedText ? text : "";
  if (delta) {
    callbacks.onTextDelta(delta);
    return true;
  }
  return false;
}

function handleToolProgress(
  message: SDKMessage,
  callbacks: AgentSessionCallbacks,
  openTools: Map<string, OpenTool>,
): void {
  const object = message as unknown as JsonObject;
  const toolId = stringValue(object.tool_use_id);
  if (!toolId) return;
  const toolName = stringValue(object.tool_name) ?? "tool";
  if (!openTools.has(toolId)) {
    openTools.set(toolId, { id: toolId, name: toolName });
    callbacks.onToolStart(toolName, toolId);
  }
  const elapsed = numberValue(object.elapsed_time_seconds);
  callbacks.onToolUpdate(toolId, elapsed !== null ? `${toolName} running for ${Math.round(elapsed)}s` : `${toolName} running`);
}

function claudeToolApprovalPolicy(permissionMode: string, toolName: string): "allow" | "ask" | "deny" {
  if (permissionMode === "bypassPermissions") {
    return "allow";
  }
  if (isClaudeReadOnlyTool(toolName)) {
    return "allow";
  }
  if (permissionMode === "acceptEdits" && isClaudeEditTool(toolName)) {
    return "allow";
  }
  if (permissionMode === "dontAsk" || permissionMode === "plan") {
    return "deny";
  }
  return "ask";
}

function isClaudeReadOnlyTool(toolName: string): boolean {
  return ["Read", "Grep", "Glob", "LS", "TodoRead", "NotebookRead"].includes(toolName);
}

function isClaudeEditTool(toolName: string): boolean {
  return ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName);
}

function claudePermissionResult(
  choice: AgentApprovalChoice,
  toolUseId: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  if (choice === "no") {
    return {
      behavior: "deny",
      message: "Denied via NordRelay.",
      toolUseID: toolUseId,
      decisionClassification: "user_reject",
    };
  }
  return {
    behavior: "allow",
    toolUseID: toolUseId,
    updatedPermissions: choice === "persist" && suggestions?.length ? suggestions : undefined,
    decisionClassification: choice === "persist" ? "user_permanent" : "user_temporary",
  };
}

function permissionPrefixRule(suggestions: PermissionUpdate[] | undefined): string[] {
  if (!suggestions?.length) {
    return [];
  }
  return suggestions
    .flatMap((suggestion) => "rules" in suggestion ? suggestion.rules : [])
    .map((rule) => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
}

function approvalChoiceLabel(choice: AgentApprovalChoice): string {
  if (choice === "persist") {
    return "Proceed and remember";
  }
  if (choice === "no") {
    return "Denied";
  }
  return "Proceed";
}

function handleToolSummary(
  message: SDKMessage,
  callbacks: AgentSessionCallbacks,
  openTools: Map<string, OpenTool>,
): void {
  const object = message as unknown as JsonObject;
  const summary = stringValue(object.summary);
  for (const toolId of arrayValue(object.preceding_tool_use_ids).map(stringValue).filter((value): value is string => Boolean(value))) {
    const tool = openTools.get(toolId);
    if (summary) callbacks.onToolUpdate(toolId, summary);
    if (tool) {
      callbacks.onToolEnd(tool.id, false);
      openTools.delete(tool.id);
    }
  }
}

function defaultClaudeCodeModels(currentModel?: string): AgentModelRecord[] {
  const models: AgentModelRecord[] = [
    { slug: "sonnet", displayName: "sonnet", supportsThinking: true, supportsImages: true },
    { slug: "opus", displayName: "opus", supportsThinking: true, supportsImages: true },
    { slug: "haiku", displayName: "haiku", supportsThinking: true, supportsImages: true },
    { slug: "claude-sonnet-4-6", displayName: "claude-sonnet-4-6", supportsThinking: true, supportsImages: true },
    { slug: "claude-opus-4-7", displayName: "claude-opus-4-7", supportsThinking: true, supportsImages: true },
    { slug: "claude-3-5-haiku-latest", displayName: "claude-3-5-haiku-latest", supportsThinking: false, supportsImages: true },
  ];
  if (currentModel && !models.some((model) => model.slug === currentModel)) {
    models.unshift({ slug: currentModel, displayName: currentModel, supportsThinking: true, supportsImages: true });
  }
  return models;
}

function normalizeClaudeCodeEffort(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (CLAUDE_CODE_EFFORT_LEVELS.includes(value as never)) {
    return value;
  }
  throw new Error(`Unsupported Claude Code effort: ${value}`);
}

function allowsClaudeCodeUnsafeProfile(profileId: string | undefined, includeUnsafe: boolean): boolean {
  return includeUnsafe || profileId === "bypass-permissions";
}

function isClaudeEffortLevel(value: string): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function sessionIdOf(message: SDKMessage): string | null {
  return stringValue((message as unknown as JsonObject).session_id) ?? stringValue((message as unknown as JsonObject).sessionId);
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifyPreview(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  try {
    const text = JSON.stringify(value);
    return text.length <= 700 ? text : `${text.slice(0, 697)}...`;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

function mimeTypeForImage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
