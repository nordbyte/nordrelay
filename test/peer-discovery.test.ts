import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConnectorConfig } from "../src/core/config.js";
import { PeerDiscoveryJobManager } from "../src/peers/peer-discovery-jobs.js";
import { countDiscoveryTargets } from "../src/peers/peer-discovery.js";

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

  it("persists discovery jobs and marks interrupted jobs after restart", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "nordrelay-peer-discovery-"));
    const filePath = path.join(home, "peer-discovery-jobs.json");
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      jobs: [{
        id: "job-running",
        status: "running",
        createdAt: "2026-05-16T10:00:00.000Z",
        startedAt: "2026-05-16T10:00:01.000Z",
        scanned: 3,
        total: 20,
        candidates: [],
        warnings: [],
        log: ["started"],
        options: { targets: ["192.168.178.10"], timeoutMs: 250, concurrency: 4, maxHosts: 32 },
      }],
    }), "utf8");

    const manager = new PeerDiscoveryJobManager({
      peerTlsEnabled: true,
      peerPort: 31979,
      peerDiscoveryTimeoutMs: 250,
    } as ConnectorConfig, home);

    const job = manager.get("job-running");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("interrupted");
    expect(manager.log("job-running")).toContain("interrupted");
    expect(readFileSync(filePath, "utf8")).toContain("job-running");
  });
});
