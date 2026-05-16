import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportPeerIdentityBackup,
  fingerprintForPublicKey,
  loadOrCreatePeerIdentity,
  restorePeerIdentityBackup,
} from "../src/peers/peer-identity.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("peer identity backup", () => {
  it("exports and restores the node identity with private key validation", () => {
    const source = tempHome();
    const target = tempHome();
    const identity = loadOrCreatePeerIdentity(source, "source");
    const backup = exportPeerIdentityBackup(source);

    const restored = restorePeerIdentityBackup(backup, target);

    expect(restored.public).toEqual(identity.public);
    expect(fingerprintForPublicKey(restored.public.publicKey)).toBe(restored.public.fingerprint);
  });

  it("rejects backups where the public fingerprint was changed", () => {
    const source = tempHome();
    const backup = exportPeerIdentityBackup(source);

    expect(() => restorePeerIdentityBackup({
      ...backup,
      identity: { ...backup.identity, fingerprint: "00:11" },
    }, tempHome())).toThrow(/fingerprint/);
  });
});

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-identity-"));
  tmpDirs.push(dir);
  return dir;
}
