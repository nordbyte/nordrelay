import { findOpenClawLaunchProfile, openClawProfileAsLaunchProfile } from "../src/agents/openclaw/openclaw-launch.js";

describe("openclaw-launch", () => {
  it("maps interactive profiles to on-request launch profiles", () => {
    expect(openClawProfileAsLaunchProfile(findOpenClawLaunchProfile("default"))).toEqual({
      id: "default",
      label: "Default",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      unsafe: false,
    });
  });
});
