import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("nordrelay CLI script", () => {
  it("does not mix readline echo with raw password masking", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const askSecret = source.match(/async function askSecret[\s\S]*?\r?\n}\r?\n\r?\nasync function askChoice/)?.[0] ?? "";

    expect(askSecret).toContain('output.write("*")');
    expect(askSecret).toContain("input.pause();");
    expect(askSecret).not.toContain("rl.pause()");
    expect(askSecret).not.toContain("rl.resume()");
  });

  it("exposes a first-class update command", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("async function commandUpdate");
    expect(source).toContain('options.command === "update"');
    expect(source).toContain("nordrelay [init|user|peer|service|doctor|web|start|stop|restart|status|update|foreground|version]");
    expect(source).toContain("@nordbyte/nordrelay@latest");
  });

  it("treats WebUI as a first-class init access surface", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('arg === "--disable-webui"');
    expect(source).toContain('await askChoice(null, "Enable WebUI", "true")');
    expect(source).toContain('await askChoice(null, "Enable NordRelay autostart", "true")');
    expect(source).toContain('await askChoice(null, "Enable WebUI autostart", "true")');
    expect(source).toContain("NORDRELAY_WEBUI_ENABLED");
    expect(source).toContain("NORDRELAY_AUTOSTART_ENABLED");
    expect(source).toContain("NORDRELAY_WEBUI_AUTOSTART_ENABLED");
    expect(source).toContain("At least WebUI or one chat adapter must be enabled.");
  });

  it("configures init autostart entries from the selected settings", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('arg === "--disable-autostart"');
    expect(source).toContain('arg === "--disable-webui-autostart"');
    expect(source).toContain("async function applyInitialAutostartSettings");
    expect(source).toContain('path.join(RUNTIME_ROOT, "dist", "support", "autostart.js")');
    expect(source).toContain("mod.applyAutostartSettings");
  });

  it("supports doctor auto-fix hints and safe local fixes", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('arg === "--fix"');
    expect(source).toContain("async function runDoctorFixes");
    expect(source).toContain("function envValueFix");
    expect(source).toContain("doctor [--fix]");
    expect(source).toContain("Run `nordrelay doctor --fix` to apply safe local fixes.");
  });

  it("supports source builds before launches and restart", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('arg === "--build"');
    expect(source).toContain("async function buildRuntime()");
    expect(source).toContain("warnIfRuntimeBuildIsStale()");
    expect(source).toContain("runtimeForwardFlags(options.rawFlags)");
    expect(source).toContain("nordrelay restart --build");
    expect(source).toContain('console.log("  --build');
  });

  it("passes the launch workspace into detached runtime and WebUI processes", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("function resolveLaunchWorkspace()");
    expect(source).toContain("NORDRELAY_WORKSPACE: resolveLaunchWorkspace()");
    expect(source).toContain("const launchWorkspace = resolveLaunchWorkspace()");
    expect(source).toContain("NORDRELAY_WORKSPACE: launchWorkspace");
  });

  it("starts the WebUI command as a detached background process", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const commandWeb = source.match(/async function commandWeb[\s\S]*?\n}\n\nasync function commandServiceRun/)?.[0] ?? "";
    const commandServiceRun = source.match(/async function commandServiceRun[\s\S]*?\n}\n\nasync function startWebDashboard/)?.[0] ?? "";

    expect(commandWeb).toContain("await startWebDashboard(options, { detached: true })");
    expect(commandServiceRun).toContain("await startWebDashboard(options, { detached: false, stopConnectorOnExit: true })");
    expect(source).toContain("Start the WebUI and connector in the background");
  });

  it("handles --help before the foreground default", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('copy[0] === "--help" || copy[0] === "-h"');
    expect(source).toContain("function printHelp()");
    expect(source).toContain('if (options.command === "help")');
  });

  it("runs through npm bin symlinks", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("function isMainScript");
    expect(source).toContain("fs.realpathSync.native(argvPath)");
    expect(source).toContain("if (isMainScript(process.argv[1]))");
  });

  it("loads built user and peer runtimes from their dist subdirectories", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('path.join(RUNTIME_ROOT, "dist", "access", "user-management.js")');
    expect(source).toContain('path.join(RUNTIME_ROOT, "dist", "peers", file)');
    expect(source).not.toContain('path.join(RUNTIME_ROOT, "dist", "user-management.js")');
    expect(source).not.toContain('path.join(RUNTIME_ROOT, "dist", file)');
  });

  it("guards connector and web lifecycle pid files with locks and process identity checks", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("async function withLifecycleLock");
    expect(source).toContain("function pidFileLock");
    expect(source).toContain("async function isManagedConnectorPid");
    expect(source).toContain("async function isManagedWebPid");
    expect(source).toContain("await withLifecycleLock(pidFileLock(options.pidFile)");
    expect(source).toContain("await withLifecycleLock(pidFileLock(options.webPidFile)");
    expect(source).toContain("await writePidAtomic(options.pidFile, child.pid)");
    expect(source).toContain("await writePidAtomic(options.webPidFile, child.pid)");
  });

  it("prevents TypeScript emits after type errors", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"));

    expect(tsconfig.compilerOptions.noEmitOnError).toBe(true);
  });
});
