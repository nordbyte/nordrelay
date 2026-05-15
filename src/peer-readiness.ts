import net from "node:net";

import type { ConnectorConfig } from "./config.js";
import type { PeerReadiness } from "./peer-types.js";

export async function buildPeerReadiness(config: ConnectorConfig): Promise<PeerReadiness> {
  const listenUrl = peerListenUrl(config);
  const localListening = await checkLocalPort(config.peerHost, config.peerPort);
  const loopbackOnly = isLoopbackUrl(listenUrl);
  const bindLoopbackOnly = isLoopbackHost(config.peerHost);
  const warnings: string[] = [];

  if (!config.peerEnabled) {
    warnings.push("Peer server is disabled. Invites can be created, but pairing will fail until NORDRELAY_PEER_ENABLED=true and NordRelay is restarted.");
  }
  if (config.peerEnabled && !localListening) {
    warnings.push(`Peer server is enabled, but no listener was detected on ${connectHostForBindHost(config.peerHost)}:${config.peerPort}.`);
  }
  if (loopbackOnly) {
    warnings.push("Listen URL uses a loopback host. Other machines cannot reach this URL unless they run on the same host.");
  }
  if (bindLoopbackOnly && !loopbackOnly) {
    warnings.push("Peer server is bound to loopback. Remote access requires a local tunnel, reverse proxy, or port forward to this host.");
  }
  if (!config.peerTlsEnabled && (!loopbackOnly || !bindLoopbackOnly)) {
    warnings.push("Peer TLS is disabled. Use TLS for non-loopback or internet-reachable peer endpoints.");
  }
  return {
    enabled: config.peerEnabled,
    listenUrl,
    bindHost: config.peerHost,
    port: config.peerPort,
    tlsEnabled: config.peerTlsEnabled,
    requireTls: config.peerRequireTls,
    localListening,
    loopbackOnly,
    bindLoopbackOnly,
    manualCheckCommand: `nordrelay peer check ${listenUrl}`,
    warnings,
  };
}

export function peerListenUrl(config: ConnectorConfig): string {
  if (config.peerPublicUrl) return config.peerPublicUrl;
  const scheme = config.peerTlsEnabled ? "https" : "http";
  const host = config.peerHost === "0.0.0.0" || config.peerHost === "::" ? "127.0.0.1" : config.peerHost;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${displayHost}:${config.peerPort}`;
}

function checkLocalPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function connectHostForBindHost(host: string): string {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("127.");
}
