import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  BUILTIN_GROUPS,
  READONLY_GROUP_ID,
  USER_GROUP_ID,
  permissionForCallbackData,
  permissionForCommand,
  permissionForWebRequest,
} from "../src/access-control.js";
import { WEB_API_ROUTE_DEFINITIONS } from "../src/web-api-contract.js";

describe("access-control", () => {
  it("maps commands to granular permissions", () => {
    expect(permissionForCommand("start")).toBe("inspect");
    expect(permissionForCommand("tasks")).toBe("inspect");
    expect(permissionForCommand("activity")).toBe("sessions.read");
    expect(permissionForCommand("sessions")).toBe("sessions.read");
    expect(permissionForCommand("sync")).toBe("sessions.write");
    expect(permissionForCommand("retry")).toBe("prompt.send");
    expect(permissionForCommand("artifacts")).toBe("files.read");
    expect(permissionForCommand("model")).toBe("settings.write");
    expect(permissionForCommand("login")).toBe("auth.manage");
    expect(permissionForCommand("diagnostics")).toBe("diagnostics.read");
    expect(permissionForCommand("support")).toBe("diagnostics.read");
    expect(permissionForCommand("queue")).toBe("queue.read");
    expect(permissionForCommand("unknown")).toBeNull();
    expect(permissionForCommand("restart")).toBe("system.restart");
    expect(permissionForCommand("register_chat")).toBe("users.write");
  });

  it("maps callback data to granular permissions", () => {
    expect(permissionForCallbackData("sess_0")).toBe("sessions.write");
    expect(permissionForCallbackData("ws_1")).toBe("sessions.write");
    expect(permissionForCallbackData("model_gpt-5.5")).toBe("settings.write");
    expect(permissionForCallbackData("effort_xhigh")).toBe("settings.write");
    expect(permissionForCallbackData("codex_abort:123")).toBe("prompt.abort");
    expect(permissionForCallbackData("approval_yes:abc123")).toBe("prompt.abort");
    expect(permissionForCallbackData("queue_cancel:123:abc123")).toBe("queue.write");
    expect(permissionForCallbackData("queue_remove:-100:4:abc123")).toBe("queue.write");
    expect(permissionForCallbackData("artifact_send:turn")).toBe("files.read");
    expect(permissionForCallbackData("artifact_delete:turn")).toBe("files.write");
    expect(permissionForCallbackData("unknown_callback")).toBeNull();
  });

  it("maps web requests to user-management permissions", () => {
    expect(WEB_API_ROUTE_DEFINITIONS.length).toBeGreaterThan(10);
    expect(permissionForWebRequest("GET", "/api/users")).toBe("users.read");
    expect(permissionForWebRequest("POST", "/api/users")).toBe("users.write");
    expect(permissionForWebRequest("POST", "/api/users/example")).toBeNull();
    expect(permissionForWebRequest("GET", "/api/settings")).toBe("settings.read");
    expect(permissionForWebRequest("PATCH", "/api/settings")).toBe("settings.write");
    expect(permissionForWebRequest("POST", "/api/prompt")).toBe("prompt.send");
    expect(permissionForWebRequest("GET", "/api/queue")).toBe("queue.read");
    expect(permissionForWebRequest("POST", "/api/queue")).toBe("queue.write");
    expect(permissionForWebRequest("GET", "/api/jobs")).toBe("inspect");
    expect(permissionForWebRequest("POST", "/api/jobs/queue%3Aabc/action")).toBe("inspect");
    expect(permissionForWebRequest("GET", "/api/jobs/agent-update%3Aabc/log")).toBe("inspect");
    expect(permissionForWebRequest("GET", "/api/diagnostics")).toBe("diagnostics.read");
    expect(permissionForWebRequest("GET", "/api/diagnostics/bundle")).toBe("diagnostics.read");
    expect(permissionForWebRequest("POST", "/api/logs/clear")).toBe("logs.clear");
    expect(permissionForWebRequest("POST", "/api/abort")).toBe("prompt.abort");
    expect(permissionForWebRequest("GET", "/api/artifacts")).toBe("files.read");
    expect(permissionForWebRequest("DELETE", "/api/artifacts")).toBe("files.write");
    expect(permissionForWebRequest("DELETE", "/api/artifacts/file")).toBeNull();
    expect(permissionForWebRequest("GET", "/api/agent-updates")).toBe("updates.run");
    expect(permissionForWebRequest("POST", "/api/agent-update/job/input")).toBe("updates.run");
    expect(permissionForWebRequest("DELETE", "/api/agent-update/job/log")).toBe("updates.run");
  });

  it("defines builtin groups with scoped permissions", () => {
    const admin = BUILTIN_GROUPS.find((group) => group.id === "admin");
    const user = BUILTIN_GROUPS.find((group) => group.id === USER_GROUP_ID);
    const readonly = BUILTIN_GROUPS.find((group) => group.id === READONLY_GROUP_ID);

    expect(admin?.permissions).toEqual(ALL_PERMISSIONS);
    expect(user?.permissions).toContain("prompt.send");
    expect(user?.permissions).toContain("queue.write");
    expect(user?.permissions).not.toContain("users.write");
    expect(readonly?.permissions).toContain("sessions.read");
    expect(readonly?.permissions).not.toContain("prompt.send");
  });
});
