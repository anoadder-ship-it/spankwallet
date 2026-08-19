import { invoke } from "@tauri-apps/api/core";
import { base64urlDecode } from "./webauthn";

/**
 * Desktop-eigen passkey-registratie - roept het eigen register_passkey-
 * Tauri-command aan (Rust, ctap-hid-fido2 direct), i.p.v.
 * navigator.credentials.create() (bestaat niet in WebKitGTK/Linux) OF
 * tauri-plugin-webauthn (authenticator-rs bleek structureel te hangen op
 * deze machine - STATUS.md sectie 75, volledige onderzoekstrail).
 *
 * De CBOR-/COSE-sleutel-extractielogica die hier vroeger stond (identiek
 * aan client/src/passkey.ts) is VERVALLEN: ctap-hid-fido2 retourneert al
 * een getypeerd Rust-struct met de al-gecomprimeerde publieke sleutel en
 * credential-ID - de extractie gebeurt nu in Rust (passkey_ctap.rs),
 * dichter bij de bron, geen dubbele CBOR-parsing meer nodig.
 */
export interface PasskeyCreationResult {
  compressedPublicKey: Uint8Array;
  credentialId: Uint8Array;
}

interface RegisterPasskeyResult {
  compressedPublicKeyB64url: string;
  credentialIdB64url: string;
}

export async function createSpankWalletPasskey(
  rpId: string,
  userName: string,
  origin: string,
  pin: string
): Promise<PasskeyCreationResult> {
  const result = await invoke<RegisterPasskeyResult>("register_passkey", {
    rpId,
    origin,
    userName,
    pin,
  });

  return {
    compressedPublicKey: base64urlDecode(result.compressedPublicKeyB64url),
    credentialId: base64urlDecode(result.credentialIdB64url),
  };
}
