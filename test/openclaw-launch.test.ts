import { findOpenClawLaunchProfile, openClawProfileAsLaunchProfile } from "../src/openclaw-launch.js";

describe("openclaw-launch", () => {
  it("maps interactive profiles to no-approval launch profiles", () => {
    expect(openClawProfileAsLaunchProfile(findOpenClawLaunchProfile("default"))).toEqual({
      id: "default",
      label: "Default",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafe: false,
    });
  });
});
