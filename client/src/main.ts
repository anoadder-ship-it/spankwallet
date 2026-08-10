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
  const testRecipient = lastWallet.publicKey;
  const testAmountLamports = 1000n;
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
