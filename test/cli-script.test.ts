import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("nordrelay CLI script", () => {
  it("does not mix readline echo with raw password masking", () => {
    const source = readFileSync("plugins/nordrelay/scripts/prompt-utils.mjs", "utf8");
    const askSecret = source.match(/export async function askSecret[\s\S]*?\r?\n}\r?\n\r?\nexport async function askChoice/)?.[0] ?? "";

    expect(askSecret).toContain('output.write("*")');
    expect(askSecret).toContain("input.pause();");
    expect(askSecret).not.toContain("rl.pause()");
    expect(askSecret).not.toContain("rl.resume()");
  });

  it("collects init defaults without a TTY prompt crash", async () => {
    const { collectInitConfig } = await import("../plugins/nordrelay/scripts/init-tui.mjs");

    const config = await collectInitConfig({
      disableAutostart: true,
      disableWebuiAutostart: true,
    });

    expect(config.enableWebui).toBe("true");
    expect(config.enableTelegram).toBe("false");
    expect(config.adminName).toBe("Admin");
  });

  it("enables Telegram by default only when a Telegram token was supplied", async () => {
    const { collectInitConfig } = await import("../plugins/nordrelay/scripts/init-tui.mjs");

    const config = await collectInitConfig({
      telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz",
      disableAutostart: true,
      disableWebuiAutostart: true,
    });

    expect(config.enableTelegram).toBe("true");
    expect(config.telegramBotToken).toBe("123456:abcdefghijklmnopqrstuvwxyz");
  });

  it("hides chat adapter detail fields until the adapter is enabled", async () => {
    const { initTuiRows } = await import("../plugins/nordrelay/scripts/init-tui.mjs");
    const base = {
      enableTelegram: "false",
      enableDiscord: "false",
      enableSlack: "false",
      enableMatrix: "false",
      enableWebui: "true",
      enableCodex: "true",
      stateBackend: "json",
    };

    const disabledLabels = initTuiRows(base).map((row) => row.label);
    expect(disabledLabels).toContain("Telegram enabled");
    expect(disabledLabels).toContain("Discord enabled");
    expect(disabledLabels).toContain("Slack enabled");
    expect(disabledLabels).toContain("Matrix enabled");
    expect(disabledLabels).not.toContain("Telegram bot token");
    expect(disabledLabels).not.toContain("Discord bot token");
    expect(disabledLabels).not.toContain("Slack bot token");
    expect(disabledLabels).not.toContain("Matrix homeserver URL");

    const enabledLabels = initTuiRows({ ...base, enableTelegram: "true", enableMatrix: "true" }).map((row) => row.label);
    expect(enabledLabels).toContain("Telegram bot token");
    expect(enabledLabels).toContain("Link Telegram user ID");
    expect(enabledLabels).toContain("Matrix homeserver URL");
    expect(enabledLabels).toContain("Matrix bot user ID");
    expect(enabledLabels).not.toContain("Discord bot token");
  });

  it("exposes a first-class update command", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("async function commandUpdate");
    expect(source).toContain('options.command === "update"');
    expect(source).toContain("nordrelay [init|user|peer|plugin|service|doctor|web|start|stop|restart|status|update|foreground|version]");
    expect(source).toContain("@nordbyte/nordrelay@latest");
  });

  it("treats WebUI as a first-class init access surface", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const initTui = readFileSync("plugins/nordrelay/scripts/init-tui.mjs", "utf8");

    expect(source).toContain("collectInitConfig(options)");
    expect(initTui).toContain("async function runInitTui");
    expect(initTui).toContain("Use Up/Down to select, Enter to edit");
    expect(initTui).toContain("function renderInitScreen");
    expect(initTui).toContain("function initStyle");
    expect(initTui).toContain('dependsOn: "enableTelegram"');
    expect(initTui).toContain("Save config and create admin");
    expect(initTui).toContain("select another field to revise it");
    expect(initTui).toContain("Enter - to clear an optional value.");
    expect(source).toContain('arg === "--disable-webui"');
    expect(initTui).toContain('await askChoice(null, "Enable WebUI", "true")');
    expect(initTui).toContain('await askChoice(null, "Enable NordRelay autostart", "true")');
    expect(initTui).toContain('await askChoice(null, "Enable WebUI autostart", "true")');
    expect(source).toContain("NORDRELAY_WEBUI_ENABLED");
    expect(source).toContain("NORDRELAY_AUTOSTART_ENABLED");
    expect(source).toContain("NORDRELAY_WEBUI_AUTOSTART_ENABLED");
    expect(initTui).toContain("At least WebUI or one chat adapter must be enabled.");
  });

  it("uses the runtime env path and explains incomplete existing init state", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const initState = readFileSync("plugins/nordrelay/scripts/init-state.mjs", "utf8");
    const commandInit = source.match(/async function commandInit[\s\S]*?\r?\n}\r?\n\r?\nasync function createUserStore/)?.[0] ?? "";

    expect(source).toContain('import { printExistingInitState } from "./init-state.mjs"');
    expect(commandInit).toContain("const envPath = resolveEnvPath(options.home)");
    expect(commandInit).toContain("await mkdirp(path.dirname(envPath))");
    expect(commandInit).toContain("printExistingInitState(options.home, envPath)");
    expect(commandInit.indexOf("printExistingInitState(options.home, envPath)"))
      .toBeLessThan(commandInit.indexOf("const userStore = await createUserStore(options.home)"));
    expect(initState).toContain("function readExistingInitState");
    expect(initState).toContain("Admin user: missing (users.json does not exist yet)");
    expect(initState).toContain("nordrelay user create-admin");
  });

  it("keeps init config writes when the admin user already exists", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const commandInit = source.match(/async function commandInit[\s\S]*?\r?\n}\r?\n\r?\nasync function createUserStore/)?.[0] ?? "";

    expect(commandInit.indexOf("await fsp.writeFile(envPath"))
      .toBeLessThan(commandInit.indexOf("userStore.createAdmin"));
    expect(commandInit).toContain("isUserAlreadyExistsError(error, adminEmail)");
    expect(commandInit).toContain("User already exists: ${adminEmail}");
    expect(commandInit).toContain("nordrelay user reset-password --email");
    expect(commandInit.indexOf("isUserAlreadyExistsError(error, adminEmail)"))
      .toBeLessThan(commandInit.indexOf("await applyInitialAutostartSettings"));
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
    const serviceDoctor = readFileSync("plugins/nordrelay/scripts/service-doctor.mjs", "utf8");

    expect(source).toContain('arg === "--fix"');
    expect(source).toContain("async function runDoctorFixes");
    expect(source).toContain("function envValueFix");
    expect(source).toContain("import { cliAutostartChecks } from \"./service-doctor.mjs\"");
    expect(serviceDoctor).toContain("export async function cliAutostartChecks");
    expect(serviceDoctor).toContain("systemdUserServiceDoctorCheck");
    expect(serviceDoctor).toContain("launchdServiceDoctorCheck");
    expect(serviceDoctor).toContain("windowsTaskDoctorCheck");
    expect(serviceDoctor).toContain("cliServiceWorkspaceCheck");
    expect(serviceDoctor).toContain("cliPortListeningCheck");
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
    expect(source).toContain("function childProcessEnv(extra = {})");
    expect(source).toContain("path.dirname(process.execPath)");
    expect(source).toContain("NORDRELAY_WORKSPACE: resolveLaunchWorkspace()");
    expect(source).toContain("const launchWorkspace = resolveLaunchWorkspace()");
    expect(source).toContain("NORDRELAY_WORKSPACE: launchWorkspace");
  });

  it("starts the WebUI command as a detached background process", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const commandWeb = source.match(/async function commandWeb[\s\S]*?\r?\n}\r?\n\r?\nasync function commandServiceRun/)?.[0] ?? "";
    const commandServiceRun = source.match(/async function commandServiceRun[\s\S]*?\r?\n}\r?\n\r?\nasync function startWebDashboard/)?.[0] ?? "";

    expect(commandWeb).toContain("await startWebDashboard(options, { detached: true })");
    expect(commandServiceRun).toContain("await startWebDashboard(options, { detached: false, stopConnectorOnExit: true })");
    expect(source).toContain("Start the WebUI and connector in the background");
  });

  it("validates dashboard ports before launch", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("function isValidPort(port)");
    expect(source).toContain("port >= 1 && port <= 65535");
    expect(source).toContain("Dashboard port must be an integer between 1 and 65535.");
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

  it("loads built user, peer, and plugin runtimes from their dist subdirectories", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const pluginManager = readFileSync("plugins/nordrelay/scripts/plugin-manager.mjs", "utf8");

    expect(source).toContain('path.join(RUNTIME_ROOT, "dist", "access", "user-management.js")');
    expect(source).toContain('path.join(RUNTIME_ROOT, "dist", "peers", file)');
    expect(source).toContain('import { commandPlugin } from "./plugin-manager.mjs"');
    expect(pluginManager).toContain('path.join(RUNTIME_ROOT, "dist", "plugins", "plugin-service.js")');
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

  it("hardens update restarts with child PATH enrichment, settle checks, and retry", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const lifecycleUtils = readFileSync("plugins/nordrelay/scripts/lifecycle-utils.mjs", "utf8");

    expect(source).toContain("async function commandRestart");
    expect(source).toContain("RESTART_START_ATTEMPTS");
    expect(source).toContain("await waitForRestartSettle(options");
    expect(source).toContain("suppressPathWarning: true");
    expect(source).toContain("env: childProcessEnv(settings.env || {})");
    expect(lifecycleUtils).toContain("export function commonNpmGlobalBinDirs");
    expect(lifecycleUtils).toContain("export async function waitForTcpClosed");
    expect(lifecycleUtils).toContain("export function waitForDetachedChildStartup");
  });

  it("prevents TypeScript emits after type errors", () => {
    const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8"));

    expect(tsconfig.compilerOptions.noEmitOnError).toBe(true);
  });
});
