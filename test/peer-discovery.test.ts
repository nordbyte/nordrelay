import { describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/config.js";
import { countDiscoveryTargets } from "../src/peer-discovery.js";

describe("peer discovery target expansion", () => {
  it("supports custom CIDR, range, IPv6, mDNS host, and URL targets", async () => {
    const config = {
      peerTlsEnabled: true,
      peerPort: 31979,
      peerDiscoveryTimeoutMs: 250,
    } as ConnectorConfig;

    await expect(countDiscoveryTargets(config, {
      targets: [
        "192.168.178.0/30",
        "192.168.178.10-11",
        "fd00::1",
        "host.local",
        "https://example.local:31980",
      ],
      maxHosts: 512,
    })).resolves.toBe(7);
  });

  it("doubles targets for plaintext peers because both http and https are probed", async () => {
    const config = {
      peerTlsEnabled: false,
      peerPort: 31979,
      peerDiscoveryTimeoutMs: 250,
    } as ConnectorConfig;

    await expect(countDiscoveryTargets(config, {
      targets: ["192.168.178.0/30"],
      maxHosts: 512,
    })).resolves.toBe(4);
  });
});
