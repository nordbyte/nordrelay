import { afterEach, describe, expect, it } from "vitest";

import { configureRedaction, redactText } from "../src/redaction.js";

describe("redaction", () => {
  afterEach(() => {
    configureRedaction([]);
  });

  it("redacts common token patterns", () => {
    configureRedaction([]);

    expect(redactText("TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyz123456")).toBe("TELEGRAM_BOT_TOKEN=[REDACTED]");
    expect(redactText("Authorization: sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  it("applies configured redaction patterns", () => {
    configureRedaction(["customer-[0-9]+"]);

    expect(redactText("ticket for customer-1234")).toBe("ticket for [REDACTED]");
  });
});
