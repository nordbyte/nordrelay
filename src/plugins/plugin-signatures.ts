import { verify } from "node:crypto";

import { canonicalJson } from "./plugin-integrity.js";
import type { PluginManifest, PluginSignatureVerification } from "./plugin-types.js";

export function verifyPluginManifestSignature(
  manifest: PluginManifest,
  publicKeyPem: string | undefined,
  requireSignature: boolean | undefined,
): PluginSignatureVerification {
  const signature = manifest.signature;
  if (!signature?.value) {
    return requireSignature
      ? { status: "invalid", message: "Manifest signature is required but missing." }
      : { status: "unsigned", message: "Manifest is not signed." };
  }
  if (!publicKeyPem) {
    return requireSignature
      ? { status: "invalid", keyId: signature.keyId, message: "Manifest signature has no trusted public key." }
      : { status: "unsigned", keyId: signature.keyId, message: "Manifest signature cannot be verified without a trusted public key." };
  }
  if (signature.algorithm && signature.algorithm !== "ed25519") {
    return { status: "invalid", keyId: signature.keyId, message: `Unsupported signature algorithm: ${signature.algorithm}` };
  }
  try {
    const { signature: _signature, ...unsignedManifest } = manifest;
    const ok = verify(
      null,
      Buffer.from(canonicalJson(unsignedManifest)),
      publicKeyPem,
      Buffer.from(signature.value, "base64"),
    );
    return ok
      ? { status: "verified", keyId: signature.keyId, message: "Manifest signature verified." }
      : { status: "invalid", keyId: signature.keyId, message: "Manifest signature verification failed." };
  } catch (error) {
    return {
      status: "invalid",
      keyId: signature.keyId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
