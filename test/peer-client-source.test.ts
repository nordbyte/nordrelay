import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("peer client transport", () => {
  it("disables HTTP agent reuse for TLS-pinned peer requests", () => {
    const peerClient = readFileSync("src/peers/peer-client.ts", "utf8");
    const outboundRelay = readFileSync("src/peers/peer-outbound-relay.ts", "utf8");

    expect(peerClient.match(/agent: false/g)?.length).toBeGreaterThanOrEqual(2);
    expect(outboundRelay).toContain("agent: false");
  });

  it("parses complete SSE data frames for peer event streams", () => {
    const peerClient = readFileSync("src/peers/peer-client.ts", "utf8");

    expect(peerClient).toContain("function sseFrameData(frame: string): string");
    expect(peerClient).toContain("for (const rawLine of frame.split(/\\r?\\n/))");
    expect(peerClient).toContain("if (field !== \"data\") continue;");
    expect(peerClient).toContain("return dataLines.join(\"\\n\").trim();");
    expect(peerClient).not.toContain("frame.split(/\\n/).find((line) => line.startsWith(\"data:\"))");
  });
});
