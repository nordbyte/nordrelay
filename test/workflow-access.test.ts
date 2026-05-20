import { describe, expect, it } from "vitest";

import { ADMIN_GROUP_ID, USER_GROUP_ID } from "../src/access/access-control.js";
import type { AuthenticatedUser, GroupRecord } from "../src/access/user-management.js";
import { canReadScopedWorkflowEntity } from "../src/web/web-dashboard-workflow-routes.js";

describe("workflow access scope", () => {
  it("shows private workflow items only to their owner or admins", () => {
    const owner = user("owner", USER_GROUP_ID);
    const other = user("other", USER_GROUP_ID);
    const admin = user("admin", ADMIN_GROUP_ID);

    expect(canReadScopedWorkflowEntity(other, { scope: "shared" })).toBe(true);
    expect(canReadScopedWorkflowEntity(owner, { scope: "private", ownerUserId: "owner" })).toBe(true);
    expect(canReadScopedWorkflowEntity(other, { scope: "private", ownerUserId: "owner" })).toBe(false);
    expect(canReadScopedWorkflowEntity(admin, { scope: "private", ownerUserId: "owner" })).toBe(true);
  });
});

function user(id: string, groupId: string): AuthenticatedUser {
  const group = {
    id: groupId,
    name: groupId,
    description: "",
    permissions: [],
    system: true,
  } as unknown as GroupRecord;
  return {
    user: {
      id,
      email: `${id}@example.com`,
      displayName: id,
      passwordHash: "",
      passwordSalt: "",
      active: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    groups: [group],
    permissions: [],
  };
}
