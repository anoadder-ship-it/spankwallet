import { invoke } from "@tauri-apps/api/core";

/**
 * Desktop-eigen WebAuthn-aanroep-helper - roept het eigen sign_with_passkey-
 * Tauri-command aan (Rust, ctap-hid-fido2 direct). Zie passkey.ts's
 * doc-comment voor de volledige onderbouwing (STATUS.md sectie 75) van
 * waarom dit niet meer via tauri-plugin-webauthn/authenticator-rs loopt.
 *
 * De challenge-vergelijking en de DER->raw-low-S-conversie gebeuren nog
 * steeds niet hier, maar in Rust (execute.rs) - dit bestand doet
 * uitsluitend de base64url-(de)codering en de invoke()-aanroep zelf.
 */
export interface WebAuthnRawResponse {
  clientDataJsonB64url: string;
  authenticatorDataB64url: string;
  signatureDerB64url: string;
}

interface SignWithPasskeyResult {
  clientDataJsonB64url: string;
  authenticatorDataB64url: string;
  signatureDerB64url: string;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signWithPasskeyRaw(
  origin: string,
  rpId: string,
  credentialId: Uint8Array,
  challengeB64url: string,
  pin: string
): Promise<WebAuthnRawResponse> {
  const result = await invoke<SignWithPasskeyResult>("sign_with_passkey", {
    rpId,
    origin,
    credentialIdB64url: base64urlEncode(credentialId),
    challengeB64url,
    pin,
  });

  return {
    clientDataJsonB64url: result.clientDataJsonB64url,
    authenticatorDataB64url: result.authenticatorDataB64url,
    signatureDerB64url: result.signatureDerB64url,
  };
}
