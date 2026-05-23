import { WEB_API_ROUTE_DEFINITIONS, type WebHttpMethod } from "../web/web-api-contract.js";
import { PEER_WEB_ROUTE_CONTRACT_PATHS } from "./peer-runtime-routes.js";

export interface PeerProxyRouteKey {
  method: WebHttpMethod;
  path: string;
}

const LOCAL_ONLY_ROUTE_PATHS = new Set([
  "/api/auth/me",
  "/api/dashboard/logout",
  "/api/profile",
  "/api/profile/password",
  "/api/profile/logout-other-sessions",
  "/api/permissions",
  "/api/settings",
  "/api/settings/wizard/test",
  "/api/doctor",
  "/api/doctor/fix",
  "/api/peers",
  "/api/peers/invite",
  "/api/peers/pair",
  "/api/peers/probe",
  "/api/peers/discover",
  "/api/peers/discovery-jobs",
  "/api/peers/discovery-jobs/:id",
  "/api/peers/discovery-jobs/:id/cancel",
  "/api/peers/discovery-jobs/:id/log",
  "/api/peers/relay",
  "/api/peers/identity/backup",
  "/api/peers/identity/restore",
  "/api/peers/invitations/:id",
  "/api/peers/:id",
  "/api/peers/:id/repin",
  "/api/peers/:id/rotate",
  "/api/peers/:id/health",
  "/api/peers/:id/debug",
  "/api/peers/:id/debug/probe",
  "/api/peers/:id/effective-access",
  "/api/peers/:id/health-history",
  "/api/peers/:id/repair",
  "/api/peers/:id/proxy",
  "/api/peers/:id/events",
  "/api/peers/global-sessions",
  "/api/users",
  "/api/users/:id",
  "/api/users/:id/password",
  "/api/users/:id/sessions",
  "/api/users/:id/sessions/:sessionId",
  "/api/users/:id/telegram",
  "/api/users/:id/telegram/:identityId",
  "/api/users/:id/discord",
  "/api/users/:id/discord/:identityId",
  "/api/users/:id/slack",
  "/api/users/:id/slack/:identityId",
  "/api/users/:id/matrix",
  "/api/users/:id/matrix/:identityId",
  "/api/groups",
  "/api/groups/:id",
  "/api/telegram-chats",
  "/api/telegram-chats/:id",
  "/api/discord-channels",
  "/api/discord-channels/:id",
  "/api/slack-channels",
  "/api/slack-channels/:id",
  "/api/matrix-rooms",
  "/api/matrix-rooms/:id",
  "/api/audit",
]);

export function peerProxyCoverage(): {
  implemented: PeerProxyRouteKey[];
  localOnly: PeerProxyRouteKey[];
  missing: PeerProxyRouteKey[];
} {
  const implemented: PeerProxyRouteKey[] = [];
  const localOnly: PeerProxyRouteKey[] = [];
  const missing: PeerProxyRouteKey[] = [];
  for (const route of WEB_API_ROUTE_DEFINITIONS) {
    for (const method of route.methods) {
      const key = { method, path: route.path };
      if (PEER_WEB_ROUTE_CONTRACT_PATHS.has(route.path)) {
        implemented.push(key);
      } else if (LOCAL_ONLY_ROUTE_PATHS.has(route.path)) {
        localOnly.push(key);
      } else {
        missing.push(key);
      }
    }
  }
  return { implemented, localOnly, missing };
}

export function isPeerProxyLocalOnlyPath(path: string): boolean {
  return LOCAL_ONLY_ROUTE_PATHS.has(path);
}
