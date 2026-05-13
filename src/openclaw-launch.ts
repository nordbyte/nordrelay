import type { AgentLaunchProfileRecord } from "./agent.js";
import { createLaunchProfile, type CodexLaunchProfile } from "./codex-launch.js";

export interface OpenClawLaunchProfile extends AgentLaunchProfileRecord {
  local: boolean;
  deliver: boolean;
  instructions?: string;
}

export const OPENCLAW_LAUNCH_PROFILES: OpenClawLaunchProfile[] = [
  {
    id: "default",
    label: "Default",
    behavior: "OpenClaw Gateway defaults",
    unsafe: false,
    local: false,
    deliver: false,
  },
  {
    id: "safe",
    label: "Safe",
    behavior: "non-destructive intent / Gateway defaults",
    unsafe: false,
    local: false,
    deliver: false,
    instructions: "Do not perform destructive operations. If a risky action is required, stop and explain the required approval.",
  },
  {
    id: "readonly",
    label: "Read Only",
    behavior: "inspect-only intent / no file changes",
    unsafe: false,
    local: false,
    deliver: false,
    instructions: "Treat this run as read-only. Inspect, explain, and plan, but do not modify files or execute destructive commands.",
  },
  {
    id: "local",
    label: "Local",
    behavior: "force OpenClaw embedded local run",
    unsafe: false,
    local: true,
    deliver: false,
  },
  {
    id: "deliver",
    label: "Deliver",
    behavior: "OpenClaw Gateway delivery enabled",
    unsafe: false,
    local: false,
    deliver: true,
  },
];

export function listOpenClawLaunchProfiles(): AgentLaunchProfileRecord[] {
  return OPENCLAW_LAUNCH_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    behavior: profile.behavior,
    unsafe: profile.unsafe,
  }));
}

export function findOpenClawLaunchProfile(profileId: string | undefined): OpenClawLaunchProfile {
  const profile = OPENCLAW_LAUNCH_PROFILES.find((candidate) => candidate.id === profileId);
  return profile ?? OPENCLAW_LAUNCH_PROFILES[0]!;
}

export function openClawProfileAsLaunchProfile(profile: OpenClawLaunchProfile): CodexLaunchProfile {
  return createLaunchProfile({
    id: profile.id,
    label: profile.label,
    sandboxMode: profile.unsafe ? "danger-full-access" : "workspace-write",
    approvalPolicy: "never",
  });
}
