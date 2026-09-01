// pendingAction.ts — STATUS.md sectie 124 (stap 6): echte tests tegen een
// levende validator voor alle vier de PendingAction-kinds
// (SolWithdrawal/TokenTransfer/AdvancedAction/ThresholdChange), sectie 115/
// 118/120/122/123's ontwerp/implementatie. Tot nu toe was alleen bewezen dat
// de code compileert - dit bestand bewijst dat initiate_*/finalize_*/
// cancel_action daadwerkelijk doen wat sectie 115 beweert, tegen een echte
// solana-test-validator, geen surfpool/mock.
//
// VEREIST de test-fast-pending-timelock Cargo-feature (verkort
// PENDING_ACTION_TIMELOCK_SECONDS van 24u naar 3s, zie instructions.rs/
// Cargo.toml) - zonder die feature zou elke finalize_*-test 24 echte uren
// moeten wachten (een echte solana-test-validator-klok is niet sneller te
// warpen dan echte tijd, zie STATUS.md sectie 124 voor de volledige
// afweging). Draai deze suite daarom UITSLUITEND via:
//     yarn test:pending-action
// nooit via het gewone `yarn test` (dat blijft bouwen tegen de echte
// 24u-constante, precies zoals productie). De guard hieronder (before-hook)
// bewijst dat zelf: een poging om dit bestand op een andere manier te
// draaien skipt zichtbaar, i.p.v. 24 uur te hangen of onduidelijk te falen.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
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
  advanceOnChainClockPast,
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
} from "./webauthnTestHelper";

// Moet overeenkomen met de `test-fast-pending-timelock`-variant van
// PENDING_ACTION_TIMELOCK_SECONDS in instructions.rs (3 seconden) - zie
// Cargo.toml/instructions.rs voor de niet-testvariant (24u, ongewijzigd).
const FAST_TIMELOCK_SECONDS = 3;

// Zelfde native SPL-Token-byte-lay-outs als tests/policy.ts/transferToken.ts
// (bewust gedupliceerd, zelfde per-bestand-onafhankelijkheidsconventie als
// de rest van deze testsuite - geen gedeelde testmodule).
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

function encodeInitializeMintIx(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(0, 0);
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function encodeInitializeAccountIx(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function encodeMintToIx(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: number
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function readTokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

interface RemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

describe("spankwallet: PendingAction - initiate/finalize/cancel voor alle vier kinds (STATUS.md sectie 124)", function () {
  // --- Guard: deze hele suite vereist de fast-timelock-testbuild ---
  before(function () {
    if (process.env.PENDING_ACTION_FAST_TIMELOCK !== "1") {
      // eslint-disable-next-line no-console
      console.warn(
        "\n    [pendingAction.ts] OVERGESLAGEN (geen finalize_*-test gedraaid):\n" +
          "    deze suite vereist de verkorte testtimelock (Cargo-feature\n" +
          "    test-fast-pending-timelock, PENDING_ACTION_TIMELOCK_SECONDS=3s\n" +
          "    i.p.v. de echte 24u). Draai 'yarn test:pending-action' om deze\n" +
          "    suite daadwerkelijk uit te voeren - 'yarn test' bouwt bewust\n" +
          "    tegen de echte 24u-constante en zou hier 24 uur op vastlopen.\n"
      );
      this.skip();
    }
  });

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
    const [pendingActionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_action"), walletPda.toBuffer()],
      program.programId
    );
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    return {
      walletPda,
      vaultPda,
      passkeysPda,
      policyPda,
      pendingActionPda,
      spendWindowPda,
      walletSeedHash: Array.from(seedHash),
    };
  }

  async function createWallet(recoveryTimelockSeconds?: number) {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const pdas = derivePdas(passkey.compressedPublicKey);
    const recoveryTimelock =
      recoveryTimelockSeconds != null ? new BN(recoveryTimelockSeconds) : null;

    const payload = Buffer.concat([
      backupAuthority.publicKey.toBuffer(),
      encodeOptionalI64(recoveryTimelock ? recoveryTimelock.toNumber() : null),
    ]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      pdas.walletPda,
      "init_wallet",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    await program.methods
      .initWallet(
        Array.from(passkey.compressedPublicKey),
        pdas.walletSeedHash,
        backupAuthority.publicKey,
        recoveryTimelock,
        clientDataJSON
      )
      .accounts({
        wallet: pdas.walletPda,
        vault: pdas.vaultPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();

    // Elke wallet krijgt hier meteen wat SOL, zodat een echte-opname-happy-
    // path (finalize_withdrawal) daadwerkelijk lamports heeft om te
    // verplaatsen - permissionless funden van de vault-PDA, zelfde principe
    // als execute's eigen commentaar hierover.
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: pdas.vaultPda,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );

    return { passkey, backupAuthority, ...pdas };
  }

  async function callAddPasskey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    newPasskeyBytes: Buffer
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), newPasskeyBytes]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_passkey",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .addPasskey(Array.from(newPasskeyBytes), new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callAddAllowedProgram(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    targetProgramId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), targetProgramId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_allowed_program",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .addAllowedProgram(targetProgramId, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callRemoveAllowedProgram(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    targetProgramId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), targetProgramId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_allowed_program",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .removeAllowedProgram(targetProgramId, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // --- initiate_recovery/finalize_recovery (voor testpunt 5, kind-agnostisch) ---
  function dummyNewOwnerPasskey(): number[] {
    const bytes = Buffer.from(generateTestPasskey().compressedPublicKey);
    return Array.from(bytes);
  }

  async function callInitiateRecovery(
    backupAuthority: Keypair,
    walletPda: PublicKey,
    newOwnerPasskey: number[]
  ) {
    return program.methods
      .initiateRecovery(newOwnerPasskey)
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();
  }

  async function callFinalizeRecovery(walletPda: PublicKey, passkeysPda: PublicKey) {
    return program.methods
      .finalizeRecovery()
      .accounts({ wallet: walletPda, passkeys: passkeysPda })
      .rpc();
  }

  // ================= SolWithdrawal (kind=0) =================

  async function callInitiateWithdrawal(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    recipient: PublicKey,
    amount: BN
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      recipient.toBuffer(),
      amount.toArrayLike(Buffer, "le", 8),
    ]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "initiate_withdrawal",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .initiateWithdrawal(recipient, amount, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callFinalizeWithdrawal(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    recipient: PublicKey,
    amount: BN,
    closer: PublicKey = provider.wallet.publicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    // commitment wordt hier NIET onafhankelijk herberekend (dat is precies
    // wat instructions.rs zelf doet en verifieert) - de payload-vorm hier is
    // puur "wat de client tekent", de daadwerkelijke correctheidscontrole
    // gebeurt on-chain.
    const pendingAction = await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = Buffer.from(pendingAction.actionCommitment);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "finalize_withdrawal",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .finalizeWithdrawal(amount, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        pendingAction: pendingActionPda,
        recipient,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callCancelAction(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    payer: PublicKey = provider.wallet.publicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "cancel_action",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .cancelAction(new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function expectAnchorError(promise: Promise<unknown>, errorCode: string) {
    try {
      await promise;
    } catch (err: any) {
      const code = err?.error?.errorCode?.code ?? err?.errorCode?.code ?? String(err);
      assert.include(String(code) + String(err?.message ?? ""), errorCode, `verwachtte ${errorCode}, kreeg: ${err}`);
      return;
    }
    assert.fail(`had moeten falen met ${errorCode}, maar slaagde`);
  }

  describe("kind=0 SolWithdrawal (initiate_withdrawal/finalize_withdrawal)", () => {
    it("1. happy path (single passkey): opname verplaatst lamports en sluit de PendingAction-PDA", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);

      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      // 2. single-passkey-degradatie: confirmed moet al true zijn na initiate.
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      assert.isTrue(pendingAfterInitiate.confirmed, "confirmed had na initiate met 1 passkey al true moeten zijn");
      assert.equal(pendingAfterInitiate.kind, 0);

      const vaultBefore = await provider.connection.getBalance(vaultPda);

      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeWithdrawal(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        recipient,
        amount
      );

      const recipientBalance = await provider.connection.getBalance(recipient);
      assert.equal(recipientBalance, amount.toNumber());
      const vaultAfter = await provider.connection.getBalance(vaultPda);
      assert.equal(vaultBefore - vaultAfter, amount.toNumber());

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na finalize");
    });

    it("3. two-of-two-afdwinging: finalize met dezelfde passkey als initiate faalt, met een andere passkey slaagt", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const secondPasskey = generateTestPasskey();
      await callAddPasskey(passkey, walletPda, passkeysPda, secondPasskey.compressedPublicKey);

      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      assert.isFalse(
        pendingAfterInitiate.confirmed,
        "confirmed had FALSE moeten zijn - er bestonden al 2 geldige passkeys bij initiate"
      );

      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, amount),
        "SecondPasskeyMustDifferFromInitiator"
      );

      // Met de ANDERE passkey moet het gewoon slagen.
      await callFinalizeWithdrawal(
        secondPasskey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        recipient,
        amount
      );
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("4. timelock: finalize faalt vóór 3s, slaagt erna", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      await expectAnchorError(
        callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, amount),
        "PendingActionTimelockNotElapsed"
      );

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, amount);
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("5. recovery tijdens pending: finalize faalt met PendingActionStaleEpoch na een voltooide recovery", async () => {
      const recoveryTimelockSeconds = 3;
      const { passkey, backupAuthority, walletPda, vaultPda, passkeysPda, pendingActionPda } =
        await createWallet(recoveryTimelockSeconds);
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      const newOwnerPasskey = dummyNewOwnerPasskey();
      await callInitiateRecovery(backupAuthority, walletPda, newOwnerPasskey);

      const walletAfterRecoveryInitiate = await program.account.walletAccount.fetch(walletPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        walletAfterRecoveryInitiate.recoveryState.initiatedAt.toNumber() + recoveryTimelockSeconds
      );
      await callFinalizeRecovery(walletPda, passkeysPda);

      // Nieuwe eigenaar (na recovery) probeert de OUDE pending action alsnog
      // af te ronden - moet stuklopen op de epoch-check, niet stilzwijgend
      // slagen.
      const newOwnerTestPasskey: TestPasskey = {
        privateKey: new Uint8Array(32), // ongebruikt: finalize faalt al vóór verificatie van deze handtekening zou kunnen slagen
        compressedPublicKey: Buffer.from(newOwnerPasskey),
      };
      await expectAnchorError(
        callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, amount),
        "PendingActionStaleEpoch"
      );
      void newOwnerTestPasskey;
    });

    it("6. commitment-mismatch: finalize met een ander bedrag dan bij initiate faalt met PendingActionCommitmentMismatch", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      const wrongAmount = amount.add(new BN(1));
      await expectAnchorError(
        callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, wrongAmount),
        "PendingActionCommitmentMismatch"
      );

      // Zelfde controle op een andere bestemming (bedrag ongewijzigd).
      const wrongRecipient = Keypair.generate().publicKey;
      await expectAnchorError(
        callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, wrongRecipient, amount),
        "PendingActionCommitmentMismatch"
      );

      // Met de ORIGINELE waarden slaagt het gewoon nog.
      await callFinalizeWithdrawal(passkey, walletPda, vaultPda, pendingActionPda, passkeysPda, recipient, amount);
    });

    it("8a. cancel_action sluit de PDA en betaalt de rent terug aan de canceller", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      const pendingInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNotNull(pendingInfo);
      const rentLamports = pendingInfo!.lamports;

      const balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);
      const balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na cancel_action");
      // Rent komt terug (min. de eigen tx-fee, ruim onder de rent zelf).
      assert.isAbove(balanceAfter - balanceBefore, rentLamports - 20_000);
    });

    it("8b. cancel_action werkt ook tijdens een lopende recovery", async () => {
      const recoveryTimelockSeconds = 3;
      const { passkey, backupAuthority, walletPda, passkeysPda, pendingActionPda } =
        await createWallet(recoveryTimelockSeconds);
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amount);

      await callInitiateRecovery(backupAuthority, walletPda, dummyNewOwnerPasskey());
      const wallet = await program.account.walletAccount.fetch(walletPda);
      assert.isNotNull(wallet.recoveryState, "recovery had actief moeten zijn voor deze test");

      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "cancel_action had moeten slagen ondanks lopende recovery");
    });

    it("7. drempel-eligibiliteit: initiate_withdrawal onder spend_threshold_lamports faalt met AmountEligibleForInstantExecute", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda } = await createWallet();

      // Drempel eerst omhoog via de volledige initiate/finalize_threshold_change-
      // wachtrij (kind=3) - spend_threshold_lamports is standaard 0 (fail-safe),
      // dus zonder deze stap zou ELK positief bedrag toch door de wachtrij-eis
      // heen komen (amount > 0 == amount > threshold).
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);
      const pendingThresholdChange = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingThresholdChange.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      const { spendWindowPda } = derivePdas(passkey.compressedPublicKey);
      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        newThreshold,
        newWindowCap
      );

      const walletAfter = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletAfter.spendThresholdLamports.toString(), newThreshold.toString());

      const recipient = Keypair.generate().publicKey;
      const belowThreshold = newThreshold.sub(new BN(1));
      await expectAnchorError(
        callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, belowThreshold),
        "AmountEligibleForInstantExecute"
      );

      // Exact op de drempel (niet erboven) moet ook nog steeds falen - de
      // check in instructions.rs is `amount > threshold`, dus `== threshold`
      // hoort ook instant-eligible te zijn.
      await expectAnchorError(
        callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, newThreshold),
        "AmountEligibleForInstantExecute"
      );

      // Eén lamport boven de drempel moet wel slagen (queue-eligible).
      await callInitiateWithdrawal(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipient,
        newThreshold.add(new BN(1))
      );
    });
  });

  // ================= ThresholdChange (kind=3) helpers (nodig voor testpunt 7 hierboven) =================

  async function callInitiateThresholdChange(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    newSpendThresholdLamports: BN,
    newWindowTotalCapLamports: BN
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      newSpendThresholdLamports.toArrayLike(Buffer, "le", 8),
      newWindowTotalCapLamports.toArrayLike(Buffer, "le", 8),
    ]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "initiate_threshold_change",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .initiateThresholdChange(
        newSpendThresholdLamports,
        newWindowTotalCapLamports,
        new BN(nonce.toString()),
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callFinalizeThresholdChange(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    spendWindowPda: PublicKey,
    newSpendThresholdLamports: BN,
    newWindowTotalCapLamports: BN,
    closer: PublicKey = provider.wallet.publicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const pendingAction = await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = Buffer.from(pendingAction.actionCommitment);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "finalize_threshold_change",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .finalizeThresholdChange(
        newSpendThresholdLamports,
        newWindowTotalCapLamports,
        new BN(nonce.toString()),
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        spendWindow: spendWindowPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // ================= TokenTransfer (kind=1) =================

  /// Zelfde helper als tests/transferToken.ts se eigen
  /// `setupMintAndAccounts` (bewust gedupliceerd, zelfde
  /// per-bestand-onafhankelijkheidsconventie als de rest van deze suite).
  async function setupMintAndAccounts(
    vaultPda: PublicKey,
    recipientOwner: PublicKey,
    mintAmount: number
  ): Promise<{ mint: Keypair; vaultTokenAccount: Keypair; recipientTokenAccount: Keypair }> {
    const mint = Keypair.generate();
    const vaultTokenAccount = Keypair.generate();
    const recipientTokenAccount = Keypair.generate();
    const mintRent = await provider.connection.getMinimumBalanceForRentExemption(MINT_LEN);
    const tokenAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);

    const setupTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: mintRent,
        space: MINT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeMintIx(mint.publicKey, 0, provider.wallet.publicKey),
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: vaultTokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(vaultTokenAccount.publicKey, mint.publicKey, vaultPda),
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: recipientTokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(recipientTokenAccount.publicKey, mint.publicKey, recipientOwner),
      encodeMintToIx(mint.publicKey, vaultTokenAccount.publicKey, provider.wallet.publicKey, mintAmount)
    );
    await provider.sendAndConfirm(setupTx, [mint, vaultTokenAccount, recipientTokenAccount]);
    return { mint, vaultTokenAccount, recipientTokenAccount };
  }

  async function callInitiateTokenTransfer(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    recipientTokenAccount: PublicKey,
    tokenMint: PublicKey,
    amount: BN,
    vaultTokenAccount: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      recipientTokenAccount.toBuffer(),
      tokenMint.toBuffer(),
      amount.toArrayLike(Buffer, "le", 8),
      vaultTokenAccount.toBuffer(),
    ]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "initiate_token_transfer",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .initiateTokenTransfer(
        recipientTokenAccount,
        tokenMint,
        amount,
        vaultTokenAccount,
        new BN(nonce.toString()),
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callFinalizeTokenTransfer(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    vaultTokenAccount: PublicKey,
    recipientTokenAccount: PublicKey,
    tokenMint: PublicKey,
    amount: BN,
    closer: PublicKey = provider.wallet.publicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const pendingAction = await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = Buffer.from(pendingAction.actionCommitment);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "finalize_token_transfer",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .finalizeTokenTransfer(amount, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        vaultTokenAccount,
        recipientTokenAccount,
        tokenMint,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  describe("kind=1 TokenTransfer (initiate_token_transfer/finalize_token_transfer)", () => {
    it("1. happy path: verplaatst het exacte tokenbedrag en sluit de PendingAction-PDA", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );
      const amount = new BN(250);

      await callInitiateTokenTransfer(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount,
        vaultTokenAccount.publicKey
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      assert.equal(pendingAfterInitiate.kind, 1);

      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeTokenTransfer(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        vaultTokenAccount.publicKey,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount
      );

      const vaultInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
      const recipientInfo = await provider.connection.getAccountInfo(recipientTokenAccount.publicKey);
      assert.equal(readTokenAccountAmount(vaultInfo!.data), BigInt(1_000 - 250));
      assert.equal(readTokenAccountAmount(recipientInfo!.data), BigInt(250));

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na finalize");
    });

    it("3. two-of-two-afdwinging: finalize met dezelfde passkey als initiate faalt, met een andere passkey slaagt", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const secondPasskey = generateTestPasskey();
      await callAddPasskey(passkey, walletPda, passkeysPda, secondPasskey.compressedPublicKey);
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );
      const amount = new BN(250);
      await callInitiateTokenTransfer(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount,
        vaultTokenAccount.publicKey
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeTokenTransfer(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          passkeysPda,
          vaultTokenAccount.publicKey,
          recipientTokenAccount.publicKey,
          mint.publicKey,
          amount
        ),
        "SecondPasskeyMustDifferFromInitiator"
      );

      await callFinalizeTokenTransfer(
        secondPasskey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        vaultTokenAccount.publicKey,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount
      );
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("4. timelock: finalize faalt vóór 3s, slaagt erna", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );
      const amount = new BN(250);
      await callInitiateTokenTransfer(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount,
        vaultTokenAccount.publicKey
      );

      await expectAnchorError(
        callFinalizeTokenTransfer(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          passkeysPda,
          vaultTokenAccount.publicKey,
          recipientTokenAccount.publicKey,
          mint.publicKey,
          amount
        ),
        "PendingActionTimelockNotElapsed"
      );

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeTokenTransfer(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        vaultTokenAccount.publicKey,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount
      );
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("6. commitment-mismatch: finalize met een ander bedrag dan bij initiate faalt met PendingActionCommitmentMismatch", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );
      const amount = new BN(250);
      await callInitiateTokenTransfer(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount,
        vaultTokenAccount.publicKey
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      const wrongAmount = amount.add(new BN(1));
      await expectAnchorError(
        callFinalizeTokenTransfer(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          passkeysPda,
          vaultTokenAccount.publicKey,
          recipientTokenAccount.publicKey,
          mint.publicKey,
          wrongAmount
        ),
        "PendingActionCommitmentMismatch"
      );

      await callFinalizeTokenTransfer(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        passkeysPda,
        vaultTokenAccount.publicKey,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount
      );
    });

    it("8a. cancel_action sluit de PDA en betaalt de rent terug aan de canceller, geen tokens verplaatst", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda } = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );
      const amount = new BN(250);
      await callInitiateTokenTransfer(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        amount,
        vaultTokenAccount.publicKey
      );

      const pendingInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNotNull(pendingInfo);
      const rentLamports = pendingInfo!.lamports;

      const balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);
      const balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na cancel_action");
      assert.isAbove(balanceAfter - balanceBefore, rentLamports - 20_000);

      // Geannuleerd, dus geen enkele token had verplaatst mogen zijn.
      const vaultInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
      const recipientInfo = await provider.connection.getAccountInfo(recipientTokenAccount.publicKey);
      assert.equal(readTokenAccountAmount(vaultInfo!.data), BigInt(1_000));
      assert.equal(readTokenAccountAmount(recipientInfo!.data), BigInt(0));
    });
  });

  // ================= AdvancedAction (kind=2) =================

  /// Exacte TS-tegenhanger van de challenge-payload-bouw voor
  /// initiate_advanced_action/finalize_advanced_action - zelfde vorm als
  /// tests/policy.ts se buildExecuteAdvancedPayload (bewust gedupliceerd,
  /// zelfde per-bestand-onafhankelijkheidsconventie).
  function buildAdvancedActionMetadataPayload(
    cpiProgramId: PublicKey,
    vaultPda: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer
  ): Buffer {
    const parts: Buffer[] = [cpiProgramId.toBuffer()];
    const countBuf = Buffer.alloc(2);
    countBuf.writeUInt16LE(remainingAccounts.length, 0);
    parts.push(countBuf);
    for (const acc of remainingAccounts) {
      const isSigner = acc.pubkey.equals(vaultPda) || acc.isSigner;
      parts.push(acc.pubkey.toBuffer());
      parts.push(Buffer.from([acc.isWritable ? 1 : 0]));
      parts.push(Buffer.from([isSigner ? 1 : 0]));
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(data.length, 0);
    parts.push(lenBuf);
    parts.push(data);
    return Buffer.concat(parts);
  }

  async function callInitiateAdvancedAction(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    pendingActionPda: PublicKey,
    policyPda: PublicKey,
    passkeysPda: PublicKey,
    cpiProgramId: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer,
    extraSigners: Keypair[] = []
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const rawPayload = buildAdvancedActionMetadataPayload(cpiProgramId, vaultPda, remainingAccounts, data);
    const payload = Buffer.concat([nonceLeBytes(nonce), rawPayload]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "initiate_advanced_action",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .initiateAdvancedAction(data, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        pendingAction: pendingActionPda,
        policy: policyPda,
        cpiProgram: cpiProgramId,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        remainingAccounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable, isSigner: a.isSigner }))
      )
      .preInstructions([secp256r1Ix])
      // build_cpi_account_metadata (instructions.rs) leest is_signer LIVE
      // van de daadwerkelijk ingediende AccountInfo, niet van een
      // client-opgegeven vlag - dus een remaining account met isSigner:true
      // moet ook déze initiate-transactie al écht mee-ondertekenen, anders
      // faalt Solana's eigen handtekeningcontrole al vóór het programma
      // draait (los van wat initiate zelf met die handtekening doet).
      .signers(extraSigners)
      .rpc();
  }

  async function callFinalizeAdvancedAction(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    pendingActionPda: PublicKey,
    policyPda: PublicKey,
    passkeysPda: PublicKey,
    cpiProgramId: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer,
    extraSigners: Keypair[] = [],
    closer: PublicKey = provider.wallet.publicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const pendingAction = await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = Buffer.from(pendingAction.actionCommitment);
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "finalize_advanced_action",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .finalizeAdvancedAction(data, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        pendingAction: pendingActionPda,
        policy: policyPda,
        cpiProgram: cpiProgramId,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer,
      })
      .remainingAccounts(
        remainingAccounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable, isSigner: a.isSigner }))
      )
      .preInstructions([secp256r1Ix])
      .signers(extraSigners)
      .rpc();
  }

  /// Zet een gefunde, nog-niet-toegewezen account + een System::Assign-CPI
  /// naar het SpankWallet-programma zelf op - zelfde constructie als
  /// tests/policy.ts se execute_advanced-happy-path-test, hergebruikt hier
  /// voor de initiate/finalize_advanced_action-wachtrij.
  async function setupAssignCpiFixture(): Promise<{ target: Keypair; assignIx: TransactionInstruction }> {
    const target = Keypair.generate();
    const rentExemptMinimum = await provider.connection.getMinimumBalanceForRentExemption(0);
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: target.publicKey,
          lamports: rentExemptMinimum,
        })
      )
    );
    const assignIx = SystemProgram.assign({ accountPubkey: target.publicKey, programId: program.programId });
    return { target, assignIx };
  }

  describe("kind=2 AdvancedAction (initiate_advanced_action/finalize_advanced_action)", () => {
    it("1. happy path: echte CPI via System Program Assign, na queue + timelock", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      assert.equal(pendingAfterInitiate.kind, 2);

      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );

      const info = await provider.connection.getAccountInfo(target.publicKey);
      assert.isNotNull(info);
      assert.equal(info!.owner.toBase58(), program.programId.toBase58());
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na finalize");
    });

    it("3. two-of-two-afdwinging: finalize met dezelfde passkey als initiate faalt, met een andere passkey slaagt", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      const secondPasskey = generateTestPasskey();
      await callAddPasskey(passkey, walletPda, passkeysPda, secondPasskey.compressedPublicKey);
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeAdvancedAction(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          policyPda,
          passkeysPda,
          SystemProgram.programId,
          remainingAccounts,
          assignIx.data,
          [target]
        ),
        "SecondPasskeyMustDifferFromInitiator"
      );

      await callFinalizeAdvancedAction(
        secondPasskey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("6. commitment-mismatch: andere cpi_instruction_data bij finalize dan bij initiate faalt met PendingActionCommitmentMismatch", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const otherAssignIx = SystemProgram.assign({
        accountPubkey: target.publicKey,
        programId: SystemProgram.programId,
      });
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeAdvancedAction(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          policyPda,
          passkeysPda,
          SystemProgram.programId,
          remainingAccounts,
          otherAssignIx.data,
          [target]
        ),
        "PendingActionCommitmentMismatch"
      );

      await callFinalizeAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
    });

    it("herverificatie bij finalize: programma van de allowlist verwijderd tussen initiate en finalize faalt met ProgramNotAllowed", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );

      // Eigenaar verwijdert het programma weer van de allowlist TERWIJL de
      // actie in de wachtrij staat - finalize mag dan niet alsnog slagen
      // alsof er niets veranderd is (STATUS.md sectie 122).
      await callRemoveAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeAdvancedAction(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          policyPda,
          passkeysPda,
          SystemProgram.programId,
          remainingAccounts,
          assignIx.data,
          [target]
        ),
        "ProgramNotAllowed"
      );
    });

    it("4. timelock: finalize faalt vóór 3s, slaagt erna", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );

      await expectAnchorError(
        callFinalizeAdvancedAction(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          policyPda,
          passkeysPda,
          SystemProgram.programId,
          remainingAccounts,
          assignIx.data,
          [target]
        ),
        "PendingActionTimelockNotElapsed"
      );

      // De CPI mag zeker niet stiekem toch al uitgevoerd zijn na de
      // geweigerde finalize-poging.
      const infoBeforeTimelock = await provider.connection.getAccountInfo(target.publicKey);
      assert.equal(infoBeforeTimelock!.owner.toBase58(), SystemProgram.programId.toBase58());

      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );
      const infoAfterTimelock = await provider.connection.getAccountInfo(target.publicKey);
      assert.equal(infoAfterTimelock!.owner.toBase58(), program.programId.toBase58());
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("8a. cancel_action sluit de PDA en betaalt de rent terug aan de canceller, geen CPI uitgevoerd", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        remainingAccounts,
        assignIx.data,
        [target]
      );

      const pendingInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNotNull(pendingInfo);
      const rentLamports = pendingInfo!.lamports;

      const balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);
      const balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na cancel_action");
      assert.isAbove(balanceAfter - balanceBefore, rentLamports - 20_000);

      // Geannuleerd, dus de CPI (System::Assign naar spankwallet) mag nooit
      // uitgevoerd zijn - target blijft eigendom van System Program.
      const targetInfo = await provider.connection.getAccountInfo(target.publicKey);
      assert.equal(targetInfo!.owner.toBase58(), SystemProgram.programId.toBase58());
    });
  });

  // ================= ThresholdChange (kind=3) dedicated tests =================
  // (helpers callInitiateThresholdChange/callFinalizeThresholdChange staan
  // hierboven al, nodig voor testpunt 7 van kind=0.)

  describe("kind=3 ThresholdChange (initiate_threshold_change/finalize_threshold_change)", () => {
    it("1. happy path: beide velden toegepast, SpendWindow voor het eerst aangemaakt", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);

      const spendWindowBefore = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(spendWindowBefore, "SpendWindow had nog niet moeten bestaan vóór de eerste drempelwijziging");

      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);
      const pendingAfterInitiate = await program.account.pendingAction.fetch(pendingActionPda);
      assert.equal(pendingAfterInitiate.kind, 3);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        newThreshold,
        newWindowCap
      );

      const walletAfter = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletAfter.spendThresholdLamports.toString(), newThreshold.toString());
      const spendWindow = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(spendWindow.windowTotalCapLamports.toString(), newWindowCap.toString());
      assert.equal(spendWindow.spentLamportsThisWindow.toString(), "0");

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na finalize");
    });

    it("SpendWindow.windowStartedAt blijft ongewijzigd bij een TWEEDE drempelwijziging (geen stille reset)", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const firstThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const firstWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, firstThreshold, firstWindowCap);
      let pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        firstThreshold,
        firstWindowCap
      );
      const spendWindowAfterFirst = await program.account.spendWindow.fetch(spendWindowPda);
      const windowStartedAtAfterFirst = spendWindowAfterFirst.windowStartedAt.toString();

      // Een TWEEDE, onafhankelijke drempelwijziging (nieuwe waarden) - mag
      // window_started_at niet stilzwijgend resetten.
      const secondThreshold = firstThreshold.add(new BN(anchor.web3.LAMPORTS_PER_SOL / 20));
      const secondWindowCap = firstWindowCap.add(new BN(anchor.web3.LAMPORTS_PER_SOL / 2));
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, secondThreshold, secondWindowCap);
      pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        secondThreshold,
        secondWindowCap
      );

      const spendWindowAfterSecond = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        spendWindowAfterSecond.windowStartedAt.toString(),
        windowStartedAtAfterFirst,
        "window_started_at had NIET gereset moeten worden door een tweede drempelwijziging"
      );
      assert.equal(spendWindowAfterSecond.windowTotalCapLamports.toString(), secondWindowCap.toString());
    });

    it("een drempelVERLAGING loopt via dezelfde volledige wachtrij, geen instant-pad", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const highThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL);
      const highWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL * 2);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, highThreshold, highWindowCap);
      let pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        highThreshold,
        highWindowCap
      );

      const lowThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 100);
      const lowWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, lowThreshold, lowWindowCap);
      pending = await program.account.pendingAction.fetch(pendingActionPda);

      // Vóór de timelock verstreken is, moet finalize (ook voor een
      // VERLAGING) nog steeds falen - geen speciaal, instant-pad.
      await expectAnchorError(
        callFinalizeThresholdChange(
          passkey,
          walletPda,
          pendingActionPda,
          passkeysPda,
          spendWindowPda,
          lowThreshold,
          lowWindowCap
        ),
        "PendingActionTimelockNotElapsed"
      );

      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        lowThreshold,
        lowWindowCap
      );
      const walletAfter = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletAfter.spendThresholdLamports.toString(), lowThreshold.toString());
    });

    it("3. two-of-two-afdwinging: finalize met dezelfde passkey als initiate faalt, met een andere passkey slaagt", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const secondPasskey = generateTestPasskey();
      await callAddPasskey(passkey, walletPda, passkeysPda, secondPasskey.compressedPublicKey);
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);
      const pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(
        callFinalizeThresholdChange(
          passkey,
          walletPda,
          pendingActionPda,
          passkeysPda,
          spendWindowPda,
          newThreshold,
          newWindowCap
        ),
        "SecondPasskeyMustDifferFromInitiator"
      );

      await callFinalizeThresholdChange(
        secondPasskey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        newThreshold,
        newWindowCap
      );
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("6. commitment-mismatch: finalize met een afwijkende window-cap dan bij initiate faalt met PendingActionCommitmentMismatch", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);
      const pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      const wrongWindowCap = newWindowCap.add(new BN(1));
      await expectAnchorError(
        callFinalizeThresholdChange(
          passkey,
          walletPda,
          pendingActionPda,
          passkeysPda,
          spendWindowPda,
          newThreshold,
          wrongWindowCap
        ),
        "PendingActionCommitmentMismatch"
      );

      const wrongThreshold = newThreshold.add(new BN(1));
      await expectAnchorError(
        callFinalizeThresholdChange(
          passkey,
          walletPda,
          pendingActionPda,
          passkeysPda,
          spendWindowPda,
          wrongThreshold,
          newWindowCap
        ),
        "PendingActionCommitmentMismatch"
      );

      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        newThreshold,
        newWindowCap
      );
    });

    // Bewust een EIGEN, herkenbaar testpunt, ook al zit hetzelfde gedrag al
    // impliciet in de "drempelVERLAGING"-test hierboven (die primair iets
    // anders bewijst: dat een verlaging geen instant-pad krijgt). Zonder
    // deze losse test zou de basale timelock-garantie stilzwijgend van de
    // dekking kunnen verdwijnen als die andere test ooit herzien wordt -
    // zelfde reden waarom kind=0/1/2 elk hun eigen "N. timelock"-test
    // hebben, niet alleen een toevallige door-elkaar-heen-bewezen variant.
    it("4. timelock: finalize faalt vóór 3s, slaagt erna", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);

      await expectAnchorError(
        callFinalizeThresholdChange(
          passkey,
          walletPda,
          pendingActionPda,
          passkeysPda,
          spendWindowPda,
          newThreshold,
          newWindowCap
        ),
        "PendingActionTimelockNotElapsed"
      );

      // Nog niet toegepast na de geweigerde poging.
      const walletBeforeTimelock = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletBeforeTimelock.spendThresholdLamports.toString(), "0");

      const pending = await program.account.pendingAction.fetch(pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        pending.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await callFinalizeThresholdChange(
        passkey,
        walletPda,
        pendingActionPda,
        passkeysPda,
        spendWindowPda,
        newThreshold,
        newWindowCap
      );
      const walletAfter = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletAfter.spendThresholdLamports.toString(), newThreshold.toString());
      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo);
    });

    it("8a. cancel_action sluit de PDA en betaalt de rent terug aan de canceller, drempel ongewijzigd", async () => {
      const { passkey, walletPda, passkeysPda, pendingActionPda, spendWindowPda } = await createWallet();
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);

      const pendingInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNotNull(pendingInfo);
      const rentLamports = pendingInfo!.lamports;

      const balanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);
      const balanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);

      const closedInfo = await provider.connection.getAccountInfo(pendingActionPda);
      assert.isNull(closedInfo, "PendingAction-PDA had gesloten moeten zijn na cancel_action");
      assert.isAbove(balanceAfter - balanceBefore, rentLamports - 20_000);

      // Geannuleerd, dus de drempel zelf mag niet gewijzigd zijn, en
      // SpendWindow had nog niet aangemaakt mogen worden.
      const walletAfter = await program.account.walletAccount.fetch(walletPda);
      assert.equal(walletAfter.spendThresholdLamports.toString(), "0");
      const spendWindowInfo = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(spendWindowInfo, "SpendWindow had niet aangemaakt moeten zijn na een geannuleerde wijziging");
    });
  });
});
