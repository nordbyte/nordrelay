import { describe, expect, it } from "vitest";

import {
  createDefaultRolePolicies,
  hasTelegramPermission,
  parseRolePoliciesJson,
  permissionForCallbackData,
  permissionForCommand,
} from "../src/access-control.js";

describe("access-control", () => {
  it("maps commands to granular permissions", () => {
    expect(permissionForCommand("start")).toBe("inspect");
    expect(permissionForCommand("tasks")).toBe("inspect");
    expect(permissionForCommand("activity")).toBe("inspect");
    expect(permissionForCommand("sessions")).toBe("sessions");
    expect(permissionForCommand("sync")).toBe("sessions");
    expect(permissionForCommand("retry")).toBe("prompt");
    expect(permissionForCommand("artifacts")).toBe("files");
    expect(permissionForCommand("model")).toBe("settings");
    expect(permissionForCommand("login")).toBe("auth");
    expect(permissionForCommand("diagnostics")).toBe("admin");
    expect(permissionForCommand("restart")).toBe("admin");
  });

  it("maps callback data to granular permissions", () => {
    expect(permissionForCallbackData("sess_0")).toBe("sessions");
    expect(permissionForCallbackData("ws_1")).toBe("sessions");
    expect(permissionForCallbackData("model_gpt-5.5")).toBe("settings");
    expect(permissionForCallbackData("effort_xhigh")).toBe("settings");
    expect(permissionForCallbackData("codex_abort:123")).toBe("prompt");
    expect(permissionForCallbackData("approval_yes:abc123")).toBe("prompt");
    expect(permissionForCallbackData("queue_cancel:123:abc123")).toBe("prompt");
    expect(permissionForCallbackData("queue_remove:-100:4:abc123")).toBe("prompt");
    expect(permissionForCallbackData("artifact_send:turn")).toBe("files");
  });

  it("applies default role policies", () => {
    const policies = createDefaultRolePolicies();

    expect(hasTelegramPermission(policies, "readonly", "sessions")).toBe(true);
    expect(hasTelegramPermission(policies, "readonly", "prompt")).toBe(false);
    expect(hasTelegramPermission(policies, "operator", "settings")).toBe(true);
    expect(hasTelegramPermission(policies, "operator", "admin")).toBe(false);
    expect(hasTelegramPermission(policies, "admin", "admin")).toBe(true);
  });

  it("parses custom role policies", () => {
    const policies = parseRolePoliciesJson(JSON.stringify({
      operator: ["inspect", "prompt"],
      readonly: ["inspect"],
      admin: "*",
    }));

    expect(policies.operator).toEqual(new Set(["inspect", "prompt"]));
    expect(policies.readonly).toEqual(new Set(["inspect"]));
    expect(policies.admin.has("files")).toBe(true);
    expect(policies.admin.has("admin")).toBe(true);
  });
});
