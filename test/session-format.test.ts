import { describe, expect, it } from "vitest";

import type { CodexSessionInfo } from "../src/agents/codex/codex-session.js";
import {
  formatFileSize,
  renderLaunchSummaryPlain,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
  renderSessionUsageRows,
} from "../src/channels/shared/session-format.js";

describe("session-format", () => {
  const baseInfo: CodexSessionInfo = {
    threadId: "thread-1",
    workspace: "/workspace/project",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
    codexUsage: {
      contextWindow: 200_000,
      contextUsedPercent: 12.34,
      lastTokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
        reasoningOutputTokens: 100,
        totalTokens: 1500,
      },
      totalTokenUsage: {
        inputTokens: 123_456,
        cachedInputTokens: 12_000,
        outputTokens: 2_300_000,
        reasoningOutputTokens: 900,
        totalTokens: 2_423_456,
      },
      rateLimits: {
        primary: {
          usedPercent: 55,
          remainingPercent: 45,
          windowMinutes: 300,
          resetsAt: new Date("2026-05-11T05:00:00.000Z"),
        },
        secondary: {
          usedPercent: 70,
          remainingPercent: 30,
          windowMinutes: 10_080,
          resetsAt: new Date("2026-05-18T00:00:00.000Z"),
        },
      },
      updatedAt: new Date("2026-05-11T00:00:00.000Z"),
    },
    sessionTokens: {
      input: 1500,
      cached: 200,
      output: 2_000_000,
    },
  };

  it("renders compact plain session details", () => {
    const rendered = renderSessionInfoPlain(baseInfo);
    expect(rendered).toContain("Reasoning/Fast: xhigh / off");
    expect(rendered).toContain("Context used: 12.3% (1.5K / 200K)");
    expect(rendered).toContain("out: 2.3M");
    expect(rendered).toContain("Limits left: 5h 45% · weekly 30%");
    expect(rendered).toContain("Session tokens: in: 1.5K");
  });

  it("renders escaped HTML session details", () => {
    const rendered = renderSessionInfoHTML({
      ...baseInfo,
      workspace: "/workspace/<project>",
    });
    expect(rendered).toContain("/workspace/&lt;project&gt;");
    expect(rendered).toContain("<b>Reasoning/Fast:</b>");
    expect(rendered).toContain("5h 45% · weekly 30%");
  });

  it("exposes session usage rows with Telegram labels", () => {
    expect(renderSessionUsageRows(baseInfo)).toEqual([
      ["Context used", "12.3% (1.5K / 200K)"],
      ["Tokens", "in 123K · cached 12K · out 2.3M · reasoning out 900"],
      ["Limits left", "5h 45% · weekly 30%"],
      ["Session tokens", "in: 1.5K · cached: 200 · out: 2M"],
    ]);
  });

  it("renders launch summary and file sizes", () => {
    expect(renderLaunchSummaryPlain({ ...baseInfo, unsafeLaunch: true })).toContain("[unsafe]");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2 MB");
  });
});
