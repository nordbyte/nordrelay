import { describe, expect, it } from "vitest";

import { parseLastAgentMessageOptions } from "../src/channels/shared/last-agent-message.js";

describe("last agent message command", () => {
  it("defaults to one message", () => {
    expect(parseLastAgentMessageOptions("").count).toBe(1);
    expect(parseLastAgentMessageOptions("full").count).toBe(1);
  });

  it("accepts a bounded message count", () => {
    expect(parseLastAgentMessageOptions("3").count).toBe(3);
    expect(parseLastAgentMessageOptions("last 20").count).toBe(5);
    expect(parseLastAgentMessageOptions("0").count).toBe(1);
  });
});
