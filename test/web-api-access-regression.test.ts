import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS, permissionForWebRequest, type Permission } from "../src/access/access-control.js";
import type { AuthenticatedUser, UserStore } from "../src/access/user-management.js";
import { WEB_API_ROUTE_DEFINITIONS, type WebHttpMethod } from "../src/web/web-api-contract.js";
import { assertPeerProxyTargetPermission } from "../src/web/web-dashboard-peer-routes.js";

describe("WebUI API access regressions", () => {
  it("denies every known route when the required permission is missing", () => {
    for (const route of WEB_API_ROUTE_DEFINITIONS) {
      if (route.auth === "anonymous-token") {
        continue;
      }
      for (const method of route.methods) {
        const path = samplePath(route);
        const required = permissionForWebRequest(method, path);
        expect(required, `${method} ${path}`).not.toBeNull();
        expect(simulateDashboardGate(method, path, without(required!))).toBe(403);
      }
    }
  });

  it("allows every known route when the required permission is present", () => {
    for (const route of WEB_API_ROUTE_DEFINITIONS) {
      if (route.auth === "anonymous-token") {
        continue;
      }
      for (const method of route.methods) {
        const path = samplePath(route);
        const required = permissionForWebRequest(method, path);
        expect(simulateDashboardGate(method, path, required ? [required] : [])).toBe(200);
      }
    }
  });

  it("denies unknown routes and unsupported methods by default", () => {
    expect(simulateDashboardGate("GET", "/api/not-real", ALL_PERMISSIONS)).toBe(403);
    expect(simulateDashboardGate("DELETE", "/api/prompt", ALL_PERMISSIONS)).toBe(403);
    expect(permissionForWebRequest("POST", "/api/workflow-triggers/sample-token/run")).toBeNull();
  });

  it("requires the proxied target permission in addition to peers.connect", () => {
    const user = fakeAuthUser(["peers.connect"]);
    const users = {
      hasPermission: (authUser: AuthenticatedUser | null | undefined, permission: Permission | null | undefined) =>
        Boolean(authUser && permission && authUser.permissions.includes(permission)),
    } as Pick<UserStore, "hasPermission">;

    expect(() => assertPeerProxyTargetPermission({ users: users as UserStore, authUser: user }, {
      method: "POST",
      path: "/api/prompt",
    })).toThrow(/prompt\.send/);
    expect(assertPeerProxyTargetPermission({ users: users as UserStore, authUser: fakeAuthUser(["peers.connect", "prompt.send"]) }, {
      method: "POST",
      path: "/api/prompt",
    })).toBe("prompt.send");
  });
});

function samplePath(route: typeof WEB_API_ROUTE_DEFINITIONS[number]): string {
  const source = "dynamicType" in route && route.dynamicType ? route.dynamicType : route.path;
  return source.replaceAll("${string}", "sample-id");
}

function simulateDashboardGate(method: WebHttpMethod, path: string, permissions: Permission[]): 200 | 403 {
  const required = permissionForWebRequest(method, path);
  if (!required) {
    return 403;
  }
  return permissions.includes(required) ? 200 : 403;
}

function without(permission: Permission): Permission[] {
  return ALL_PERMISSIONS.filter((candidate) => candidate !== permission);
}

function fakeAuthUser(permissions: Permission[]): AuthenticatedUser {
  return {
    user: {
      id: "user-1",
      email: "user@example.test",
      displayName: "User",
      passwordHash: "",
      passwordSalt: "",
      active: true,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
    groups: [],
    permissions,
  };
}
