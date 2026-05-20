import { describe, expect, it } from "vitest";

import {
  buildLaunchdServiceSpec,
  buildSystemdUserServiceSpec,
  buildWindowsTaskServiceSpec,
  parseServiceFlags,
} from "../plugins/nordrelay/scripts/service-installer.mjs";

const options = {
  home: "/tmp/nordrelay-home",
  host: "127.0.0.1",
  port: 31878,
};

describe("service installer specs", () => {
  it("parses dry-run and platform flags", () => {
    expect(parseServiceFlags(["install", "--dry-run", "--platform", "darwin", "--label", "io.test.nordrelay"])).toMatchObject({
      subcommand: "install",
      dryRun: true,
      platform: "darwin",
      label: "io.test.nordrelay",
    });
  });

  it("builds deterministic systemd install content without writing files", () => {
    const spec = buildSystemdUserServiceSpec(options, { name: "nordrelay", start: false });

    expect(spec.path).toContain("nordrelay.service");
    expect(spec.content).toContain("Description=NordRelay connector and WebUI");
    expect(spec.content).toContain("service-run");
    expect(spec.content).toContain("--home");
    expect(spec.content).toContain("/tmp/nordrelay-home");
    expect(spec.commands.map((command) => command.command)).toEqual(["systemctl", "systemctl"]);
    expect(spec.commands.at(-1)?.args).toEqual(["--user", "enable", "nordrelay.service"]);
  });

  it("builds launchd and Windows dry-run commands", () => {
    const launchd = buildLaunchdServiceSpec(options, { label: "io.test.nordrelay", start: true });
    expect(launchd.path).toContain("io.test.nordrelay.plist");
    expect(launchd.content).toContain("<string>io.test.nordrelay</string>");
    expect(launchd.commands.map((command) => command.command)).toContain("launchctl");

    const windows = buildWindowsTaskServiceSpec(options, { name: "NordRelay", start: true });
    expect(windows.path).toBe("NordRelay");
    expect(windows.commands[0]?.args).toContain("/Create");
    expect(windows.commands[0]?.args).toContain("/TR");
    expect(windows.commands[1]?.args).toEqual(["/Run", "/TN", "NordRelay"]);
  });
});
