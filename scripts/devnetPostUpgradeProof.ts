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
  TestPasskey,
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
async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  console.log("RPC endpoint:", (provider.connection as any)._rpcEndpoint);
  console.log("program ID (uit IDL):", program.programId.toBase58());
  console.log("fee-payer:", provider.wallet.publicKey.toBase58());

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), seedHash],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), walletPda.toBuffer()],
      program.programId
    );
    const [passkeysPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("passkeys"), walletPda.toBuffer()],
      program.programId
    );
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash: Array.from(seedHash) };
  }

  function deriveSessionPda(walletPda: PublicKey, sessionKey: PublicKey) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), walletPda.toBuffer(), sessionKey.toBuffer()],
      program.programId
    );
    return sessionPda;
  }

  // ---------- 1. init_wallet op een verse wallet ----------
  console.log("\n=== 1. init_wallet (verse wallet) ===");
  const passkey = generateTestPasskey();
  const backupAuthority = Keypair.generate();
  const { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash } = derivePdas(
    passkey.compressedPublicKey
  );
  console.log("walletPda:", walletPda.toBase58());
  console.log("vaultPda:", vaultPda.toBase58());

  const initPayload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
  const initChallenge = buildExpectedChallenge(program.programId, walletPda, "init_wallet", initPayload);
  const initSigned = signTestChallenge(passkey, initChallenge);
  const initSecpIx = buildSecp256r1Instruction(
    passkey.compressedPublicKey,
    initSigned.signedMessage,
    initSigned.rawSignature
  );

  const initSig = await program.methods
    .initWallet(Array.from(passkey.compressedPublicKey), walletSeedHash, backupAuthority.publicKey, null, initSigned.clientDataJSON)
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
  const nonceAfterInit = await fetchActionNonce(provider.connection, walletPda);
  console.log("action_nonce na init_wallet:", nonceAfterInit.toString());

  // ---------- 2. een passkey-gebonden actie: add_passkey ----------
  console.log("\n=== 2. add_passkey (passkey-gebonden actie) ===");
  const extraPasskey = generateTestPasskey();
  const nonceForAdd = await fetchActionNonce(provider.connection, walletPda);
  const addPayload = Buffer.concat([nonceLeBytes(nonceForAdd), extraPasskey.compressedPublicKey]);
  const addChallenge = buildExpectedChallenge(program.programId, walletPda, "add_passkey", addPayload);
  const addSigned = signTestChallenge(passkey, addChallenge);
  const addSecpIx = buildSecp256r1Instruction(
    passkey.compressedPublicKey,
    addSigned.signedMessage,
    addSigned.rawSignature
  );
  const addIx = await program.methods
    .addPasskey(Array.from(extraPasskey.compressedPublicKey), new BN(nonceForAdd.toString()), addSigned.clientDataJSON)
    .accounts({
      wallet: walletPda,
      passkeys: passkeysPda,
      payer: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  async function sendFresh(instructions: anchor.web3.TransactionInstruction[]) {
    const tx = new Transaction().add(...instructions);
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash("finalized")).blockhash;
    const signed = await (provider.wallet as anchor.Wallet).signTransaction(tx);
    const sig = await provider.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await provider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  const addSig = await sendFresh([addSecpIx, addIx]);
  console.log("add_passkey OK, sig:", addSig);
  const nonceAfterAdd = await fetchActionNonce(provider.connection, walletPda);
  console.log("action_nonce na add_passkey:", nonceAfterAdd.toString(), "(verwacht:", (nonceForAdd + 1n).toString() + ")");

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

  // ---------- 4. spend-limit: add_session_key met kleine cap + execute_via_session ----------
  console.log("\n=== 4. spend-limit (add_session_key + execute_via_session) ===");
  const rentExemptVault = await provider.connection.getMinimumBalanceForRentExemption(41);
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: vaultPda,
        lamports: rentExemptVault + 10_000_000,
      })
    )
  );
  console.log("vault gefund met 10_000_000 lamports extra (+ rent-exempt minimum)");

  const sessionKeypair = Keypair.generate();
  const currentSlot = await provider.connection.getSlot();
  const expirySlot = currentSlot + 1000;
  const MAX_U64 = new BN("18446744073709551615");
  // Ruim boven Solana's rent-exempt-minimum voor een verse 0-byte ontvanger
  // (~890_880 lamports) - anders faalt zelfs een binnen-de-cap-transfer op
  // de "insufficient funds for rent"-invariant van de runtime, los van de
  // spend-limit-logica die deze stap juist wil bewijzen.
  const maxLamportsPerTx = new BN(2_000_000);
  const maxLamportsTotal = new BN(10_000_000);

  const nonceForSession = await fetchActionNonce(provider.connection, walletPda);
  const sessionPayloadRaw = Buffer.concat([
    sessionKeypair.publicKey.toBuffer(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(expirySlot), 0); return b; })(),
    Buffer.from([1, 0, 0]), // canExecute=true, canTransferToken=false, canExecuteAdvanced=false
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(), // 0 sub-scope programs
    maxLamportsPerTx.toArrayLike(Buffer, "le", 8),
    maxLamportsTotal.toArrayLike(Buffer, "le", 8),
    PublicKey.default.toBuffer(),
    new BN(0).toArrayLike(Buffer, "le", 8),
    new BN(0).toArrayLike(Buffer, "le", 8),
  ]);
  const sessionPayload = Buffer.concat([nonceLeBytes(nonceForSession), sessionPayloadRaw]);
  const sessionChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", sessionPayload);
  const sessionSigned = signTestChallenge(passkey, sessionChallenge);
  const sessionSecpIx = buildSecp256r1Instruction(
    passkey.compressedPublicKey,
    sessionSigned.signedMessage,
    sessionSigned.rawSignature
  );
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  const addSessionSig = await program.methods
    .addSessionKey(
      sessionKeypair.publicKey,
      new BN(expirySlot),
      true,
      false,
      false,
      [],
      maxLamportsPerTx,
      maxLamportsTotal,
      PublicKey.default,
      new BN(0),
      new BN(0),
      new BN(nonceForSession.toString()),
      sessionSigned.clientDataJSON
    )
    .accounts({
      wallet: walletPda,
      session: sessionPda,
      payer: provider.wallet.publicKey,
      policy: policyPda,
      passkeys: passkeysPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([sessionSecpIx])
    .rpc();
  console.log("add_session_key OK, sig:", addSessionSig, "cap: maxLamportsPerTx=500_000, maxLamportsTotal=10_000_000");

  // binnen de cap: moet slagen
  const recipientWithin = Keypair.generate().publicKey;
  const withinSig = await program.methods
    .executeViaSession(new BN(1_500_000))
    .accounts({
      wallet: walletPda,
      vault: vaultPda,
      recipient: recipientWithin,
      session: sessionPda,
      sessionKey: sessionKeypair.publicKey,
    })
    .signers([sessionKeypair])
    .rpc();
  const recipientBalance = await provider.connection.getBalance(recipientWithin);
  console.log("execute_via_session(1_500_000) binnen cap: OK, sig:", withinSig, "ontvanger-balans:", recipientBalance);

  // boven de cap: moet falen met SessionSpendPerTxExceeded
  let overCapOk = false;
  let overCapErr = "";
  try {
    await program.methods
      .executeViaSession(new BN(2_000_001))
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        recipient: Keypair.generate().publicKey,
        session: sessionPda,
        sessionKey: sessionKeypair.publicKey,
      })
      .signers([sessionKeypair])
      .rpc();
    overCapOk = true;
  } catch (err: any) {
    overCapErr = err?.message ?? String(err);
  }
  console.log("execute_via_session(2_000_001) boven cap geslaagd (had NIET mogen slagen):", overCapOk);
  console.log("foutmelding:", overCapErr);
  console.log("bevat 'SessionSpendPerTxExceeded':", overCapErr.includes("SessionSpendPerTxExceeded"));

  const sessionAfter = await program.account.sessionKeyAccount.fetch(sessionPda);
  console.log("session.spentLamports na beide pogingen:", sessionAfter.spentLamports.toString(), "(verwacht: 1500000, dus de mislukte poging telde niet mee)");

  // ---------- 5. bestaande, vóór-upgrade wallet: schone deserialisatiefout ----------
  console.log("\n=== 5. bestaande pre-upgrade wallet: moet SCHOON falen, niet half werken ===");
  const disc = Buffer.from([158, 98, 171, 153, 212, 64, 242, 213]);
  const bs58mod = await import("bs58");
  const bs58 = (bs58mod as any).default ?? bs58mod;
  const existing = await provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  console.log("gevonden bestaande WalletAccount-accounts (alle van vóór deze upgrade):", existing.length);
  const sample = existing[0];
  console.log("voorbeeld pubkey:", sample.pubkey.toBase58(), "data length:", sample.account.data.length);

  let decodeOk = false;
  let decodeErr = "";
  try {
    const decoded = await program.account.walletAccount.fetch(sample.pubkey);
    decodeOk = true;
    console.log("ONVERWACHT: decodering slaagde:", JSON.stringify(decoded));
  } catch (err: any) {
    decodeErr = err?.message ?? String(err);
    console.log("decodering geweigerd (verwacht), foutmelding:");
    console.log("  " + decodeErr);
  }
  console.log("decodering geslaagd (had NIET mogen slagen):", decodeOk);

  console.log("\n=== SAMENVATTING ===");
  console.log(JSON.stringify({
    init_wallet_ok: true,
    add_passkey_ok: true,
    replay_correctly_rejected: !replayOk && replayErr.includes("StaleActionNonce"),
    spend_within_cap_ok: recipientBalance === 1_500_000,
    spend_over_cap_correctly_rejected: !overCapOk && overCapErr.includes("SessionSpendPerTxExceeded"),
    old_wallet_decode_correctly_rejected: !decodeOk,
  }, null, 2));
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
