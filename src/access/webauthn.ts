import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import type { UserRecord, WebAuthnCredentialRecord } from "./user-management-types.js";

export interface WebAuthnRelyingParty {
  rpName: string;
  rpId: string;
  origin: string;
}

export async function webAuthnRegistrationOptions(input: {
  rp: WebAuthnRelyingParty;
  user: Pick<UserRecord, "id" | "email" | "displayName">;
  credentials: WebAuthnCredentialRecord[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: input.rp.rpName,
    rpID: input.rp.rpId,
    userName: input.user.email,
    userDisplayName: input.user.displayName,
    userID: Buffer.from(input.user.id),
    attestationType: "none",
    excludeCredentials: input.credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as never,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

export async function verifyWebAuthnRegistration(input: {
  rp: WebAuthnRelyingParty;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<{
  verified: boolean;
  credential?: {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    deviceType?: string;
    backedUp?: boolean;
  };
}> {
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.rpId,
    requireUserVerification: false,
  });
  if (!verification.verified) {
    return { verified: false };
  }
  const info = verification.registrationInfo;
  return {
    verified: true,
    credential: {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transports: input.response.response.transports,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
  };
}

export async function webAuthnAuthenticationOptions(input: {
  rp: WebAuthnRelyingParty;
  credentials: WebAuthnCredentialRecord[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.rp.rpId,
    allowCredentials: input.credentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as never,
    })),
    userVerification: "preferred",
  });
}

export async function verifyWebAuthnAuthenticationChallenge(input: {
  rp: WebAuthnRelyingParty;
  response: AuthenticationResponseJSON;
  credential: WebAuthnCredentialRecord;
  expectedChallenge: string;
}): Promise<{ verified: boolean; newCounter?: number }> {
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.rpId,
    credential: webAuthnCredential(input.credential),
    requireUserVerification: false,
  });
  return {
    verified: verification.verified,
    newCounter: verification.authenticationInfo?.newCounter,
  };
}

function webAuthnCredential(credential: WebAuthnCredentialRecord): WebAuthnCredential {
  return {
    id: credential.credentialId,
    publicKey: Buffer.from(credential.publicKey, "base64url"),
    counter: credential.counter,
    transports: credential.transports as never,
  };
}
