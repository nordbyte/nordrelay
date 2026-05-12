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
});
