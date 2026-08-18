/**
 * Desktop-eigen WebAuthn-aanroep-helper - bewust VEREENVOUDIGD t.o.v.
 * client/src/webauthnSign.ts: de challenge-vergelijking en de DER->raw-
 * low-S-conversie gebeuren niet meer hier, maar in Rust (execute.rs), zie
 * het Tauri-migratie-ontwerp (hoofdplan punt 1) - dit bestand doet
 * uitsluitend de rauwe navigator.credentials.get()-aanroep zelf (moet in
 * JS blijven, kan niet anders) en base64url-encodeert de respons-velden
 * voor invoke().
 */
export interface WebAuthnRawResponse {
  clientDataJsonB64url: string;
  authenticatorDataB64url: string;
  signatureDerB64url: string;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signWithPasskeyRaw(
  rpId: string,
  credentialId: Uint8Array,
  challengeB64url: string
): Promise<WebAuthnRawResponse> {
  const challenge = base64urlDecode(challengeB64url);

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      timeout: 120000,
    },
  })) as PublicKeyCredential;

  if (!assertion) {
    throw new Error("navigator.credentials.get() gaf geen credential terug");
  }

  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    clientDataJsonB64url: base64urlEncode(new Uint8Array(response.clientDataJSON)),
    authenticatorDataB64url: base64urlEncode(new Uint8Array(response.authenticatorData)),
    signatureDerB64url: base64urlEncode(new Uint8Array(response.signature)),
  };
}

export { base64urlEncode, base64urlDecode };
