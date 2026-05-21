import type { ConnectorConfig } from "../../core/config.js";
import type {
  AgentApprovalChoice,
  AgentApprovalRequest,
  AgentSessionService,
} from "./agent.js";
import { getExternalSnapshotForSession } from "./agent-activity.js";
import {
  respondToCodexExternalApproval,
  type CodexExternalApprovalResult,
} from "../codex/codex-external-approval.js";

export type AgentExternalApprovalResult = CodexExternalApprovalResult;

export function findPendingExternalApproval(
  session: AgentSessionService,
  config: ConnectorConfig,
  approvalId?: string,
): AgentApprovalRequest | null {
  const snapshot = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
  const approvals = snapshot?.pendingApprovals ?? [];
  if (!approvalId) {
    return approvals[0] ?? null;
  }
  return approvals.find((approval) => approval.id === approvalId) ?? null;
}

export function respondToExternalApproval(
  session: AgentSessionService,
  config: ConnectorConfig,
  approvalId: string | undefined,
  choice: AgentApprovalChoice,
): AgentExternalApprovalResult {
  const info = session.getInfo();
  const approval = findPendingExternalApproval(session, config, approvalId);
  if (!approval) {
    return {
      ok: false,
      status: "not-found",
      message: "No pending action-required prompt was found for this session.",
    };
  }

  if (info.agentId !== "codex") {
    return {
      ok: false,
      status: "unsupported",
      message: `${info.agentLabel} external approval responses are not supported yet.`,
    };
  }

  return respondToCodexExternalApproval(approval, config, choice);
}
