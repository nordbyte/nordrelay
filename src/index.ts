import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createBot, registerCommands } from "./bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { describeCodexCli, resolveCodexCli } from "./codex-cli.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { enabledAgents } from "./agent-factory.js";
import { loadConfig } from "./config.js";
import { installConsoleLogger } from "./logger.js";
import { describePiCli, resolvePiCli } from "./pi-cli.js";
import { configureRedaction } from "./redaction.js";
import { SessionRegistry } from "./session-registry.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;

try {
  const config = loadConfig();
  configureRedaction(config.telegramRedactPatterns);
  installConsoleLogger(config.logFormat);
  registry = new SessionRegistry(config);
  bot = createBot(config, registry);
  await registerCommands(bot);

  console.log("NordRelay running");
  const authStatus = config.codexEnabled
    ? await checkAuthStatus(config.codexApiKey)
    : { authenticated: true, method: "codex-disabled" };
  if (config.codexEnabled) {
    console.log(`Auth: ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
    if (!authStatus.authenticated) {
      console.warn("Warning: Codex is not authenticated. Use /login or set CODEX_API_KEY.");
    }
  }
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Enabled agents: ${enabledAgents(config).join(", ")} (default: ${config.defaultAgent})`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  const codexCli = resolveCodexCli();
  const piCli = resolvePiCli(process.env, config.piCliPath);
  console.log(`Codex CLI: ${describeCodexCli(codexCli)}`);
  console.log(`Pi CLI: ${describePiCli(piCli)}`);
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per Telegram context");
  await writeConnectorState({
    status: "ready",
    pid: Number(process.env.NORDRELAY_WRAPPER_PID) || process.pid,
    appPid: process.pid,
    workspace: config.workspace,
    sessionMode: "per Telegram context",
    authenticated: authStatus.authenticated,
    authMethod: authStatus.method,
    codexCli: describeCodexCli(codexCli),
    piCli: describePiCli(piCli),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start NordRelay: ${message}`);
  await writeConnectorState({
    status: "error",
    pid: Number(process.env.NORDRELAY_WRAPPER_PID) || process.pid,
    appPid: process.pid,
    error: message,
  });
  registry?.disposeAll();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down NordRelay...`);
  if (bot) bot.stop();

  setTimeout(() => {
    registry?.disposeAll();
    void writeConnectorState({
      status: "stopped",
      pid: Number(process.env.NORDRELAY_WRAPPER_PID) || process.pid,
      appPid: process.pid,
      signal,
    }).finally(() => {
      console.log("NordRelay stopped.");
      process.exit(0);
    });
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    await bot!.start({
      drop_pending_updates: process.env.NORDRELAY_DROP_PENDING_UPDATES !== "0",
      onStart: () => {
        restartAttempts = 0;
      },
    });
  } catch (error) {
    if (shuttingDown) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts += 1;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    registry?.disposeAll();
    process.exit(1);
  }
}

await startPolling();

async function writeConnectorState(payload: Record<string, unknown>): Promise<void> {
  const stateFile = process.env.NORDRELAY_STATE_FILE;
  if (!stateFile) {
    return;
  }

  try {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      `${JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn(
      "Failed to write connector state:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
