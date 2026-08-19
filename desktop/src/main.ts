import { invoke } from "@tauri-apps/api/core";
import { createSpankWalletPasskey } from "./passkey";
import { showExecutePreview } from "./executePreview";
import { runExecuteAction } from "./executeAction";
import { showFeePayerSetupCard } from "./feePayerSetupCard";
import { showFeePayerUnlockCard } from "./feePayerUnlockCard";
import { PublicKey } from "@solana/web3.js";

const RP_ID = window.location.hostname || "localhost";
const RP_ORIGIN = window.location.origin;
const RP_NAME = "SpankWallet (desktop, fase 0)";

let lastCredentialId: Uint8Array | null = null;
let lastPasskeyPublicKey: Uint8Array | null = null;

const outputEl = () => document.getElementById("output")!;

function log(line: string): void {
  outputEl().textContent += line + "\n";
}

async function bootstrapFeePayer(): Promise<void> {
  log("Fee-payer-status controleren...");
  const exists = await invoke<boolean>("fee_payer_exists");
  if (exists) {
    log("Bestaand fee-payer-snapshot gevonden - ontgrendelen.");
    const pubkey = await showFeePayerUnlockCard();
    log("Fee-payer ontgrendeld: " + pubkey);
  } else {
    log("Geen fee-payer-snapshot gevonden - eenmalige installatie.");
    const pubkey = await showFeePayerSetupCard();
    log("Fee-payer aangemaakt: " + pubkey);
  }
}

async function registerPasskey(): Promise<void> {
  log("Stap 1: nieuwe passkey registreren voor deze Tauri-webview (rpId=" + RP_ID + ")...");
  log("tauri-plugin-webauthn's register() wordt aangeroepen (WebKitGTK heeft geen eigen");
  log("navigator.credentials - zie STATUS.md) - sluit je externe FIDO2-hardware-sleutel");
  log("aan en keur de PIN-/aanraak-prompt goed.");
  try {
    const result = await createSpankWalletPasskey(RP_NAME, RP_ID, "spankwallet-desktop", RP_ORIGIN);
    lastCredentialId = result.credentialId;
    lastPasskeyPublicKey = result.compressedPublicKey;

    const pubkeyHex = Array.from(result.compressedPublicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    log("Passkey geregistreerd. Gecomprimeerde publieke sleutel (hex, 33 bytes):");
    log(pubkeyHex);
    log("");
    log("Voeg deze sleutel nu toe aan een bestaande wallet via de browser-client's");
    log("add_passkey-flow (secties 11-15), ondertekend door PASSKEY 1. Vul daarna");
    log("hierboven het wallet-PDA-adres in en klik op stap 2.");

    (document.getElementById("execute-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("FOUT bij passkey-registratie: " + String(err));
    console.error(err);
  }
}

async function runExecute(): Promise<void> {
  if (!lastCredentialId || !lastPasskeyPublicKey) {
    log("Registreer eerst een passkey (stap 1).");
    return;
  }
  const walletPdaInput = document.getElementById("wallet-pda-input") as HTMLInputElement;
  const walletPda = walletPdaInput.value.trim();
  if (!walletPda) {
    log("Vul eerst het wallet-PDA-adres in.");
    return;
  }
  let walletPubkey: PublicKey;
  try {
    walletPubkey = new PublicKey(walletPda);
  } catch {
    log("Ongeldig wallet-PDA-adres.");
    return;
  }

  log("Stap 2: execute-bevestigingskaart tonen...");
  const choice = await showExecutePreview(walletPubkey, 1_000_000n);
  if (!choice) {
    log("Geweigerd in de bevestigingskaart - execute_action NIET aangeroepen.");
    return;
  }

  log(
    "Bevestigd: " + choice.amountLamports.toString() + " lamports naar " + choice.recipient.toBase58() + "."
  );
  log("tauri-plugin-webauthn's authenticate() wordt aangeroepen - keur de PIN-/aanraak-prompt");
  log("op je hardware-sleutel goed.");

  try {
    const signature = await runExecuteAction({
      walletPda,
      recipient: choice.recipient.toBase58(),
      amountLamports: choice.amountLamports,
      origin: RP_ORIGIN,
      rpId: RP_ID,
      credentialId: lastCredentialId,
      passkeyCompressedPublicKey: lastPasskeyPublicKey,
    });
    log("SUCCES - execute-transactie bevestigd op devnet. Signature:");
    log(signature);
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message : JSON.stringify(err);
    log("FOUT bij execute_action: " + message);
    console.error(err);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("register-passkey-btn")!.addEventListener("click", () => {
    registerPasskey();
  });
  document.getElementById("execute-btn")!.addEventListener("click", () => {
    runExecute();
  });

  bootstrapFeePayer().catch((err) => {
    log("FOUT bij fee-payer-bootstrap: " + String(err));
    console.error(err);
  });
});
