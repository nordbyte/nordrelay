import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("peer client transport", () => {
  it("disables HTTP agent reuse for TLS-pinned peer requests", () => {
    const peerClient = readFileSync("src/peers/peer-client.ts", "utf8");
    const outboundRelay = readFileSync("src/peers/peer-outbound-relay.ts", "utf8");

    expect(peerClient.match(/agent: false/g)?.length).toBeGreaterThanOrEqual(2);
    expect(outboundRelay).toContain("agent: false");
  });
});
