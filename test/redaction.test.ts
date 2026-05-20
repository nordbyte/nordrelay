import { afterEach, describe, expect, it } from "vitest";

import { SECRET_KEYS } from "../src/core/config-metadata.js";
import { configureRedaction, redactText } from "../src/core/redaction.js";

describe("redaction", () => {
  afterEach(() => {
    configureRedaction([]);
  });

  it("redacts common token patterns", () => {
    configureRedaction([]);

    expect(redactText("TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyz123456")).toBe("TELEGRAM_BOT_TOKEN=[REDACTED]");
    expect(redactText("Authorization: sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  it("redacts every documented secret setting key", () => {
    configureRedaction([]);

    for (const key of SECRET_KEYS) {
      const secret = `fake-secret-value-for-${key.toLowerCase()}-1234567890`;
      const redacted = redactText(`${key}=${secret}`);
      expect(redacted, key).toBe(`${key}=[REDACTED]`);
      expect(redacted, key).not.toContain(secret);
    }
  });

  it("redacts adapter and authorization secrets outside the documented key list", () => {
    configureRedaction([]);

    expect(redactText("CUSTOM_SERVICE_TOKEN=custom-token-1234567890")).toBe("CUSTOM_SERVICE_TOKEN=[REDACTED]");
    expect(redactText("Authorization: Bearer custom-token-1234567890")).toBe("Authorization: [REDACTED]");
  });

  it("applies configured redaction patterns", () => {
    configureRedaction(["customer-[0-9]+"]);

    expect(redactText("ticket for customer-1234")).toBe("ticket for [REDACTED]");
  });
});
