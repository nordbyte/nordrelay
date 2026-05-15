import { WebClient } from "@slack/web-api";

import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { UserStore } from "./user-management.js";

export interface SlackDiagnosticCheck {
  status: "ok" | "warn" | "error" | "skipped";
  label: string;
  detail: string;
}

export interface SlackChannelDiagnostic {
  channelId: string;
  teamId?: string;
  title?: string;
  status: SlackDiagnosticCheck["status"];
  detail: string;
}

export interface SlackDiagnostics {
  enabled: boolean;
  mode: "socket" | "http";
  configured: boolean;
  generatedAt: string;
  checks: SlackDiagnosticCheck[];
  auth?: {
    ok: boolean;
    teamId?: string;
    userId?: string;
    botId?: string;
    url?: string;
    detail: string;
  };
  registeredChannels: number;
  channelChecks: SlackChannelDiagnostic[];
  rateLimit?: {
    queued: number;
    running: number;
    retries: number;
    rateLimitHits: number;
    lastRateLimitAt?: string;
    lastRetryAfterSeconds?: number;
  };
}

export async function collectSlackDiagnostics(input: {
  config: ConnectorConfig;
  userStore?: UserStore;
  channelProbeLimit?: number;
  timeoutMs?: number;
  rateLimit?: SlackDiagnostics["rateLimit"];
}): Promise<SlackDiagnostics> {
  const { config } = input;
  const checks: SlackDiagnosticCheck[] = [];
  const userStore = input.userStore ?? new UserStore();
  const registeredChannels = userStore.snapshot().slackChannels;
  const mode = config.slackSocketMode ? "socket" : "http";
  const configured = Boolean(config.slackBotToken) &&
    (config.slackSocketMode ? Boolean(config.slackAppToken) : Boolean(config.slackSigningSecret));

  checks.push(check(Boolean(config.slackBotToken), "Bot token", "SLACK_BOT_TOKEN is configured.", "SLACK_BOT_TOKEN is missing."));
  checks.push(check(config.slackSocketMode ? Boolean(config.slackAppToken) : Boolean(config.slackSigningSecret), "Transport secret", config.slackSocketMode ? "Socket Mode app token is configured." : "HTTP signing secret is configured.", config.slackSocketMode ? "SLACK_APP_TOKEN is required for Socket Mode." : "SLACK_SIGNING_SECRET is required for HTTP Events mode."));
  checks.push({
    status: registeredChannels.length > 0 ? "ok" : "warn",
    label: "Registered channels",
    detail: registeredChannels.length > 0
      ? `${registeredChannels.length} Slack channel access record(s) configured.`
      : "No Slack channels are registered yet. Admins can use /register_channel or the WebUI Access page.",
  });
  checks.push({
    status: config.slackAllowedTeamIds.length > 0 || config.slackAllowedChannelIds.length > 0 ? "ok" : "warn",
    label: "Environment allow-list",
    detail: config.slackAllowedTeamIds.length > 0 || config.slackAllowedChannelIds.length > 0
      ? `Team allow-list: ${config.slackAllowedTeamIds.length}; channel allow-list: ${config.slackAllowedChannelIds.length}.`
      : "No SLACK_ALLOWED_TEAM_IDS or SLACK_ALLOWED_CHANNEL_IDS are set. User/group permissions still apply.",
  });
  checks.push({
    status: "ok",
    label: "File upload smoke",
    detail: "Slack file upload uses files.uploadV2; real upload probes are intentionally not sent without a target channel.",
  });

  let auth: SlackDiagnostics["auth"];
  const channelChecks: SlackChannelDiagnostic[] = [];
  if (config.slackEnabled && config.slackBotToken) {
    const client = new WebClient(config.slackBotToken);
    const timeoutMs = input.timeoutMs ?? 4_000;
    try {
      const authResult = await withTimeout(client.auth.test(), timeoutMs);
      auth = {
        ok: Boolean(authResult.ok),
        teamId: authResult.team_id,
        userId: authResult.user_id,
        botId: authResult.bot_id,
        url: authResult.url,
        detail: authResult.ok ? "Slack auth.test succeeded." : "Slack auth.test returned ok=false.",
      };
      checks.push({ status: auth.ok ? "ok" : "error", label: "Slack auth.test", detail: auth.detail });
    } catch (error) {
      auth = { ok: false, detail: friendlyErrorText(error) };
      checks.push({ status: "error", label: "Slack auth.test", detail: auth.detail });
    }

    for (const channel of registeredChannels.slice(0, input.channelProbeLimit ?? 5)) {
      try {
        const result = await withTimeout(client.conversations.info({ channel: channel.channelId }), timeoutMs);
        channelChecks.push({
          channelId: channel.channelId,
          teamId: channel.teamId,
          title: channel.title,
          status: result.ok ? "ok" : "warn",
          detail: result.ok ? "Slack conversations.info succeeded." : "Slack conversations.info returned ok=false.",
        });
      } catch (error) {
        channelChecks.push({
          channelId: channel.channelId,
          teamId: channel.teamId,
          title: channel.title,
          status: "error",
          detail: friendlyErrorText(error),
        });
      }
    }
  } else if (config.slackEnabled) {
    checks.push({ status: "error", label: "Slack API probes", detail: "Cannot run Slack API probes without SLACK_BOT_TOKEN." });
  } else {
    checks.push({ status: "skipped", label: "Slack API probes", detail: "Slack adapter is disabled." });
  }

  return {
    enabled: config.slackEnabled,
    mode,
    configured,
    generatedAt: new Date().toISOString(),
    checks,
    auth,
    registeredChannels: registeredChannels.length,
    channelChecks,
    rateLimit: input.rateLimit,
  };
}

function check(condition: boolean, label: string, okDetail: string, errorDetail: string): SlackDiagnosticCheck {
  return {
    status: condition ? "ok" : "error",
    label,
    detail: condition ? okDetail : errorDetail,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Slack API probe timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

