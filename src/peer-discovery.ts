import dns from "node:dns/promises";
import net from "node:net";
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

export interface PeerDiscoveryOptions {
  timeoutMs?: number;
  concurrency?: number;
  maxHosts?: number;
  targets?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: { scanned: number; total: number; candidate?: PeerDiscoveryCandidate; target: string }) => void;
}

export async function discoverLanPeers(config: ConnectorConfig, options: PeerDiscoveryOptions = {}): Promise<PeerDiscoveryResult> {
  const warnings: string[] = [];
  const targets = await buildDiscoveryTargets(config, options.maxHosts ?? 512, warnings, options.targets ?? []);
  const candidates: PeerDiscoveryCandidate[] = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 32, 128));
  let index = 0;
  let scanned = 0;

  async function worker(): Promise<void> {
    while (index < targets.length) {
      if (options.signal?.aborted) {
        return;
      }
      const target = targets[index++];
      const startedAt = Date.now();
      const probe = await checkPeerIdentityEndpoint(target.url, { timeoutMs: options.timeoutMs ?? config.peerDiscoveryTimeoutMs });
      scanned += 1;
      if (!probe.ok || !probe.identity) {
        options.onProgress?.({ scanned, total: targets.length, target: target.url });
        continue;
      }
      const candidate: PeerDiscoveryCandidate = {
        url: target.url,
        host: target.host,
        port: target.port,
        scheme: target.scheme,
        nodeId: probe.identity.nodeId,
        name: probe.identity.name,
        fingerprint: probe.identity.fingerprint,
        tlsFingerprint: probe.tlsFingerprint,
        latencyMs: probe.latencyMs ?? Date.now() - startedAt,
      };
      candidates.push(candidate);
      options.onProgress?.({ scanned, total: targets.length, candidate, target: target.url });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return {
    scanned,
    candidates: dedupeCandidates(candidates),
    warnings: options.signal?.aborted ? [...warnings, "Discovery was cancelled."] : warnings,
  };
}

export async function countDiscoveryTargets(config: ConnectorConfig, options: Pick<PeerDiscoveryOptions, "maxHosts" | "targets"> = {}): Promise<number> {
  return (await buildDiscoveryTargets(config, options.maxHosts ?? 512, [], options.targets ?? [])).length;
}

async function buildDiscoveryTargets(config: ConnectorConfig, maxHosts: number, warnings: string[], requestedTargets: string[]): Promise<DiscoveryTarget[]> {
  const schemes: Array<"http" | "https"> = config.peerTlsEnabled ? ["https"] : ["http", "https"];
  const explicitTargets = await customDiscoveryTargets(requestedTargets, config.peerPort, schemes, maxHosts, warnings);
  if (explicitTargets.length > 0) {
    return dedupeTargets(explicitTargets);
  }

  const targets: DiscoveryTarget[] = [];
  const hosts = localSubnetHosts(maxHosts, warnings);
  const mdnsHosts = await mdnsCandidateHosts(warnings);
  if (hosts.length === 0 && mdnsHosts.length === 0) {
    warnings.push("No private IPv4 LAN interface was found for peer discovery.");
  }
  for (const host of [...hosts, ...mdnsHosts]) {
    for (const scheme of schemes) {
      targets.push({ host, scheme, port: config.peerPort, url: formatDiscoveryUrl(scheme, host, config.peerPort) });
    }
  }
  return dedupeTargets(targets);
}

async function customDiscoveryTargets(
  requested: string[],
  port: number,
  schemes: Array<"http" | "https">,
  maxHosts: number,
  warnings: string[],
): Promise<DiscoveryTarget[]> {
  const targets: DiscoveryTarget[] = [];
  for (const raw of requested.flatMap((value) => value.split(/[\n, ]/)).map((value) => value.trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const scheme = url.protocol === "http:" ? "http" : "https";
        const targetPort = Number(url.port || port);
        targets.push({ host: url.hostname, scheme, port: targetPort, url: formatDiscoveryUrl(scheme, url.hostname, targetPort) });
      } catch {
        warnings.push(`Ignored invalid discovery URL: ${raw}`);
      }
      continue;
    }
    for (const host of expandHostPattern(raw, maxHosts, warnings)) {
      for (const scheme of schemes) {
        targets.push({ host, scheme, port, url: formatDiscoveryUrl(scheme, host, port) });
      }
    }
  }
  return targets;
}

function expandHostPattern(raw: string, maxHosts: number, warnings: string[]): string[] {
  if (raw.includes("/")) {
    return expandIpv4Cidr(raw, maxHosts, warnings);
  }
  const range = raw.match(/^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$/);
  if (range) {
    const start = Number(range[2]);
    const end = Number(range[3]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 255 || start > end) {
      warnings.push(`Ignored invalid IPv4 range: ${raw}`);
      return [];
    }
    return Array.from({ length: Math.min(maxHosts, end - start + 1) }, (_, index) => `${range[1]}${start + index}`);
  }
  if (net.isIP(raw) || /^[a-z0-9_.-]+$/i.test(raw)) {
    return [raw];
  }
  warnings.push(`Ignored invalid discovery target: ${raw}`);
  return [];
}

function expandIpv4Cidr(raw: string, maxHosts: number, warnings: string[]): string[] {
  const [address, prefixText] = raw.split("/");
  const prefix = Number(prefixText);
  if (net.isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 16 || prefix > 32) {
    warnings.push(`Ignored unsupported discovery CIDR: ${raw}. Use IPv4 /16 through /32.`);
    return [];
  }
  const base = ipv4ToNumber(address);
  const hostBits = 32 - prefix;
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = base & mask;
  const total = prefix === 32 ? 1 : Math.max(0, (2 ** hostBits) - 2);
  const count = Math.min(total, maxHosts);
  if (total > maxHosts) {
    warnings.push(`CIDR ${raw} was limited to ${maxHosts} host candidates.`);
  }
  return Array.from({ length: count }, (_, index) => numberToIpv4(network + (prefix === 32 ? index : index + 1)));
}

async function mdnsCandidateHosts(warnings: string[]): Promise<string[]> {
  const names = [`${os.hostname()}.local`, "nordrelay.local"];
  const found: string[] = [];
  for (const name of names) {
    try {
      await withTimeout(dns.lookup(name), 250);
      found.push(name);
    } catch {
      // mDNS support depends on the host resolver; absence is normal.
    }
  }
  return found;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("mDNS lookup timed out.")), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatDiscoveryUrl(scheme: "http" | "https", host: string, port: number): string {
  const displayHost = net.isIP(host) === 6 && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${displayHost}:${port}`;
}

function dedupeTargets(targets: DiscoveryTarget[]): DiscoveryTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function ipv4ToNumber(address: string): number {
  return address.split(".").map(Number).reduce((sum, part) => ((sum << 8) + part) >>> 0, 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
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
