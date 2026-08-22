import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  fetchActionNonce,
  nonceLeBytes,
} from "../tests/webauthnTestHelper";

// Functioneel bewijs voor een B1-B7-achtige upgrade (STATUS.md sectie 83's
// plan, stap 1) tegen een VERSE, WEGWERP-programma-ID op devnet - NOOIT het
// echte, multisig-bestuurde adres. Ontstaan bij de eerste keer (2NHovxaquuaf-
// 1RsPsKAPk9rVAcN4ntfoFCiHWYhpCAp8, sectie 87), bewaard om vóór een volgend
// echt voorstel opnieuw te draaien tegen een verse build.
//
// WAARSCHUWING - WAAROM DE HARDE GRENDEL HIERONDER BESTAAT: dit script doet
// DESTRUCTIEVE dingen (initiate_recovery, finalize_recovery, add_passkey) op
// een wallet. Zou dit ooit per ongeluk tegen het echte programma draaien -
// een verkeerde ANCHOR_PROVIDER_URL, een IDL die per ongeluk het echte adres
// bevat - dan raakt het ECHTE wallets. `refuseIfRealProgram()` hieronder
// weigert daarom HARD (geen waarschuwing, een crash) zodra het opgeloste
// program-ID gelijk is aan het echte devnet-adres uit
// `scripts/lib/devnet-program-id.sh` (dezelfde ENE bron als build-and-
// deploy.sh/build-devnet-buffer.sh gebruiken, geen eigen, uit elkaar te
// lopen kopie van dat adres).
//
// Gebruik (in een GEÏSOLEERDE worktree, gebouwd op een wegwerp-`declare_id!`
// - zie build-devnet-buffer.sh/build-and-deploy.sh voor het patroon; NOOIT
// in deze hoofd-werkboom draaien met het echte adres nog in de build):
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
//     node_modules/.bin/ts-node --transpile-only scripts/throwawayB1B7Proof.ts
const MAX_SESSION_DURATION_SLOTS = 1_512_000n; // state.rs, moet exact overeenkomen - de letterlijke broncode-constante, geen losstaande aanname

function refuseIfRealProgram(programId: PublicKey) {
  const shPath = path.join(__dirname, "lib", "devnet-program-id.sh");
  const content = fs.readFileSync(shPath, "utf8");
  const match = content.match(/SPANKWALLET_DEVNET_PROGRAM_ID="([^"]+)"/);
  if (!match) {
    throw new Error(`WEIGERING: kon SPANKWALLET_DEVNET_PROGRAM_ID niet uitlezen uit ${shPath} - weiger uit voorzorg door te gaan zonder die vergelijking te kunnen maken.`);
  }
  const realProgramId = match[1];
  if (programId.toBase58() === realProgramId) {
    throw new Error(
      `WEIGERING: dit script doet destructieve dingen (initiate_recovery, finalize_recovery, ` +
      `add_passkey) en mag NOOIT tegen het echte, multisig-bestuurde programma draaien. ` +
      `Het opgeloste program-ID (${programId.toBase58()}) is EXACT het echte devnet-adres ` +
      `uit scripts/lib/devnet-program-id.sh. Script stopt hier, voordat er iets on-chain gebeurt.`
    );
  }
  console.log("Grendel gepasseerd: program-ID is NIET het echte devnet-adres (" + realProgramId + ").");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  refuseIfRealProgram(program.programId);

  console.log("RPC endpoint:", (provider.connection as any)._rpcEndpoint);
  console.log("program ID (uit IDL):", program.programId.toBase58());
  console.log("fee-payer:", provider.wallet.publicKey.toBase58());

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), seedHash], program.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), walletPda.toBuffer()], program.programId);
    const [passkeysPda] = PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], program.programId);
    const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("policy"), walletPda.toBuffer()], program.programId);
    return { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash: Array.from(seedHash) };
  }
  function deriveSessionPda(walletPda: PublicKey, sessionKey: PublicKey) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), walletPda.toBuffer(), sessionKey.toBuffer()],
      program.programId
    );
    return sessionPda;
  }
  async function sendFresh(instructions: anchor.web3.TransactionInstruction[]) {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash("finalized")).blockhash;
    const signed = await (provider.wallet as anchor.Wallet).signTransaction(tx);
    const sig = await provider.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await provider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
  function addSessionKeyPayload(opts: {
    nonce: bigint;
    sessionKey: PublicKey;
    expirySlot: number;
    maxLamportsPerTx: BN;
    maxLamportsTotal: BN;
  }) {
    const raw = Buffer.concat([
      opts.sessionKey.toBuffer(),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(opts.expirySlot), 0); return b; })(),
      Buffer.from([1, 0, 0]), // canExecute=true, canTransferToken=false, canExecuteAdvanced=false
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(), // 0 sub-scope programs
      opts.maxLamportsPerTx.toArrayLike(Buffer, "le", 8),
      opts.maxLamportsTotal.toArrayLike(Buffer, "le", 8),
      PublicKey.default.toBuffer(),
      new BN(0).toArrayLike(Buffer, "le", 8),
      new BN(0).toArrayLike(Buffer, "le", 8),
    ]);
    return Buffer.concat([nonceLeBytes(opts.nonce), raw]);
  }

  const results: Record<string, unknown> = {};
  // Publieke devnet-RPC (api.devnet.solana.com) rate-limit't agressief bij
  // een reeks snel-opeenvolgende aanroepen - een korte, vaste pauze tussen
  // stappen is goedkoper en betrouwbaarder dan op web3.js' eigen (beperkte)
  // ingebouwde retry-backoff te vertrouwen voor een script met dit veel
  // sequentiele RPC-aanroepen.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ========== 1. init_wallet, MET KORTE recovery_timelock_seconds (5s) ==========
  // Bewust een korte, niet-standaard timelock (alleen mogelijk omdat dit een
  // wegwerp-testprogramma is): init_wallet's recovery_timelock_seconds is een
  // caller-argument (geen minimum afgedwongen in de broncode, geverifieerd),
  // nodig om B2's recovery-flow binnen de looptijd van dit script te kunnen
  // afronden zonder 72 echte uren te wachten.
  console.log("\n=== 1. init_wallet (verse wallet, recovery_timelock_seconds=5s voor testdoeleinden) ===");
  const passkey = generateTestPasskey();
  const backupAuthority = Keypair.generate();
  const { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);
  console.log("walletPda:", walletPda.toBase58());

  const SHORT_TIMELOCK = 5;
  const initPayload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(SHORT_TIMELOCK)]);
  const initChallenge = buildExpectedChallenge(program.programId, walletPda, "init_wallet", initPayload);
  const initSigned = signTestChallenge(passkey, initChallenge);
  const initSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, initSigned.signedMessage, initSigned.rawSignature);

  const initSig = await program.methods
    .initWallet(Array.from(passkey.compressedPublicKey), walletSeedHash, backupAuthority.publicKey, new BN(SHORT_TIMELOCK), initSigned.clientDataJSON)
    .accounts({
      wallet: walletPda,
      vault: vaultPda,
      payer: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([initSecpIx])
    .rpc();
  console.log("init_wallet OK, sig:", initSig);
  const walletInfo = await provider.connection.getAccountInfo(walletPda);
  console.log("walletPda dataLen (nieuwe layout):", walletInfo!.data.length);
  results.init_wallet_ok = true;

  // ========== 2. add_passkey (action_nonce-gebonden actie) ==========
  console.log("\n=== 2. add_passkey ===");
  const extraPasskey = generateTestPasskey();
  const nonceForAdd = await fetchActionNonce(provider.connection, walletPda);
  const addPayload = Buffer.concat([nonceLeBytes(nonceForAdd), extraPasskey.compressedPublicKey]);
  const addChallenge = buildExpectedChallenge(program.programId, walletPda, "add_passkey", addPayload);
  const addSigned = signTestChallenge(passkey, addChallenge);
  const addSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, addSigned.signedMessage, addSigned.rawSignature);
  const addIx = await program.methods
    .addPasskey(Array.from(extraPasskey.compressedPublicKey), new BN(nonceForAdd.toString()), addSigned.clientDataJSON)
    .accounts({ wallet: walletPda, passkeys: passkeysPda, payer: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
    .instruction();
  const addSig = await sendFresh([addSecpIx, addIx]);
  console.log("add_passkey OK, sig:", addSig);
  results.add_passkey_ok = true;

  // ========== 3. replay: zelfde nonce/handtekening nogmaals ==========
  console.log("\n=== 3. replay-weigering ===");
  let replayOk = false, replayErr = "";
  try {
    await sendFresh([addSecpIx, addIx]);
    replayOk = true;
  } catch (e: any) {
    replayErr = e?.message ?? String(e);
  }
  console.log("replay geslaagd (had niet gemogen):", replayOk, " bevat StaleActionNonce:", replayErr.includes("StaleActionNonce"));
  results.replay_correctly_rejected = !replayOk && replayErr.includes("StaleActionNonce");

  // ========== 4. spend-limit (add_session_key + execute_via_session) ==========
  console.log("\n=== 4. spend-limit ===");
  const rentExemptVault = await provider.connection.getMinimumBalanceForRentExemption(41);
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: rentExemptVault + 10_000_000 })));

  const sessionKeypair = Keypair.generate();
  let currentSlot = await provider.connection.getSlot();
  const expirySlot = currentSlot + 1000;
  const maxLamportsPerTx = new BN(2_000_000);
  const maxLamportsTotal = new BN(10_000_000);
  const nonceForSession = await fetchActionNonce(provider.connection, walletPda);
  const sessionPayload = addSessionKeyPayload({ nonce: nonceForSession, sessionKey: sessionKeypair.publicKey, expirySlot, maxLamportsPerTx, maxLamportsTotal });
  const sessionChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", sessionPayload);
  const sessionSigned = signTestChallenge(passkey, sessionChallenge);
  const sessionSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, sessionSigned.signedMessage, sessionSigned.rawSignature);
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  await program.methods
    .addSessionKey(sessionKeypair.publicKey, new BN(expirySlot), true, false, false, [], maxLamportsPerTx, maxLamportsTotal, PublicKey.default, new BN(0), new BN(0), new BN(nonceForSession.toString()), sessionSigned.clientDataJSON)
    .accounts({ wallet: walletPda, session: sessionPda, payer: provider.wallet.publicKey, policy: policyPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
    .preInstructions([sessionSecpIx])
    .rpc();
  console.log("add_session_key OK");

  const recipientWithin = Keypair.generate().publicKey;
  await program.methods.executeViaSession(new BN(1_500_000)).accounts({ wallet: walletPda, vault: vaultPda, recipient: recipientWithin, session: sessionPda, sessionKey: sessionKeypair.publicKey }).signers([sessionKeypair]).rpc();
  const recipientBalance = await provider.connection.getBalance(recipientWithin);
  console.log("execute_via_session(1_500_000) binnen cap: OK, ontvanger-balans:", recipientBalance);
  results.spend_within_cap_ok = recipientBalance === 1_500_000;

  let overCapOk = false, overCapErr = "";
  try {
    await program.methods.executeViaSession(new BN(2_000_001)).accounts({ wallet: walletPda, vault: vaultPda, recipient: Keypair.generate().publicKey, session: sessionPda, sessionKey: sessionKeypair.publicKey }).signers([sessionKeypair]).rpc();
    overCapOk = true;
  } catch (e: any) {
    overCapErr = e?.message ?? String(e);
  }
  console.log("execute_via_session boven cap geslaagd (had niet gemogen):", overCapOk, " bevat SessionSpendPerTxExceeded:", overCapErr.includes("SessionSpendPerTxExceeded"));
  results.spend_over_cap_correctly_rejected = !overCapOk && overCapErr.includes("SessionSpendPerTxExceeded");

  // ========== 5. B3: max sessieduur ==========
  console.log("\n=== 5. B3: MAX_SESSION_DURATION_SLOTS ===");
  currentSlot = await provider.connection.getSlot();
  const tooLongExpiry = currentSlot + Number(MAX_SESSION_DURATION_SLOTS) + 1000; // ruim voorbij de grens
  const tooLongSessionKeypair = Keypair.generate();
  const nonceForTooLong = await fetchActionNonce(provider.connection, walletPda);
  const tooLongPayload = addSessionKeyPayload({ nonce: nonceForTooLong, sessionKey: tooLongSessionKeypair.publicKey, expirySlot: tooLongExpiry, maxLamportsPerTx: new BN(1), maxLamportsTotal: new BN(1) });
  const tooLongChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", tooLongPayload);
  const tooLongSigned = signTestChallenge(passkey, tooLongChallenge);
  const tooLongSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, tooLongSigned.signedMessage, tooLongSigned.rawSignature);
  const tooLongSessionPda = deriveSessionPda(walletPda, tooLongSessionKeypair.publicKey);

  let tooLongOk = false, tooLongErr = "";
  try {
    await program.methods
      .addSessionKey(tooLongSessionKeypair.publicKey, new BN(tooLongExpiry), true, false, false, [], new BN(1), new BN(1), PublicKey.default, new BN(0), new BN(0), new BN(nonceForTooLong.toString()), tooLongSigned.clientDataJSON)
      .accounts({ wallet: walletPda, session: tooLongSessionPda, payer: provider.wallet.publicKey, policy: policyPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .preInstructions([tooLongSecpIx])
      .rpc();
    tooLongOk = true;
  } catch (e: any) {
    tooLongErr = e?.message ?? String(e);
  }
  console.log("add_session_key met expiry ver-voorbij-de-grens geslaagd (had niet gemogen):", tooLongOk, " bevat SessionDurationTooLong:", tooLongErr.includes("SessionDurationTooLong"));
  results.session_too_long_correctly_rejected = !tooLongOk && tooLongErr.includes("SessionDurationTooLong");

  // Exact op de grens (max_expiry_slot zelf) moet WEL slagen (grens is <=, niet <).
  currentSlot = await provider.connection.getSlot();
  const exactBoundaryExpiry = currentSlot + Number(MAX_SESSION_DURATION_SLOTS);
  const boundarySessionKeypair = Keypair.generate();
  const nonceForBoundary = await fetchActionNonce(provider.connection, walletPda);
  const boundaryPayload = addSessionKeyPayload({ nonce: nonceForBoundary, sessionKey: boundarySessionKeypair.publicKey, expirySlot: exactBoundaryExpiry, maxLamportsPerTx: new BN(1), maxLamportsTotal: new BN(1) });
  const boundaryChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", boundaryPayload);
  const boundarySigned = signTestChallenge(passkey, boundaryChallenge);
  const boundarySecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, boundarySigned.signedMessage, boundarySigned.rawSignature);
  const boundarySessionPda = deriveSessionPda(walletPda, boundarySessionKeypair.publicKey);
  let boundaryOk = false, boundaryErr = "";
  try {
    await program.methods
      .addSessionKey(boundarySessionKeypair.publicKey, new BN(exactBoundaryExpiry), true, false, false, [], new BN(1), new BN(1), PublicKey.default, new BN(0), new BN(0), new BN(nonceForBoundary.toString()), boundarySigned.clientDataJSON)
      .accounts({ wallet: walletPda, session: boundarySessionPda, payer: provider.wallet.publicKey, policy: policyPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
      .preInstructions([boundarySecpIx])
      .rpc();
    boundaryOk = true;
  } catch (e: any) {
    boundaryErr = e?.message ?? String(e);
  }
  console.log("add_session_key EXACT op de grens (current_slot + MAX_SESSION_DURATION_SLOTS) geslaagd:", boundaryOk, boundaryOk ? "" : ("fout: " + boundaryErr));
  results.session_at_exact_boundary_ok = boundaryOk;

  // ========== 6. B2: recovery bumpt session_epoch, oude sessie wordt ongeldig ==========
  console.log("\n=== 6. B2: session_epoch/recovery-invalidatie ===");
  const nonceForRecoverySession = await fetchActionNonce(provider.connection, walletPda);
  const recoverySessionKeypair = Keypair.generate();
  const recoveryTestExpiry = (await provider.connection.getSlot()) + 1000;
  const recoverySessionPayload = addSessionKeyPayload({ nonce: nonceForRecoverySession, sessionKey: recoverySessionKeypair.publicKey, expirySlot: recoveryTestExpiry, maxLamportsPerTx: new BN(1_000_000), maxLamportsTotal: new BN(1_000_000) });
  const recoverySessionChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", recoverySessionPayload);
  const recoverySessionSigned = signTestChallenge(passkey, recoverySessionChallenge);
  const recoverySessionSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, recoverySessionSigned.signedMessage, recoverySessionSigned.rawSignature);
  const recoverySessionPda = deriveSessionPda(walletPda, recoverySessionKeypair.publicKey);
  await program.methods
    .addSessionKey(recoverySessionKeypair.publicKey, new BN(recoveryTestExpiry), true, false, false, [], new BN(1_000_000), new BN(1_000_000), PublicKey.default, new BN(0), new BN(0), new BN(nonceForRecoverySession.toString()), recoverySessionSigned.clientDataJSON)
    .accounts({ wallet: walletPda, session: recoverySessionPda, payer: provider.wallet.publicKey, policy: policyPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
    .preInstructions([recoverySessionSecpIx])
    .rpc();
  console.log("sessie vóór recovery aangemaakt:", recoverySessionPda.toBase58());

  // vóór de recovery: sessie moet nog gewoon werken
  await sleep(800);
  const preRecoveryRecipient = Keypair.generate().publicKey;
  await program.methods.executeViaSession(new BN(1_000_000)).accounts({ wallet: walletPda, vault: vaultPda, recipient: preRecoveryRecipient, session: recoverySessionPda, sessionKey: recoverySessionKeypair.publicKey }).signers([recoverySessionKeypair]).rpc();
  await sleep(800);
  const preRecoveryBalance = await provider.connection.getBalance(preRecoveryRecipient);
  console.log("sessie werkt vóór recovery: balans ontvanger:", preRecoveryBalance, "(verwacht 1000000)");
  results.session_works_before_recovery = preRecoveryBalance === 1_000_000;

  const newOwnerPasskey = generateTestPasskey();
  await sleep(800);
  await program.methods
    .initiateRecovery(Array.from(newOwnerPasskey.compressedPublicKey))
    .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
    .signers([backupAuthority])
    .rpc();
  console.log("initiate_recovery OK (backup_authority-handtekening, geen passkey nodig)");

  console.log(`wachten ${SHORT_TIMELOCK + 2}s tot recovery_timelock_seconds (${SHORT_TIMELOCK}s) verstreken is...`);
  await sleep((SHORT_TIMELOCK + 2) * 1000);

  await program.methods
    .finalizeRecovery()
    .accounts({ wallet: walletPda, passkeys: passkeysPda })
    .rpc();
  console.log("finalize_recovery OK (permissionless, na de timelock)");

  await sleep(800);
  const walletAfterRecovery = await program.account.walletAccount.fetch(walletPda);
  console.log("session_epoch na recovery:", walletAfterRecovery.sessionEpoch.toString(), "(verwacht: 1)");
  results.session_epoch_bumped = walletAfterRecovery.sessionEpoch.toString() === "1";

  // ná de recovery: DEZELFDE (oude) sessie moet nu falen met SessionRevokedByRecovery
  await sleep(800);
  let oldSessionOk = false, oldSessionErr = "";
  try {
    await program.methods.executeViaSession(new BN(1_000_000)).accounts({ wallet: walletPda, vault: vaultPda, recipient: Keypair.generate().publicKey, session: recoverySessionPda, sessionKey: recoverySessionKeypair.publicKey }).signers([recoverySessionKeypair]).rpc();
    oldSessionOk = true;
  } catch (e: any) {
    oldSessionErr = e?.message ?? String(e);
  }
  console.log("oude sessie werkt na recovery (had niet gemogen):", oldSessionOk, " bevat SessionRevokedByRecovery:", oldSessionErr.includes("SessionRevokedByRecovery"));
  results.old_session_correctly_revoked_after_recovery = !oldSessionOk && oldSessionErr.includes("SessionRevokedByRecovery");

  // een NIEUWE sessie, aangemaakt door de NIEUWE eigenaar NA de recovery, moet gewoon werken
  await sleep(800);
  const nonceForNewSession = await fetchActionNonce(provider.connection, walletPda);
  const newSessionKeypair = Keypair.generate();
  await sleep(800);
  const newSessionExpiry = (await provider.connection.getSlot()) + 1000;
  const newSessionPayload = addSessionKeyPayload({ nonce: nonceForNewSession, sessionKey: newSessionKeypair.publicKey, expirySlot: newSessionExpiry, maxLamportsPerTx: new BN(1_000_000), maxLamportsTotal: new BN(1_000_000) });
  const newSessionChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", newSessionPayload);
  const newSessionSigned = signTestChallenge(newOwnerPasskey, newSessionChallenge);
  const newSessionSecpIx = buildSecp256r1Instruction(newOwnerPasskey.compressedPublicKey, newSessionSigned.signedMessage, newSessionSigned.rawSignature);
  const newSessionPda = deriveSessionPda(walletPda, newSessionKeypair.publicKey);
  await sleep(800);
  await program.methods
    .addSessionKey(newSessionKeypair.publicKey, new BN(newSessionExpiry), true, false, false, [], new BN(1_000_000), new BN(1_000_000), PublicKey.default, new BN(0), new BN(0), new BN(nonceForNewSession.toString()), newSessionSigned.clientDataJSON)
    .accounts({ wallet: walletPda, session: newSessionPda, payer: provider.wallet.publicKey, policy: policyPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId })
    .preInstructions([newSessionSecpIx])
    .rpc();
  await sleep(800);
  const postRecoveryRecipient = Keypair.generate().publicKey;
  await program.methods.executeViaSession(new BN(1_000_000)).accounts({ wallet: walletPda, vault: vaultPda, recipient: postRecoveryRecipient, session: newSessionPda, sessionKey: newSessionKeypair.publicKey }).signers([newSessionKeypair]).rpc();
  await sleep(800);
  const postRecoveryBalance = await provider.connection.getBalance(postRecoveryRecipient);
  console.log("nieuwe sessie (na recovery, nieuwe eigenaar) werkt: balans ontvanger:", postRecoveryBalance, "(verwacht 1000000)");
  results.new_session_after_recovery_works = postRecoveryBalance === 1_000_000;

  console.log("\n=== SAMENVATTING ===");
  console.log(JSON.stringify(results, null, 2));
  const allOk = Object.values(results).every((v) => v === true);
  console.log("\nALLE CONTROLES GESLAAGD:", allOk);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
