import { describe, expect, it } from "vitest";

import { evaluateWorkspacePolicy } from "../src/core/workspace-policy.js";

describe("workspace policy", () => {
  it("treats filesystem root as a valid parent root", () => {
    expect(evaluateWorkspacePolicy("/tmp/nordrelay-project", {
      workspaceAllowedRoots: ["/"],
      workspaceWarnRoots: [],
    }).allowed).toBe(true);
  });

  it("allows child paths without allowing prefix siblings", () => {
    expect(evaluateWorkspacePolicy("/workspace/base/app", {
      workspaceAllowedRoots: ["/workspace/base"],
      workspaceWarnRoots: [],
    }).allowed).toBe(true);

    expect(evaluateWorkspacePolicy("/workspace/base-other/app", {
      workspaceAllowedRoots: ["/workspace/base"],
      workspaceWarnRoots: [],
    }).allowed).toBe(false);
  });
});
