import type { WorkflowStep } from "../state/workflow-store.js";
import { RemoteRelayClient } from "../peers/peer-client.js";
import type { TraceDetailDto } from "./relay-runtime-types.js";
import type { WebActivityActor } from "../web/web-state.js";

const PEER_WORKFLOW_POLL_MS = 2_000;
const PEER_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export interface PeerWorkflowClient {
  webProxy(peerId: string, payload: { method: string; path: string; body?: Record<string, unknown>; query?: Record<string, unknown> }, actor?: WebActivityActor, sourceContextKey?: string): Promise<unknown>;
}

export async function runPeerWorkflowPromptStep(options: {
  client?: PeerWorkflowClient;
  peerId: string;
  step: WorkflowStep;
  prompt: string;
  correlationId: string;
  actor?: WebActivityActor;
  sourceContextKey?: string;
  timeoutMs?: number;
}): Promise<{ status: string; detail?: string }> {
  const client: PeerWorkflowClient = options.client ?? new RemoteRelayClient();
  const request = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>, query?: Record<string, unknown>) =>
    await client.webProxy(options.peerId, { method, path, body, query }, options.actor, options.sourceContextKey);

  if (options.step.sessionMode === "attach") {
    if (!options.step.threadId) throw new Error(`Workflow step ${options.step.name} needs a thread id.`);
    if (options.step.agentId) await request("POST", "/api/agent", { agentId: options.step.agentId });
    await request("POST", "/api/sessions/attach", { threadId: options.step.threadId });
  } else if (options.step.sessionMode === "new") {
    await request("POST", "/api/sessions/new", {
      agentId: options.step.agentId,
      workspace: options.step.workspace,
      workspaceMode: options.step.workspaceMode,
      model: options.step.model,
      reasoningEffort: options.step.reasoningEffort,
      launchProfileId: options.step.launchProfileId,
    });
  } else if (options.step.agentId) {
    await request("POST", "/api/agent", { agentId: options.step.agentId });
  }

  await request("POST", "/api/prompt", { text: options.prompt, correlationId: options.correlationId });
  return await waitForPeerPromptTrace({
    client,
    peerId: options.peerId,
    correlationId: options.correlationId,
    actor: options.actor,
    sourceContextKey: options.sourceContextKey,
    timeoutMs: options.timeoutMs ?? PEER_WORKFLOW_TIMEOUT_MS,
  });
}

async function waitForPeerPromptTrace(options: {
  client: PeerWorkflowClient;
  peerId: string;
  correlationId: string;
  actor?: WebActivityActor;
  sourceContextKey?: string;
  timeoutMs: number;
}): Promise<{ status: string; detail?: string }> {
  const deadline = Date.now() + Math.max(1_000, options.timeoutMs);
  let lastTrace: TraceDetailDto | null = null;
  while (Date.now() < deadline) {
    const raw = await options.client.webProxy(options.peerId, {
      method: "GET",
      path: "/api/trace",
      query: { correlationId: options.correlationId },
    }, options.actor, options.sourceContextKey);
    const trace = raw as TraceDetailDto;
    lastTrace = trace;
    const terminal = terminalPromptEvent(trace);
    if (terminal) {
      if (terminal.status === "failed" || terminal.status === "aborted") {
        throw new Error(terminal.detail || `Peer workflow step ${terminal.status}.`);
      }
      return { status: terminal.status, detail: terminal.detail };
    }
    await delay(PEER_WORKFLOW_POLL_MS);
  }
  throw new Error(`Peer workflow step timed out waiting for correlation ${options.correlationId}. Last status: ${lastTrace?.summary?.status ?? "unknown"}`);
}

function terminalPromptEvent(trace: TraceDetailDto): { status: string; detail?: string } | null {
  const events = [...(trace.activity ?? [])].reverse();
  const event = events.find((candidate) =>
    candidate.type === "prompt_completed" ||
    candidate.type === "prompt_failed" ||
    candidate.type === "prompt_aborted"
  );
  if (!event) return null;
  if (event.type === "prompt_completed") return { status: "completed", detail: event.detail };
  if (event.type === "prompt_aborted") return { status: "aborted", detail: event.detail };
  return { status: "failed", detail: event.detail };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
