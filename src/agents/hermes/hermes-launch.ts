import type { AgentLaunchProfileRecord } from "../shared/agent.js";
import { createLaunchProfile, type CodexLaunchProfile } from "../codex/codex-launch.js";

export type HermesApprovalChoice = "once" | "session" | "always" | "deny";

export interface HermesLaunchProfile extends AgentLaunchProfileRecord {
  approvalChoice: HermesApprovalChoice;
  instructions?: string;
}

export const HERMES_LAUNCH_PROFILES: HermesLaunchProfile[] = [
  {
    id: "default",
    label: "Default",
    behavior: "Hermes API server defaults / auto-approve once",
    unsafe: false,
    approvalChoice: "once",
  },
  {
    id: "safe",
    label: "Safe",
    behavior: "normal tools / deny dangerous approvals",
    unsafe: false,
    approvalChoice: "deny",
    instructions: "Do not perform destructive operations. If a dangerous action requires approval, stop and explain what needs approval.",
  },
  {
    id: "readonly",
    label: "Read Only",
    behavior: "read-only intent / deny dangerous approvals",
    unsafe: false,
    approvalChoice: "deny",
    instructions: "Treat this run as read-only. Inspect, explain, and plan, but do not modify files or execute destructive commands.",
  },
  {
    id: "yolo",
    label: "YOLO",
    behavior: "auto-approve for session",
    unsafe: true,
    approvalChoice: "session",
    instructions: "Proceed autonomously within the configured Hermes API-server runtime.",
  },
];

export function listHermesLaunchProfiles(): AgentLaunchProfileRecord[] {
  return HERMES_LAUNCH_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    behavior: profile.behavior,
    unsafe: profile.unsafe,
  }));
}

export function findHermesLaunchProfile(profileId: string | undefined): HermesLaunchProfile {
  const profile = HERMES_LAUNCH_PROFILES.find((candidate) => candidate.id === profileId);
  if (profile) {
    return profile;
  }
  return HERMES_LAUNCH_PROFILES[0]!;
}

export function hermesProfileAsLaunchProfile(profile: HermesLaunchProfile): CodexLaunchProfile {
  return createLaunchProfile({
    id: profile.id,
    label: profile.label,
    sandboxMode: profile.unsafe ? "danger-full-access" : "workspace-write",
    approvalPolicy: profile.unsafe ? "never" : "on-request",
  });
}
