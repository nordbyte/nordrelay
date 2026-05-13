import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { maskSecret, resolveDashboardEnvPath, SettingsService } from "../src/settings-service.js";

describe("SettingsService", () => {
  it("masks secrets and writes changed settings", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-settings-"));
    try {
      const envPath = path.join(dir, "nordrelay.env");
      writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=123456789:secret-token\nNORDRELAY_PI_ENABLED=false\n", "utf8");
      const service = new SettingsService(envPath);

      const snapshot = await service.snapshot({});
      const botToken = snapshot.settings.find((setting) => setting.key === "TELEGRAM_BOT_TOKEN");
      expect(botToken?.masked).toBe(true);
      expect(botToken?.value).toBe("1234...oken");

      const result = await service.update({
        TELEGRAM_BOT_TOKEN: botToken?.value,
        NORDRELAY_PI_ENABLED: "true",
        CODEX_MODEL: "gpt-5.5",
      });

      expect(result.errors).toEqual([]);
      expect(result.changedKeys).toEqual(["NORDRELAY_PI_ENABLED", "CODEX_MODEL"]);
      await expect(readFile(envPath, "utf8")).resolves.toContain("NORDRELAY_PI_ENABLED=true");
      await expect(readFile(envPath, "utf8")).resolves.toContain("CODEX_MODEL=gpt-5.5");
      await expect(readFile(envPath, "utf8")).resolves.toContain("TELEGRAM_BOT_TOKEN=123456789:secret-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the dashboard env path from home by default", () => {
    const original = process.env.NORDRELAY_ENV_FILE;
    delete process.env.NORDRELAY_ENV_FILE;
    try {
      expect(resolveDashboardEnvPath("/tmp/nordrelay-home", "/tmp/project")).toBe("/tmp/nordrelay-home/nordrelay.env");
    } finally {
      if (original === undefined) delete process.env.NORDRELAY_ENV_FILE;
      else process.env.NORDRELAY_ENV_FILE = original;
    }
  });

  it("masks short and long secrets", () => {
    expect(maskSecret("short")).toBe("********");
    expect(maskSecret("abcdefghijkl")).toBe("abcd...ijkl");
  });

  it("keeps configured values separate from active defaults", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-settings-defaults-"));
    try {
      const envPath = path.join(dir, "nordrelay.env");
      writeFileSync(envPath, "", "utf8");
      const service = new SettingsService(envPath);

      const snapshot = await service.snapshot({}, {
        CONNECTOR_LOG_FORMAT: "text",
        NORDRELAY_STATE_BACKEND: "json",
      });
      const logFormat = snapshot.settings.find((setting) => setting.key === "CONNECTOR_LOG_FORMAT");
      const stateBackend = snapshot.settings.find((setting) => setting.key === "NORDRELAY_STATE_BACKEND");

      expect(logFormat).toEqual(expect.objectContaining({
        configured: false,
        value: "",
        effectiveValue: "text",
      }));
      expect(stateBackend).toEqual(expect.objectContaining({
        configured: false,
        value: "",
        effectiveValue: "json",
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates dashboard setting values before writing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-settings-validation-"));
    try {
      const envPath = path.join(dir, "nordrelay.env");
      writeFileSync(envPath, "NORDRELAY_STATE_BACKEND=json\n", "utf8");
      const service = new SettingsService(envPath);

      const result = await service.update({
        NORDRELAY_STATE_BACKEND: "bad",
        TELEGRAM_WEBHOOK_PORT: "not-a-number",
      });

      expect(result.changedKeys).toEqual([]);
      expect(result.errors.map((error) => error.key)).toEqual(["NORDRELAY_STATE_BACKEND", "TELEGRAM_WEBHOOK_PORT"]);
      await expect(readFile(envPath, "utf8")).resolves.toContain("NORDRELAY_STATE_BACKEND=json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
