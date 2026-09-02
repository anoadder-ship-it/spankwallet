import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
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
  TestPasskey,
} from "./webauthnTestHelper";

// C-1-fix (STATUS.md sectie 69): mechanica-tests voor de action_nonce zelf,
// los van de replay-regressietest (replay_execute.ts) - bewijst de bredere
// eigenschappen die het ontwerpplan vastlegde: monotone ophoging, een
// duidelijke StaleActionNonce-weigering (niet alleen een generieke
// WebAuthnChallengeMismatch) op meerdere instructie-categorieën, en de
// optimistic-concurrency-semantiek bij twee races op dezelfde startnonce.
describe("C-1-fix: action_nonce mechanica", () => {
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
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), walletPda.toBuffer()],
      program.programId
    );
    // STATUS.md sectie 132/133 (stap B): SpendWindow-PDA, execute vereist
    // dit account nu in de accountlijst (nog niet gelezen/geschreven, dat
    // is stap c).
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    return {
      walletPda,
      vaultPda,
      passkeysPda,
      policyPda,
      spendWindowPda,
      walletSeedHash: Array.from(seedHash),
    };
  }

  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, policyPda, spendWindowPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );

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

    return { passkey, walletPda, vaultPda, passkeysPda, policyPda, spendWindowPda };
  }

  async function callAddPasskey(passkey: TestPasskey, walletPda: PublicKey, passkeysPda: PublicKey, newPasskeyBytes: Buffer, nonceOverride?: bigint) {
    const nonce = nonceOverride ?? (await fetchActionNonce(provider.connection, walletPda));
    const payload = Buffer.concat([nonceLeBytes(nonce), newPasskeyBytes]);
    const challenge = buildExpectedChallenge(program.programId, walletPda, "add_passkey", payload);
    const signed = signTestChallenge(passkey, challenge);
    const secpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, signed.signedMessage, signed.rawSignature);
    return program.methods
      .addPasskey(Array.from(newPasskeyBytes), new BN(nonce.toString()), signed.clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secpIx])
      .rpc();
  }

  async function callRemovePasskey(passkey: TestPasskey, walletPda: PublicKey, passkeysPda: PublicKey, targetPasskeyBytes: Buffer) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), targetPasskeyBytes]);
    const challenge = buildExpectedChallenge(program.programId, walletPda, "remove_passkey", payload);
    const signed = signTestChallenge(passkey, challenge);
    const secpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, signed.signedMessage, signed.rawSignature);
    return program.methods
      .removePasskey(Array.from(targetPasskeyBytes), new BN(nonce.toString()), signed.clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secpIx])
      .rpc();
  }

  async function buildExecuteTx(
    passkey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    passkeysPda: PublicKey,
    recipient: PublicKey,
    amount: BN,
    nonceOverride?: bigint
  ) {
    const nonce = nonceOverride ?? (await fetchActionNonce(provider.connection, walletPda));
    const payload = Buffer.concat([nonceLeBytes(nonce), recipient.toBuffer(), Buffer.from(amount.toArray("le", 8))]);
    const challenge = buildExpectedChallenge(program.programId, walletPda, "execute", payload);
    const signed = signTestChallenge(passkey, challenge);
    const secpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, signed.signedMessage, signed.rawSignature);
    // STATUS.md sectie 132/133 (stap B): SpendWindow, nog niet
    // gelezen/geschreven (stap c) - moet wel al meegestuurd worden.
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    const ix = await program.methods
      .execute(amount, new BN(nonce.toString()), signed.clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        spendWindow: spendWindowPda,
        recipient,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const tx = new Transaction().add(secpIx, ix);
    return { tx, nonceUsed: nonce };
  }

  async function sendTx(tx: Transaction): Promise<{ ok: boolean; err?: string }> {
    try {
      tx.feePayer = provider.wallet.publicKey;
      tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
      const signed = await (provider.wallet as anchor.Wallet).signTransaction(tx);
      const sig = await provider.connection.sendRawTransaction(signed.serialize());
      await provider.connection.confirmTransaction(sig, "confirmed");
      return { ok: true };
    } catch (err: any) {
      return { ok: false, err: err?.message ?? String(err) };
    }
  }

  it("action_nonce hoogt precies met 1 op per geslaagde challenge-instructie", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    assert.equal(await fetchActionNonce(provider.connection, walletPda), 0n);

    const extra = generateTestPasskey();
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    assert.equal(await fetchActionNonce(provider.connection, walletPda), 1n);

    await callRemovePasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    assert.equal(await fetchActionNonce(provider.connection, walletPda), 2n);
  });

  it("een verouderde action_nonce wordt geweigerd (StaleActionNonce), de actuele nonce slaagt - execute", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }))
    );
    // Al gefund (provider.wallet) i.p.v. een vers 0-balans-account - anders
    // faalt zelfs de correcte poging op Solana's rent-exemption-invariant,
    // los van de nonce-check die deze test wil isoleren.
    const recipient = provider.wallet.publicKey;

    // Ondertekend met een nonce die niet de actuele (0) is.
    const { tx: staleTx } = await buildExecuteTx(passkey, walletPda, vaultPda, passkeysPda, recipient, new BN(1000), 5n);
    const staleResult = await sendTx(staleTx);
    assert.isFalse(staleResult.ok, "execute met verouderde action_nonce had moeten falen");
    assert.include(staleResult.err ?? "", "StaleActionNonce", "had specifiek StaleActionNonce moeten teruggeven, niet een generieke fout");

    const { tx: freshTx } = await buildExecuteTx(passkey, walletPda, vaultPda, passkeysPda, recipient, new BN(1000));
    const freshResult = await sendTx(freshTx);
    assert.isTrue(freshResult.ok, `execute met de actuele action_nonce had moeten slagen, kreeg: ${freshResult.err}`);
  });

  it("een verouderde action_nonce wordt geweigerd (StaleActionNonce), de actuele nonce slaagt - add_passkey (administratieve categorie)", async () => {
    const { passkey, walletPda, passkeysPda } = await createWallet();
    const extra = generateTestPasskey();

    let threw = false;
    let errMsg = "";
    try {
      await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey, 7n);
    } catch (err: any) {
      threw = true;
      errMsg = err?.message ?? String(err);
    }
    assert.isTrue(threw, "add_passkey met verouderde action_nonce had moeten falen");
    assert.include(errMsg, "StaleActionNonce");

    // Actuele nonce (0) slaagt gewoon.
    await callAddPasskey(passkey, walletPda, passkeysPda, extra.compressedPublicKey);
    const passkeys = await program.account.passkeysAccount.fetch(passkeysPda);
    assert.equal(passkeys.count, 1);
  });

  // STATUS.md sectie 131 (vervolg op sectie 115/127-130): execute_advanced
  // is permanent geblokkeerd voor directe aanroep sinds die sectie - de
  // stale-nonce-test die hier stond (execute_advanced) is verplaatst naar
  // tests/pendingAction.ts's kind=2-blok, tegen initiate_advanced_action
  // (dezelfde gedeelde check_current_action_nonce, nu bewezen op de
  // aanroeper die nog wél bestaat) plus een volledige finalize om de
  // "CPI echt uitgevoerd"-claim van de oorspronkelijke test te behouden -
  // dat laatste vereist de fast-timelock-feature, vandaar de verhuizing
  // naar yarn test:pending-action i.p.v. een herschrijving hier in yarn
  // test's timelockvrije bestand.

  it("concurrency: twee geldige handtekeningen op dezelfde startnonce - eerste wint, tweede wordt netjes geweigerd", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }))
    );

    const startNonce = await fetchActionNonce(provider.connection, walletPda);
    const recipientA = Keypair.generate().publicKey;
    const recipientB = Keypair.generate().publicKey;

    // Bedrag boven de rent-exempt-drempel voor een vers 0-balans-account
    // (anders faalt zelfs de winnende poging op Solana's rent-invariant, los
    // van de concurrency-vraag die deze test wil isoleren).
    const amount = new BN(1_000_000);

    // Twee ONAFHANKELIJK geldige, verschillende acties (andere ontvanger),
    // BEIDE ondertekend tegen dezelfde startnonce - modelleert twee
    // apparaten/tabbladen die tegelijk een actie voorbereiden, niet zomaar
    // dezelfde bytes kopiëren.
    const { tx: txA } = await buildExecuteTx(passkey, walletPda, vaultPda, passkeysPda, recipientA, amount, startNonce);
    const { tx: txB } = await buildExecuteTx(passkey, walletPda, vaultPda, passkeysPda, recipientB, amount, startNonce);

    const resultA = await sendTx(txA);
    assert.isTrue(resultA.ok, `eerste (winnende) actie had moeten slagen: ${resultA.err}`);
    assert.equal(await fetchActionNonce(provider.connection, walletPda), startNonce + 1n);

    const resultB = await sendTx(txB);
    assert.isFalse(resultB.ok, "tweede actie op dezelfde (inmiddels verouderde) startnonce had moeten falen");
    assert.include(resultB.err ?? "", "StaleActionNonce", "had specifiek StaleActionNonce moeten teruggeven, niet een cryptische generieke fout");

    const recipientBBalance = await provider.connection.getBalance(recipientB);
    assert.equal(recipientBBalance, 0, "de verliezende actie mag geen enkel effect gehad hebben");
  });
});
