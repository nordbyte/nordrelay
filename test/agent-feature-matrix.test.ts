import { describe, expect, it } from "vitest";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agent.js";
import { agentFeatureStates, formatAgentFeatureSummaryPlain } from "../src/agent-feature-matrix.js";

describe("agent feature matrix", () => {
  it("renders supported and unsupported feature summaries", () => {
    const codex = agentFeatureStates(CODEX_AGENT_CAPABILITIES);
    expect(codex.every((feature) => feature.supported)).toBe(true);

    const piSummary = formatAgentFeatureSummaryPlain(PI_AGENT_CAPABILITIES);
    expect(piSummary.join("\n")).toContain("Model");
    expect(piSummary.join("\n")).toContain("Fast mode");
    expect(piSummary.join("\n")).toContain("Login");
  });
});
