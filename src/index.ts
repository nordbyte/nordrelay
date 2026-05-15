import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { webhookCallback } from "grammy";

import { agentLabel, type AgentId } from "./agent.js";
import { createBot, registerCommands } from "./bot.js";
import { createDiscordBridge } from "./discord-bot.js";
import { checkAuthStatus } from "./codex-auth.js";
import { describeCodexCli, resolveCodexCli } from "./codex-cli.js";
import { checkClaudeCodeAuthStatus } from "./claude-code-auth.js";
import { describeClaudeCodeCli, resolveClaudeCodeCli } from "./claude-code-cli.js";
import { findLaunchProfile, formatLaunchProfileBehavior } from "./codex-launch.js";
import { enabledAgents } from "./agent-factory.js";
import { loadConfig, type ConnectorConfig } from "./config.js";
import { checkHermesAuthStatus } from "./hermes-auth.js";
import { describeHermesCli, resolveHermesCli } from "./hermes-cli.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { describeOpenClawCli, resolveOpenClawCli } from "./openclaw-cli.js";
import { installConsoleLogger } from "./logger.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { describePiCli, resolvePiCli } from "./pi-cli.js";
import { configureRedaction } from "./redaction.js";
import { SessionRegistry } from "./session-registry.js";
import { UserStore } from "./user-management.js";

let registry: SessionRegistry | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let discordBridge: ReturnType<typeof createDiscordBridge> | undefined;
let webhookServer: Server | undefined;
let runtimeConfig: ConnectorConfig | undefined;

try {
  const config = loadConfig();
  runtimeConfig = config;
  configureRedaction(config.telegramRedactPatterns);
  installConsoleLogger(config.logFormat);
  registry = new SessionRegistry(config);
  if (config.telegramEnabled) {
    bot = createBot(config, registry);
    await registerCommands(bot);
  }
  discordBridge = createDiscordBridge(config, registry);
  await discordBridge?.start();

  console.log("NordRelay running");
  const userStore = new UserStore();
  if (userStore.hasAdminUser()) {
    console.log("User management: admin user configured");
  } else {
    console.warn("Warning: no NordRelay admin user exists. Run `nordrelay user create-admin` to enable WebUI and Telegram access.");
  }
  const authStatus = await checkDefaultAgentAuth(config);
  console.log(`Auth (${agentLabel(config.defaultAgent)}): ${authStatus.authenticated ? "authenticated" : "not authenticated"} (${authStatus.method})`);
  if (!authStatus.authenticated) {
    console.warn(`Warning: ${agentLabel(config.defaultAgent)} is not authenticated. ${authStatus.detail}`);
  }
  for (const warning of config.adapterWarnings ?? []) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Enabled agents: ${enabledAgents(config).join(", ")} (default: ${config.defaultAgent})`);
  if (config.codexModel) {
    console.log(`Default model: ${config.codexModel}`);
  }
  const codexCli = resolveCodexCli();
  const piCli = resolvePiCli(process.env, config.piCliPath);
  const hermesCli = resolveHermesCli(process.env, config.hermesCliPath);
  const openClawCli = resolveOpenClawCli(process.env, config.openClawCliPath);
  const claudeCodeCli = resolveClaudeCodeCli(process.env, config.claudeCodeCliPath);
  console.log(`Codex CLI: ${describeCodexCli(codexCli)}`);
  console.log(`Pi CLI: ${describePiCli(piCli)}`);
  console.log(`Hermes CLI: ${describeHermesCli(hermesCli)}`);
  console.log(`OpenClaw CLI: ${describeOpenClawCli(openClawCli)}`);
  console.log(`Claude Code CLI: ${describeClaudeCodeCli(claudeCodeCli)}`);
  if (config.hermesEnabled) {
    console.log(`Hermes API: ${config.hermesApiBaseUrl}`);
  }
  if (config.openClawEnabled) {
    console.log(`OpenClaw Gateway: ${config.openClawGatewayUrl}`);
  }
  const defaultLaunchProfile = findLaunchProfile(config.launchProfiles, config.defaultLaunchProfileId);
  if (defaultLaunchProfile) {
    console.log(
      `Default launch profile: ${defaultLaunchProfile.label} (${formatLaunchProfileBehavior(defaultLaunchProfile)})`,
    );
    if (defaultLaunchProfile.unsafe) {
      console.warn("Warning: Default launch profile uses danger-full-access.");
    }
  }
  console.log("Session mode: per chat context");
  console.log(`Telegram: ${config.telegramEnabled ? config.telegramTransport : "disabled"}`);
  console.log(`Discord: ${config.discordEnabled ? "enabled" : "disabled"}`);
  await writeConnectorState({
    status: "ready",
    pid: Number(process.env.NORDRELAY_WRAPPER_PID) || process.pid,
    appPid: process.pid,
    workspace: config.workspace,
    sessionMode: "per chat context",
    authenticated: authStatus.authenticated,
    authMethod: authStatus.method,
    codexCli: describeCodexCli(codexCli),
    piCli: describePiCli(piCli),
    hermesCli: describeHermesCli(hermesCli),
    openClawCli: describeOpenClawCli(openClawCli),
    claudeCodeCli: describeClaudeCodeCli(claudeCodeCli),
    openClawGateway: config.openClawGatewayUrl,
    telegramTransport: config.telegramTransport,
    discordEnabled: config.discordEnabled,
    adapterWarnings: config.adapterWarnings ?? [],
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

async function checkDefaultAgentAuth(config: ConnectorConfig): Promise<{
  authenticated: boolean;
  method: string;
  detail: string;
}> {
  const agentId: AgentId = config.defaultAgent;
  if (agentId === "pi") {
    return checkPiAuthStatus(config.piDefaultModel);
  }
  if (agentId === "hermes") {
    return checkHermesAuthStatus({
      baseUrl: config.hermesApiBaseUrl,
      apiKey: config.hermesApiKey,
    });
  }
  if (agentId === "openclaw") {
    return checkOpenClawAuthStatus({
      gatewayUrl: config.openClawGatewayUrl,
      token: config.openClawGatewayToken,
      password: config.openClawGatewayPassword,
    });
  }
  if (agentId === "claude-code") {
    return checkClaudeCodeAuthStatus(config.claudeCodeCliPath);
  }
  return checkAuthStatus(config.codexApiKey);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down NordRelay...`);
  if (bot && runtimeConfig?.telegramTransport !== "webhook") bot.stop();
  void discordBridge?.stop().catch((error) => {
    console.warn("Failed to stop Discord bridge:", error instanceof Error ? error.message : String(error));
  });
  webhookServer?.close();

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

if (registry && bot) {
  if (runtimeConfig?.telegramTransport === "webhook") {
    webhookServer = await startWebhook(bot, runtimeConfig);
  } else {
    await startPolling();
  }
}

async function startWebhook(activeBot: ReturnType<typeof createBot>, config: ConnectorConfig): Promise<Server> {
  const callback = webhookCallback(activeBot, "http", {
    secretToken: config.telegramWebhookSecret,
  });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    if (req.url?.split("?")[0] !== config.telegramWebhookPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    void callback(req, res);
  });
  await activeBot.api.setWebhook(joinWebhookUrl(config.telegramWebhookUrl!, config.telegramWebhookPath), {
    secret_token: config.telegramWebhookSecret,
    drop_pending_updates: process.env.NORDRELAY_DROP_PENDING_UPDATES !== "0",
  });
  await new Promise<void>((resolve) => {
    server.listen(config.telegramWebhookPort, config.telegramWebhookHost, resolve);
  });
  console.log(`Webhook listening on ${config.telegramWebhookHost}:${config.telegramWebhookPort}${config.telegramWebhookPath}`);
  return server;
}

function joinWebhookUrl(baseUrl: string, webhookPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`}`;
}

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
