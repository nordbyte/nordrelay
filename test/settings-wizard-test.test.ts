import { describe, expect, it } from "vitest";

import { mergeSettingsWizardTestSettings, runSettingsWizardTest } from "../src/core/settings-wizard-test.js";

describe("settings wizard test checks", () => {
  it("keeps existing secrets for live checks when the WebUI submits masked values", () => {
    const settings = mergeSettingsWizardTestSettings(
      {
        TELEGRAM_BOT_TOKEN: "123456789:real-token-from-local-config",
        TELEGRAM_TRANSPORT: "polling",
      },
      {
        TELEGRAM_BOT_TOKEN: "1234...nfig",
        TELEGRAM_TRANSPORT: "webhook",
      },
    );

    expect(settings).toMatchObject({
      TELEGRAM_BOT_TOKEN: "123456789:real-token-from-local-config",
      TELEGRAM_TRANSPORT: "webhook",
    });
  });

  it("validates Telegram webhook settings without leaking configured secrets", async () => {
    const result = await runSettingsWizardTest("telegram", {
      TELEGRAM_BOT_TOKEN: "1234...abcd",
      TELEGRAM_TRANSPORT: "webhook",
      TELEGRAM_WEBHOOK_URL: "http://example.test",
      TELEGRAM_WEBHOOK_HOST: "127.0.0.1",
      TELEGRAM_WEBHOOK_PORT: "8080",
      TELEGRAM_WEBHOOK_PATH: "/telegram/webhook",
    });

    expect(result.channel).toBe("telegram");
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Telegram bot token",
      status: "warn",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Webhook public URL",
      status: "error",
    }));
  });

  it("validates Discord IDs and command mode", async () => {
    const result = await runSettingsWizardTest("discord", {
      DISCORD_BOT_TOKEN: "short",
      DISCORD_CLIENT_ID: "not-a-snowflake",
      DISCORD_GUILD_IDS: "12345, abc",
      DISCORD_ALLOWED_GUILD_IDS: "",
      DISCORD_ALLOWED_CHANNEL_IDS: "",
      DISCORD_COMMAND_MODE: "both",
      DISCORD_MESSAGE_CONTENT_ENABLED: "false",
    });

    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Discord bot token",
      status: "error",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Discord client ID",
      status: "error",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Message Content Intent",
      status: "warn",
    }));
  });

  it("validates Slack socket-mode token requirements", async () => {
    const result = await runSettingsWizardTest("slack", {
      SLACK_BOT_TOKEN: "xoxb-...abcd",
      SLACK_APP_TOKEN: "",
      SLACK_SOCKET_MODE: "true",
      SLACK_COMMAND: "nordrelay",
      SLACK_ALLOWED_TEAM_IDS: "T123",
      SLACK_ALLOWED_CHANNEL_IDS: "bad-id!",
    });

    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Slack app token",
      status: "error",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Slack command",
      status: "error",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      label: "Allowed Slack channels",
      status: "error",
    }));
  });
});
