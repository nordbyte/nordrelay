import { describe, expect, it } from "vitest";

import { peerProxyCoverage } from "../src/peers/peer-web-proxy-contract.js";

describe("peer web proxy contract", () => {
  it("classifies every Web API route as proxied or local-only", () => {
    const coverage = peerProxyCoverage();
    expect(coverage.missing).toEqual([]);
    expect(coverage.implemented.map((route) => `${route.method} ${route.path}`)).toContain("GET /api/adapters/conformance");
    expect(coverage.implemented.map((route) => `${route.method} ${route.path}`)).toContain("POST /api/locks");
    expect(coverage.localOnly.map((route) => `${route.method} ${route.path}`)).toContain("GET /api/profile");
    expect(coverage.localOnly.map((route) => `${route.method} ${route.path}`)).toContain("POST /api/settings/wizard/test");
    expect(coverage.localOnly.map((route) => `${route.method} ${route.path}`)).toContain("GET /api/peers/global-sessions");
    expect(coverage.localOnly.map((route) => `${route.method} ${route.path}`)).toContain("POST /api/peers/sync");
    expect(coverage.localOnly.map((route) => `${route.method} ${route.path}`)).toContain("GET /api/peers/:id/sync-candidates");
  });
});
