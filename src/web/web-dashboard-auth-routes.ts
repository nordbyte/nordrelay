import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEvent } from "../access/audit-log.js";
import type { AuthenticatedUser, UserStore, WebSessionRecord } from "../access/user-management.js";
import {
  verifyWebAuthnAuthenticationChallenge,
  webAuthnAuthenticationOptions,
  type WebAuthnRelyingParty,
} from "../access/webauthn.js";
import { friendlyErrorText } from "../core/error-messages.js";
import type { WebActivityActor } from "./web-state.js";
import { objectRecord, optionalStringField, readJsonBody, sendJson } from "./web-dashboard-http.js";
import { consumeRateLimit, resetRateLimit, type RateLimitBucket } from "./web-rate-limit.js";
import { firstRunSetupTokenError } from "./web-first-run-setup-policy.js";

interface PendingLoginChallenge {
  userId: string;
  email: string;
  expectedChallenge?: string;
  expiresAt: number;
}

export interface DashboardAuthRouteOptions {
  users: UserStore;
  loginAttempts: Map<string, RateLimitBucket>;
  firstRunSetupToken?: string;
  webAuthnEnabled: boolean;
  webAuthnRp: (req: IncomingMessage) => WebAuthnRelyingParty;
  audit: (event: Omit<AuditEvent, "id" | "timestamp" | "channelId"> & { channelId?: AuditEvent["channelId"] }) => void;
  recordActivity: (event: { source: "web"; status: "info"; type: string; threadId: null; actor: WebActivityActor; detail: string }) => void;
  currentUserDto: (authUser: AuthenticatedUser, req?: IncomingMessage, sessionToken?: string) => unknown;
  setSessionCookie: (res: ServerResponse, token: string, req?: IncomingMessage) => void;
}

const pendingLoginChallenges = new Map<string, PendingLoginChallenge>();

export async function handleFirstRunSetup(req: IncomingMessage, res: ServerResponse, options: DashboardAuthRouteOptions): Promise<void> {
  const { users } = options;
  if (users.hasAdminUser()) {
    sendJson(res, 409, { error: "Admin user already exists." });
    return;
  }
  const body = await readJsonBody(req);
  const email = optionalStringField(body, "email") ?? "";
  const displayName = optionalStringField(body, "displayName") ?? email;
  const password = optionalStringField(body, "password") ?? "";
  const setupToken = optionalStringField(body, "setupToken") ?? "";
  const setupTokenError = firstRunSetupTokenError(setupToken, options.firstRunSetupToken);
  if (setupTokenError) {
    options.audit({
      action: "auth_login_failed",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      description: `Rejected first-run setup for ${email || "unknown"}`,
    });
    sendJson(res, 403, { error: setupTokenError });
    return;
  }
  if (!email || !password || password.length < 12) {
    sendJson(res, 400, { error: "Email and a password with at least 12 characters are required." });
    return;
  }
  const authUser = users.createAdmin({ email, displayName, password });
  const session = users.createWebSession(authUser.user.id, sessionMetadata(req, false));
  options.audit({
    action: "user_created",
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `First admin created: ${authUser.user.email}`,
  });
  options.recordActivity({
    source: "web",
    status: "info",
    type: "first_run_admin_created",
    threadId: null,
    actor: webActivityActor(authUser),
    detail: authUser.user.email,
  });
  options.setSessionCookie(res, session.token, req);
  sendJson(res, 201, options.currentUserDto(authUser, undefined, session.token));
}

export async function handleLogin(req: IncomingMessage, res: ServerResponse, options: DashboardAuthRouteOptions): Promise<void> {
  const body = await readJsonBody(req);
  const email = optionalStringField(body, "email");
  const password = optionalStringField(body, "password");
  const rateLimitKey = `${req.socket.remoteAddress ?? "unknown"}:${email ?? "-"}`;
  const limited = consumeRateLimit(options.loginAttempts, rateLimitKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
  if (limited.limited) {
    options.audit({
      action: "auth_login_failed",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      description: `Rate limited login attempt for ${email ?? "unknown"}`,
      detail: `${Math.ceil((limited.retryAfterMs ?? 0) / 1000)}s retry-after`,
    });
    sendJson(res, 429, { error: "Too many login attempts. Try again later.", retryAfterMs: limited.retryAfterMs });
    return;
  }
  if (!options.users.hasAdminUser()) {
    sendJson(res, 503, { error: "No admin user exists. Run nordrelay user create-admin first." });
    return;
  }
  const authUser = email && password ? options.users.verifyPassword(email, password) : null;
  if (!authUser) {
    options.audit({
      action: "auth_login_failed",
      status: "failed",
      channelId: "web",
      contextKey: "web",
      description: `Failed login for ${email ?? "unknown"}`,
    });
    sendJson(res, 401, { error: "Invalid credentials" });
    return;
  }
  resetRateLimit(options.loginAttempts, rateLimitKey);
  const mfa = options.users.mfaStatus(authUser.user.id);
  if (mfa.totpEnabled || mfa.recoveryCodesRemaining > 0 || (options.webAuthnEnabled && mfa.webAuthnCredentials.length > 0)) {
    await requestMfa(req, res, options, authUser);
    return;
  }
  await completeLogin(req, res, options, authUser, false);
}

export async function handleLoginMfa(req: IncomingMessage, res: ServerResponse, options: DashboardAuthRouteOptions): Promise<void> {
  const body = await readJsonBody(req);
  const challengeId = optionalStringField(body, "challengeId") ?? "";
  const code = optionalStringField(body, "code") ?? "";
  const pending = consumeLoginChallenge(challengeId);
  if (!pending) {
    sendJson(res, 400, { error: "MFA challenge expired. Sign in again." });
    return;
  }
  const method = options.users.verifyMfaCode(pending.userId, code);
  if (!method) {
    pendingLoginChallenges.set(challengeId, pending);
    options.audit({
      action: "auth_login_failed",
      status: "failed",
      channelId: "web",
      contextKey: "web",
      description: `Failed MFA login for ${pending.email}`,
    });
    sendJson(res, 401, { error: "Invalid authenticator or recovery code." });
    return;
  }
  await completeMfaLogin(req, res, options, pending, `MFA ${method}`);
}

export async function handleLoginWebAuthnVerify(req: IncomingMessage, res: ServerResponse, options: DashboardAuthRouteOptions): Promise<void> {
  if (!options.webAuthnEnabled) {
    sendJson(res, 404, { error: "Passkeys are disabled." });
    return;
  }
  const body = await readJsonBody(req);
  const challengeId = optionalStringField(body, "challengeId") ?? "";
  const pending = consumeLoginChallenge(challengeId);
  if (!pending?.expectedChallenge) {
    sendJson(res, 400, { error: "Passkey challenge expired. Sign in again." });
    return;
  }
  const response = objectRecord(body?.response);
  const credentialId = optionalStringField(response, "id") ?? optionalStringField(response, "rawId") ?? "";
  const credential = options.users.getWebAuthnCredential(credentialId);
  if (!credential || credential.userId !== pending.userId) {
    pendingLoginChallenges.set(challengeId, pending);
    sendJson(res, 401, { error: "Unknown passkey." });
    return;
  }
  try {
    const verification = await verifyWebAuthnAuthenticationChallenge({
      rp: options.webAuthnRp(req),
      response: response as never,
      credential,
      expectedChallenge: pending.expectedChallenge,
    });
    if (!verification.verified || verification.newCounter === undefined) {
      pendingLoginChallenges.set(challengeId, pending);
      sendJson(res, 401, { error: "Passkey verification failed." });
      return;
    }
    options.users.updateWebAuthnCredentialUse(credential.credentialId, verification.newCounter);
    await completeMfaLogin(req, res, options, pending, "Passkey");
  } catch (error) {
    pendingLoginChallenges.set(challengeId, pending);
    sendJson(res, 401, { error: friendlyErrorText(error) });
  }
}

async function requestMfa(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardAuthRouteOptions,
  authUser: AuthenticatedUser,
): Promise<void> {
  const mfa = options.users.mfaStatus(authUser.user.id);
  const challengeId = randomBytes(18).toString("base64url");
  const pending: PendingLoginChallenge = {
    userId: authUser.user.id,
    email: authUser.user.email,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  let webAuthnOptions: unknown;
  if (options.webAuthnEnabled && mfa.webAuthnCredentials.length > 0) {
    try {
      webAuthnOptions = await webAuthnAuthenticationOptions({
        rp: options.webAuthnRp(req),
        credentials: options.users.listWebAuthnCredentials(authUser.user.id),
      });
      pending.expectedChallenge = (webAuthnOptions as { challenge?: string }).challenge;
    } catch (error) {
      options.audit({
        action: "auth_mfa_required",
        status: "failed",
        channelId: "web",
        contextKey: "web",
        actor: webActivityActor(authUser),
        actorId: authUser.user.id,
        actorRole: authUser.groups.map((group) => group.name).join(", "),
        description: `Passkey challenge unavailable for ${authUser.user.email}`,
        detail: friendlyErrorText(error),
      });
    }
  }
  pendingLoginChallenges.set(challengeId, pending);
  options.audit({
    action: "auth_mfa_required",
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `MFA required for ${authUser.user.email}`,
  });
  sendJson(res, 200, {
    mfaRequired: true,
    challengeId,
    methods: {
      totp: mfa.totpEnabled,
      recovery: mfa.recoveryCodesRemaining > 0,
      webAuthn: Boolean(webAuthnOptions),
    },
    webAuthnOptions,
  });
}

async function completeMfaLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardAuthRouteOptions,
  pending: PendingLoginChallenge,
  detail: string,
): Promise<void> {
  const authUser = options.users.authenticatedUserById(pending.userId);
  if (!authUser) {
    sendJson(res, 401, { error: "User is disabled or missing." });
    return;
  }
  options.audit({
    action: "auth_mfa_verified",
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `${detail} verified for ${authUser.user.email}`,
  });
  await completeLogin(req, res, options, authUser, true);
}

async function completeLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardAuthRouteOptions,
  authUser: AuthenticatedUser,
  mfaVerified: boolean,
): Promise<void> {
  const session = options.users.createWebSession(authUser.user.id, sessionMetadata(req, mfaVerified));
  options.audit({
    action: "auth_login",
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `Login ${authUser.user.email}`,
  });
  options.recordActivity({
    source: "web",
    status: "info",
    type: "auth_login",
    threadId: null,
    actor: webActivityActor(authUser),
    detail: authUser.user.email,
  });
  options.setSessionCookie(res, session.token, req);
  sendJson(res, 200, options.currentUserDto(authUser, undefined, session.token));
}

function consumeLoginChallenge(challengeId: string): PendingLoginChallenge | null {
  const pending = pendingLoginChallenges.get(challengeId);
  pendingLoginChallenges.delete(challengeId);
  return pending && pending.expiresAt >= Date.now() ? pending : null;
}

function sessionMetadata(req: IncomingMessage, mfaVerified: boolean): Partial<Pick<WebSessionRecord, "userAgent" | "ipAddress" | "deviceName" | "mfaVerified">> {
  const userAgent = headerValue(req, "user-agent") || undefined;
  return {
    userAgent,
    ipAddress: requestIp(req),
    deviceName: deviceNameFromUserAgent(userAgent),
    mfaVerified,
  };
}

function requestIp(req: IncomingMessage): string | undefined {
  const forwarded = headerValue(req, "x-forwarded-for").split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || undefined;
}

function deviceNameFromUserAgent(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  if (/Firefox/i.test(userAgent)) return "Firefox";
  if (/Edg\//i.test(userAgent)) return "Microsoft Edge";
  if (/Chrome|Chromium/i.test(userAgent)) return "Chrome";
  if (/Safari/i.test(userAgent)) return "Safari";
  return userAgent.split(/\s+/).slice(0, 2).join(" ").slice(0, 80);
}

function webActivityActor(authUser: AuthenticatedUser): WebActivityActor {
  return {
    channel: "web",
    id: authUser.user.id,
    label: authUser.user.displayName || authUser.user.email,
    username: authUser.user.email,
  };
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
