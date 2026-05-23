import { describe, expect, it } from "vitest";

import { firstRunSetupTokenError } from "../src/web/web-first-run-setup-policy.js";

describe("first-run setup token policy", () => {
  it("always requires the generated setup token", () => {
    expect(firstRunSetupTokenError("", "secret")).toBe("Setup token required.");
    expect(firstRunSetupTokenError("wrong", "secret")).toBe("Invalid setup token.");
    expect(firstRunSetupTokenError("secret", "secret")).toBeNull();
  });
});
