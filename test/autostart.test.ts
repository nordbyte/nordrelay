import { describe, expect, it } from "vitest";

import { applyAutostartSettings, buildAutostartSpec } from "../src/support/autostart.js";

const options = {
  home: "/tmp/nordrelay-home",
  runtimeRoot: "/opt/nordrelay",
  nodePath: "/usr/bin/node",
  userHome: "/home/test",
};

describe("autostart specs", () => {
  it("builds separate systemd units for connector and WebUI", () => {
    const connector = buildAutostartSpec("connector", "install", { ...options, platform: "linux" });
    const webui = buildAutostartSpec("webui", "install", { ...options, platform: "linux" });

    expect(connector.path).toBe("/home/test/.config/systemd/user/nordrelay.service");
    expect(connector.content).toContain("Description=NordRelay connector");
    expect(connector.content).toContain("foreground");
    expect(connector.content).not.toContain("service-run");
    expect(webui.path).toBe("/home/test/.config/systemd/user/nordrelay-webui.service");
    expect(webui.content).toContain("Description=NordRelay WebUI");
    expect(webui.content).toContain('"web-run"');
  });

  it("builds launchd and Windows autostart entries", () => {
    const launchd = buildAutostartSpec("webui", "install", { ...options, platform: "darwin" });
    expect(launchd.path).toBe("/home/test/Library/LaunchAgents/io.nordbyte.nordrelay.webui.plist");
    expect(launchd.content).toContain("<string>io.nordbyte.nordrelay.webui</string>");
    expect(launchd.content).toContain("<string>web-run</string>");

    const windows = buildAutostartSpec("connector", "install", { ...options, platform: "win32" });
    expect(windows.path).toBe("NordRelay");
    expect(windows.commands[0]?.args).toContain("/Create");
    expect(windows.commands[0]?.args.join(" ")).toContain("foreground");
  });

  it("ignores unchanged autostart settings", async () => {
    await expect(applyAutostartSettings(
      { NORDRELAY_AUTOSTART_ENABLED: "true" },
      [],
      { ...options, platform: "linux" },
    )).resolves.toEqual([]);
  });
});
