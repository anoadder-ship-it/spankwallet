import { invoke } from "@tauri-apps/api/core";
import { signWithPasskeyRaw, base64urlEncode } from "./webauthn";

/**
 * Desktop-eigen tegenhanger van client/src/execute.ts - bouwt niet zelf de
 * transactie (dat gebeurt nu in Rust, execute_action), maar orchestreert
 * het tweestaps-invoke()-patroon (Tauri-migratie-ontwerp, Stronghold-
 * deelplan punt 4): eerst het challenge ophalen bij Rust, dan de ECHTE
 * hardware-passkey-ceremonie (moet in JS), dan de ruwe respons terug naar
 * Rust voor onafhankelijke verificatie + daadwerkelijke verzending.
 */
export interface ExecuteActionParams {
  walletPda: string;
  recipient: string;
  amountLamports: bigint;
  origin: string;
  rpId: string;
  credentialId: Uint8Array;
  passkeyCompressedPublicKey: Uint8Array;
  pin: string;
}

interface PrepareExecuteChallengeResult {
  challengeB64url: string;
  actionNonce: number;
}

interface ExecuteActionResult {
  signature: string;
}

export async function runExecuteAction(params: ExecuteActionParams): Promise<string> {
  const prepared = await invoke<PrepareExecuteChallengeResult>("prepare_execute_challenge", {
    walletPda: params.walletPda,
    recipient: params.recipient,
    amountLamports: Number(params.amountLamports),
  });

  const response = await signWithPasskeyRaw(
    params.origin,
    params.rpId,
    params.credentialId,
    prepared.challengeB64url,
    params.pin
  );

  const result = await invoke<ExecuteActionResult>("execute_action", {
    input: {
      walletPda: params.walletPda,
      recipient: params.recipient,
      amountLamports: Number(params.amountLamports),
      actionNonce: prepared.actionNonce,
      clientDataJsonB64url: response.clientDataJsonB64url,
      authenticatorDataB64url: response.authenticatorDataB64url,
      signatureDerB64url: response.signatureDerB64url,
      passkeyCompressedPubkeyB64url: base64urlEncode(params.passkeyCompressedPublicKey),
    },
  });

  return result.signature;
}
