import { describe, expect, it } from "vitest";

import { checkPiAuthStatus } from "../src/agents/pi/pi-auth.js";

describe("pi-auth", () => {
  it("checks provider environment variables for selected Pi models", () => {
    expect(checkPiAuthStatus("openai-codex/gpt-5.5", { OPENAI_API_KEY: "key" })).toMatchObject({
      authenticated: true,
      method: "api-key",
    });

    expect(checkPiAuthStatus("anthropic/claude-sonnet", {})).toMatchObject({
      authenticated: false,
      method: "none",
    });
  });

  it("treats unknown providers as host-verifiable", () => {
    expect(checkPiAuthStatus("custom/model", {})).toMatchObject({
      authenticated: true,
      method: "cli",
    });
  });
});
