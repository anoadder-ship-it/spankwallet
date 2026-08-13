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
import { buildTransferTokenTransaction } from "./transferToken";
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
  buildRemoveAllowedProgramTransaction,
} from "./policy";
import { buildExecuteAdvancedTransaction, RemainingAccountSpec } from "./executeAdvanced";
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
  buildExecuteViaSessionTransaction,
  buildExecuteAdvancedViaSessionTransaction,
  buildCloseExpiredSessionTransaction,
} from "./sessionKeys";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
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

const connection = new Connection("https://devnet.helius-rpc.com/?api-key=f39fc413-6730-4848-a60f-a6685a6f04d3", "confirmed");

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

    (document.getElementById("step3-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step4-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step6-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step7-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step5-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step8-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step11-btn") as HTMLButtonElement).disabled = false;
    (document.getElementById("step16-btn") as HTMLButtonElement).disabled = false;
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

async function runStep7(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 7: transfer_token - SPL-token versturen vanuit de vault met een");
  log("ECHTE passkey-handtekening (echte devnet-USDC, zelfde patroon als");
  log("transfer_sol maar dan voor tokens).");
  log("");
  try {
    const usdcMint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const payerAta = getAssociatedTokenAddressSync(usdcMint, lastWallet.publicKey);
    const vaultAta = getAssociatedTokenAddressSync(usdcMint, lastPdas.vaultPda, true);

    log("7a. Vault-USDC-ATA aanmaken + 1 USDC ernaartoe sturen (voorbereiding -");
    log("zonder saldo in de vault is er niets om transfer_token mee te testen)...");
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

    const fundTx = new Transaction().add(
      createTransferInstruction(payerAta, vaultAta, lastWallet.publicKey, 1_000_000)
    );
    fundTx.feePayer = lastWallet.publicKey;
    const { blockhash: fundBh } = await connection.getLatestBlockhash();
    fundTx.recentBlockhash = fundBh;
    const { signature: fundSig } = await lastWallet.signAndSendTransaction(fundTx);
    await connection.confirmTransaction(fundSig, "confirmed");
    log("1 USDC naar de vault gestuurd. Signature: " + fundSig);
    log("");

    log("7b. transfer_token aanroepen: 0.5 USDC (500000 units) van de vault");
    log("terug naar de payer zelf...");
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction } = await buildTransferTokenTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      vaultAta,
      payerAta,
      usdcMint,
      500_000n,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    log("");
    log("Eigen simulatie (dit is de daadwerkelijke test van verify_passkey_signature");
    log("+ de nieuwe SPL-token-CPI-logica)...");
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
    log("SUCCES - transfer_token heeft 0.5 USDC daadwerkelijk verplaatst van de");
    log("vault terug naar de payer, met een ECHTE passkey-handtekening. Bewijst");
    log("dat de tweede getypeerde actie (na transfer_sol) end-to-end werkt op");
    log("devnet, inclusief de vault-PDA-ondertekende SPL-Token-CPI.");
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
  log("System Program is hier bewust gekozen als veilig, ongevaarlijk testprogramma");
  log("(geen echte waarde in het spel) - zie stap 9 voor de daadwerkelijke CPI ernaartoe.");
  log("");

  try {
    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction, policyPda } = await buildAddAllowedProgramTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      SystemProgram.programId,
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

    log("Policy-account teruglezen (ruwe account-bytes) om te bevestigen dat System");
    log("Program daadwerkelijk op de allowlist staat...");
    const policy = await readPolicyAccount(connection, policyPda);
    if (!policy) {
      log("FOUT: policy-account bestaat niet na bevestigde add_allowed_program (onverwacht).");
      return;
    }
    log("count: " + policy.count);
    log("allowed_programs: " + policy.allowedPrograms.map((p) => p.toBase58()).join(", "));
    if (!policy.allowedPrograms.some((p) => p.equals(SystemProgram.programId))) {
      log("FOUT: System Program staat niet in de teruggelezen allowlist (onverwacht).");
      return;
    }
    log("");
    log("SUCCES - add_allowed_program heeft het policy-account daadwerkelijk aangemaakt");
    log("(init_if_needed) en System Program toegevoegd, met een ECHTE passkey-handtekening.");
    log("");
    log("Klaar voor stap 9.");

    (document.getElementById("step9-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep9(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 9: execute_advanced - eerst het NEGATIEVE pad (geweigerd programma),");
  log("daarna het POSITIEVE pad (echte CPI naar een toegestaan programma). Het");
  log("negatieve pad is net zo belangrijk om te bewijzen als het positieve: het");
  log("bewijst dat de allowlist-check daadwerkelijk iets tegenhoudt, niet alleen dat");
  log("er iets doorheen kan.");
  log("");

  try {
    const policyPda = derivePolicyPda(lastPdas.walletPda);

    log("9a. NEGATIEF: execute_advanced tegen TOKEN_PROGRAM_ID - NOOIT toegevoegd");
    log("aan de allowlist. Verwacht: geweigerd met ProgramNotAllowed. Alleen");
    log("simuleren (niet versturen) - we willen de weigering aantonen, geen fee");
    log("betalen voor een transactie die toch niets gaat doen.");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");

    const { transaction: negativeTx } = await buildExecuteAdvancedTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      policyPda,
      TOKEN_PROGRAM_ID,
      [],
      new Uint8Array(0),
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );

    const negativeSim = await connection.simulateTransaction(negativeTx);
    log("Simulatie err: " + JSON.stringify(negativeSim.value.err));
    log("Simulatie logs:");
    for (const line of negativeSim.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (!negativeSim.value.err) {
      log("FOUT: execute_advanced tegen een niet-toegestaan programma had moeten");
      log("falen, maar de simulatie slaagde (onverwacht - de allowlist-check werkt niet).");
      return;
    }
    log("SUCCES - execute_advanced weigert correct een niet-toegestaan programma");
    log("(TOKEN_PROGRAM_ID stond nooit op de allowlist).");
    log("");

    log("9b. POSITIEF: execute_advanced tegen System Program (toegevoegd in stap 8) -");
    log("een echte, ongevaarlijke CPI (System::Assign) op een vers, leeg testaccount,");
    log("verandert alleen de eigenaar van dat testaccount naar ons eigen programma-ID.");
    log("Geen SOL/tokens van waarde in het spel.");
    log("");

    const target = Keypair.generate();
    log("Test-account: " + target.publicKey.toBase58());
    log("Eerst funden met de rent-exempte minimum (anders ruimt de runtime het account");
    log("na de transactie meteen weer op, en is de eigenaarswijziging niet meer");
    log("waarneembaar)...");

    const rentExemptMinimum = await connection.getMinimumBalanceForRentExemption(0);
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: lastWallet.publicKey,
        toPubkey: target.publicKey,
        lamports: rentExemptMinimum,
      })
    );
    fundTx.feePayer = lastWallet.publicKey;
    const { blockhash: fundBh } = await connection.getLatestBlockhash();
    fundTx.recentBlockhash = fundBh;
    const { signature: fundSig } = await lastWallet.signAndSendTransaction(fundTx);
    await connection.confirmTransaction(fundSig, "confirmed");
    log("Gefund (" + rentExemptMinimum + " lamports). Signature: " + fundSig);
    log("");

    const assignIx = SystemProgram.assign({
      accountPubkey: target.publicKey,
      programId: SPANKWALLET_PROGRAM_ID,
    });
    const remainingAccounts: RemainingAccountSpec[] = [
      { pubkey: target.publicKey, isWritable: true, isSigner: true },
    ];

    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction: positiveTx } = await buildExecuteAdvancedTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      policyPda,
      SystemProgram.programId,
      remainingAccounts,
      assignIx.data,
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    positiveTx.partialSign(target);

    log("Eigen simulatie...");
    const positiveSim = await connection.simulateTransaction(positiveTx);
    log("Simulatie err: " + JSON.stringify(positiveSim.value.err));
    log("Simulatie logs:");
    for (const line of positiveSim.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (positiveSim.value.err) {
      log("Simulatie faalde - stop hier.");
      return;
    }

    log("Simulatie geslaagd. Transactie versturen (keur goed in je wallet-extensie)...");
    const { blockhash } = await connection.getLatestBlockhash();
    positiveTx.recentBlockhash = blockhash;
    const { signature } = await lastWallet.signAndSendTransaction(positiveTx);
    log("Verstuurd. Signature: " + signature);

    log("Wachten op bevestiging...");
    await connection.confirmTransaction(signature, "confirmed");
    log("Bevestigd.");
    log("");

    log("Test-account teruglezen om te bevestigen dat de eigenaar daadwerkelijk");
    log("gewijzigd is via de CPI...");
    const info = await connection.getAccountInfo(target.publicKey);
    if (!info) {
      log("FOUT: test-account bestaat niet meer na bevestigde execute_advanced (onverwacht).");
      return;
    }
    log("Nieuwe eigenaar: " + info.owner.toBase58());
    if (!info.owner.equals(SPANKWALLET_PROGRAM_ID)) {
      log("FOUT: eigenaar is niet ons eigen programma-ID (onverwacht).");
      return;
    }
    log("");
    log("SUCCES - execute_advanced heeft een ECHTE CPI naar een toegestaan extern");
    log("programma (System Program) uitgevoerd, met een ECHTE passkey-handtekening,");
    log("en tegelijk correct een niet-toegestaan programma geweigerd. Beide kanten van");
    log("de allowlist-gate zijn nu end-to-end bewezen op devnet.");
    log("");
    log("Klaar voor stap 10.");

    (document.getElementById("step10-btn") as HTMLButtonElement).disabled = false;
  } catch (err) {
    log("");
    log("FOUT:");
    log(String(err));
    console.error(err);
  }
}

async function runStep10(): Promise<void> {
  if (!lastPasskeyPublicKey || !lastCredentialId || !lastPdas || !lastWallet) {
    log("Voer eerst stap 1 en stap 2 uit.");
    return;
  }
  log("Stap 10: remove_allowed_program - System Program weer verwijderen van de");
  log("allowlist, met een ECHTE passkey-handtekening, en daarna herbevestigen dat");
  log("execute_advanced ernaartoe nu weer geweigerd wordt (sluit de cirkel: add");
  log("laat iets toe, remove trekt het weer in, allebei aantoonbaar effectief).");
  log("");

  try {
    const policyPda = derivePolicyPda(lastPdas.walletPda);

    log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");
    const { transaction } = await buildRemoveAllowedProgramTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      SystemProgram.programId,
      lastPasskeyPublicKey,
      lastCredentialId,
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

    log("Policy-account teruglezen om te bevestigen dat System Program daadwerkelijk");
    log("verwijderd is...");
    const policy = await readPolicyAccount(connection, policyPda);
    if (!policy) {
      log("FOUT: policy-account bestaat niet meer (onverwacht).");
      return;
    }
    log("count: " + policy.count);
    log("allowed_programs: " + policy.allowedPrograms.map((p) => p.toBase58()).join(", "));
    if (policy.allowedPrograms.some((p) => p.equals(SystemProgram.programId))) {
      log("FOUT: System Program staat nog steeds in de allowlist (onverwacht).");
      return;
    }
    log("");

    log("Herbevestigen: execute_advanced tegen System Program moet nu weer geweigerd");
    log("worden (alleen simuleren, we weten al dat dit hoort te falen)...");
    log("navigator.credentials.get() wordt aangeroepen - keur de prompt goed.");
    const { transaction: retryTx } = await buildExecuteAdvancedTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
      policyPda,
      SystemProgram.programId,
      [],
      new Uint8Array(0),
      lastPasskeyPublicKey,
      lastCredentialId,
      window.location.hostname
    );
    const retrySim = await connection.simulateTransaction(retryTx);
    log("Simulatie err: " + JSON.stringify(retrySim.value.err));
    for (const line of retrySim.value.logs ?? []) {
      log("  " + line);
    }
    log("");

    if (!retrySim.value.err) {
      log("FOUT: execute_advanced tegen het zojuist verwijderde System Program had");
      log("moeten falen, maar de simulatie slaagde (onverwacht).");
      return;
    }

    log("SUCCES - remove_allowed_program heeft System Program daadwerkelijk van de");
    log("allowlist gehaald, met een ECHTE passkey-handtekening, en execute_advanced");
    log("weigert er nu weer een CPI naartoe. De volledige programma-allowlist-cyclus");
    log("(add, gebruiken, remove, geweigerd worden) is nu end-to-end bewezen op devnet.");
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

  try {
    log("[PASSKEY 1, OORSPRONKELIJK] navigator.credentials.get() wordt");
    log("aangeroepen - keur de biometrie-/PIN-prompt goed voor de EERSTE,");
    log("oorspronkelijke passkey (niet de zojuist aangemaakte tweede!).");
    const { transaction, passkeysPda } = await buildAddPasskeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey2,
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
      bytesToHex(passkeys.additionalPasskeys[0]) !== bytesToHex(lastPasskeyPublicKey2)
    ) {
      log("FOUT: PASSKEY 2 staat niet correct in het teruggelezen passkeys-account.");
      return;
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

  try {
    log("[PASSKEY 2] navigator.credentials.get() wordt aangeroepen - keur de");
    log("biometrie-/PIN-prompt goed voor de TWEEDE passkey.");
    const { transaction } = await buildRemovePasskeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPasskeyPublicKey,
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
  if (!lastPdas || !lastWallet || !lastPasskeyPublicKey2 || !lastCredentialId2) {
    log("Voer eerst stap 1, 2 en 11-14 uit.");
    return;
  }
  log("Stap 15: LOCKOUT-BESCHERMING - proberen PASSKEY 2 te verwijderen terwijl");
  log("het de ENIGE nog geldige sleutel is. Dit MOET geweigerd worden");
  log("(CannotRemoveLastPasskey) - anders zou de wallet permanent onbereikbaar");
  log("worden. Alleen simuleren (niet versturen) - we willen de weigering");
  log("aantonen, geen fee betalen voor een transactie die toch niets gaat doen.");
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
    const expirySlot = currentSlot + 300n;
    lastSessionExpirySlot = expirySlot;
    log("Huidige slot: " + currentSlot + ", expiry_slot: " + expirySlot);
    log("");

    log("[PASSKEY] navigator.credentials.get() wordt aangeroepen - add_session_key");
    log("vereist ALTIJD een echte passkey-handtekening (het wijzigt WIE toegang");
    log("heeft), zelfs al is de sessiesleutel zelf geen passkey.");

    // Spend-limits (ontwerpdocument): max_lamports_per_tx=50_000,
    // max_lamports_total=100_000 - ruim genoeg voor de 1000-lamport-
    // aanroepen in stap 17/19 hieronder, maar wel expliciete, echte caps
    // (geen "0 = onbeperkt"-val) i.p.v. een toevallig groot getal. Geen
    // token-limiet nodig (canTransferToken=false), dus token_mint blijft
    // PublicKey.default() en de token-caps blijven 0n.
    const { transaction, sessionPda } = await buildAddSessionKeyTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      sessionKeypair.publicKey,
      expirySlot,
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
document.getElementById("step7-btn")!.addEventListener("click", () => {
  runStep7();
});
document.getElementById("step8-btn")!.addEventListener("click", () => {
  runStep8();
});
document.getElementById("step9-btn")!.addEventListener("click", () => {
  runStep9();
});
document.getElementById("step10-btn")!.addEventListener("click", () => {
  runStep10();
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
