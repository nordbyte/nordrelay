import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEvent } from "../access/audit-log.js";
import type { AuthenticatedUser, UserStore } from "../access/user-management.js";
import {
  verifyWebAuthnRegistration,
  webAuthnRegistrationOptions,
  type WebAuthnRelyingParty,
} from "../access/webauthn.js";
import { friendlyErrorText } from "../core/error-messages.js";
import { objectRecord, optionalStringField, parseCookies, readJsonBody, sendJson } from "./web-dashboard-http.js";

interface DashboardProfileSecurityRouteOptions {
  users: UserStore;
  authUser: AuthenticatedUser;
  webAuthnEnabled: boolean;
  webAuthnRp: () => WebAuthnRelyingParty;
  auditUserAction: (authUser: AuthenticatedUser, action: AuditEvent["action"], description: string) => void;
}

interface PendingWebAuthnRegistrationChallenge {
  userId: string;
  expectedChallenge: string;
  expiresAt: number;
}

const pendingWebAuthnRegistrationChallenges = new Map<string, PendingWebAuthnRegistrationChallenge>();

export async function handleDashboardProfileSecurityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardProfileSecurityRouteOptions,
): Promise<boolean> {
  const { users, authUser } = options;

  if (req.method === "POST" && url.pathname === "/api/profile/mfa/totp/setup") {
    sendJson(res, 200, users.setupTotp(authUser.user.id, authUser.user.email));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/mfa/totp/enable") {
    const body = await readJsonBody(req);
    try {
      const result = users.enableTotp(
        authUser.user.id,
        optionalStringField(body, "secret") ?? "",
        optionalStringField(body, "code") ?? "",
      );
      options.auditUserAction(authUser, "user_mfa_updated", `TOTP enabled: ${authUser.user.email}`);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: friendlyErrorText(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/mfa/totp/disable") {
    const status = users.disableTotp(authUser.user.id);
    options.auditUserAction(authUser, "user_mfa_updated", `TOTP disabled: ${authUser.user.email}`);
    sendJson(res, 200, { status });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/mfa/recovery-codes") {
    const result = users.regenerateRecoveryCodes(authUser.user.id);
    options.auditUserAction(authUser, "user_mfa_updated", `Recovery codes regenerated: ${authUser.user.email}`);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/webauthn/register/options") {
    if (!options.webAuthnEnabled) {
      sendJson(res, 404, { error: "Passkeys are disabled." });
      return true;
    }
    const optionsJson = await webAuthnRegistrationOptions({
      rp: options.webAuthnRp(),
      user: authUser.user,
      credentials: users.listWebAuthnCredentials(authUser.user.id),
    });
    const challengeId = randomBytes(18).toString("base64url");
    pendingWebAuthnRegistrationChallenges.set(challengeId, {
      userId: authUser.user.id,
      expectedChallenge: optionsJson.challenge,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    sendJson(res, 200, { challengeId, options: optionsJson });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/webauthn/register/verify") {
    if (!options.webAuthnEnabled) {
      sendJson(res, 404, { error: "Passkeys are disabled." });
      return true;
    }
    const body = await readJsonBody(req);
    const challengeId = optionalStringField(body, "challengeId") ?? "";
    const pending = pendingWebAuthnRegistrationChallenges.get(challengeId);
    pendingWebAuthnRegistrationChallenges.delete(challengeId);
    if (!pending || pending.userId !== authUser.user.id || pending.expiresAt < Date.now()) {
      sendJson(res, 400, { error: "Passkey registration challenge expired. Try again." });
      return true;
    }
    try {
      const verification = await verifyWebAuthnRegistration({
        rp: options.webAuthnRp(),
        response: objectRecord(body?.response) as never,
        expectedChallenge: pending.expectedChallenge,
      });
      if (!verification.verified || !verification.credential) {
        sendJson(res, 400, { error: "Passkey registration failed." });
        return true;
      }
      const credential = users.addWebAuthnCredential(authUser.user.id, {
        ...verification.credential,
        name: optionalStringField(body, "name") ?? "Passkey",
      });
      options.auditUserAction(authUser, "user_webauthn_updated", `Passkey registered: ${authUser.user.email}`);
      sendJson(res, 200, { credential, status: users.mfaStatus(authUser.user.id) });
    } catch (error) {
      sendJson(res, 400, { error: friendlyErrorText(error) });
    }
    return true;
  }

  const passkeyDeleteMatch = url.pathname.match(/^\/api\/profile\/webauthn\/([^/]+)$/);
  if (req.method === "DELETE" && passkeyDeleteMatch?.[1]) {
    const removed = users.deleteWebAuthnCredential(authUser.user.id, decodeURIComponent(passkeyDeleteMatch[1]));
    if (removed) options.auditUserAction(authUser, "user_webauthn_updated", `Passkey removed: ${authUser.user.email}`);
    sendJson(res, 200, { removed, status: users.mfaStatus(authUser.user.id) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/profile/api-tokens") {
    const entry = users.snapshot().users.find((user) => user.id === authUser.user.id);
    sendJson(res, 200, { tokens: entry?.apiTokens ?? [] });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/api-tokens") {
    const body = await readJsonBody(req);
    const requestedPermissions = stringListBody(body?.permissions);
    const permissions = requestedPermissions.filter((permission) =>
      authUser.permissions.includes(permission as AuthenticatedUser["permissions"][number])
    );
    if (permissions.length === 0) {
      sendJson(res, 400, { error: "Choose at least one permission available to your account." });
      return true;
    }
    if (permissions.length !== requestedPermissions.length) {
      sendJson(res, 403, { error: "API token permissions must be a subset of your own permissions." });
      return true;
    }
    try {
      const result = users.createApiToken(authUser.user.id, {
        name: optionalStringField(body, "name") ?? "API token",
        permissions,
        agentIds: stringListBody(body?.agentIds),
        workspaceRoots: stringListBody(body?.workspaceRoots),
        peerIds: stringListBody(body?.peerIds),
        expiresAt: optionalStringField(body, "expiresAt"),
      });
      options.auditUserAction(authUser, "user_api_token_created", `API token created: ${result.record.name}`);
      sendJson(res, 201, result);
    } catch (error) {
      sendJson(res, 400, { error: friendlyErrorText(error) });
    }
    return true;
  }

  const tokenDeleteMatch = url.pathname.match(/^\/api\/profile\/api-tokens\/([^/]+)$/);
  if (req.method === "DELETE" && tokenDeleteMatch?.[1]) {
    const removed = users.revokeApiToken(authUser.user.id, decodeURIComponent(tokenDeleteMatch[1]));
    if (removed) options.auditUserAction(authUser, "user_api_token_revoked", `API token revoked: ${decodeURIComponent(tokenDeleteMatch[1])}`);
    sendJson(res, 200, { removed });
    return true;
  }

  const sessionDeleteMatch = url.pathname.match(/^\/api\/profile\/sessions\/([^/]+)$/);
  if (req.method === "DELETE" && sessionDeleteMatch?.[1]) {
    const sessionId = decodeURIComponent(sessionDeleteMatch[1]);
    const currentSession = users.webSessionForToken(parseCookies(req.headers.cookie ?? "").nr_session);
    if (currentSession?.id === sessionId) {
      sendJson(res, 400, { error: "Use logout to end the current session." });
      return true;
    }
    const ownSession = users.snapshot().users
      .find((user) => user.id === authUser.user.id)
      ?.webSessions.some((session) => session.id === sessionId);
    if (!ownSession) {
      sendJson(res, 404, { error: "Session not found." });
      return true;
    }
    const removed = users.revokeWebSession(sessionId);
    if (removed) options.auditUserAction(authUser, "user_session_revoked", `Own web session revoked: ${sessionId}`);
    sendJson(res, 200, { removed });
    return true;
  }

  return false;
}

function stringListBody(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
