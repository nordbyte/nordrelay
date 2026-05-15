import os from "node:os";

import type { ConnectorConfig } from "./config.js";
import { checkPeerIdentityEndpoint } from "./peer-client.js";
import type { PeerDiscoveryCandidate, PeerDiscoveryResult } from "./peer-types.js";

interface DiscoveryTarget {
  host: string;
  url: string;
  scheme: "http" | "https";
  port: number;
}

export async function discoverLanPeers(config: ConnectorConfig, options: {
  timeoutMs?: number;
  concurrency?: number;
  maxHosts?: number;
} = {}): Promise<PeerDiscoveryResult> {
  const warnings: string[] = [];
  const targets = buildDiscoveryTargets(config, options.maxHosts ?? 512, warnings);
  const candidates: PeerDiscoveryCandidate[] = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 32, 128));
  let index = 0;

  async function worker(): Promise<void> {
    while (index < targets.length) {
      const target = targets[index++];
      const startedAt = Date.now();
      const probe = await checkPeerIdentityEndpoint(target.url, { timeoutMs: options.timeoutMs ?? config.peerDiscoveryTimeoutMs });
      if (!probe.ok || !probe.identity) {
        continue;
      }
      candidates.push({
        url: target.url,
        host: target.host,
        port: target.port,
        scheme: target.scheme,
        nodeId: probe.identity.nodeId,
        name: probe.identity.name,
        fingerprint: probe.identity.fingerprint,
        tlsFingerprint: probe.tlsFingerprint,
        latencyMs: probe.latencyMs ?? Date.now() - startedAt,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return {
    scanned: targets.length,
    candidates: dedupeCandidates(candidates),
    warnings,
  };
}

function buildDiscoveryTargets(config: ConnectorConfig, maxHosts: number, warnings: string[]): DiscoveryTarget[] {
  const schemes: Array<"http" | "https"> = config.peerTlsEnabled ? ["https"] : ["http", "https"];
  const hosts = localSubnetHosts(maxHosts, warnings);
  if (hosts.length === 0) {
    warnings.push("No private IPv4 LAN interface was found for peer discovery.");
  }
  const targets: DiscoveryTarget[] = [];
  for (const host of hosts) {
    for (const scheme of schemes) {
      targets.push({ host, scheme, port: config.peerPort, url: `${scheme}://${host}:${config.peerPort}` });
    }
  }
  return targets;
}

function localSubnetHosts(maxHosts: number, warnings: string[]): string[] {
  const interfaces = os.networkInterfaces();
  const hosts = new Set<string>();
  for (const items of Object.values(interfaces)) {
    for (const item of items ?? []) {
      if (item.family !== "IPv4" || item.internal || !isPrivateIPv4(item.address)) {
        continue;
      }
      const parts = item.address.split(".").map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
        continue;
      }
      const prefix = parts.slice(0, 3).join(".");
      for (let last = 1; last <= 254; last += 1) {
        const host = `${prefix}.${last}`;
        if (host !== item.address) {
          hosts.add(host);
        }
        if (hosts.size >= maxHosts) {
          warnings.push(`LAN discovery was limited to ${maxHosts} host candidates.`);
          return [...hosts];
        }
      }
    }
  }
  return [...hosts];
}

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function dedupeCandidates(candidates: PeerDiscoveryCandidate[]): PeerDiscoveryCandidate[] {
  const byNode = new Map<string, PeerDiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = byNode.get(candidate.nodeId);
    if (!existing || (candidate.latencyMs ?? Number.MAX_SAFE_INTEGER) < (existing.latencyMs ?? Number.MAX_SAFE_INTEGER)) {
      byNode.set(candidate.nodeId, candidate);
    }
  }
  return [...byNode.values()].sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host));
}
