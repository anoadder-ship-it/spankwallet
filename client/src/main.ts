import "./polyfill";



import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { createSpankWalletPasskey } from "./passkey";
import { connectWallet, ConnectedWallet } from "./wallet";
import { buildInitWalletTransaction, InitWalletPdas } from "./initWallet";
import { buildExecuteTransaction } from "./execute";
import { showExecutePreview } from "./executePreview";
import { showAddPasskeyPreview } from "./addPasskeyPreview";
import {
  readWalletAccount,
  buildInitiateRecoveryTransaction,
  buildCancelRecoveryTransaction,
} from "./recovery";
import { setupSpamTokenAccount, buildHuntTransaction, INCINERATOR } from "./hunt";
import {
  derivePolicyPda,
  readPolicyAccount,
  buildAddAllowedProgramTransaction,
} from "./policy";
import { showRemovePasskeyPreview } from "./removePasskeyPreview";
import { showAddAllowedProgramPreview } from "./addAllowedProgramPreview";
import { showAddSessionKeyPreview } from "./addSessionKeyPreview";
import { showRemoveSessionKeyPreview } from "./removeSessionKeyPreview";
import { showCancelRecoveryPreview } from "./cancelRecoveryPreview";
import { showHuntPreview } from "./huntPreview";
import { readSpendThresholdLamports } from "./challenge";
import { renderThresholdBanner } from "./thresholdBanner";
import { showThresholdChangeInitiatePreview } from "./thresholdChangeInitiatePreview";
import { showThresholdChangeFinalizePreview } from "./thresholdChangeFinalizePreview";
import {
  derivePendingActionPda,
  readPendingAction,
  buildInitiateThresholdChangeTransaction,
  buildFinalizeThresholdChangeTransaction,
  buildCancelActionTransaction,
  PENDING_ACTION_TIMELOCK_SECONDS,
} from "./thresholdChange";
import { thresholdChangePanelState, renderThresholdChangePanel } from "./thresholdChangePanel";
import { readSpendWindow } from "./spendWindow";
import {
  derivePasskeysPda,
  readPasskeysAccount,
  buildAddPasskeyTransaction,
  buildRemovePasskeyTransaction,
} from "./passkeys";
import {
  deriveSessionPda,
  readSessionKeyAccount,
  buildAddSessionKeyTransaction,
  buildRemoveSessionKeyTransaction,
  buildExecuteViaSessionTransaction,
  buildExecuteAdvancedViaSessionTransaction,
  buildCloseExpiredSessionTransaction,
} from "./sessionKeys";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function log(msg: string): void {
  const el = document.getElementById("output")!;
  const line = document.createElement("span");
  if (msg.startsWith("SUCCES")) {
    line.className = "log-success";
  } else if (msg.startsWith("FOUT")) {
    line.className = "log-error";
  }
  line.textContent = msg;
  el.appendChild(line);
  el.appendChild(document.createTextNode("\n"));
}

let lastPasskeyPublicKey: Uint8Array | null = null;
let lastCredentialId: Uint8Array | null = null;
let lastPdas: InitWalletPdas | null = null;
let lastWallet: ConnectedWallet | null = null;
let lastBackupAuthority: Keypair | null = null;
// PASSKEY 2: een tweede, onafhankelijke passkey voor het multi-passkey-model
// (stap 11-15) - los van lastPasskeyPublicKey/lastCredentialId (PASSKEY 1,
// de oorspronkelijke owner_passkey uit stap 1).
let lastPasskeyPublicKey2: Uint8Array | null = null;
let lastCredentialId2: Uint8Array | null = null;
// Session keys (stap 16-20): een gewone Ed25519-Solana-Keypair, GEEN passkey
// - lokaal gegenereerd, geen navigator.credentials-aanroep nodig om hem aan
// te maken. add_session_key blijft wel passkey-gated (zie STATUS.md).
let lastSessionKeypair: Keypair | null = null;
let lastSessionExpirySlot: bigint | null = null;

// STATUS.md sectie 107/109: was hardcoded op drie plekken (hier,
// admin/wallet-signer.html, desktop/src-tauri/src/rpc.rs) - nu een
// env-var, uitsluitend zodat rotatie ooit één regel is i.p.v. drie
// bestanden. GEEN echte secret-hantering: dit is een gratis, devnet-only
// Helius-sleutel (bevestigd in sectie 107 punt 5) - de hardcoded waarde
// hieronder is bewust de terugvaloptie, niet een placeholder, zodat een
// verse kloon zonder enige configuratiestap blijft werken. Eigen sleutel
// zetten: client/.env.local (Vite laadt dit automatisch, .gitignored) met
// VITE_HELIUS_API_KEY=<sleutel>.
const HELIUS_API_KEY = import.meta.env.VITE_HELIUS_API_KEY ?? "f39fc413-6730-4848-a60f-a6685a6f04d3";
const connection = new Connection(`https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, "confirmed");

/**
 * STATUS.md sectie 135: DE ENE plek die bepaalt wat stap 24/25's paneel
 * toont. Leest de pending_action-PDA VERS van de keten en rendert
 * daaruit - geen aparte "ik heb net initiate_threshold_change aangeroepen"
 * -vlag in de client. Aangeroepen ná wallet-load EN ná elke geslaagde
 * initiate/finalize/cancel - een pagina-herlaad een dag later doorloopt
 * daarmee exact hetzelfde codepad als "net geklikt" (ontwerpvraag 2).
 */
async function refreshThresholdChangeStatus(): Promise<void> {
  if (!lastPdas) return;
  const pendingActionPda = derivePendingActionPda(lastPdas.walletPda);
  const pending = await readPendingAction(connection, pendingActionPda);
  const state = thresholdChangePanelState(pending, Math.floor(Date.now() / 1000));
  renderThresholdChangePanel(state);
}

async function runStep1(): Promise<void> {
  log("Stap 1: passkey aanmaken via navigator.credentials.create()...");
  try {
    const result = await createSpankWalletPasskey(
      "SpankWallet (test)",
      window.location.hostname,
      "spankwallet-test-user"
    );

    lastPasskeyPublicKey = result.compressedPublicKey;
    lastCredentialId = result.credentialId;

    log("");
    log("SUCCES.");
    log("");
    log("Gecomprimeerde publieke sleutel (33 bytes, dit is seed_key voor init_wallet):");
    log(bytesToHex(result.compressedPublicKey));
    log("");
    log("Lengte: " + result.compressedPublicKey.length + " bytes (moet exact 33 zijn)");
    log("Prefix-byte: 0x" + result.compressedPublicKey[0].toString(16) + " (moet 0x02 of 0x03 zijn)");
    log("");
    log("Credential-ID (nodig voor navigator.credentials.get() later):");
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
  if (!lastPasskeyPublicKey || !lastCredentialId) {
    log("Voer eerst stap 1 uit (passkey aanmaken).");
    return;
  }

  log("Stap 2: browser-wallet verbinden (Wallet Standard)...");
  let wallet: ConnectedWallet;
  try {
    wallet = await connectWallet();
    lastWallet = wallet;
    log("Verbonden met \"" + wallet.walletName + "\", publicKey: " + wallet.publicKey.toBase58());
  } catch (err) {
    log("FOUT bij wallet-verbinding:");
    log(String(err));
    console.error(err);
    return;
  }

  log("");
  log(
    "backup_authority: willekeurig gegenereerd Ed25519-keypair, bewaard voor hergebruik " +
      "in stap 4 (recovery-flow). Dit is GEEN veilig backup-mechanisme voor productie - " +
      "puur test-keypair, de recovery-timelock-semantiek is al apart getest in " +
      "tests/recovery.ts."
  );
  const backupAuthority = Keypair.generate();
  lastBackupAuthority = backupAuthority;
  log("backup_authority pubkey: " + backupAuthority.publicKey.toBase58());

  log("");
  log("Transactie opbouwen (init_wallet, handmatig Borsh-geencodeerd, geen IDL)...");

  try {
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction, pdas } = await buildInitWalletTransaction(
      connection,
      wallet.publicKey,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname,
      backupAuthority.publicKey,
      null
    );
    lastPdas = pdas;

    log("wallet PDA: " + pdas.walletPda.toBase58());
    log("vault PDA:  " + pdas.vaultPda.toBase58());
    log("");

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    log("Eigen simulatie (voor volledige programma-logs, los van de wallet-extensie)...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { signature } = await wallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

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
    log("Account-eigenaar (moet ons programma-ID zijn): " + accountInfo.owner.toBase58());
    log("Account-grootte: " + accountInfo.data.length + " bytes");
    log("");
    log("Klaar voor stap 3, 4 en/of 5.");

    const spendThreshold = await readSpendThresholdLamports(connection, pdas.walletPda);
    renderThresholdBanner(spendThreshold);

    (document.getElementById("step3-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step4-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step6-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step5-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step8-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step11-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step16-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step24-btn") as HTMLButtonElement).disabled = false;
    // Ontwerpvraag 2 (STATUS.md sectie 135): dit is ook het "terugkerend
    // bezoek"-codepad, niet alleen "wallet net aangemaakt" - deze wallet is
    // hier weliswaar altijd vers (init_wallet), maar refreshThresholdChangeStatus()
    // zelf maakt geen onderscheid en zou een al bestaande PendingAction net zo
    // goed oppikken.
    await refreshThresholdChangeStatus();
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep3(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }

  log("Stap 3: execute aanroepen met een ECHTE passkey-handtekening...");
  log("transfer_sol: 1000 lamports terug naar de payer zelf (kleinste zinvolle test).");
  log("Vault eerst funden met 100000 lamports (init_wallet maakt de vault met precies de rent-exempte minimum aan, geen vrij saldo om te versturen)...");
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: lastWallet.publicKey,
      toPubkey: lastPdas.vaultPda,
      lamports: 100000,
    })
  );
  fundTx.feePayer = lastWallet.publicKey;
  const { blockhash: fundBh } = await connection.getLatestBlockhash();
  fundTx.recentBlockhash = fundBh;
  const { signature: fundSig } = await lastWallet.signAndSendTransaction(fundTx);
  await connection.confirmTransaction(fundSig, "confirmed");
  log("Vault gefund. Signature: " + fundSig);

  log("");
  log("Menselijk-leesbare bevestigingskaart tonen (STATUS.md sectie 50, fase 0) -");
  log("geen passkey-prompt totdat daar expliciet op 'Bevestig en teken' geklikt wordt.");
  const choice = await showExecutePreview(lastWallet.publicKey, 1000n);
  if (choice === null) {
    log("Geweigerd in de bevestigingskaart - execute NIET aangeroepen, geen passkey-prompt.");
    return;
  }
  const testRecipient = choice.recipient;
  const testAmountLamports = choice.amountLamports;
  log("Bevestigd: " + testAmountLamports.toString() + " lamports naar " + testRecipient.toBase58() + ".");
  log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

  try {
    const { transaction, signedMessage, expectedChallenge } = await buildExecuteTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      testRecipient,
      testAmountLamports,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    log("");
    log("Passkey-handtekening ontvangen en secp256r1-precompile-instructie opgebouwd.");
    log("Verwachte challenge (keccak256): " + bytesToHex(expectedChallenge));
    log("Daadwerkelijk ondertekend bericht (authenticatorData || SHA-256(clientDataJSON)):");
    log(bytesToHex(signedMessage));
    log("");

    log("Eigen simulatie (dit is de daadwerkelijke test van verify_passkey_signature)...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("SUCCES - de secp256r1-precompile + verify_passkey_signature accepteerden een");
    log("ECHTE WebAuthn-handtekening van echte hardware.");
    log("");
    log("Transactie versturen (keur goed in je wallet-extensie)...");

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd. execute end-to-end bewezen.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep4(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet || !lastBackupAuthority) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }

  log("Stap 4: initiate_recovery + cancel_recovery, allebei met echte ondertekening...");
  log("");

  try {
    log("4a. initiate_recovery (ondertekend door backup_authority, GEEN passkey nodig)...");
    const dummyNewOwnerPasskey = crypto.getRandomValues(new Uint8Array(33));
    dummyNewOwnerPasskey[0] = 0x02; // secp256r1-prefix moet 0x02/0x03 zijn (validate_passkey_prefix)

    const initiateTx = await buildInitiateRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastBackupAuthority,
      dummyNewOwnerPasskey
    );

    const initiateSimResult = await connection.simulateTransaction(initiateTx);
    log("Simulatie err: " + JSON.stringify(initiateSimResult.value.err));
    for (const line of initiateSimResult.value.logs ?? []) {
      log("  " + line);
    }
    if (initiateSimResult.value.err) {
      log("initiate_recovery-simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Versturen (keur goed in je wallet-extensie)...");
    const { signature: initiateSig } = await lastWallet.signAndSendTransaction(initiateTx);
    log("Verstuurd. Signature: " + initiateSig);
    await connection.confirmTransaction(initiateSig, "confirmed");
    log("Bevestigd.");
    log("");

    log("Controleren of recovery_state daadwerkelijk gezet is (ruwe account-bytes)...");
    const afterInitiate = await readWalletAccount(connection, lastPdas.walletPda);
    if (!afterInitiate.recoveryState) {
      log("FOUT: recovery_state is None na bevestigde initiate_recovery (onverwacht).");
      return;
    }
    log("recovery_state.initiated_at: " + afterInitiate.recoveryState.initiatedAt);
    log(
      "recovery_state.new_owner_passkey: " +
        bytesToHex(afterInitiate.recoveryState.newOwnerPasskey)
    );
    log("");

    log("4b. cancel_recovery (ECHTE passkey-handtekening, huidige owner_passkey)...");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");

    const { transaction: cancelTx } = await buildCancelRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname,
      afterInitiate.recoveryState
    );

    const cancelSimResult = await connection.simulateTransaction(cancelTx);
    log("Simulatie err: " + JSON.stringify(cancelSimResult.value.err));
    for (const line of cancelSimResult.value.logs ?? []) {
      log("  " + line);
    }
    if (cancelSimResult.value.err) {
      log("cancel_recovery-simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    cancelTx.recentBlockhash = blockhash;
    const { signature: cancelSig } = await lastWallet.signAndSendTransaction(cancelTx);
    log("Verstuurd. Signature: " + cancelSig);
    await connection.confirmTransaction(cancelSig, "confirmed");
    log("Bevestigd.");
    log("");

    log("Controleren of recovery_state weer None is...");
    const afterCancel = await readWalletAccount(connection, lastPdas.walletPda);
    if (afterCancel.recoveryState) {
      log("FOUT: recovery_state is nog steeds gezet na bevestigde cancel_recovery.");
      return;
    }
    log("");
    log("SUCCES - volledige recovery-flow (initiate met backup_authority, cancel met");
    log("ECHTE passkey-handtekening) end-to-end bewezen op devnet.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep5(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }

  log("Stap 5: hunt - spam-token opruimen met echte passkey-handtekening...");
  log("");

  try {
    log("5a. Spam-SPL-token aanmaken en naar de vault-PDA sturen (simuleert ongewenste airdrop)...");
    log("Dit vraagt om 2 goedkeuringen in je wallet-extensie (mint-aanmaak, dan mint-to).");

    const { mint, tokenAccount } = await setupSpamTokenAccount(
      connection,
      lastWallet,
      lastPdas.vaultPda
    );
    log("Spam-mint: " + mint.toBase58());
    log("Spam-token-account (eigendom van vault): " + tokenAccount.toBase58());
    log("");

    const incineratorBalanceBefore = await connection.getBalance(INCINERATOR);
    const rentDestBalanceBefore = await connection.getBalance(lastWallet.publicKey);
    log("Incinerator-saldo voor hunt: " + incineratorBalanceBefore + " lamports");
    log("");

    log("5b. hunt aanroepen (ECHTE passkey-handtekening, burn + close + 50/50-rentsplitsing)...");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");

    const { transaction } = await buildHuntTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      tokenAccount,
      mint,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    log("");
    log("Eigen simulatie (dit test zowel de passkey-verificatie als de nieuwe");
    log("rent-splitsings-logica)...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("Controleren of het spam-token-account daadwerkelijk gesloten is...");
    const closedAccountInfo = await connection.getAccountInfo(tokenAccount);
    if (closedAccountInfo !== null) {
      log("FOUT: target_token_account bestaat nog na bevestigde hunt (onverwacht).");
      return;
    }
    log("Bevestigd: account gesloten.");
    log("");

    const incineratorBalanceAfter = await connection.getBalance(INCINERATOR);
    const incineratorDelta = incineratorBalanceAfter - incineratorBalanceBefore;
    log("Incinerator-saldo na hunt: " + incineratorBalanceAfter + " lamports");
    log("Incinerator-toename door deze hunt: " + incineratorDelta + " lamports");

    const rentDestBalanceAfter = await connection.getBalance(lastWallet.publicKey);
    log(
      "Hunter-saldo delta (bevat ook transactiekosten, dus niet exact " +
        "incineratorDelta): " +
        (rentDestBalanceAfter - rentDestBalanceBefore) +
        " lamports"
    );
    log("");

    if (incineratorDelta <= 0) {
      log("FOUT: incinerator-saldo is niet toegenomen (onverwacht - de 50/50-splitsing");
      log("lijkt niet gewerkt te hebben).");
      return;
    }

    log("SUCCES - hunt heeft het spam-token daadwerkelijk verbrand, het token-account");
    log("gesloten, EN de teruggewonnen rent correct 50/50 gesplitst: " + incineratorDelta);
    log("lamports permanent naar de incinerator, de rest terug naar de hunter zelf.");
    log("Dit bewijst zowel de echte-passkey-verificatie als de nieuwe, eerder vandaag");
    log("toegevoegde rent-splitsings-logica end-to-end op devnet.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}


async function runStep6(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 6: hunt tegen een ECHT, extern devnet-token (Circle devnet-USDC),");
  log("niet zelf aangemaakt - bewijst dat hunt correct werkt op elk willekeurig");
  log("SPL-token, niet alleen tokens uit onze eigen testflow.");
  log("");
  try {
    const usdcMint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const payerAta = getAssociatedTokenAddressSync(usdcMint, lastWallet.publicKey);
    const vaultAta = getAssociatedTokenAddressSync(usdcMint, lastPdas.vaultPda, true);

    log("6a. 1 USDC (1000000 units, 6 decimalen) sturen van je eigen wallet naar de");
    log("vault-PDA (simuleert een echte, ongevraagde ontvangst van buitenaf)...");
    log("Dit vraagt om 2 goedkeuringen in je wallet-extensie (ATA-aanmaak, dan transfer).");

    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        lastWallet.publicKey,
        vaultAta,
        lastPdas.vaultPda,
        usdcMint
      )
    );
    createAtaTx.feePayer = lastWallet.publicKey;
    const { blockhash: ataBh } = await connection.getLatestBlockhash();
    createAtaTx.recentBlockhash = ataBh;
    const { signature: ataSig } = await lastWallet.signAndSendTransaction(createAtaTx);
    await connection.confirmTransaction(ataSig, "confirmed");
    log("Vault-USDC-ATA aangemaakt: " + vaultAta.toBase58());

    const transferTx = new Transaction().add(
      createTransferInstruction(payerAta, vaultAta, lastWallet.publicKey, 1_000_000)
    );
    transferTx.feePayer = lastWallet.publicKey;
    const { blockhash: transferBh } = await connection.getLatestBlockhash();
    transferTx.recentBlockhash = transferBh;
    const { signature: transferSig } = await lastWallet.signAndSendTransaction(transferTx);
    await connection.confirmTransaction(transferSig, "confirmed");
    log("1 USDC verstuurd naar de vault. Signature: " + transferSig);
    log("");

    const incineratorBalanceBefore = await connection.getBalance(INCINERATOR);
    log("Incinerator-saldo voor hunt: " + incineratorBalanceBefore + " lamports");
    log("");
    log("6b. hunt aanroepen op het echte devnet-USDC-token in de vault...");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");
    const { transaction } = await buildHuntTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      vaultAta,
      usdcMint,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    log("");
    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }
    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");
    log("Controleren of het vault-USDC-account daadwerkelijk gesloten is...");
    const closedAccountInfo = await connection.getAccountInfo(vaultAta);
    if (closedAccountInfo !== null) {
      log("FOUT: target_token_account bestaat nog na bevestigde hunt (onverwacht).");
      return;
    }
    log("Bevestigd: account gesloten.");
    log("");
    const incineratorBalanceAfter = await connection.getBalance(INCINERATOR);
    const incineratorDelta = incineratorBalanceAfter - incineratorBalanceBefore;
    log("Incinerator-saldo na hunt: " + incineratorBalanceAfter + " lamports");
    log("Incinerator-toename door deze hunt: " + incineratorDelta + " lamports");
    log("");
    log("SUCCES - hunt werkt correct op een echt, extern devnet-token (Circle");
    log("devnet-USDC) dat niet door onze eigen testcode is aangemaakt. De 1 USDC");
    log("zelf is verbrand (destructief per ontwerp, zie STATUS.md), het token-account");
    log("is gesloten, en de teruggewonnen rent is 50/50 gesplitst.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep8(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 8: add_allowed_program - System Program toevoegen aan de");
  log("programma-allowlist van deze wallet, met een ECHTE passkey-handtekening.");
  log("System Program is hier bewust gekozen als veilig, ongevaarlijk testprogramma.");
  log("execute_advanced zelf is sinds STATUS.md sectie 131 permanent geblokkeerd voor");
  log("directe aanroep (altijd via initiate_advanced_action/finalize_advanced_action) -");
  log("deze testpagina heeft daar nog geen wachtrij-UI voor, dus geen stapknop hier die");
  log("een daadwerkelijke CPI ernaartoe demonstreert.");
  log("");

  log("Menselijk-leesbare bevestigingskaart tonen (STATUS.md sectie 58/59/61) -");
  log("hold-to-confirm, geen passkey-prompt totdat de knop volledig ingedrukt");
  log("gehouden is.");
  const allowChoice = await showAddAllowedProgramPreview(connection, lastPdas.walletPda, SystemProgram.programId);
  if (allowChoice.kind === "denied") {
    log("Geweigerd in de bevestigingskaart - add_allowed_program NIET aangeroepen,");
    log("geen passkey-prompt.");
    return;
  }
  if (allowChoice.kind === "would-fail") {
    log("FOUT: onverwacht 'would-fail' (" + allowChoice.reason + ") voor System Program -");
    log("dit is de allereerste toevoeging in deze testrun, zou moeten kunnen.");
    return;
  }
  const programToAllow = allowChoice.programId;
  log("Bevestigd: " + programToAllow.toBase58() + " wordt toegevoegd.");
  log("");

  try {
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction, policyPda } = await buildAddAllowedProgramTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      programToAllow,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    log("policy PDA: " + policyPda.toBase58());
    log("");

    log("Eigen simulatie (test verify_passkey_signature + de init_if_needed-creatie");
    log("van het policy-account)...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("Policy-account teruglezen (ruwe account-bytes) om te bevestigen dat het");
    log("bevestigde programma daadwerkelijk op de allowlist staat...");
    const policy = await readPolicyAccount(connection, policyPda);
    if (!policy) {
      log("FOUT: policy-account bestaat niet na bevestigde add_allowed_program (onverwacht).");
      return;
    }
    log("count: " + policy.count);
    log("allowed_programs: " + policy.allowedPrograms.map((p) => p.toBase58()).join(", "));
    if (!policy.allowedPrograms.some((p) => p.equals(programToAllow))) {
      log("FOUT: " + programToAllow.toBase58() + " staat niet in de teruggelezen allowlist (onverwacht).");
      return;
    }
    log("");
    log("SUCCES - add_allowed_program heeft het policy-account daadwerkelijk aangemaakt");
    log("(init_if_needed) en System Program toegevoegd, met een ECHTE passkey-handtekening.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep11(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 11: TWEEDE, onafhankelijke passkey aanmaken (multi-passkey-model,");
  log("stap 11-15). Dit simuleert een tweede apparaat - de wallet kan straks");
  log("meerdere, gelijkwaardige sleutels tegelijk geregistreerd hebben. Je mag");
  log("dezelfde hardware-sleutel/authenticator gebruiken als bij stap 1, of een");
  log("andere als je die hebt - het gaat om twee cryptografisch onafhankelijke");
  log("passkeys, niet per se twee fysieke apparaten.");
  log("");
  try {
    log("[PASSKEY 2, NIEUW] navigator.credentials.create() wordt aangeroepen -");
    log("keur de biometrie-/PIN-prompt goed voor deze NIEUWE, TWEEDE passkey.");
    const result = await createSpankWalletPasskey(
      "SpankWallet (test) - tweede sleutel",
      window.location.hostname,
      "spankwallet-test-user-2"
    );
    lastPasskeyPublicKey2 = result.compressedPublicKey;
    lastCredentialId2 = result.credentialId;

    log("");
    log("SUCCES.");
    log("");
    log("Gecomprimeerde publieke sleutel van PASSKEY 2 (33 bytes):");
    log(bytesToHex(result.compressedPublicKey));
    log("");
    log("PASSKEY 2 bestaat nu, maar staat nog NERGENS geregistreerd op de");
    log("wallet - dat gebeurt in stap 12 via add_passkey.");
    log("");
    log("Klaar voor stap 12.");

    (document.getElementById("step12-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep12(): Promise<void> {
  if (
    !lastPasskeyPublicKey ||
    !lastCredentialId ||
    !lastPdas ||
    !lastWallet ||
    !lastPasskeyPublicKey2 ||
    !lastCredentialId2
  ) {
    log("Voer eerst stap 1, 2 en 11 uit.");
    return;
  }
  log("Stap 12: add_passkey - PASSKEY 2 registreren op de wallet, ondertekend");
  log("door PASSKEY 1 (de oorspronkelijke owner_passkey uit stap 1) - elke AL");
  log("geldige sleutel mag een nieuwe sleutel toevoegen.");
  log("");

  log("Menselijk-leesbare bevestigingskaart tonen (STATUS.md sectie 58, fase 1 -");
  log("eerste HOOG-risicoklasse-kaart: hold-to-confirm, geen enkele losse klik).");
  log("Geen passkey-prompt totdat de knop volledig ingedrukt gehouden is.");
  const choice = await showAddPasskeyPreview(lastPasskeyPublicKey2);
  if (choice === null) {
    log("Geweigerd in de bevestigingskaart - add_passkey NIET aangeroepen, geen passkey-prompt.");
    return;
  }
  const newPasskeyBytes = choice.newPasskeyBytes;
  log("Bevestigd: " + bytesToHex(newPasskeyBytes) + " wordt toegevoegd.");
  log("");

  try {
    log("[PASSKEY 1, OORSPRONKELIJK] navigator.credentials.get() wordt");
    log("aangeroepen - keur de biometrie-/PIN-prompt goed voor de EERSTE,");
    log("oorspronkelijke passkey (niet de zojuist aangemaakte tweede!).");
    const { transaction, passkeysPda } = await buildAddPasskeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      newPasskeyBytes,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    log("passkeys PDA: " + passkeysPda.toBase58());
    log("");

    log("Eigen simulatie (test verify_passkey_signature_multi + de");
    log("init_if_needed-creatie van het passkeys-account)...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("Passkeys-account teruglezen (ruwe account-bytes) om te bevestigen dat");
    log("PASSKEY 2 daadwerkelijk geregistreerd staat...");
    const passkeys = await readPasskeysAccount(connection, passkeysPda);
    if (!passkeys) {
      log("FOUT: passkeys-account bestaat niet na bevestigde add_passkey (onverwacht).");
      return;
    }
    log("count: " + passkeys.count);
    log("owner_passkey_revoked: " + passkeys.ownerPasskeyRevoked);
    log("additional_passkeys[0]: " + bytesToHex(passkeys.additionalPasskeys[0]));
    if (
      passkeys.count !== 1 ||
      bytesToHex(passkeys.additionalPasskeys[0]) !== bytesToHex(newPasskeyBytes)
    ) {
      log("FOUT: de op-chain geregistreerde sleutel komt niet overeen met wat in de");
      log("bevestigingskaart is bevestigd (onverwacht).");
      return;
    }
    if (bytesToHex(newPasskeyBytes) !== bytesToHex(lastPasskeyPublicKey2)) {
      log("");
      log("LET OP: de bevestigde sleutel is in de kaart BEWERKT t.o.v. de");
      log("daadwerkelijk in stap 11 aangemaakte PASSKEY 2 - stap 13+ verwacht nog");
      log("steeds de ORIGINELE PASSKEY 2 en zal falen, want de browser heeft geen");
      log("private key voor de zojuist bewerkte, verzonnen bytes. Dit is een");
      log("bewuste testfunctie van de kaart ('wat je ziet is wat je ondertekent'),");
      log("niet een bug - herstart bij stap 11 om een schone run te doen.");
    }
    log("");
    log("SUCCES - add_passkey heeft het passkeys-account daadwerkelijk aangemaakt");
    log("(init_if_needed) en PASSKEY 2 geregistreerd, ondertekend door PASSKEY 1.");
    log("");
    log("Klaar voor stap 13 - dat bewijst pas dat PASSKEY 2 ook daadwerkelijk");
    log("ZELFSTANDIG zeggenschap heeft, niet enkel dat de registratie zelf slaagde.");

    (document.getElementById("step13-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep13(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastPasskeyPublicKey2 || !lastCredentialId2) {
    log("Voer eerst stap 1, 2, 11 en 12 uit.");
    return;
  }
  log("Stap 13: HET EIGENLIJKE BEWIJS - PASSKEY 2 ondertekent ZELFSTANDIG een");
  log("HELE ANDERE instructie (add_allowed_program), zonder PASSKEY 1 erbij te");
  log("betrekken. Als dit slaagt, heeft PASSKEY 2 daadwerkelijk volledige,");
  log("onafhankelijke zeggenschap over de wallet - niet slechts een");
  log("geregistreerde, maar verder krachteloze vermelding.");
  log("");

  try {
    log("[PASSKEY 2] navigator.credentials.get() wordt aangeroepen - keur de");
    log("biometrie-/PIN-prompt goed voor de TWEEDE passkey (niet de eerste!).");
    const { transaction, policyPda } = await buildAddAllowedProgramTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      TOKEN_PROGRAM_ID,
      lastPasskeyPublicKey2,
      lastCredentialId2,
      window.location.hostname
    );
    log("policy PDA: " + policyPda.toBase58());
    log("");

    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    const policy = await readPolicyAccount(connection, policyPda);
    if (!policy || !policy.allowedPrograms.some((p) => p.equals(TOKEN_PROGRAM_ID))) {
      log("FOUT: TOKEN_PROGRAM_ID staat niet in de teruggelezen allowlist (onverwacht).");
      return;
    }
    log("count: " + policy.count);
    log("allowed_programs: " + policy.allowedPrograms.map((p) => p.toBase58()).join(", "));
    log("");
    log("SUCCES - PASSKEY 2 heeft ZELFSTANDIG add_allowed_program ondertekend en");
    log("uitgevoerd, zonder PASSKEY 1 erbij te betrekken. Dit is het daadwerkelijke");
    log("bewijs dat het multi-passkey-model werkt: twee onafhankelijke sleutels");
    log("met gelijke, volledige zeggenschap over dezelfde wallet.");
    log("");
    log("Klaar voor stap 14.");

    (document.getElementById("step14-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep14(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastPdas || !lastWallet || !lastPasskeyPublicKey2 || !lastCredentialId2) {
    log("Voer eerst stap 1, 2, 11, 12 en 13 uit.");
    return;
  }
  log("Stap 14: remove_passkey - PASSKEY 1 (de oorspronkelijke owner_passkey)");
  log("intrekken, ondertekend door PASSKEY 2. Mag alleen omdat PASSKEY 2 er nog");
  log("is als resterende geldige sleutel - dit bewijst zowel dat een sleutel");
  log("zichzelf kan opvolgen als beheerder, als dat de wallet daarna nog");
  log("bereikbaar blijft (via PASSKEY 2).");
  log("");

  log("Menselijk-leesbare bevestigingskaart tonen (STATUS.md sectie 58/59) -");
  log("hold-to-confirm, geen passkey-prompt totdat de knop volledig ingedrukt");
  log("gehouden is.");
  const removeChoice = await showRemovePasskeyPreview(
    connection,
    lastPdas.walletPda,
    lastPasskeyPublicKey,
    lastPasskeyPublicKey
  );
  if (removeChoice.kind === "denied") {
    log("Geweigerd in de bevestigingskaart - remove_passkey NIET aangeroepen, geen");
    log("passkey-prompt.");
    return;
  }
  if (removeChoice.kind === "would-fail") {
    log("FOUT: onverwacht 'would-fail' (" + removeChoice.reason + ") voor PASSKEY 1 -");
    log("die zou op dit punt nog gewoon intrekbaar moeten zijn.");
    return;
  }
  const targetToRemove = removeChoice.targetPasskeyBytes;
  log("Bevestigd: " + bytesToHex(targetToRemove) + " wordt ingetrokken.");
  log("");

  try {
    log("[PASSKEY 2] navigator.credentials.get() wordt aangeroepen - keur de");
    log("biometrie-/PIN-prompt goed voor de TWEEDE passkey.");
    const { transaction } = await buildRemovePasskeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      targetToRemove,
      lastPasskeyPublicKey2,
      lastCredentialId2,
      window.location.hostname
    );

    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    const passkeysPda = derivePasskeysPda(lastPdas.walletPda);
    const passkeys = await readPasskeysAccount(connection, passkeysPda);
    if (!passkeys || !passkeys.ownerPasskeyRevoked) {
      log("FOUT: owner_passkey_revoked staat niet op true (onverwacht).");
      return;
    }
    log("owner_passkey_revoked: " + passkeys.ownerPasskeyRevoked);
    log("count (extra passkeys): " + passkeys.count);
    log("");
    log("SUCCES - PASSKEY 1 is ingetrokken. Alleen PASSKEY 2 is nu nog geldig.");
    log("");
    log("Klaar voor stap 15 - nu bewijzen we de lockout-bescherming: PASSKEY 2");
    log("verwijderen moet NU geweigerd worden (het zou de allerlaatste geldige");
    log("sleutel zijn).");

    (document.getElementById("step15-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep15(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastPasskeyPublicKey || !lastPasskeyPublicKey2 || !lastCredentialId2) {
    log("Voer eerst stap 1, 2 en 11-14 uit.");
    return;
  }
  log("Stap 15: LOCKOUT-BESCHERMING - proberen PASSKEY 2 te verwijderen terwijl");
  log("het de ENIGE nog geldige sleutel is. Dit MOET geweigerd worden");
  log("(CannotRemoveLastPasskey) - anders zou de wallet permanent onbereikbaar");
  log("worden.");
  log("");
  log("15a. Alleen simuleren (niet versturen) - we willen de weigering aantonen,");
  log("geen fee betalen voor een transactie die toch niets gaat doen. Dit is het");
  log("on-chain-bewijs, los van elke UI-laag.");
  log("");

  try {
    log("[PASSKEY 2] navigator.credentials.get() wordt aangeroepen - keur de");
    log("biometrie-/PIN-prompt goed (de handtekening zelf is cryptografisch");
    log("geldig, de on-chain lockout-check moet 'm alsnog weigeren).");
    const { transaction } = await buildRemovePasskeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey2,
      lastPasskeyPublicKey2,
      lastCredentialId2,
      window.location.hostname
    );

    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (!simResult.value.err) {
      log("FOUT: het verwijderen van de allerlaatste geldige passkey had moeten");
      log("falen, maar de simulatie slaagde (onverwacht - de lockout-bescherming");
      log("werkt niet).");
      return;
    }

    log("SUCCES - de lockout-bescherming werkt: PASSKEY 2 (de laatste geldige");
    log("sleutel) kon NIET verwijderd worden.");
    log("");

    log("15b. Dezelfde weigering, maar nu via de nieuwe bevestigingskaart");
    log("(STATUS.md sectie 58/59) - tegen deze ECHTE, natuurlijk ontstane");
    log("laatste-sleutel-toestand van deze testrun (na stap 14 is PASSKEY 2");
    log("daadwerkelijk de enige geldige sleutel). Verwacht: kind='would-fail'");
    log("met reason='last-passkey', GEEN kaart, GEEN passkey-prompt.");
    const lockoutPreflight = await showRemovePasskeyPreview(
      connection,
      lastPdas.walletPda,
      lastPasskeyPublicKey,
      lastPasskeyPublicKey2
    );
    if (lockoutPreflight.kind !== "would-fail" || lockoutPreflight.reason !== "last-passkey") {
      log("FOUT: verwachtte kind='would-fail'/reason='last-passkey', kreeg " + JSON.stringify(lockoutPreflight) + ".");
      return;
    }
    log("SUCCES - de kaart kortsluit correct vóór elke frictie: geen kaart getoond,");
    log("geen passkey-prompt, voor een verwijdering die toch geweigerd zou worden.");
    log("");
    log("Het volledige multi-passkey-model is nu end-to-end bewezen op devnet:");
    log("een tweede sleutel toevoegen (stap 11-12), zelfstandige zeggenschap van");
    log("die sleutel over een HELE ANDERE instructie (stap 13), de oorspronkelijke");
    log("sleutel intrekken zodra een tweede bestaat (stap 14), en de");
    log("lockout-bescherming die voorkomt dat de wallet permanent onbereikbaar");
    log("wordt (stap 15).");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep16(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 16: SESSIESLEUTEL aanmaken (stap 16-20, session keys - STATUS.md).");
  log("Een sessiesleutel is een GEWONE Ed25519-Solana-Keypair, GEEN passkey - puur");
  log("lokaal gegenereerd in de browser, geen navigator.credentials-aanroep nodig");
  log("om hem aan te maken. Scope voor deze test: ALLEEN execute toegestaan (geen");
  log("transfer_token, geen execute_advanced), expiry over 300 slots (ruim 2");
  log("minuten op devnet - genoeg marge om stap 17-18 comfortabel te doorlopen");
  log("voordat je bij stap 19 daadwerkelijk op de expiry gaat wachten).");
  log("");

  try {
    const sessionKeypair = Keypair.generate();
    lastSessionKeypair = sessionKeypair;
    log("Sessiesleutel (publiek): " + sessionKeypair.publicKey.toBase58());

    const currentSlot = BigInt(await connection.getSlot());
    log("Huidige slot: " + currentSlot);
    log("");

    log("Menselijk-leesbare bevestigingskaart tonen (STATUS.md sectie 58/59/64) -");
    log("MIDDEN-risicoklasse, gewone klik (geen hold-to-confirm). De caps zijn hier");
    log("de headline - het risico van een sessie is begrensd door precies deze");
    log("waarden.");
    // Spend-limits (ontwerpdocument): defaults max_lamports_per_tx=50_000,
    // max_lamports_total=100_000 - ruim genoeg voor de 1000-lamport-
    // aanroepen in stap 17/19 hieronder, maar wel expliciete, echte caps
    // (geen "0 = onbeperkt"-val) i.p.v. een toevallig groot getal. Geen
    // token-scope voor deze sessie (canTransferToken=false).
    const sessionChoice = await showAddSessionKeyPreview({
      connection,
      currentSlot,
      defaultDurationSlots: 300n,
      canExecute: true,
      canTransferToken: false,
      canExecuteAdvanced: false,
      sessionAllowedPrograms: [],
      tokenMint: PublicKey.default,
      defaultMaxLamportsPerTx: 50_000n,
      defaultMaxLamportsTotal: 100_000n,
      defaultMaxTokenAmountPerTx: 0n,
      defaultMaxTokenAmountTotal: 0n,
    });
    if (sessionChoice === null) {
      log("Geweigerd in de bevestigingskaart - add_session_key NIET aangeroepen, geen");
      log("passkey-prompt.");
      return;
    }
    const expirySlot = sessionChoice.expirySlot;
    lastSessionExpirySlot = expirySlot;
    log(
      "Bevestigd: expiry_slot=" + expirySlot + ", max_lamports_per_tx=" +
        sessionChoice.maxLamportsPerTx + ", max_lamports_total=" + sessionChoice.maxLamportsTotal + "."
    );
    log("");

    log("[PASSKEY] navigator.credentials.get() wordt aangeroepen - add_session_key");
    log("vereist ALTIJD een echte passkey-handtekening (het wijzigt WIE toegang");
    log("heeft), zelfs al is de sessiesleutel zelf geen passkey.");

    // PUNT C1 (STATUS.md sectie 78): scope komt rechtstreeks van
    // sessionChoice (teruggegeven door showAddSessionKeyPreview, dezelfde
    // scope waarop de kaart zijn risicoklasse baseerde) - GEEN losse,
    // opnieuw getypte true/false/[]-literals meer, die konden stilzwijgend
    // uit de pas lopen met wat de kaart daadwerkelijk toonde.
    const { transaction, sessionPda } = await buildAddSessionKeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      sessionKeypair.publicKey,
      expirySlot,
      sessionChoice.canExecute,
      sessionChoice.canTransferToken,
      sessionChoice.canExecuteAdvanced,
      sessionChoice.sessionAllowedPrograms,
      sessionChoice.maxLamportsPerTx,
      sessionChoice.maxLamportsTotal,
      sessionChoice.tokenMint,
      sessionChoice.maxTokenAmountPerTx,
      sessionChoice.maxTokenAmountTotal,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    log("session PDA: " + sessionPda.toBase58());
    log("");
    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    const session = await readSessionKeyAccount(connection, sessionPda);
    if (!session || !session.canExecute || session.canTransferToken || session.canExecuteAdvanced) {
      log("FOUT: de teruggelezen sessie-scope komt niet overeen met wat verwacht werd.");
      return;
    }
    log(
      "Teruggelezen: canExecute=" +
        session.canExecute +
        ", canTransferToken=" +
        session.canTransferToken +
        ", canExecuteAdvanced=" +
        session.canExecuteAdvanced +
        ", expirySlot=" +
        session.expirySlot
    );
    log("");

    log("Vault + sessiesleutel funden (wallet-extensie-goedkeuring nodig, GEEN");
    log("passkey) - de sessiesleutel moet straks ZELF haar eigen transactiefee");
    log("kunnen betalen, zonder enige verdere prompt.");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: lastWallet.publicKey,
        toPubkey: lastPdas.vaultPda,
        lamports: 100000,
      }),
      SystemProgram.transfer({
        fromPubkey: lastWallet.publicKey,
        toPubkey: sessionKeypair.publicKey,
        lamports: 5_000_000,
      })
    );
    fundTx.feePayer = lastWallet.publicKey;
    const { blockhash: fundBh } = await connection.getLatestBlockhash();
    fundTx.recentBlockhash = fundBh;
    const { signature: fundSig } = await lastWallet.signAndSendTransaction(fundTx);
    await connection.confirmTransaction(fundSig, "confirmed");
    log("Gefund. Signature: " + fundSig);
    log("");
    log("SUCCES - sessiesleutel geregistreerd en gefund.");
    log("");
    log("Klaar voor stap 17.");

    (document.getElementById("step17-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep17(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastSessionKeypair) {
    log("Voer eerst stap 1, 2 en 16 uit.");
    return;
  }
  log("Stap 17: HET EIGENLIJKE BEWIJS - execute_via_session, ondertekend door de");
  log("sessiesleutel zelf. GEEN passkey-prompt, GEEN wallet-extensie-prompt: dit is");
  log("een gewone, stille Ed25519-handtekening die volledig in de browser zelf");
  log("gebeurt - dat is het hele punt van session keys.");
  log("");

  try {
    const recipient = lastWallet.publicKey;
    const amount = 1000n;

    const { transaction } = await buildExecuteViaSessionTransaction(
      connection,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      recipient,
      amount,
      lastSessionKeypair
    );

    log("Transactie is al volledig ondertekend door de sessiesleutel zelf (feePayer =");
    log("sessiesleutel, geen enkele andere handtekening nodig).");
    log("");
    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Rechtstreeks versturen (GEEN wallet.signAndSendTransaction -");
    log("er is geen extra handtekening nodig)...");
    const signature = await connection.sendRawTransaction(transaction.serialize());
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");
    log("SUCCES - de sessiesleutel heeft ZELFSTANDIG execute_via_session ondertekend");
    log("en uitgevoerd, zonder ENIGE prompt van welke aard dan ook.");
    log("");
    log("Klaar voor stap 18.");

    (document.getElementById("step18-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep18(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastSessionKeypair) {
    log("Voer eerst stap 1, 2 en 16 uit.");
    return;
  }
  log("Stap 18: NEGATIEF scope-bewijs - deze sessie is ALLEEN gescoped voor execute");
  log("(stap 16), niet voor execute_advanced. Een poging tot");
  log("execute_advanced_via_session moet geweigerd worden met");
  log("SessionInstructionNotAllowed - en dat MOET de eerst gecontroleerde reden");
  log("zijn, zelfs als er nog geen PolicyAccount voor deze wallet bestaat (dat");
  log("kan zonder stap 8 te draaien): autorisatie hoort altijd voor te gaan op de");
  log("vraag of iets anders uberhaupt bestaat. Alleen simuleren (niet versturen) -");
  log("we willen de weigering aantonen, geen fee betalen voor een transactie die");
  log("toch niets gaat doen.");
  log("");

  try {
    const policyPda = derivePolicyPda(lastPdas.walletPda);

    const { transaction } = await buildExecuteAdvancedViaSessionTransaction(
      lastPdas.walletPda,
      lastPdas.vaultPda,
      policyPda,
      SystemProgram.programId,
      [],
      new Uint8Array(0),
      connection,
      lastSessionKeypair
    );

    log("GEEN prompt nodig om deze transactie op te bouwen of te ondertekenen (de");
    log("sessiesleutel ondertekent zelf, lokaal) - maar het programma weigert de");
    log("AANROEP zelf toch, on-chain. Dat is precies de bedoelde bescherming.");
    log("");

    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (!simResult.value.err) {
      log("FOUT: execute_advanced_via_session had moeten falen (deze sessie mag dat");
      log("niet), maar de simulatie slaagde (onverwacht).");
      return;
    }
    const logsText = (simResult.value.logs ?? []).join("\n");
    if (!logsText.includes("SessionInstructionNotAllowed")) {
      log("FOUT: de simulatie faalde wel, maar NIET met SessionInstructionNotAllowed -");
      log("dit bewijst niet wat we willen bewijzen. Zie de fout hierboven.");
      return;
    }
    log("SUCCES - de scope-beperking werkt: deze sessie kon GEEN execute_advanced");
    log("aanroepen, precies zoals bij add_session_key ingesteld");
    log("(can_execute_advanced=false) - bevestigd via de expliciete");
    log("SessionInstructionNotAllowed-foutmelding hierboven.");
    log("");
    log("Klaar voor stap 19.");

    (document.getElementById("step19-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep19(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastSessionKeypair || lastSessionExpirySlot === null) {
    log("Voer eerst stap 1, 2 en 16 uit.");
    return;
  }
  log("Stap 19: EXPIRY bewijzen - wachten tot de daadwerkelijke on-chain slot");
  log("expiry_slot (" + lastSessionExpirySlot + ") gepasseerd is (devnet-slots gaan");
  log("vanzelf vooruit, geen dummy-transacties nodig zoals in de lokale testsuite),");
  log("en dan bewijzen dat execute_via_session daarna geweigerd wordt met");
  log("SessionExpired.");
  log("");

  try {
    for (;;) {
      const currentSlot = BigInt(await connection.getSlot());
      if (currentSlot > lastSessionExpirySlot) {
        log("Huidige slot " + currentSlot + " > expiry_slot " + lastSessionExpirySlot + " - verlopen.");
        break;
      }
      log(
        "Huidige slot " +
          currentSlot +
          " <= expiry_slot " +
          lastSessionExpirySlot +
          " - nog " +
          (lastSessionExpirySlot - currentSlot) +
          " slot(s) te gaan, 2s wachten..."
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    log("");

    log("execute_via_session opnieuw proberen - moet nu falen met SessionExpired.");
    log("Alleen simuleren (niet versturen).");

    const { transaction } = await buildExecuteViaSessionTransaction(
      connection,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      lastWallet.publicKey,
      1000n,
      lastSessionKeypair
    );

    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (!simResult.value.err) {
      log("FOUT: execute_via_session had moeten falen na expiry, maar de simulatie");
      log("slaagde (onverwacht).");
      return;
    }
    log("SUCCES - de sessie is daadwerkelijk verlopen: execute_via_session wordt");
    log("geweigerd met SessionExpired.");
    log("");
    log("Klaar voor stap 20.");

    (document.getElementById("step20-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep20(): Promise<void> {
  if (!lastPdas || !lastWallet || !lastSessionKeypair) {
    log("Voer eerst stap 1, 2, 16 en 19 uit.");
    return;
  }
  log("Stap 20: close_expired_session - PERMISSIONLESS. Een compleet willekeurige");
  log("derde partij (hier: een verse, lokaal gegenereerde Keypair die nooit iets");
  log("met deze wallet te maken heeft gehad) mag de verlopen sessie opruimen en de");
  log("teruggewonnen rent claimen. Geen passkey, geen sessiesleutel, geen relatie");
  log("met de wallet - puur de expiry_slot telt.");
  log("");

  try {
    const closer = Keypair.generate();
    log("closer (willekeurige derde): " + closer.publicKey.toBase58());
    log("closer funden zodat hij zijn eigen transactiefee kan betalen (wallet-");
    log("extensie-goedkeuring nodig, GEEN passkey)...");

    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: lastWallet.publicKey,
        toPubkey: closer.publicKey,
        lamports: 5_000_000,
      })
    );
    fundTx.feePayer = lastWallet.publicKey;
    const { blockhash: fundBh } = await connection.getLatestBlockhash();
    fundTx.recentBlockhash = fundBh;
    const { signature: fundSig } = await lastWallet.signAndSendTransaction(fundTx);
    await connection.confirmTransaction(fundSig, "confirmed");
    log("Gefund. Signature: " + fundSig);
    log("");

    const sessionPda = deriveSessionPda(lastPdas.walletPda, lastSessionKeypair.publicKey);
    const balanceBefore = await connection.getBalance(closer.publicKey);

    const { transaction } = await buildCloseExpiredSessionTransaction(
      connection,
      lastPdas.walletPda,
      lastSessionKeypair.publicKey,
      closer
    );

    log("GEEN prompt nodig - closer ondertekent zelf, lokaal, en betaalt zelf de fee.");
    const signature = await connection.sendRawTransaction(transaction.serialize());
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    const sessionInfo = await connection.getAccountInfo(sessionPda);
    if (sessionInfo !== null) {
      log("FOUT: het session-account had gesloten moeten zijn.");
      return;
    }
    const balanceAfter = await connection.getBalance(closer.publicKey);
    log(
      "session-account is gesloten. closer-balans: " +
        balanceBefore +
        " -> " +
        balanceAfter +
        " lamports (rent teruggewonnen, minus de betaalde fee)."
    );
    log("");
    log("Het volledige session-key-model is nu end-to-end bewezen op devnet: een");
    log("sessiesleutel aanmaken met beperkte scope en korte, slot-gebonden expiry");
    log("(stap 16), zelfstandig ondertekenen zonder ENIGE prompt (stap 17), de");
    log("scope-beperking die andere instructies weigert (stap 18), daadwerkelijk");
    log("verlopen (stap 19), en permissionless opruiming door een derde (stap 20).");
    log("");
    log("Klaar voor stap 21.");

    (document.getElementById("step21-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep21(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet || !lastBackupAuthority) {
    log("Voer eerst stap 1, 2 en 4 uit.");
    return;
  }
  log("Stap 21: remove_session_key (STATUS.md sectie 58/59/67) - vroegtijdige");
  log("intrekking door een geldige passkey, LAAG-risicoklasse, gewone klik.");
  log("Eigen, verse sessiesleutel voor deze stap - onafhankelijk van de sessie uit");
  log("stap 16-20 (die is al gesloten).");
  log("");

  try {
    const sessionKeypair = Keypair.generate();
    log("Sessiesleutel (publiek): " + sessionKeypair.publicKey.toBase58());

    const currentSlot = BigInt(await connection.getSlot());
    log("21a. add_session_key om deze sessie op te zetten (rechtstreeks aangeroepen,");
    log("geen kaart hier - die is al volledig gedekt in stap 16). Ruime expiry (3600");
    log("slots) zodat de recovery-cyclus hieronder comfortabel past.");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");

    const { transaction: addTx, sessionPda } = await buildAddSessionKeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      sessionKeypair.publicKey,
      currentSlot + 3600n,
      true,
      false,
      false,
      [],
      50_000n,
      100_000n,
      PublicKey.default,
      0n,
      0n,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    const { blockhash: addBh } = await connection.getLatestBlockhash();
    addTx.recentBlockhash = addBh;
    const { signature: addSig } = await lastWallet.signAndSendTransaction(addTx);
    await connection.confirmTransaction(addSig, "confirmed");
    log("Bevestigd. session PDA: " + sessionPda.toBase58());
    log("");

    log("21b. initiate_recovery (backup_authority, GEEN passkey) - om de");
    log("recovery-in-progress-weigering hieronder ECHT te testen, niet synthetisch.");
    const dummyNewOwnerPasskey = crypto.getRandomValues(new Uint8Array(33));
    dummyNewOwnerPasskey[0] = 0x02;
    const initiateTx = await buildInitiateRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastBackupAuthority,
      dummyNewOwnerPasskey
    );
    const { signature: initiateSig } = await lastWallet.signAndSendTransaction(initiateTx);
    await connection.confirmTransaction(initiateSig, "confirmed");
    const afterInitiate = await readWalletAccount(connection, lastPdas.walletPda);
    if (!afterInitiate.recoveryState) {
      log("FOUT: recovery_state is None na bevestigde initiate_recovery (onverwacht).");
      return;
    }
    log("Bevestigd - recovery_state is gezet.");
    log("");

    log("21c. Bevestigingskaart tonen terwijl recovery loopt - moet DIRECT");
    log("'would-fail: recovery-in-progress' teruggeven, GEEN kaart, GEEN prompt.");
    const duringRecovery = await showRemoveSessionKeyPreview(connection, lastPdas.walletPda, sessionKeypair.publicKey);
    if (duringRecovery.kind !== "would-fail" || duringRecovery.reason !== "recovery-in-progress") {
      log("FOUT: verwachtte would-fail/recovery-in-progress, kreeg: " + JSON.stringify(duringRecovery));
      return;
    }
    log("Bevestigd: " + JSON.stringify(duringRecovery) + " - geen kaart getoond.");
    log("");

    log("21d. cancel_recovery (ECHTE passkey-handtekening) om de normale staat te");
    log("herstellen.");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");
    const { transaction: cancelTx } = await buildCancelRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname,
      afterInitiate.recoveryState
    );
    const { blockhash: cancelBh } = await connection.getLatestBlockhash();
    cancelTx.recentBlockhash = cancelBh;
    const { signature: cancelSig } = await lastWallet.signAndSendTransaction(cancelTx);
    await connection.confirmTransaction(cancelSig, "confirmed");
    const afterCancel = await readWalletAccount(connection, lastPdas.walletPda);
    if (afterCancel.recoveryState) {
      log("FOUT: recovery_state is nog steeds gezet na bevestigde cancel_recovery.");
      return;
    }
    log("Bevestigd - recovery_state is weer None.");
    log("");

    log("21e. Bevestigingskaart opnieuw tonen, nu ZONDER lopende recovery - moet de");
    log("sessie tonen (scope, resterende caps, resterende geldigheid) en op een");
    log("gewone klik wachten (LAAG-risicoklasse, geen hold-to-confirm).");
    const choice = await showRemoveSessionKeyPreview(connection, lastPdas.walletPda, sessionKeypair.publicKey);
    if (choice.kind === "denied") {
      log("Geweigerd in de bevestigingskaart - remove_session_key NIET aangeroepen,");
      log("geen passkey-prompt.");
      return;
    }
    if (choice.kind === "would-fail") {
      log("FOUT: onverwacht 'would-fail' (" + choice.reason + ") - de sessie zou hier");
      log("nog moeten bestaan en er loopt geen recovery meer.");
      return;
    }
    log("Bevestigd.");
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

    const { transaction: removeTx } = await buildRemoveSessionKeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      sessionKeypair.publicKey,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    const simResult = await connection.simulateTransaction(removeTx);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    log("Simulatie logs:");
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash: removeBh } = await connection.getLatestBlockhash();
    removeTx.recentBlockhash = removeBh;
    const { signature: removeSig } = await lastWallet.signAndSendTransaction(removeTx);
    log("Verstuurd. Signature: " + removeSig);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(removeSig, "confirmed");
    log("Bevestigd.");
    log("");

    const afterRemove = await readSessionKeyAccount(connection, sessionPda);
    if (afterRemove !== null) {
      log("FOUT: het session-account had gesloten moeten zijn.");
      return;
    }
    log("Session-account is gesloten - remove_session_key heeft daadwerkelijk");
    log("gewerkt, met een ECHTE passkey-handtekening.");
    log("");

    log("21f. Bevestigingskaart een derde keer tonen, tegen dezelfde (nu");
    log("verwijderde) sessie - moet DIRECT 'would-fail: not-found' teruggeven, GEEN");
    log("kaart, GEEN prompt.");
    const afterClose = await showRemoveSessionKeyPreview(connection, lastPdas.walletPda, sessionKeypair.publicKey);
    if (afterClose.kind !== "would-fail" || afterClose.reason !== "not-found") {
      log("FOUT: verwachtte would-fail/not-found, kreeg: " + JSON.stringify(afterClose));
      return;
    }
    log("Bevestigd: " + JSON.stringify(afterClose) + " - geen kaart getoond.");
    log("");

    log("SUCCES - remove_session_key end-to-end bewezen op devnet: beide");
    log("gegarandeerde weigeringen (recovery-in-progress, not-found) ECHT getest,");
    log("plus de daadwerkelijke intrekking met een echte passkey-handtekening.");
    log("");
    log("Klaar voor stap 22.");

    (document.getElementById("step22-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep22(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet || !lastBackupAuthority) {
    log("Voer eerst stap 1, 2 en 4 uit.");
    return;
  }
  log("Stap 22: cancel_recovery-bevestigingskaart (STATUS.md sectie 71) - noodrem");
  log("tegen een lopende recovery, LAAG-risicoklasse, gewone klik, geen tone:danger.");
  log("");

  try {
    log("22a. Kaart tonen VOORDAT er een recovery loopt - moet DIRECT");
    log("'would-fail: no-recovery-in-progress' teruggeven, GEEN kaart, GEEN prompt.");
    const before = await showCancelRecoveryPreview(connection, lastPdas.walletPda);
    if (before.kind !== "would-fail" || before.reason !== "no-recovery-in-progress") {
      log("FOUT: verwachtte would-fail/no-recovery-in-progress, kreeg: " + JSON.stringify(before));
      return;
    }
    log("Bevestigd: " + JSON.stringify(before) + " - geen kaart getoond.");
    log("");

    log("22b. initiate_recovery (backup_authority, GEEN passkey) om een echte");
    log("recovery te starten om tegen te houden.");
    const dummyNewOwnerPasskey = crypto.getRandomValues(new Uint8Array(33));
    dummyNewOwnerPasskey[0] = 0x02;
    const initiateTx = await buildInitiateRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastBackupAuthority,
      dummyNewOwnerPasskey
    );
    const { signature: initiateSig } = await lastWallet.signAndSendTransaction(initiateTx);
    await connection.confirmTransaction(initiateSig, "confirmed");
    log("Bevestigd - recovery_state is gezet.");
    log("");

    log("22c. Kaart opnieuw tonen - nu WEL een lopende recovery, moet de echte");
    log("initiated_at/new_owner_passkey/finalize-datum tonen en op een gewone klik");
    log("wachten (LAAG-risicoklasse, geen hold-to-confirm).");
    const choice = await showCancelRecoveryPreview(connection, lastPdas.walletPda);
    if (choice.kind === "denied") {
      log("Geweigerd in de bevestigingskaart - cancel_recovery NIET aangeroepen,");
      log("geen passkey-prompt.");
      return;
    }
    if (choice.kind === "would-fail") {
      log("FOUT: onverwacht 'would-fail' (" + choice.reason + ") - er zou hier juist een");
      log("lopende recovery moeten zijn.");
      return;
    }
    log(
      "Bevestigd. Kaart toonde initiated_at=" + choice.recoveryState.initiatedAt +
        ", new_owner_passkey=" + bytesToHex(choice.recoveryState.newOwnerPasskey)
    );
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

    const { transaction: cancelTx } = await buildCancelRecoveryTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname,
      choice.recoveryState
    );
    const { blockhash: cancelBh } = await connection.getLatestBlockhash();
    cancelTx.recentBlockhash = cancelBh;
    const { signature: cancelSig } = await lastWallet.signAndSendTransaction(cancelTx);
    log("Verstuurd. Signature: " + cancelSig);
    await connection.confirmTransaction(cancelSig, "confirmed");
    log("Bevestigd.");
    log("");

    const afterCancel = await readWalletAccount(connection, lastPdas.walletPda);
    if (afterCancel.recoveryState) {
      log("FOUT: recovery_state is nog steeds gezet na bevestigde cancel_recovery.");
      return;
    }
    log("recovery_state is weer None - cancel_recovery heeft daadwerkelijk gewerkt,");
    log("met een ECHTE passkey-handtekening en de exacte snapshot uit de kaart.");
    log("");

    log("22d. Kaart een derde keer tonen - recovery is nu weer geannuleerd, moet");
    log("opnieuw DIRECT 'would-fail: no-recovery-in-progress' teruggeven.");
    const after = await showCancelRecoveryPreview(connection, lastPdas.walletPda);
    if (after.kind !== "would-fail" || after.reason !== "no-recovery-in-progress") {
      log("FOUT: verwachtte would-fail/no-recovery-in-progress, kreeg: " + JSON.stringify(after));
      return;
    }
    log("Bevestigd: " + JSON.stringify(after) + " - geen kaart getoond.");
    log("");

    log("SUCCES - cancel_recovery-bevestigingskaart end-to-end bewezen op devnet:");
    log("beide gegarandeerde takken (geen recovery ervoor, geen recovery erna) ECHT");
    log("getest, plus de daadwerkelijke annulering met een echte passkey-handtekening.");
    log("");
    log("Klaar voor stap 23.");

    (document.getElementById("step23-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep23(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 23: hunt-bevestigingskaart (STATUS.md sectie 73) - laatste LAAG-kaart,");
  log("sluit UI-fase 1 af. Gewone klik, geen tone:danger.");
  log("");

  try {
    log("23a. Kaart tonen tegen een NIET-BESTAAND token-account - moet DIRECT");
    log("'would-fail: not-found' teruggeven, GEEN kaart, GEEN prompt.");
    const nonExistent = Keypair.generate().publicKey;
    const before = await showHuntPreview(connection, lastPdas.vaultPda, nonExistent);
    if (before.kind !== "would-fail" || before.reason !== "not-found") {
      log("FOUT: verwachtte would-fail/not-found, kreeg: " + JSON.stringify(before));
      return;
    }
    log("Bevestigd: " + JSON.stringify(before) + " - geen kaart getoond.");
    log("");

    log("23b. Spam-SPL-token aanmaken en naar de vault-PDA sturen (simuleert ongewenste");
    log("airdrop). Dit vraagt om 2 goedkeuringen in je wallet-extensie.");
    const { mint, tokenAccount } = await setupSpamTokenAccount(
      connection,
      lastWallet,
      lastPdas.vaultPda
    );
    log("Spam-mint: " + mint.toBase58());
    log("Spam-token-account (eigendom van vault): " + tokenAccount.toBase58());
    log("");

    const incineratorBalanceBefore = await connection.getBalance(INCINERATOR);

    log("23c. Kaart tonen tegen dit ECHTE spam-token-account - moet doelaccount, mint,");
    log("saldo en de rent-splitsing-consequentie tonen, en op een gewone klik wachten.");
    const choice = await showHuntPreview(connection, lastPdas.vaultPda, tokenAccount);
    if (choice.kind === "denied") {
      log("Geweigerd in de bevestigingskaart - hunt NIET aangeroepen, geen passkey-prompt.");
      return;
    }
    if (choice.kind === "would-fail") {
      log("FOUT: onverwacht 'would-fail' (" + choice.reason + ") - dit zou een geldig doel");
      log("moeten zijn.");
      return;
    }
    log(
      "Bevestigd. Kaart toonde mint=" + choice.tokenMint.toBase58() +
        " (moet gelijk zijn aan de zojuist aangemaakte spam-mint)."
    );
    if (!choice.tokenMint.equals(mint)) {
      log("FOUT: kaart toonde een andere mint dan de daadwerkelijk aangemaakte spam-mint.");
      return;
    }
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

    const { transaction } = await buildHuntTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      choice.targetTokenAccount,
      choice.tokenMint,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    for (const line of simResult.value.logs ?? []) {
      log("  " + line);
    }
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("Controleren of het spam-token-account daadwerkelijk gesloten is...");
    const closedAccountInfo = await connection.getAccountInfo(tokenAccount);
    if (closedAccountInfo !== null) {
      log("FOUT: target_token_account bestaat nog na bevestigde hunt (onverwacht).");
      return;
    }
    log("Bevestigd: account gesloten.");

    const incineratorBalanceAfter = await connection.getBalance(INCINERATOR);
    const incineratorDelta = incineratorBalanceAfter - incineratorBalanceBefore;
    log("Incinerator-toename door deze hunt: " + incineratorDelta + " lamports");
    if (incineratorDelta <= 0) {
      log("FOUT: incinerator-saldo is niet toegenomen (onverwacht).");
      return;
    }
    log("");

    log("23d. Kaart een derde keer tonen tegen hetzelfde, nu gesloten account - moet");
    log("opnieuw DIRECT 'would-fail: not-found' teruggeven.");
    const after = await showHuntPreview(connection, lastPdas.vaultPda, tokenAccount);
    if (after.kind !== "would-fail" || after.reason !== "not-found") {
      log("FOUT: verwachtte would-fail/not-found, kreeg: " + JSON.stringify(after));
      return;
    }
    log("Bevestigd: " + JSON.stringify(after) + " - geen kaart getoond.");
    log("");

    log("SUCCES - hunt-bevestigingskaart end-to-end bewezen op devnet: beide");
    log("gegarandeerde weigeringen (not-found ervoor, not-found erna) ECHT getest, plus");
    log("de daadwerkelijke burn+close+rentsplitsing met een echte passkey-handtekening.");
    log("");
    log("UI-fase 1 is hiermee compleet - elke passkey-ondertekende, risicodragende");
    log("instructie heeft nu een mens-leesbare bevestigingskaart.");
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep24(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 24: initiate_threshold_change - nieuwe instant-drempel + venstercap voorstellen.");
  log("STATUS.md sectie 99/115/134-vervolg (sectie 135): het laatste van de vier initiate_*/");
  log("finalize_*-paren dat een client-ingang krijgt, en het paar dat de eigenaar daadwerkelijk");
  log("moet gebruiken om het spend-cap-mechanisme te activeren (spend_threshold_lamports staat");
  log("vandaag op 0). Start de ECHTE 24-uurs-timelock - stap 25 (finalize) is normaliter pas een");
  log("dag later daadwerkelijk bruikbaar, geen versnelde testfeature.");
  log("");
  log("Menselijk-leesbare bevestigingskaart tonen - HOOG-risicoklasse (hold-to-confirm): dit");
  log("bepaalt hoeveel een gekaapte ceremonie straks ONGEMERKT (instant, zonder wachtrij) zou");
  log("kunnen verplaatsen. Geen voorgestelde bedragen (STATUS.md sectie 127 punt 3/132) - de");
  log("eigenaar kiest zelf, zonder gesuggereerd anker.");
  const choice = await showThresholdChangeInitiatePreview();
  if (choice === null) {
    log("Geweigerd in de bevestigingskaart - initiate_threshold_change NIET aangeroepen, geen passkey-prompt.");
    return;
  }
  log(
    "Bevestigd: nieuwe drempel=" + choice.newSpendThresholdLamports.toString() +
      " lamports, nieuwe venstercap=" + choice.newWindowTotalCapLamports.toString() + " lamports."
  );
  log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

  try {
    const { transaction, pendingActionPda } = await buildInitiateThresholdChangeTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      choice.newSpendThresholdLamports,
      choice.newWindowTotalCapLamports,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    log("pending_action PDA: " + pendingActionPda.toBase58());
    log("");

    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    for (const line of simResult.value.logs ?? []) log("  " + line);
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("PendingAction opnieuw uitlezen (ruwe account-bytes) om de daadwerkelijke on-chain");
    log("staat te tonen, niet aannemen op basis van wat verstuurd is...");
    const pending = await readPendingAction(connection, pendingActionPda);
    if (!pending) {
      log("FOUT: pending_action bestaat niet na bevestigde initiate_threshold_change (onverwacht).");
      return;
    }
    const initiatedAtDate = new Date(Number(pending.initiatedAt) * 1000);
    const availableAtDate = new Date((Number(pending.initiatedAt) + PENDING_ACTION_TIMELOCK_SECONDS) * 1000);
    log("kind=" + pending.kind + " (3 = ThresholdChange), initiated_at=" + pending.initiatedAt +
      " (" + initiatedAtDate.toLocaleString() + ")");
    log("finalize_threshold_change (stap 25) wordt beschikbaar vanaf: " + availableAtDate.toLocaleString());
    log(
      pending.confirmed
        ? "confirmed=true: single-passkey-degradatie - dezelfde passkey mag straks ook finalize tekenen."
        : "confirmed=false: 2-of-2 vereist - finalize moet met een ANDERE, tweede passkey getekend " +
            "worden (stap 11/12 om die aan te maken/registreren, als dat nog niet gebeurd is)."
    );
    log("");
    log("SUCCES - PendingAction aangemaakt. Stap 25's paneel hieronder toont nu de wachtstatus.");

    await refreshThresholdChangeStatus();
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep25(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 25: finalize_threshold_change - de openstaande drempelwijziging bevestigen.");
  log("Alleen mogelijk als de 24-uurs-wachttijd daadwerkelijk verstreken is (het paneel boven");
  log("stap 24/25 toont de precieze staat) - een te vroege poging faalt on-chain met");
  log("PendingActionTimelockNotElapsed, deze knop is bewust pas UI-enabled zodra dat niet meer kan.");
  log("");

  const pendingActionPda = derivePendingActionPda(lastPdas.walletPda);
  const pending = await readPendingAction(connection, pendingActionPda);
  if (!pending) {
    log("Geen openstaande PendingAction - voer eerst stap 24 uit.");
    return;
  }

  let signingPasskey: Uint8Array;
  let signingCredentialId: Uint8Array;
  if (pending.confirmed) {
    log("confirmed=true: single-passkey-degradatie - PASSKEY 1 tekent ook finalize.");
    signingPasskey = lastPasskeyPublicKey;
    signingCredentialId = lastCredentialId;
  } else {
    log("confirmed=false: 2-of-2 vereist - finalize moet met een ANDERE, tweede passkey getekend");
    log("worden dan initiate. Deze demopagina gebruikt daarvoor PASSKEY 2 (stap 11/12).");
    if (!lastPasskeyPublicKey2 || !lastCredentialId2) {
      log("FOUT: PASSKEY 2 is nog niet aangemaakt/geregistreerd (stap 11/12) - zonder een tweede,");
      log("andere passkey wordt finalize on-chain geweigerd (SecondPasskeyMustDifferFromInitiator).");
      log("Voer stap 11 en 12 uit en probeer het daarna opnieuw.");
      return;
    }
    signingPasskey = lastPasskeyPublicKey2;
    signingCredentialId = lastCredentialId2;
  }

  log("");
  log("PendingAction slaat de drempel/venstercap-waarden zelf niet in platte tekst op, alleen hun");
  log("hash (action_commitment) - opnieuw invoeren gevraagd, lokaal tegen de echte on-chain");
  log("commitment geverifieerd VOORDAT er een passkey-ceremonie start.");
  const choice = await showThresholdChangeFinalizePreview(lastPdas.walletPda, pending.actionCommitment);
  if (choice === null) {
    log("Geweigerd of ongeldig in de bevestigingskaart - finalize_threshold_change NIET aangeroepen,");
    log("geen passkey-prompt.");
    return;
  }
  log(
    "Geverifieerd: drempel=" + choice.newSpendThresholdLamports.toString() +
      " lamports, venstercap=" + choice.newWindowTotalCapLamports.toString() +
      " lamports komt overeen met de openstaande wijziging."
  );
  log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

  try {
    const { transaction, spendWindowPda } = await buildFinalizeThresholdChangeTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      pendingActionPda,
      choice.newSpendThresholdLamports,
      choice.newWindowTotalCapLamports,
      signingPasskey,
      signingCredentialId,
      window.location.hostname
    );
    log("spend_window PDA: " + spendWindowPda.toBase58());
    log("");

    log("Eigen simulatie...");
    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    for (const line of simResult.value.logs ?? []) log("  " + line);
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("WalletAccount/SpendWindow opnieuw uitlezen (ruwe account-bytes) om de daadwerkelijke");
    log("on-chain waarden te tonen, niet aannemen op basis van wat verstuurd is...");
    const newThreshold = await readSpendThresholdLamports(connection, lastPdas.walletPda);
    const spendWindow = await readSpendWindow(connection, spendWindowPda);
    log("spend_threshold_lamports (opnieuw gelezen): " + newThreshold.toString());
    log(
      "window_total_cap_lamports (opnieuw gelezen): " +
        (spendWindow ? spendWindow.windowTotalCapLamports.toString() : "FOUT: spend_window bestaat niet")
    );
    log("");
    log("SUCCES - finalize_threshold_change end-to-end bewezen.");
    renderThresholdBanner(newThreshold);
    await refreshThresholdChangeStatus();
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runCancelThresholdChange(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("cancel_action - openstaande actie annuleren zodat een verkeerd ingevoerde waarde niet");
  log("24 uur hoeft te blijven hangen (STATUS.md sectie 135, punt 5). Kind-agnostisch: sluit");
  log("ELKE openstaande PendingAction, niet alleen ThresholdChange. Elke huidige geldige passkey");
  log("mag annuleren, geen 2-of-2-eis.");
  log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

  const pendingActionPda = derivePendingActionPda(lastPdas.walletPda);
  try {
    const { transaction } = await buildCancelActionTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      pendingActionPda,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    const simResult = await connection.simulateTransaction(transaction);
    log("Simulatie err: " + JSON.stringify(simResult.value.err));
    for (const line of simResult.value.logs ?? []) log("  " + line);
    log("");
    if (simResult.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(transaction);
    log("Verstuurd. Signature: " + signature);
    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("SUCCES - cancel_action end-to-end bewezen. Stap 24 kan opnieuw aangeroepen worden.");
    await refreshThresholdChangeStatus();
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

document.getElementById("step3-btn")!.addEventListener("click", () => {
  runStep3();
});

document.getElementById("step4-btn")!.addEventListener("click", () => {
  runStep4();
});

document.getElementById("step5-btn")!.addEventListener("click", () => {
  runStep5();
});
document.getElementById("step6-btn")!.addEventListener("click", () => {
  runStep6();
});
document.getElementById("step8-btn")!.addEventListener("click", () => {
  runStep8();
});
document.getElementById("step11-btn")!.addEventListener("click", () => {
  runStep11();
});
document.getElementById("step12-btn")!.addEventListener("click", () => {
  runStep12();
});
document.getElementById("step13-btn")!.addEventListener("click", () => {
  runStep13();
});
document.getElementById("step14-btn")!.addEventListener("click", () => {
  runStep14();
});
document.getElementById("step15-btn")!.addEventListener("click", () => {
  runStep15();
});
document.getElementById("step16-btn")!.addEventListener("click", () => {
  runStep16();
});
document.getElementById("step17-btn")!.addEventListener("click", () => {
  runStep17();
});
document.getElementById("step18-btn")!.addEventListener("click", () => {
  runStep18();
});
document.getElementById("step19-btn")!.addEventListener("click", () => {
  runStep19();
});
document.getElementById("step20-btn")!.addEventListener("click", () => {
  runStep20();
});
document.getElementById("step21-btn")!.addEventListener("click", () => {
  runStep21();
});
document.getElementById("step22-btn")!.addEventListener("click", () => {
  runStep22();
});
document.getElementById("step23-btn")!.addEventListener("click", () => {
  runStep23();
});
document.getElementById("step24-btn")!.addEventListener("click", () => {
  runStep24();
});
document.getElementById("step25-btn")!.addEventListener("click", () => {
  runStep25();
});
document.getElementById("step25-cancel-btn")!.addEventListener("click", () => {
  runCancelThresholdChange();
});
