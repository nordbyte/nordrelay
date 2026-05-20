import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { UserStore } from "../../access/user-management.js";
import { MatrixClient } from "./matrix-client.js";

export interface MatrixDiagnosticCheck {
  status: "ok" | "warn" | "error" | "skipped";
  label: string;
  detail: string;
}

export interface MatrixRoomDiagnostic {
  roomId: string;
  homeserver?: string;
  title?: string;
  status: MatrixDiagnosticCheck["status"];
  detail: string;
}

export interface MatrixDiagnostics {
  enabled: boolean;
  configured: boolean;
  generatedAt: string;
  checks: MatrixDiagnosticCheck[];
  auth?: {
    ok: boolean;
    userId?: string;
    deviceId?: string;
    detail: string;
  };
  registeredRooms: number;
  roomChecks: MatrixRoomDiagnostic[];
  rateLimit?: {
    queued: number;
    running: number;
    retries: number;
    rateLimitHits: number;
    lastRateLimitAt?: string;
    lastRetryAfterSeconds?: number;
  };
}

export async function collectMatrixDiagnostics(input: {
  config: ConnectorConfig;
  userStore?: UserStore;
  roomProbeLimit?: number;
  timeoutMs?: number;
  rateLimit?: MatrixDiagnostics["rateLimit"];
}): Promise<MatrixDiagnostics> {
  const { config } = input;
  const checks: MatrixDiagnosticCheck[] = [];
  const userStore = input.userStore ?? new UserStore();
  const registeredRooms = userStore.snapshot().matrixRooms;
  const configured = Boolean(config.matrixHomeserverUrl && config.matrixAccessToken && config.matrixUserId);

  checks.push(check(Boolean(config.matrixHomeserverUrl), "Homeserver URL", "MATRIX_HOMESERVER_URL is configured.", "MATRIX_HOMESERVER_URL is missing."));
  checks.push(check(Boolean(config.matrixAccessToken), "Access token", "MATRIX_ACCESS_TOKEN is configured.", "MATRIX_ACCESS_TOKEN is missing."));
  checks.push(check(Boolean(config.matrixUserId), "Bot user ID", "MATRIX_USER_ID is configured.", "MATRIX_USER_ID is missing."));
  checks.push({
    status: registeredRooms.length > 0 ? "ok" : "warn",
    label: "Registered rooms",
    detail: registeredRooms.length > 0
      ? `${registeredRooms.length} Matrix room access record(s) configured.`
      : "No Matrix rooms are registered yet. Admins can use /register_channel or the WebUI Users page.",
  });
  checks.push({
    status: config.matrixAllowedRoomIds.length > 0 ? "ok" : "warn",
    label: "Environment room allow-list",
    detail: config.matrixAllowedRoomIds.length > 0
      ? `Room allow-list: ${config.matrixAllowedRoomIds.length}.`
      : "No MATRIX_ALLOWED_ROOM_IDS is set. User/group permissions still apply.",
  });
  checks.push({
    status: "warn",
    label: "Encrypted rooms",
    detail: "End-to-end encrypted Matrix rooms are not decrypted by NordRelay. Use an unencrypted bot room or an application-service bridge.",
  });

  let auth: MatrixDiagnostics["auth"];
  const roomChecks: MatrixRoomDiagnostic[] = [];
  if (config.matrixEnabled && configured) {
    const client = new MatrixClient({
      homeserverUrl: config.matrixHomeserverUrl!,
      accessToken: config.matrixAccessToken!,
      userId: config.matrixUserId!,
      deviceId: config.matrixDeviceId,
      syncTimeoutMs: config.matrixSyncTimeoutMs,
      pollTimeoutMs: config.matrixPollTimeoutMs,
    });
    const timeoutMs = input.timeoutMs ?? 4_000;
    try {
      const whoami = await withTimeout(client.whoami(), timeoutMs);
      auth = {
        ok: whoami.user_id === config.matrixUserId,
        userId: whoami.user_id,
        deviceId: whoami.device_id,
        detail: whoami.user_id === config.matrixUserId
          ? "Matrix whoami succeeded."
          : `Matrix token belongs to ${whoami.user_id}, expected ${config.matrixUserId}.`,
      };
      checks.push({ status: auth.ok ? "ok" : "error", label: "Matrix whoami", detail: auth.detail });
    } catch (error) {
      auth = { ok: false, detail: friendlyErrorText(error) };
      checks.push({ status: "error", label: "Matrix whoami", detail: auth.detail });
    }

    let joinedRooms: string[] = [];
    try {
      joinedRooms = await withTimeout(client.joinedRooms(), timeoutMs);
      checks.push({ status: "ok", label: "Joined rooms", detail: `${joinedRooms.length} joined Matrix room(s).` });
    } catch (error) {
      checks.push({ status: "warn", label: "Joined rooms", detail: friendlyErrorText(error) });
    }

    for (const room of registeredRooms.slice(0, input.roomProbeLimit ?? 5)) {
      roomChecks.push({
        roomId: room.roomId,
        homeserver: room.homeserver,
        title: room.title,
        status: joinedRooms.includes(room.roomId) ? "ok" : "warn",
        detail: joinedRooms.includes(room.roomId)
          ? "Bot user is joined to this Matrix room."
          : "Bot user is not currently joined to this Matrix room.",
      });
    }
  } else if (config.matrixEnabled) {
    checks.push({ status: "error", label: "Matrix API probes", detail: "Cannot run Matrix API probes without homeserver URL, access token, and bot user id." });
  } else {
    checks.push({ status: "skipped", label: "Matrix API probes", detail: "Matrix adapter is disabled." });
  }

  return {
    enabled: config.matrixEnabled,
    configured,
    generatedAt: new Date().toISOString(),
    checks,
    auth,
    registeredRooms: registeredRooms.length,
    roomChecks,
    rateLimit: input.rateLimit,
  };
}

function check(condition: boolean, label: string, okDetail: string, errorDetail: string): MatrixDiagnosticCheck {
  return {
    status: condition ? "ok" : "error",
    label,
    detail: condition ? okDetail : errorDetail,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Matrix API probe timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
