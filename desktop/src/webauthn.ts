import { authenticate } from "tauri-plugin-webauthn-api";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";

/**
 * Desktop-eigen WebAuthn-aanroep-helper - gebruikt tauri-plugin-webauthn's
 * authenticate() i.p.v. navigator.credentials.get() (bestaat niet in
 * WebKitGTK/Linux, zie passkey.ts's doc-comment voor de volledige
 * onderbouwing). De challenge-vergelijking en de DER->raw-low-S-conversie
 * gebeuren nog steeds niet hier, maar in Rust (execute.rs) - dit bestand
 * doet uitsluitend de ceremonie-aanroep zelf (moet in JS/via het plugin,
 * kan niet anders) en base64url-(de)codeert de velden voor invoke().
 *
 * Het plugin retourneert/verwacht base64url-strings voor alle binaire
 * velden (@simplewebauthn/types-conventie: Base64URLString = string),
 * geen ArrayBuffer's zoals de browser-native navigator.credentials.
 */
export interface WebAuthnRawResponse {
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
  challengeB64url: string
): Promise<WebAuthnRawResponse> {
  // authenticate() is getypeerd als Promise<PublicKeyCredentialJSON>, een
  // union met RegistrationResponseJSON - onnauwkeurig aan de plugin-kant
  // (authenticate() geeft semantisch altijd een AuthenticationResponseJSON
  // terug, nooit een registratie-respons). Expliciete, gerechtvaardigde
  // vernauwing i.p.v. een blinde `as any`.
  const result = (await authenticate(origin, {
    challenge: challengeB64url,
    rpId,
    allowCredentials: [{ id: base64urlEncode(credentialId), type: "public-key" }],
    userVerification: "required",
    timeout: 120000,
  })) as AuthenticationResponseJSON;

  return {
    clientDataJsonB64url: result.response.clientDataJSON,
    authenticatorDataB64url: result.response.authenticatorData,
    signatureDerB64url: result.response.signature,
  };
}
