export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexApprovalsReviewer = "user" | "auto_review";

export interface CodexLaunchProfile {
  id: string;
  label: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  unsafe: boolean;
}

export const DEFAULT_LAUNCH_PROFILE_ID = "default";

export function isCodexSandboxMode(value: string): value is CodexSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

export function isCodexApprovalPolicy(value: string): value is CodexApprovalPolicy {
  return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted";
}

export function createLaunchProfile(input: {
  id: string;
  label: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
}): CodexLaunchProfile {
  return {
    ...input,
    unsafe: isUnsafeLaunchProfile(input.sandboxMode),
  };
}

export function createDefaultLaunchProfile(
  sandboxMode: CodexSandboxMode,
  approvalPolicy: CodexApprovalPolicy,
): CodexLaunchProfile {
  return createLaunchProfile({
    id: DEFAULT_LAUNCH_PROFILE_ID,
    label: "Default",
    sandboxMode,
    approvalPolicy,
  });
}

export function createBuiltinLaunchProfiles(
  defaultProfile: CodexLaunchProfile,
  options?: { includeFullAccess?: boolean },
): CodexLaunchProfile[] {
  const profiles = [
    defaultProfile,
    createLaunchProfile({
      id: "readonly",
      label: "Read Only",
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }),
    createLaunchProfile({
      id: "review",
      label: "Review",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    }),
  ];

  if (options?.includeFullAccess) {
    profiles.push(
      createLaunchProfile({
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }),
    );
  }

  return profiles;
}

export function createCodexPermissionProfile(profileId: string): CodexLaunchProfile | null {
  if (profileId === "ask-for-approval" || profileId === "review") {
    return createLaunchProfile({
      id: "ask-for-approval",
      label: "Ask for approval",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
  }
  if (profileId === "approve-for-me") {
    return createLaunchProfile({
      id: "approve-for-me",
      label: "Approve for me",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  }
  if (profileId === "full-access") {
    return createLaunchProfile({
      id: "full-access",
      label: "Full Access",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });
  }
  return null;
}

export function codexPermissionProfiles(): CodexLaunchProfile[] {
  return [
    createCodexPermissionProfile("ask-for-approval")!,
    createCodexPermissionProfile("approve-for-me")!,
    createCodexPermissionProfile("full-access")!,
  ];
}

export function parseLaunchProfilesJson(raw: string): CodexLaunchProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid CODEX_LAUNCH_PROFILES_JSON: expected a JSON array");
  }

  return parsed.map((entry, index) => parseLaunchProfileEntry(entry, index));
}

export function findLaunchProfile(
  profiles: CodexLaunchProfile[],
  profileId: string | undefined,
): CodexLaunchProfile | undefined {
  if (!profileId) {
    return undefined;
  }
  return profiles.find((profile) => profile.id === profileId);
}

export function formatLaunchProfileBehavior(profile: Pick<CodexLaunchProfile, "sandboxMode" | "approvalPolicy">): string {
  return `${profile.sandboxMode} / ${profile.approvalPolicy}`;
}

export function formatLaunchProfileLabel(profile: CodexLaunchProfile, isCurrent = false): string {
  const prefix = profile.unsafe ? "⚠️" : "🛡️";
  const selected = isCurrent ? " ✓" : "";
  return `${prefix} ${profile.label} · ${formatLaunchProfileBehavior(profile)}${selected}`;
}

export function isUnsafeLaunchProfile(
  profileOrSandboxMode: Pick<CodexLaunchProfile, "sandboxMode"> | CodexSandboxMode,
): boolean {
  const sandboxMode =
    typeof profileOrSandboxMode === "string" ? profileOrSandboxMode : profileOrSandboxMode.sandboxMode;
  return sandboxMode === "danger-full-access";
}

function parseLaunchProfileEntry(entry: unknown, index: number): CodexLaunchProfile {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON entry at index ${index}: expected an object`,
    );
  }

  const rawId = readStringField(entry, "id", index);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(rawId)) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON entry at index ${index}: id must match /^[a-z0-9][a-z0-9_-]*$/`,
    );
  }

  const rawLabel = readStringField(entry, "label", index);
  const rawSandboxMode = readStringField(entry, "sandboxMode", index);
  if (!isCodexSandboxMode(rawSandboxMode)) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON entry at index ${index}: unsupported sandboxMode "${rawSandboxMode}"`,
    );
  }

  const rawApprovalPolicy = readStringField(entry, "approvalPolicy", index);
  if (!isCodexApprovalPolicy(rawApprovalPolicy)) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON entry at index ${index}: unsupported approvalPolicy "${rawApprovalPolicy}"`,
    );
  }

  const approvalsReviewer = readOptionalApprovalsReviewer(entry);
  return createLaunchProfile({
    id: rawId,
    label: rawLabel,
    sandboxMode: rawSandboxMode,
    approvalPolicy: rawApprovalPolicy,
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
  });
}

function readOptionalApprovalsReviewer(entry: object): CodexApprovalsReviewer | undefined {
  const value = Reflect.get(entry, "approvalsReviewer") ?? Reflect.get(entry, "approvals_reviewer");
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "user" || value === "auto_review") {
    return value;
  }
  throw new Error(
    'Invalid CODEX_LAUNCH_PROFILES_JSON entry: approvalsReviewer must be "user" or "auto_review"',
  );
}

function readStringField(entry: object, field: string, index: number): string {
  const value = Reflect.get(entry, field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid CODEX_LAUNCH_PROFILES_JSON entry at index ${index}: missing ${field}`,
    );
  }
  return value.trim();
}
