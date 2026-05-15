import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import selfsigned from "selfsigned";

import { readJsonFileWithBackup, writeJsonFileAtomic, writeTextFileAtomic } from "./persistence.js";
import type { PeerNodeIdentity } from "./peer-types.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");

interface PersistedPeerIdentity extends PeerNodeIdentity {
  privateKey: string;
}

export interface LoadedPeerIdentity {
  public: PeerNodeIdentity;
  privateKey: string;
}

export interface PeerTlsFiles {
  certPath: string;
  keyPath: string;
  cert: string;
  key: string;
  fingerprint: string;
}

export function loadOrCreatePeerIdentity(home = process.env.NORDRELAY_HOME || DEFAULT_HOME, name?: string): LoadedPeerIdentity {
  const filePath = path.join(home, "identity.json");
  const existing = readJsonFileWithBackup<PersistedPeerIdentity>(filePath).value;
  if (existing?.nodeId && existing.publicKey && existing.privateKey && existing.fingerprint) {
    return {
      public: {
        nodeId: existing.nodeId,
        name: existing.name || defaultNodeName(),
        publicKey: existing.publicKey,
        fingerprint: existing.fingerprint,
        createdAt: existing.createdAt,
      },
      privateKey: existing.privateKey,
    };
  }

  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKey = pair.publicKey.toString();
  const createdAt = new Date().toISOString();
  const identity: PersistedPeerIdentity = {
    nodeId: createNodeId(publicKey),
    name: name?.trim() || defaultNodeName(),
    publicKey,
    privateKey: pair.privateKey.toString(),
    fingerprint: fingerprintForPublicKey(publicKey),
    createdAt,
  };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFileAtomic(filePath, identity);
  chmodSync(filePath, 0o600);
  return {
    public: {
      nodeId: identity.nodeId,
      name: identity.name,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      createdAt: identity.createdAt,
    },
    privateKey: identity.privateKey,
  };
}

export function ensurePeerTlsFiles(home = process.env.NORDRELAY_HOME || DEFAULT_HOME, identity?: PeerNodeIdentity): PeerTlsFiles {
  const certDir = path.join(home, "tls");
  const certPath = path.join(certDir, "peer.crt");
  const keyPath = path.join(certDir, "peer.key");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    return { certPath, keyPath, cert, key, fingerprint: fingerprintForCertificate(cert) };
  }

  mkdirSync(certDir, { recursive: true });
  const attrs = [{ name: "commonName", value: identity?.nodeId ?? "nordrelay-peer" }];
  const generated = selfsigned.generate(attrs, {
    algorithm: "sha256",
    days: 3650,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          { type: 7, ip: "::1" },
        ],
      },
    ],
  });
  writeTextFileAtomic(certPath, generated.cert);
  writeTextFileAtomic(keyPath, generated.private);
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o600);
  return {
    certPath,
    keyPath,
    cert: generated.cert,
    key: generated.private,
    fingerprint: fingerprintForCertificate(generated.cert),
  };
}

export function signPeerPayload(privateKey: string, payload: string): string {
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
}

export function verifyPeerPayload(publicKey: string, payload: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function createPairingSignaturePayload(nodeId: string, timestamp: string, code: string): string {
  return `${nodeId}\n${timestamp}\n${code}`;
}

export function createSharedSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function fingerprintForPublicKey(publicKey: string): string {
  return formatFingerprint(createHash("sha256").update(publicKey).digest("hex"));
}

export function fingerprintForCertificate(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return formatFingerprint(createHash("sha256").update(Buffer.from(body, "base64")).digest("hex"));
}

function createNodeId(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

function defaultNodeName(): string {
  return `${os.hostname()} (${process.platform})`;
}

function formatFingerprint(hex: string): string {
  return hex.match(/.{1,2}/g)?.join(":") ?? hex;
}
