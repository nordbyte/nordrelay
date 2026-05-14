import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS, permissionForWebRequest, type Permission } from "../src/access-control.js";
import { WEB_API_ROUTE_DEFINITIONS, type WebHttpMethod } from "../src/web-api-contract.js";

describe("WebUI API access regressions", () => {
  it("denies every known route when the required permission is missing", () => {
    for (const route of WEB_API_ROUTE_DEFINITIONS) {
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
