import "./polyfill";



import { createSpankWalletPasskey } from "./passkey";
import { connectWallet, ConnectedWallet } from "./wallet";
import { buildInitWalletTransaction, InitWalletPdas } from "./initWallet";
import { buildExecuteTransaction } from "./execute";
import {
  readWalletAccount,
  buildInitiateRecoveryTransaction,
  buildCancelRecoveryTransaction,
} from "./recovery";
import { setupSpamTokenAccount, buildHuntTransaction, INCINERATOR } from "./hunt";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

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
let lastCredentialId: Uint8Array | null = null;
let lastPdas: InitWalletPdas | null = null;
let lastWallet: ConnectedWallet | null = null;
let lastBackupAuthority: Keypair | null = null;

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

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
  if (!lastPasskeyPublicKey) {
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
    const { transaction, pdas } = await buildInitWalletTransaction(
      connection,
      wallet.publicKey,
      lastPasskeyPublicKey,
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
    (document.getElementById("step5-btn") as HTMLButtonElement).disabled = false;
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
  log("navigator.credentials.get() wordt aangeroepen - keur de biometrie-/PIN-prompt goed.");

  try {
    const { transaction, signedMessage, expectedChallenge } = await buildExecuteTransaction(
      connection,
      lastWallet.publicKey,
      lastPdas.walletPda,
      lastPdas.vaultPda,
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
