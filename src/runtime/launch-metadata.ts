import type { AgentId } from "../agents/shared/agent.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "../agents/codex/codex-launch.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ContextMetadata } from "../state/session-registry.js";

export function launchInfoFromMetadata(config: ConnectorConfig, meta: ContextMetadata, agentId: AgentId): {
  id: string;
  label: string;
  behavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafe: boolean;
} {
  const requestedId = meta.activeLaunchProfileId ?? meta.launchProfileId ?? config.defaultLaunchProfileId;
  const configuredById = agentId === "codex" ? findLaunchProfile(config.launchProfiles, requestedId) : undefined;
  const explicitSandboxMode = meta.sandboxMode?.trim();
  const explicitApprovalPolicy = meta.approvalPolicy?.trim();
  const explicitBehavior = explicitSandboxMode && explicitApprovalPolicy
    ? `${explicitSandboxMode} / ${explicitApprovalPolicy}`
    : "";
  const configuredByBehavior = explicitBehavior && agentId === "codex"
    ? config.launchProfiles.find((profile) => formatLaunchProfileBehavior(profile) === explicitBehavior)
    : undefined;
  const configured = configuredByBehavior ?? (
    configuredById && (!explicitBehavior || formatLaunchProfileBehavior(configuredById) === explicitBehavior)
      ? configuredById
      : undefined
  );
  const metadataBehavior = meta.launchProfileBehavior?.trim();
  const metadataBehaviorMatches = Boolean(metadataBehavior && (!explicitBehavior || metadataBehavior === explicitBehavior));
  const sandboxMode = explicitSandboxMode ?? configured?.sandboxMode ?? "-";
  return {
    id: configured?.id ?? (explicitBehavior ? "attached-thread" : requestedId),
    label: metadataBehaviorMatches ? meta.launchProfileLabel ?? configured?.label ?? requestedId : configured?.label ?? (explicitBehavior ? "Attached Thread" : requestedId),
    behavior: explicitBehavior || (metadataBehaviorMatches ? metadataBehavior : "") || (configured ? formatLaunchProfileBehavior(configured) : "unknown permissions"),
    sandboxMode,
    approvalPolicy: explicitApprovalPolicy ?? configured?.approvalPolicy ?? "-",
    unsafe: sandboxMode === "danger-full-access" || (meta.unsafeLaunch ?? configured?.unsafe ?? false),
  };
}
