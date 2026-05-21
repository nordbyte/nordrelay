import { createHash } from "node:crypto";

import type { AgentApprovalChoice, AgentApprovalRequest, AgentId } from "./agent.js";

export interface AgentExternalApprovalResult {
  ok: boolean;
  status: "submitted" | "disabled" | "unsupported" | "not-found" | "blocked" | "failed";
  message: string;
  ttyPath?: string;
  pid?: number;
}

export interface PendingAgentApprovalRegistration {
  agentId: AgentId;
  agentLabel: string;
  threadId: string;
  callId: string;
  toolName: string;
  command: string;
  workdir?: string | null;
  reason?: string | null;
  prefixRule?: string[];
  sandboxPermissions?: string | null;
  turnId?: string | null;
  sourcePath?: string;
  requestedAt?: Date | null;
  respond: (choice: AgentApprovalChoice, request: AgentApprovalRequest) => Promise<AgentExternalApprovalResult> | AgentExternalApprovalResult;
}

interface PendingAgentApprovalEntry {
  agentId: AgentId;
  agentLabel: string;
  threadId: string;
  request: AgentApprovalRequest;
  respond: PendingAgentApprovalRegistration["respond"];
}

const pendingApprovals = new Map<string, PendingAgentApprovalEntry>();
const pendingApprovalIdsByCall = new Map<string, string>();

export function registerPendingAgentApproval(input: PendingAgentApprovalRegistration): AgentApprovalRequest {
  const callKey = pendingApprovalCallKey(input.agentId, input.threadId, input.callId);
  const existingId = pendingApprovalIdsByCall.get(callKey);
  if (existingId) {
    const existing = pendingApprovals.get(existingId);
    if (existing) {
      return existing.request;
    }
    pendingApprovalIdsByCall.delete(callKey);
  }

  const id = pendingApprovalId(input.agentId, input.threadId, input.callId);
  const request: AgentApprovalRequest = {
    id,
    callId: input.callId,
    toolName: input.toolName,
    command: input.command,
    workdir: input.workdir ?? null,
    reason: input.reason ?? null,
    prefixRule: input.prefixRule ?? [],
    sandboxPermissions: input.sandboxPermissions ?? null,
    lineNumber: Date.now(),
    turnId: input.turnId ?? null,
    requestedAt: input.requestedAt ?? new Date(),
    sourcePath: input.sourcePath ?? `memory:${input.agentId}:${input.threadId}`,
  };
  pendingApprovals.set(id, {
    agentId: input.agentId,
    agentLabel: input.agentLabel,
    threadId: input.threadId,
    request,
    respond: input.respond,
  });
  pendingApprovalIdsByCall.set(callKey, id);
  return request;
}

export function listPendingAgentApprovals(agentId: AgentId, threadId: string): AgentApprovalRequest[] {
  return [...pendingApprovals.values()]
    .filter((entry) => entry.agentId === agentId && entry.threadId === threadId)
    .map((entry) => entry.request)
    .sort((left, right) => (left.requestedAt?.getTime() ?? 0) - (right.requestedAt?.getTime() ?? 0));
}

export function findPendingRegisteredApproval(approvalId: string | undefined): AgentApprovalRequest | null {
  if (!approvalId) {
    return null;
  }
  return pendingApprovals.get(approvalId)?.request ?? null;
}

export async function respondToRegisteredApproval(
  approvalId: string | undefined,
  choice: AgentApprovalChoice,
): Promise<AgentExternalApprovalResult | null> {
  if (!approvalId) {
    return null;
  }
  const entry = pendingApprovals.get(approvalId);
  if (!entry) {
    return null;
  }
  let result: AgentExternalApprovalResult;
  try {
    result = await entry.respond(choice, entry.request);
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.ok || result.status === "submitted") {
    removePendingAgentApproval(approvalId);
  }
  return result;
}

export function removePendingAgentApproval(approvalId: string | undefined): void {
  if (!approvalId) {
    return;
  }
  const entry = pendingApprovals.get(approvalId);
  pendingApprovals.delete(approvalId);
  if (entry) {
    pendingApprovalIdsByCall.delete(pendingApprovalCallKey(entry.agentId, entry.threadId, entry.request.callId));
  }
}

export function clearPendingAgentApprovals(agentId: AgentId, threadId: string): void {
  for (const [approvalId, entry] of pendingApprovals.entries()) {
    if (entry.agentId === agentId && entry.threadId === threadId) {
      removePendingAgentApproval(approvalId);
    }
  }
}

function pendingApprovalCallKey(agentId: AgentId, threadId: string, callId: string): string {
  return `${agentId}\0${threadId}\0${callId}`;
}

function pendingApprovalId(agentId: AgentId, threadId: string, callId: string): string {
  return createHash("sha256")
    .update(pendingApprovalCallKey(agentId, threadId, callId))
    .digest("hex")
    .slice(0, 16);
}
