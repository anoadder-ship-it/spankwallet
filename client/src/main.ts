// Buffer-polyfill: MOET als allereerste, voor @solana/web3.js in de browser
import { Buffer } from "buffer";
(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { createSpankWalletPasskey } from "./passkey";
import { connectWallet, ConnectedWallet } from "./wallet";
import { buildInitWalletTransaction } from "./initWallet";
import { Connection, Keypair } from "@solana/web3.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function log(msg: string): void {
  const el = document.getElementById("output")!;
  el.textContent += msg + "\n";
}

let lastPasskeyPublicKey: Uint8Array | null = null;

async function runStep1(): Promise<void> {
  log("Stap 1: passkey aanmaken via navigator.credentials.create()...");
  try {
    const result = await createSpankWalletPasskey(
      "SpankWallet (test)",
      window.location.hostname,
      "spankwallet-test-user"
    );

    lastPasskeyPublicKey = result.compressedPublicKey;

    log("");
    log("SUCCES.");
    log("");
    log(`Gecomprimeerde publieke sleutel (33 bytes, dit is seed_key voor init_wallet):`);
    log(bytesToHex(result.compressedPublicKey));
    log("");
    log(`Lengte: ${result.compressedPublicKey.length} bytes (moet exact 33 zijn)`);
    log(`Prefix-byte: 0x${result.compressedPublicKey[0].toString(16)} (moet 0x02 of 0x03 zijn)`);
    log("");
    log(`Credential-ID (nodig voor navigator.credentials.get() later):`);
    log(bytesToHex(result.credentialId));
    log("");
    log("Klaar voor stap 2 - klik 'Wallet verbinden + init_wallet aanroepen'.");

    (document.getElementById("step2-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep2(): Promise<void> {
  if (!lastPasskeyPublicKey) {
    log("Voer eerst stap 1 uit (passkey aanmaken).");
    return;
  }

  log("Stap 2: browser-wallet verbinden (Wallet Standard)...");
  let wallet: ConnectedWallet;
  try {
    wallet = await connectWallet();
    log(`Verbonden met "${wallet.walletName}", publicKey: ${wallet.publicKey.toBase58()}`);
  } catch (err) {
    log("FOUT bij wallet-verbinding:");
    log(String(err));
    console.error(err);
    return;
  }

  log("");
  log(
    "backup_authority: willekeurig gegenereerd Ed25519-keypair, ALLEEN voor deze " +
      "geisoleerde init_wallet-test. Dit is GEEN veilig backup-mechanisme - de " +
      "recovery-flow zelf is al apart getest in tests/recovery.ts met correcte " +
      "timelock-semantiek."
  );
  const backupAuthority = Keypair.generate();
  log(`backup_authority pubkey: ${backupAuthority.publicKey.toBase58()}`);

  log("");
  log("Transactie opbouwen (init_wallet, handmatig Borsh-geencodeerd, geen IDL)...");

  try {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const { transaction, pdas } = await buildInitWalletTransaction(
      connection,
      wallet.publicKey,
      lastPasskeyPublicKey,
      backupAuthority.publicKey,
      null
    );

    log(`wallet PDA: ${pdas.walletPda.toBase58()}`);
    log(`vault PDA:  ${pdas.vaultPda.toBase58()}`);
    log("");
    log("Transactie versturen (keur goed in je wallet-extensie)...");


    // Blockhash HIER pas verversen, vlak voor verzending - niet bij het
    // opbouwen van de transactie hierboven. Lokale validators produceren
    // blokken snel genoeg dat een blockhash kan verlopen in de tijd die de
    // gebruiker nodig heeft om de wallet-goedkeuringsprompt te bevestigen.
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    const { signature } = await wallet.signAndSendTransaction(transaction);
    log(`Verstuurd. Signature: ${signature}`);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");

    const accountInfo = await connection.getAccountInfo(pdas.walletPda);
    if (accountInfo === null) {
      log("FOUT: wallet-PDA bestaat niet na bevestigde transactie (onverwacht).");
      return;
    }
    log("");
    log("SUCCES - WalletAccount daadwerkelijk aangemaakt on-chain, met echte passkey-sleutel.");
    log(`Account-eigenaar (moet ons programma-ID zijn): ${accountInfo.owner.toBase58()}`);
    log(`Account-grootte: ${accountInfo.data.length} bytes`);
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

document.getElementById("start-btn")!.addEventListener("click", () => {
  document.getElementById("output")!.textContent = "";
  runStep1();
});

document.getElementById("step2-btn")!.addEventListener("click", () => {
  runStep2();
});
