import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
} from "./webauthnTestHelper";

const MAX_U64 = new BN("18446744073709551615");

// Externe audit M-2: beweert dat client/src/sessionKeys.ts's
// buildExecuteViaSessionTransaction/buildTransferTokenViaSessionTransaction
// isWritable:false zetten voor de session-PDA (bevestigd via grep, regel
// 429/472), terwijl instructions.rs::ExecuteViaSession/TransferTokenViaSession
// `session` #[account(mut)] declareren EN er daadwerkelijk in schrijven
// (spent_lamports/spent_token_amount, bevestigd gelezen). Dit script isoleert
// de writability-variabele: bouwt een an sich correcte execute_via_session-
// instructie via Anchor's typed builder (zelfde IDL-afgeleide encodering als
// de al-groene bestaande tests, dus GEEN losstaande handmatige
// discriminator/payload-reconstructie nodig), en verstuurt die tweemaal - een
// baseline (ongewijzigd, moet slagen) en een variant waarin ALLEEN de
// session-AccountMeta's isWritable-vlag na het bouwen handmatig naar false is
// gezet, exact wat de productieclient doet.
describe("AUDIT M-2: session-PDA isWritable in execute_via_session", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

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
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, policyPda, walletSeedHash: Array.from(seedHash) };
  }

  function deriveSessionPda(walletPda: PublicKey, sessionKey: PublicKey) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), walletPda.toBuffer(), sessionKey.toBuffer()],
      program.programId
    );
    return sessionPda;
  }

  it("dezelfde instructie slaagt met session isWritable:true, faalt met isWritable:false", async () => {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, policyPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);

    // init_wallet
    const initPayload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
    const initChallenge = buildExpectedChallenge(program.programId, walletPda, "init_wallet", initPayload);
    const initSigned = signTestChallenge(passkey, initChallenge);
    const initSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, initSigned.signedMessage, initSigned.rawSignature);
    await program.methods
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

    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }))
    );

    const sessionKeypair = Keypair.generate();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: sessionKeypair.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }))
    );

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const currentSlot = await provider.connection.getSlot();

    // add_session_key (execute-only scope, ruime limieten - alleen de
    // writability-vraag wordt hier getest, niet de spend-limit-logica).
    const expirySlot = currentSlot + 10000;
    const tokenMintPlaceholder = PublicKey.default;
    const addPayload = Buffer.concat([
      sessionKeypair.publicKey.toBuffer(),
      new BN(expirySlot).toArrayLike(Buffer, "le", 8),
      Buffer.from([1]), // can_execute = true
      Buffer.from([0]), // can_transfer_token = false
      Buffer.from([0]), // can_execute_advanced = false
      Buffer.from([0, 0, 0, 0]), // allowed_programs vec len = 0
      MAX_U64.toArrayLike(Buffer, "le", 8),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      tokenMintPlaceholder.toBuffer(),
      new BN(0).toArrayLike(Buffer, "le", 8),
      new BN(0).toArrayLike(Buffer, "le", 8),
    ]);
    const addChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", addPayload);
    const addSigned = signTestChallenge(passkey, addChallenge);
    const addSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, addSigned.signedMessage, addSigned.rawSignature);

    await program.methods
      .addSessionKey(
        sessionKeypair.publicKey,
        new BN(expirySlot),
        true,
        false,
        false,
        [],
        MAX_U64,
        MAX_U64,
        tokenMintPlaceholder,
        new BN(0),
        new BN(0),
        addSigned.clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        session: sessionPda,
        payer: provider.wallet.publicKey,
        policy: policyPda,
        passkeys: PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], program.programId)[0],
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([addSecpIx])
      .rpc();

    // Al gefund (provider.wallet) i.p.v. een vers 0-balans-account - anders
    // faalt zelfs de correcte baseline op Solana's rent-exemption-invariant
    // (elk geraakt account moet op 0 of >= rent-exempt eindigen), los van de
    // writability-vraag die dit script wil isoleren.
    const recipient = provider.wallet.publicKey;
    const amount = new BN(1000);

    // Bouw de execute_via_session-instructie via Anchor's TYPED builder (dus
    // met AUTOMATISCH correcte writability, afgeleid uit de IDL/#[account(mut)]
    // annotatie) - dit is de baseline.
    const correctIx = await program.methods
      .executeViaSession(amount)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        recipient,
        session: sessionPda,
        sessionKey: sessionKeypair.publicKey,
      })
      .instruction();

    const sessionMetaIndex = correctIx.keys.findIndex((k) => k.pubkey.equals(sessionPda));
    assert.isAbove(sessionMetaIndex, -1, "session-account-meta niet gevonden in de Anchor-gebouwde instructie");
    assert.isTrue(
      correctIx.keys[sessionMetaIndex].isWritable,
      "baseline-aanname geschonden: Anchor's eigen builder zet session zelf al niet-writable - test-opzet ongeldig"
    );

    // --- Poging 1: baseline, ongewijzigd (writable:true) - moet slagen. ---
    const baselineTx = new Transaction().add(correctIx);
    baselineTx.feePayer = sessionKeypair.publicKey;
    baselineTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    baselineTx.sign(sessionKeypair);

    let baselineErr: string | null = null;
    try {
      await provider.connection.sendRawTransaction(baselineTx.serialize());
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err: any) {
      baselineErr = err?.message ?? String(err);
    }

    const sessionAfterBaseline = await program.account.sessionKeyAccount.fetch(sessionPda);

    // --- Poging 2: EXACT zoals de productieclient - session isWritable:false. ---
    const brokenIx = await program.methods
      .executeViaSession(amount)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        recipient,
        session: sessionPda,
        sessionKey: sessionKeypair.publicKey,
      })
      .instruction();
    const brokenSessionMetaIndex = brokenIx.keys.findIndex((k) => k.pubkey.equals(sessionPda));
    brokenIx.keys[brokenSessionMetaIndex] = {
      ...brokenIx.keys[brokenSessionMetaIndex],
      isWritable: false,
    };

    const brokenTx = new Transaction().add(brokenIx);
    brokenTx.feePayer = sessionKeypair.publicKey;
    brokenTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    brokenTx.sign(sessionKeypair);

    let brokenOk = false;
    let brokenErr: string | null = null;
    try {
      const sig = await provider.connection.sendRawTransaction(brokenTx.serialize());
      await provider.connection.confirmTransaction(sig, "confirmed");
      brokenOk = true;
    } catch (err: any) {
      brokenErr = err?.message ?? String(err);
      if (err?.logs) brokenErr += " | logs: " + JSON.stringify(err.logs);
    }

    console.log("M-2 resultaat:", {
      baselineSpentLamportsAfter: sessionAfterBaseline.spentLamports.toString(),
      baselineErr,
      brokenOk,
      brokenErr,
    });

    assert.equal(
      sessionAfterBaseline.spentLamports.toNumber(),
      1000,
      "baseline (writable:true, zoals Anchor het zelf bouwt) had moeten slagen en spent_lamports moeten bijwerken"
    );

    if (brokenOk) {
      assert.fail(
        "M-2 WEERLEGD: instructie met session isWritable:false (zoals de productieclient) slaagde toch on-chain - de audit-claim klopt dan NIET zoals verwacht, nader onderzoek nodig."
      );
    } else {
      // Dit is het verwachte pad als de audit-claim klopt: de runtime moet
      // deze instructie weigeren omdat het programma probeert te schrijven
      // naar een account dat de transactie zelf als niet-writable aanmerkt.
      assert.isNotNull(brokenErr);
    }
  });
});
