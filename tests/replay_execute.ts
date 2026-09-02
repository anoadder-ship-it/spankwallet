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
  fetchActionNonce,
  nonceLeBytes,
} from "./webauthnTestHelper";

// Permanente regressietest voor de C-1-fix (STATUS.md sectie 69, externe
// audit): oorspronkelijk bewees dit script het LEK (dezelfde execute()-
// handtekening werd een tweede keer geaccepteerd in een nieuwe transactie,
// vault liep tweemaal leeg). Na de action_nonce-fix moet exact hetzelfde
// scenario nu andersom uitpakken: de eerste poging slaagt zoals altijd, de
// TWEEDE (dezelfde, inmiddels verouderde handtekening) moet geweigerd worden
// omdat de challenge de nonce bindt en die na de eerste poging al is
// opgehoogd - vault-balans mag na de tweede poging niet verder gedaald zijn.
describe("REPLAY-AUDIT: execute() challenge-replay (C-1, action_nonce-fix)", () => {
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
    const [passkeysPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("passkeys"), walletPda.toBuffer()],
      program.programId
    );
    // STATUS.md sectie 132/133 (stap B): SpendWindow-PDA, execute vereist
    // dit account nu in de accountlijst (nog niet gelezen/geschreven, dat
    // is stap c).
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, spendWindowPda, walletSeedHash: Array.from(seedHash) };
  }

  it("een eenmaal geldige execute-handtekening wordt geweigerd bij een tweede poging in een nieuwe transactie", async () => {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, spendWindowPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );

    // 1. init_wallet (echte handtekening vereist, zie STATUS.md sectie 22)
    const initPayload = Buffer.concat([
      backupAuthority.publicKey.toBuffer(),
      encodeOptionalI64(null),
    ]);
    const initChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "init_wallet",
      initPayload
    );
    const initSigned = signTestChallenge(passkey, initChallenge);
    const initSecpIx = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      initSigned.signedMessage,
      initSigned.rawSignature
    );
    await program.methods
      .initWallet(
        Array.from(passkey.compressedPublicKey),
        walletSeedHash,
        backupAuthority.publicKey,
        null,
        initSigned.clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([initSecpIx])
      .rpc();

    // 2. Vault ruim funden zodat een tweede (per ongeluk geslaagde) transfer
    // ook boven de rent-exempt-drempel zou blijven - test moet vals falen op
    // een rent-fout uitsluiten, niet op de nonce-check zelf leunen om dat te
    // maskeren.
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: vaultPda,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx);

    const recipient = Keypair.generate().publicKey;
    const amount = new BN(0.1 * LAMPORTS_PER_SOL);

    // 3. EENMALIG een geldige execute-handtekening produceren, met de op dat
    // moment actuele action_nonce (0, verse wallet) mee ondertekend.
    const nonceAtSigningTime = await fetchActionNonce(provider.connection, walletPda);
    const execPayload = Buffer.concat([
      nonceLeBytes(nonceAtSigningTime),
      recipient.toBuffer(),
      Buffer.from(amount.toArray("le", 8)),
    ]);
    const execChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "execute",
      execPayload
    );
    const execSigned = signTestChallenge(passkey, execChallenge);
    const execSecpIx = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      execSigned.signedMessage,
      execSigned.rawSignature
    );

    const balanceBefore = await provider.connection.getBalance(vaultPda);

    // Kleine helper die EXACT dezelfde precompile-ix + dezelfde execute-args
    // (inclusief dezelfde clientDataJSON/signature/nonce-argument) in een
    // VERSE transactie verstuurt (nieuwe recentBlockhash, apart getekend
    // door de fee-payer) - dit simuleert een aanvaller die de vorige,
    // publiek zichtbare on-chain-transactie kopieert en opnieuw indient.
    async function sendExecuteAttempt(): Promise<{ ok: boolean; err?: string }> {
      try {
        await program.methods
          .execute(amount, new BN(nonceAtSigningTime.toString()), execSigned.clientDataJSON)
          .accounts({
            wallet: walletPda,
            vault: vaultPda,
            spendWindow: spendWindowPda,
            recipient,
            passkeys: passkeysPda,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .preInstructions([execSecpIx])
          .rpc({ skipPreflight: false });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, err: err?.message ?? String(err) };
      }
    }

    const first = await sendExecuteAttempt();
    assert.isTrue(first.ok, `eerste execute had moeten slagen, kreeg: ${first.err}`);

    const balanceAfterFirst = await provider.connection.getBalance(vaultPda);
    assert.equal(
      balanceBefore - balanceAfterFirst,
      amount.toNumber(),
      "eerste execute had de vault met exact `amount` moeten legen"
    );

    const nonceAfterFirst = await fetchActionNonce(provider.connection, walletPda);
    assert.equal(
      nonceAfterFirst,
      nonceAtSigningTime + 1n,
      "action_nonce had na de eerste geslaagde execute precies met 1 moeten ophogen"
    );

    // 4. DEZELFDE handtekening/clientDataJSON/nonce-argument, TWEEDE keer,
    // NIEUWE transactie - moet nu geweigerd worden (StaleActionNonce/
    // WebAuthnChallengeMismatch), de vault mag niet nogmaals gedaald zijn.
    const second = await sendExecuteAttempt();

    const balanceAfterSecond = await provider.connection.getBalance(vaultPda);

    console.log("REPLAY-AUDIT (post-fix) resultaat:", {
      eersteOk: first.ok,
      tweedeOk: second.ok,
      tweedeErr: second.err,
      vaultVoor: balanceBefore,
      vaultNaEerste: balanceAfterFirst,
      vaultNaTweede: balanceAfterSecond,
    });

    assert.isFalse(
      second.ok,
      "C-1-REGRESSIE: dezelfde execute-handtekening werd een TWEEDE keer geaccepteerd - de action_nonce-fix beschermt niet (meer)."
    );
    assert.equal(
      balanceAfterSecond,
      balanceAfterFirst,
      "vaultbalans had na de geweigerde tweede poging ongewijzigd moeten blijven"
    );
  });
});
