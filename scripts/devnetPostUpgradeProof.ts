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

// Functioneel post-upgrade-bewijs tegen het ECHTE, gedeployde programma op
// devnet - ontstaan als STATUS.md sectie 80's verificatie na de
// voorstel-#10-executie, bedoeld als herbruikbaar gereedschap voor elke
// volgende upgrade. Bewust GEEN onderdeel van `tests/**/*.ts` (de
// `anchor test`/mocha-glob) - dit is geen localnet-test, het stuurt echte
// devnet-transacties met een echte fee-payer. Handmatig draaien, na een
// `anchor build` die overeenkomt met wat er daadwerkelijk gedeployed is:
//
//   ANCHOR_PROVIDER_URL=<devnet-rpc-url> ANCHOR_WALLET=~/.config/solana/id.json \
//     node_modules/.bin/ts-node --transpile-only scripts/devnetPostUpgradeProof.ts
//
// Maakt telkens een VERSE, willekeurige testwallet aan (generateTestPasskey())
// - bestaande devnet-wallets hebben mogelijk een oudere account-layout; zie
// scripts/checkAllOldWallets.ts en STATUS.md sectie 80 voor waarom die NIET
// zonder meer "schoon falen" tegen een nieuwe layout, in tegenstelling tot
// wat de native cargo-unittests suggereren.
//
// Bijgewerkt na voorstel #11 (STATUS.md sectie 95, B1-B7): twee stappen
// toegevoegd (B3 max-sessieduur, B2 session_epoch/recovery-invalidatie,
// overgenomen uit het wegwerp-bewijs `throwawayB1B7Proof.ts` dat dit al
// tegen een wegwerp-programma-ID had aangetoond) en de oude stap 5 ("een
// bestaande, vóór-upgrade wallet moet SCHOON falen te decoderen") vervangen
// door de TEGENOVERGESTELDE toets: sectie 85's worst-case-analyse
// VOORSPELDE dat alle 14 bestaande wallets nog gewoon decoderen tegen de
// nieuwe layout (in tegenstelling tot sectie 80's #10-bevinding, die een
// LAYOUT-VERGROTING zonder zo'n analyse betrof) - die voorspelling wordt
// hier gemeten, niet aangenomen.
const MAX_SESSION_DURATION_SLOTS = 1_512_000n; // state.rs, moet exact overeenkomen - de letterlijke broncode-constante, geen losstaande aanname

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---------- 1. init_wallet op een verse wallet (korte recovery_timelock_seconds, alleen voor stap 6 hieronder) ----------
  console.log("\n=== 1. init_wallet (verse wallet) ===");
  const passkey = generateTestPasskey();
  const backupAuthority = Keypair.generate();
  const { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);
  console.log("walletPda:", walletPda.toBase58());
  console.log("vaultPda:", vaultPda.toBase58());

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
  const walletAccountInfo = await provider.connection.getAccountInfo(walletPda);
  console.log("walletPda account data length (nieuwe layout):", walletAccountInfo!.data.length);
  results.init_wallet_ok = true;

  // ---------- 2. een passkey-gebonden actie: add_passkey ----------
  console.log("\n=== 2. add_passkey (passkey-gebonden actie) ===");
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

  // ---------- 3. exact dezelfde actie nogmaals, zelfde nonce -> StaleActionNonce ----------
  console.log("\n=== 3. replay: dezelfde add_passkey-poging (zelfde nonce, zelfde handtekening) nogmaals ===");
  let replayOk = false;
  let replayErr = "";
  try {
    const replaySig = await sendFresh([addSecpIx, addIx]);
    replayOk = true;
    console.log("ONVERWACHT: replay slaagde, sig:", replaySig);
  } catch (err: any) {
    replayErr = err?.message ?? String(err);
    console.log("replay geweigerd (verwacht), foutmelding:");
    console.log("  " + replayErr);
  }
  console.log("replay geslaagd (had NIET mogen slagen):", replayOk);
  console.log("bevat 'StaleActionNonce':", replayErr.includes("StaleActionNonce"));
  results.replay_correctly_rejected = !replayOk && replayErr.includes("StaleActionNonce");

  // ---------- 4. B3: sessie met expiry ver voorbij MAX_SESSION_DURATION_SLOTS moet geweigerd worden ----------
  console.log("\n=== 4. B3: MAX_SESSION_DURATION_SLOTS ===");
  const rentExemptVault = await provider.connection.getMinimumBalanceForRentExemption(41);
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: rentExemptVault + 10_000_000 })));
  console.log("vault gefund met 10_000_000 lamports extra (+ rent-exempt minimum)");

  let currentSlot = await provider.connection.getSlot();
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

  // ---------- 5. B2: recovery bumpt session_epoch, oude sessie wordt ongeldig ----------
  console.log("\n=== 5. B2: session_epoch/recovery-invalidatie ===");
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

  await program.methods.finalizeRecovery().accounts({ wallet: walletPda, passkeys: passkeysPda }).rpc();
  console.log("finalize_recovery OK (permissionless, na de timelock)");

  await sleep(800);
  const walletAfterRecovery = await program.account.walletAccount.fetch(walletPda);
  console.log("session_epoch na recovery:", walletAfterRecovery.sessionEpoch.toString(), "(verwacht: 1)");
  results.session_epoch_bumped = walletAfterRecovery.sessionEpoch.toString() === "1";

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

  // ---------- 6. §85: bestaande, vóór-upgrade wallets moeten nog gewoon decoderen (voorspelling meten, niet aannemen) ----------
  console.log("\n=== 6. §85-voorspelling: bestaande WalletAccounts decoderen tegen de nieuwe layout ===");
  const disc = Buffer.from([158, 98, 171, 153, 212, 64, 242, 213]);
  const bs58mod = await import("bs58");
  const bs58 = (bs58mod as any).default ?? bs58mod;
  const existing = await provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  console.log("gevonden bestaande WalletAccount-accounts:", existing.length);
  let decodedCount = 0;
  const decodeFailures: string[] = [];
  for (const { pubkey, account } of existing) {
    try {
      const decoded = await program.account.walletAccount.fetch(pubkey);
      decodedCount++;
      console.log(`  ${pubkey.toBase58()}: OK, dataLen=${account.data.length}, actionNonce=${decoded.actionNonce.toString()}, sessionEpoch=${decoded.sessionEpoch.toString()}`);
    } catch (e: any) {
      decodeFailures.push(pubkey.toBase58());
      console.log(`  ${pubkey.toBase58()}: DECODE GEFAALD - ${(e?.message ?? String(e)).slice(0, 200)}`);
    }
  }
  console.log(`decodeerden zonder fout: ${decodedCount}/${existing.length}`);
  results.all_existing_wallets_still_decode = decodeFailures.length === 0 && existing.length > 0;
  results.existing_wallet_count = existing.length;
  results.existing_wallet_decode_failures = decodeFailures;

  console.log("\n=== SAMENVATTING ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
