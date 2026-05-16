export type SettingsWizardChannel = "telegram" | "discord" | "slack";

export type SettingsWizardCheckStatus = "ok" | "warn" | "error";

export interface SettingsWizardCheck {
  label: string;
  status: SettingsWizardCheckStatus;
  detail: string;
}

export interface SettingsWizardTestResult {
  channel: SettingsWizardChannel;
  checkedAt: string;
  checks: SettingsWizardCheck[];
}

export async function runSettingsWizardTest(
  channel: string,
  settings: Record<string, string>,
): Promise<SettingsWizardTestResult> {
  const parsedChannel = parseSettingsWizardChannel(channel);
  const checks =
    parsedChannel === "telegram"
      ? await testTelegram(settings)
      : parsedChannel === "discord"
        ? await testDiscord(settings)
        : await testSlack(settings);
  return { channel: parsedChannel, checkedAt: new Date().toISOString(), checks };
}

export function mergeSettingsWizardTestSettings(
  activeSettings: Record<string, string | undefined>,
  submittedSettings: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(activeSettings)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(submittedSettings)) {
    if (typeof value !== "string" || isMaskedSecret(value)) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseSettingsWizardChannel(value: string): SettingsWizardChannel {
  if (value === "telegram" || value === "discord" || value === "slack") {
    return value;
  }
  throw new Error("Invalid settings wizard channel.");
}

async function testTelegram(settings: Record<string, string>): Promise<SettingsWizardCheck[]> {
  const token = settings.TELEGRAM_BOT_TOKEN ?? "";
  const transport = settings.TELEGRAM_TRANSPORT || "polling";
  const checks: SettingsWizardCheck[] = [
    tokenCheck("Telegram bot token", token, /^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/),
    {
      label: "Telegram transport",
      status: transport === "polling" || transport === "webhook" ? "ok" : "error",
      detail: transport === "webhook" ? "Webhook mode selected." : "Polling mode selected.",
    },
  ];

  if (transport === "webhook") {
    checks.push(
      {
        label: "Webhook public URL",
        status: /^https:\/\//.test(settings.TELEGRAM_WEBHOOK_URL ?? "") ? "ok" : "error",
        detail: settings.TELEGRAM_WEBHOOK_URL ? "HTTPS URL configured." : "Webhook mode requires a public HTTPS URL.",
      },
      {
        label: "Webhook bind endpoint",
        status: settings.TELEGRAM_WEBHOOK_HOST && Number.isFinite(Number(settings.TELEGRAM_WEBHOOK_PORT)) && String(settings.TELEGRAM_WEBHOOK_PATH ?? "").startsWith("/") ? "ok" : "error",
        detail: "Host, port, and path must describe the local webhook listener.",
      },
    );
  }

  if (isUsableSecret(token, /^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/)) {
    checks.push(await fetchTelegramIdentity(token));
  }
  return checks;
}

async function testDiscord(settings: Record<string, string>): Promise<SettingsWizardCheck[]> {
  const token = settings.DISCORD_BOT_TOKEN ?? "";
  const clientId = settings.DISCORD_CLIENT_ID ?? "";
  const commandMode = settings.DISCORD_COMMAND_MODE || "both";
  const checks: SettingsWizardCheck[] = [
    tokenCheck("Discord bot token", token, /^.{20,}$/),
    {
      label: "Discord client ID",
      status: isSnowflake(clientId) ? "ok" : "error",
      detail: isSnowflake(clientId) ? "Application ID looks valid." : "Copy Application ID from Discord Developer Portal > General Information.",
    },
    listCheck("Discord guild IDs", settings.DISCORD_GUILD_IDS, isSnowflake),
    listCheck("Allowed Discord guilds", settings.DISCORD_ALLOWED_GUILD_IDS, isSnowflake),
    listCheck("Allowed Discord channels", settings.DISCORD_ALLOWED_CHANNEL_IDS, isSnowflake),
    {
      label: "Discord command mode",
      status: commandMode === "slash" || commandMode === "message" || commandMode === "both" ? "ok" : "error",
      detail: "Supported values are slash, message, or both.",
    },
  ];

  if ((commandMode === "message" || commandMode === "both") && !truthy(settings.DISCORD_MESSAGE_CONTENT_ENABLED)) {
    checks.push({
      label: "Message Content Intent",
      status: "warn",
      detail: "Message command mode needs Message Content Intent enabled in the Discord Developer Portal.",
    });
  }

  if (isUsableSecret(token, /^.{20,}$/)) {
    checks.push(await fetchDiscordIdentity(token));
  }
  return checks;
}

async function testSlack(settings: Record<string, string>): Promise<SettingsWizardCheck[]> {
  const botToken = settings.SLACK_BOT_TOKEN ?? "";
  const appToken = settings.SLACK_APP_TOKEN ?? "";
  const socketMode = truthy(settings.SLACK_SOCKET_MODE);
  const checks: SettingsWizardCheck[] = [
    tokenCheck("Slack bot token", botToken, /^xoxb-/),
    {
      label: "Slack command",
      status: !settings.SLACK_COMMAND || settings.SLACK_COMMAND.startsWith("/") ? "ok" : "error",
      detail: settings.SLACK_COMMAND || "/nordrelay",
    },
    listCheck("Allowed Slack teams", settings.SLACK_ALLOWED_TEAM_IDS, isSlackId),
    listCheck("Allowed Slack channels", settings.SLACK_ALLOWED_CHANNEL_IDS, isSlackId),
  ];

  if (socketMode) {
    checks.push(tokenCheck("Slack app token", appToken, /^xapp-/));
  } else {
    checks.push(
      {
        label: "Slack signing secret",
        status: settings.SLACK_SIGNING_SECRET ? "ok" : "error",
        detail: settings.SLACK_SIGNING_SECRET ? "Signing secret configured." : "HTTP Events mode requires the Slack signing secret.",
      },
      {
        label: "Slack HTTP port",
        status: Number.isFinite(Number(settings.SLACK_PORT)) ? "ok" : "error",
        detail: settings.SLACK_PORT || "Not configured.",
      },
    );
  }

  if (isUsableSecret(botToken, /^xoxb-/)) {
    checks.push(await fetchSlackIdentity(botToken));
  }
  return checks;
}

function tokenCheck(label: string, value: string, pattern: RegExp): SettingsWizardCheck {
  if (!value) {
    return { label, status: "error", detail: "Required value is missing." };
  }
  if (isMaskedSecret(value)) {
    return { label, status: "warn", detail: "Secret is already configured. Paste the real value to run a live API test." };
  }
  return pattern.test(value)
    ? { label, status: "ok", detail: "Format looks valid." }
    : { label, status: "error", detail: "Value does not match the expected format." };
}

function listCheck(label: string, value: string | undefined, predicate: (value: string) => boolean): SettingsWizardCheck {
  const items = parseList(value);
  const invalid = items.filter((item) => !predicate(item));
  if (invalid.length > 0) {
    return { label, status: "error", detail: `Invalid values: ${invalid.join(", ")}` };
  }
  return { label, status: "ok", detail: items.length ? `${items.length} value(s) configured.` : "No allow-list configured." };
}

async function fetchTelegramIdentity(token: string): Promise<SettingsWizardCheck> {
  try {
    const data = await fetchJson(`https://api.telegram.org/bot${token}/getMe`);
    if (data.ok === true) {
      const result = data.result as { username?: string; first_name?: string } | undefined;
      return { label: "Telegram API", status: "ok", detail: `Bot reachable: ${result?.username ?? result?.first_name ?? "configured bot"}.` };
    }
    return { label: "Telegram API", status: "error", detail: String(data.description ?? "Telegram rejected the token.") };
  } catch (error) {
    return { label: "Telegram API", status: "warn", detail: `Live check failed: ${errorText(error)}` };
  }
}

async function fetchDiscordIdentity(token: string): Promise<SettingsWizardCheck> {
  try {
    const data = await fetchJson("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bot ${token}` },
    });
    if (typeof data.id === "string") {
      return { label: "Discord API", status: "ok", detail: `Bot reachable: ${data.username ?? data.id}.` };
    }
    return { label: "Discord API", status: "error", detail: String(data.message ?? "Discord rejected the bot token.") };
  } catch (error) {
    return { label: "Discord API", status: "warn", detail: `Live check failed: ${errorText(error)}` };
  }
}

async function fetchSlackIdentity(token: string): Promise<SettingsWizardCheck> {
  try {
    const data = await fetchJson("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (data.ok === true) {
      return { label: "Slack API", status: "ok", detail: `Bot reachable in ${data.team ?? "workspace"} as ${data.user ?? data.bot_id ?? "bot"}.` };
    }
    return { label: "Slack API", status: "error", detail: String(data.error ?? "Slack rejected the bot token.") };
  } catch (error) {
    return { label: "Slack API", status: "warn", detail: `Live check failed: ${errorText(error)}` };
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: response.ok, status: response.status, description: text.slice(0, 200) };
  }
}

function isUsableSecret(value: string, pattern: RegExp): boolean {
  return Boolean(value) && !isMaskedSecret(value) && pattern.test(value);
}

function isMaskedSecret(value: string): boolean {
  return /^\*+$/.test(value) || value.includes("...");
}

function parseList(value: string | undefined): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isSnowflake(value: string): boolean {
  return /^[0-9]{5,32}$/.test(value);
}

function isSlackId(value: string): boolean {
  return /^[A-Z0-9]{2,64}$/.test(value);
}

function truthy(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
