import { derSignatureToRawLowS } from "./secp256r1";

export interface WebAuthnSignResult {
  signedMessage: Uint8Array;
  rawSignature: Uint8Array;
  clientDataJSON: Uint8Array;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // EIS 2 (STATUS.md sectie 76/77) - zelfde reden als initWallet.ts::sha256:
  // een echte kopie naar een gegarandeerd vers ArrayBuffer, geen
  // type-only-onderdrukking.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return new Uint8Array(digest);
}

export async function signWithPasskey(
  rpId: string,
  credentialId: Uint8Array,
  expectedChallenge: Uint8Array
): Promise<WebAuthnSignResult> {
  const challengeBase64url = base64urlEncode(expectedChallenge);

  // EIS 2 (STATUS.md sectie 76/77) - zelfde reden als sha256() hierboven:
  // navigator.credentials.get()'s BufferSource-velden (challenge, elke
  // allowCredentials[].id) krijgen hier echte kopieën, geen type-only-
  // onderdrukking.
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(expectedChallenge),
      rpId,
      allowCredentials: [
        {
          id: new Uint8Array(credentialId),
          type: "public-key",
        },
      ],
      userVerification: "required",
      timeout: 120000,
    },
  })) as PublicKeyCredential;

  if (!assertion) {
    throw new Error("navigator.credentials.get() gaf geen credential terug");
  }

  const response = assertion.response as AuthenticatorAssertionResponse;
  const authenticatorData = new Uint8Array(response.authenticatorData);
  const clientDataJSON = new Uint8Array(response.clientDataJSON);
  const derSignature = new Uint8Array(response.signature);

  const clientDataText = new TextDecoder().decode(clientDataJSON);
  const clientData = JSON.parse(clientDataText);
  if (clientData.challenge !== challengeBase64url) {
    throw new Error(
      "Challenge-mismatch: clientDataJSON.challenge komt niet overeen met wat we vroegen. " +
        "Verwacht " + challengeBase64url + ", kreeg " + clientData.challenge
    );
  }

  const clientDataHash = await sha256(clientDataJSON);
  const signedMessage = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signedMessage.set(authenticatorData, 0);
  signedMessage.set(clientDataHash, authenticatorData.length);

  const rawSignature = derSignatureToRawLowS(derSignature);

  return { signedMessage, rawSignature, clientDataJSON };
}
