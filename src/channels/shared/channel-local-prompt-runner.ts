import type {
  AgentSessionInfo,
  AgentSessionService,
} from "../../agents/shared/agent.js";
import { agentLabel } from "../../agents/shared/agent.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import type { ConnectorConfig } from "../../core/config.js";
import { evaluateWorkspacePolicy } from "../../core/workspace-policy.js";
import type { RelayArtifactService } from "../../runtime/relay-artifact-service.js";
import type { PromptEnvelope, PromptStore } from "../../state/prompt-store.js";
import type { WebActivityActor } from "../../web/web-state.js";
import { capabilitiesOf, renderPromptFailure, type TurnProgress } from "./bot-rendering.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import type { ChannelActivityInput, ChannelAuditInput } from "./channel-bridge-controller.js";
import { createChannelPromptEngine, type ChannelPromptEngineOptions } from "./channel-prompt-engine.js";
import type { ChannelContextKey } from "./context-key.js";

export interface ChannelLocalPromptRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
}

export interface ChannelLocalPromptBusyState {
  processing: boolean;
}

export interface RunChannelLocalPromptOptions<TRequest extends ChannelLocalPromptRequest> {
  source: "discord" | "slack" | "matrix";
  label: string;
  config: ConnectorConfig;
  runtime: ChannelRuntime;
  request: TRequest;
  session: AgentSessionService;
  envelope: PromptEnvelope;
  busyState: ChannelLocalPromptBusyState;
  promptStore: PromptStore;
  turnProgress: Map<ChannelContextKey, TurnProgress>;
  artifactService: RelayArtifactService;
  abortActionPrefix: string;
  editDebounceMs: number;
  typingIntervalMs: number;
  trimMessage: ChannelPromptEngineOptions["trimMessage"];
  splitMessage: ChannelPromptEngineOptions["splitMessage"];
  actor: WebActivityActor;
  appendActivity(request: TRequest, input: ChannelActivityInput): unknown;
  audit(request: TRequest, input: ChannelAuditInput): unknown;
  checkAgentAuthStatus(info: AgentSessionInfo): Promise<{ authenticated: boolean; detail: string }>;
  ensureActiveThread(request: TRequest, session: AgentSessionService): Promise<void>;
  updateSession(request: TRequest, session: AgentSessionService): void;
  sendRecentArtifacts(engineStartedAt: Date, turnId: string): Promise<void>;
  onResponseMessage?(messageId: string): void;
  drainQueue(): Promise<void>;
}

export async function runChannelLocalPrompt<TRequest extends ChannelLocalPromptRequest>(
  options: RunChannelLocalPromptOptions<TRequest>,
): Promise<void> {
  const {
    request,
    session,
    envelope,
    busyState,
    promptStore,
    turnProgress,
    config,
  } = options;
  busyState.processing = true;
  const engine = createChannelPromptEngine({
    runtime: options.runtime,
    context: request.context,
    contextKey: request.contextKey,
    promptDescription: envelope.description,
    abortAction: `${options.abortActionPrefix}_abort:${request.contextKey}`,
    trimMessage: options.trimMessage,
    splitMessage: options.splitMessage,
    editDebounceMs: options.editDebounceMs,
    typingIntervalMs: options.typingIntervalMs,
    toolVerbosity: config.toolVerbosity,
    logPrefix: options.label,
    onResponseMessage: options.onResponseMessage,
    onToolStart: (toolName) => options.appendActivity(request, {
      status: "running",
      type: "tool_started",
      prompt: envelope.description,
      detail: toolName,
      threadId: session.getInfo().threadId,
      workspace: session.getInfo().workspace,
      agentId: session.getInfo().agentId,
    }),
    onToolEnd: (isError) => options.appendActivity(request, {
      status: isError ? "failed" : "completed",
      type: isError ? "tool_failed" : "tool_completed",
      prompt: envelope.description,
      detail: "tool",
      threadId: session.getInfo().threadId,
      workspace: session.getInfo().workspace,
      agentId: session.getInfo().agentId,
    }),
  });
  const progress = engine.progress;
  turnProgress.set(request.contextKey, progress);
  engine.start();

  try {
    const info = session.getInfo();
    if ((info.capabilities ?? capabilitiesOf(info)).auth) {
      const auth = await options.checkAgentAuthStatus(info);
      if (!auth.authenticated) {
        throw new Error(`${agentLabel(info.agentId)} is not authenticated: ${auth.detail}`);
      }
    }
    await options.ensureActiveThread(request, session);
    const currentInfo = session.getInfo();
    const workspacePolicy = evaluateWorkspacePolicy(currentInfo.workspace, config);
    if (!workspacePolicy.allowed) {
      throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
    }

    promptStore.setLastPrompt(request.contextKey, envelope);
    options.appendActivity(request, promptActivity("running", "prompt_started", envelope, currentInfo));
    options.audit(request, promptAudit("prompt_started", "ok", envelope, currentInfo));

    await session.prompt(envelope.input, engine.callbacks);
    options.updateSession(request, session);
    progress.status = "completed";
    progress.completedAt = Date.now();
    progress.updatedAt = progress.completedAt;
    await engine.finalize();
    const artifactInfo = session.getInfo();
    await options.artifactService.persistWorkspaceArtifactsForTurn(artifactInfo.workspace, engine.turnId, new Date(engine.startedAt), {
      source: options.source,
      agentId: artifactInfo.agentId,
      threadId: artifactInfo.threadId,
      workspace: artifactInfo.workspace,
      contextKey: request.contextKey,
      correlationId: envelope.correlationId,
      prompt: envelope.description,
      actor: options.actor,
      turnStartedAt: new Date(engine.startedAt).toISOString(),
    });
    await options.sendRecentArtifacts(new Date(engine.startedAt), engine.turnId);
    options.appendActivity(request, {
      ...promptActivity("completed", "prompt_completed", envelope, session.getInfo()),
      durationMs: Date.now() - engine.startedAt,
    });
    options.audit(request, promptAudit("prompt_completed", "ok", envelope, session.getInfo()));
  } catch (error) {
    progress.status = "failed";
    progress.completedAt = Date.now();
    progress.updatedAt = progress.completedAt;
    progress.error = friendlyErrorText(error);
    await engine.fail(renderPromptFailure(engine.accumulatedText(), error));
    options.appendActivity(request, {
      ...promptActivity("failed", "prompt_failed", envelope, session.getInfo()),
      detail: friendlyErrorText(error),
      durationMs: Date.now() - engine.startedAt,
    });
    options.audit(request, {
      ...promptAudit("prompt_failed", "failed", envelope, session.getInfo()),
      detail: friendlyErrorText(error),
    });
  } finally {
    engine.stop();
    busyState.processing = false;
    await options.drainQueue().catch((error) => console.error(`Failed to drain ${options.label} queue:`, error));
  }
}

function promptActivity(
  status: "running" | "completed" | "failed",
  type: "prompt_started" | "prompt_completed" | "prompt_failed",
  envelope: PromptEnvelope,
  info: AgentSessionInfo,
): ChannelActivityInput {
  return {
    status,
    type,
    prompt: envelope.description,
    threadId: info.threadId,
    workspace: info.workspace,
    agentId: info.agentId,
  };
}

function promptAudit(
  action: "prompt_started" | "prompt_completed" | "prompt_failed",
  status: "ok" | "failed",
  envelope: PromptEnvelope,
  info: AgentSessionInfo,
): ChannelAuditInput {
  return {
    action,
    status,
    agentId: info.agentId,
    threadId: info.threadId,
    workspace: info.workspace,
    description: envelope.description,
  };
}
