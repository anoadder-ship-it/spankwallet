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
  AddressLookupTableProgram,
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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
  advanceSlotPast,
  fetchActionNonce,
  actionNonceOffset,
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

// Zelfde encodering als tests/policy.ts se encodeTransferData (bewust
// gedupliceerd) - nodig voor de Token::transfer-CPI-via-execute_advanced-
// test in het kind=2-blok hieronder (STATUS.md sectie 131).
function encodeTransferData(amount: number): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer tag
  data.writeBigUInt64LE(BigInt(amount), 1);
  return data;
}

interface RemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

// --- Zelfde hunt-constanten/encodering als tests/hunt.ts/spendThreshold.ts
// (bewust gedupliceerd) - nodig voor het execute/hunt-drempel-gating-
// describe-blok onderaan dit bestand (STATUS.md sectie 127/128). ---
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const HUNT_DISCRIMINATOR = Buffer.from([0x94, 0x1e, 0x1c, 0x39, 0x31, 0xf9, 0x1d, 0x41]);

function encodeBorshVecU8(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
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

  // --- execute/hunt (STATUS.md sectie 127/128, stap A/Route 2's
  // drempel-gating) - nodig voor het describe-blok onderaan dit bestand
  // dat de threshold>0-gating en de symmetrie met initiate_withdrawal
  // bewijst. Draait hier (i.p.v. in het aparte, timelock-vrije
  // spendThreshold.ts) omdat een niet-nul drempel zetten
  // finalize_threshold_change vereist, en dus de verkorte testtimelock. ---

  async function callExecute(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
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
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "execute", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    // STATUS.md sectie 132/133 (stap B): SpendWindow, nog niet
    // gelezen/geschreven (stap c) - moet wel al meegestuurd worden.
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );

    return program.methods
      .execute(amount, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        spendWindow: spendWindowPda,
        recipient,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  /// Handmatig opgebouwd, niet via program.methods.hunt().accounts() -
  /// zelfde reden als tests/hunt.ts: Hunt::token_mint draagt bewust geen
  /// #[account(mut)] (Anchor muteert 'm nooit rechtstreeks), maar de
  /// SPL-Token Burn-CPI erin vereist wél writable op transactieniveau.
  async function callHunt(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    passkeysPda: PublicKey,
    targetTokenAccount: PublicKey,
    tokenMint: PublicKey,
    rentDestination: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      targetTokenAccount.toBuffer(),
      rentDestination.toBuffer(),
    ]);
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "hunt", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    const data = Buffer.concat([HUNT_DISCRIMINATOR, nonceLeBytes(nonce), encodeBorshVecU8(clientDataJSON)]);
    // STATUS.md sectie 132/133 (stap B): SpendWindow, nog niet
    // gelezen/geschreven (stap c) - moet wel al meegestuurd worden, zelfde
    // volgorde als Hunt in instructions.rs.
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    const huntIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: spendWindowPda, isSigner: false, isWritable: true },
        { pubkey: targetTokenAccount, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: true },
        { pubkey: rentDestination, isSigner: false, isWritable: true },
        { pubkey: INCINERATOR, isSigner: false, isWritable: true },
        { pubkey: passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new anchor.web3.Transaction().add(secp256r1Ix, huntIx);
    return provider.sendAndConfirm(tx);
  }

  async function setupSpamTokenAccount(
    vaultPda: PublicKey,
    mintAmount: number
  ): Promise<{ mint: Keypair; tokenAccount: Keypair }> {
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
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
        newAccountPubkey: tokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(tokenAccount.publicKey, mint.publicKey, vaultPda),
      encodeMintToIx(mint.publicKey, tokenAccount.publicKey, provider.wallet.publicKey, mintAmount)
    );
    await provider.sendAndConfirm(setupTx, [mint, tokenAccount]);
    return { mint, tokenAccount };
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
      // single-passkey-degradatie: confirmed moet al true zijn na initiate.
      assert.isTrue(pendingAfterInitiate.confirmed, "confirmed had na initiate met 1 passkey al true moeten zijn");

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

    it("5. recovery tijdens pending: finalize faalt met PendingActionStaleEpoch na een voltooide recovery", async () => {
      const recoveryTimelockSeconds = 3;
      const { passkey, backupAuthority, walletPda, vaultPda, passkeysPda, pendingActionPda } =
        await createWallet(recoveryTimelockSeconds);
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

      await callInitiateRecovery(backupAuthority, walletPda, dummyNewOwnerPasskey());
      const walletAfterRecoveryInitiate = await program.account.walletAccount.fetch(walletPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        walletAfterRecoveryInitiate.recoveryState.initiatedAt.toNumber() + recoveryTimelockSeconds
      );
      await callFinalizeRecovery(walletPda, passkeysPda);

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
        "PendingActionStaleEpoch"
      );
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
    extraSigners: Keypair[] = [],
    // Optioneel: forceer een specifieke (bijv. verouderde) nonce i.p.v. de
    // echte huidige - alleen nodig voor de stale-nonce-test hieronder. Valt
    // terug op de normale fetchActionNonce-weg zodra dit ontbreekt, dus
    // geen enkele andere aanroeper van deze helper hoeft hiervan te weten.
    nonceOverride?: bigint
  ) {
    const nonce = nonceOverride ?? (await fetchActionNonce(provider.connection, walletPda));
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


  // ================= Sessie-geïnitieerde AdvancedAction (STATUS.md sectie 153) =================
  //
  // Zelfde per-bestand-onafhankelijkheidsconventie als hierboven: de
  // add/remove_session_key-helpers zijn bewust gedupliceerd uit
  // tests/sessionKeys.ts.

  const MAX_U64 = new BN("18446744073709551615");

  function deriveSessionPda(walletPda: PublicKey, sessionKey: PublicKey) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), walletPda.toBuffer(), sessionKey.toBuffer()],
      program.programId
    );
    return sessionPda;
  }

  /// Anchor's instructie-discriminator: sha256("global:<naam>")[..8].
  /// confirm_pending_action en unfreeze_via_backup_authority worden
  /// hieronder met de hand opgebouwd (niet via program.methods): hun
  /// accounts/argumenten veranderden in sectie 155, en zo draait dezelfde
  /// testcode tegen de oude én de nieuwe interface (rood vóór groen).
  function instructionDiscriminator(snakeCaseName: string): Buffer {
    return createHash("sha256").update(`global:${snakeCaseName}`).digest().subarray(0, 8);
  }

  function borshVecU8(bytes: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  }

  /// Sessie met ALLEEN can_execute_advanced, sub-scope = [cpiProgramId].
  async function callAddAdvancedSessionKey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    policyPda: PublicKey,
    sessionKey: PublicKey,
    cpiProgramId: PublicKey,
    expirySlots = 100_000
  ) {
    const expirySlot = (await provider.connection.getSlot()) + expirySlots;
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const expirySlotBuf = Buffer.alloc(8);
    expirySlotBuf.writeBigUInt64LE(BigInt(expirySlot), 0);
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(1, 0);
    const zero = new BN(0);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      sessionKey.toBuffer(),
      expirySlotBuf,
      Buffer.from([0, 0, 1]),
      countBuf,
      cpiProgramId.toBuffer(),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      PublicKey.default.toBuffer(),
      zero.toArrayLike(Buffer, "le", 8),
      zero.toArrayLike(Buffer, "le", 8),
    ]);
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(signingPasskey, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(signingPasskey.compressedPublicKey, signedMessage, rawSignature);

    return program.methods
      .addSessionKey(
        sessionKey,
        new BN(expirySlot),
        false,
        false,
        true,
        [cpiProgramId],
        MAX_U64,
        MAX_U64,
        PublicKey.default,
        zero,
        zero,
        new BN(nonce.toString()),
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        session: deriveSessionPda(walletPda, sessionKey),
        payer: provider.wallet.publicKey,
        policy: policyPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  /// Bouwt (maar verstuurt niet) een remove_session_key-transactie - apart
  /// zodat een test kan bewijzen dat een VOORAF ondertekende verdedigings-
  /// actie van de eigenaar geldig blijft, ook als de sessie ondertussen
  /// iets doet (de sessie raakt action_nonce nooit).
  async function buildRemoveSessionKeyTx(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    sessionKey: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payer = provider.wallet.publicKey;
    const payload = Buffer.concat([nonceLeBytes(nonce), sessionKey.toBuffer(), payer.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "remove_session_key", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(signingPasskey, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(signingPasskey.compressedPublicKey, signedMessage, rawSignature);
    const removeIx = await program.methods
      .removeSessionKey(sessionKey, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        session: deriveSessionPda(walletPda, sessionKey),
        payer,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new anchor.web3.Transaction().add(secp256r1Ix, removeIx);
  }

  async function callInitiateAdvancedActionViaSession(
    sessionKeypair: Keypair,
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
    return program.methods
      .initiateAdvancedActionViaSession(data)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        pendingAction: pendingActionPda,
        policy: policyPda,
        cpiProgram: cpiProgramId,
        session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
        sessionKey: sessionKeypair.publicKey,
        passkeys: passkeysPda,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        remainingAccounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable, isSigner: a.isSigner }))
      )
      .signers([sessionKeypair, ...extraSigners])
      .rpc();
  }

  async function buildConfirmPendingActionIxs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    nonceOverride?: bigint,
    // Alleen voor de revival-test: bouw de instructie met een vooraf
    // vastgelegde commitment, zodat er client-side NIETS van het (dan
    // gesloten) account gelezen hoeft te worden - de weigering moet
    // on-chain gebeuren.
    commitmentOverride?: Buffer,
    // Idem voor het sessie-account (sectie 155): de initiërende sessie.
    initiatorSessionOverride?: PublicKey
  ) {
    const nonce = nonceOverride ?? (await fetchActionNonce(provider.connection, walletPda));
    const pending =
      commitmentOverride && initiatorSessionOverride
        ? null
        : await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = commitmentOverride ?? Buffer.from(pending!.actionCommitment);
    const initiatorSession = initiatorSessionOverride ?? pending!.initiatorSession;
    const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "confirm_pending_action",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(signingPasskey, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(signingPasskey.compressedPublicKey, signedMessage, rawSignature);
    const confirmIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: pendingActionPda, isSigner: false, isWritable: true },
        { pubkey: passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: deriveSessionPda(walletPda, initiatorSession), isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        instructionDiscriminator("confirm_pending_action"),
        nonceLeBytes(nonce),
        borshVecU8(Buffer.from(clientDataJSON)),
      ]),
    });
    return [secp256r1Ix, confirmIx];
  }

  async function callConfirmPendingAction(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey
  ) {
    const ixs = await buildConfirmPendingActionIxs(signingPasskey, walletPda, pendingActionPda, passkeysPda);
    return provider.sendAndConfirm(new anchor.web3.Transaction().add(...ixs));
  }

  /// Wallet + System-programma op de allowlist + een advanced-sessie + een
  /// door die sessie geïnitieerde Assign-CPI. Optioneel met een tweede
  /// passkey (vóór de initiatie toegevoegd, dus confirmed=false).
  async function setupSessionInitiatedAction(withSecondPasskey: boolean, sessionExpirySlots?: number) {
    const wallet = await createWallet();
    let secondPasskey: TestPasskey | null = null;
    if (withSecondPasskey) {
      secondPasskey = generateTestPasskey();
      await callAddPasskey(wallet.passkey, wallet.walletPda, wallet.passkeysPda, secondPasskey.compressedPublicKey);
    }
    await callAddAllowedProgram(wallet.passkey, wallet.walletPda, wallet.policyPda, SystemProgram.programId);
    const sessionKeypair = Keypair.generate();
    await callAddAdvancedSessionKey(
      wallet.passkey,
      wallet.walletPda,
      wallet.passkeysPda,
      wallet.policyPda,
      sessionKeypair.publicKey,
      SystemProgram.programId,
      sessionExpirySlots
    );
    const { target, assignIx } = await setupAssignCpiFixture();
    const remainingAccounts: RemainingAccountSpec[] = [
      { pubkey: target.publicKey, isWritable: true, isSigner: true },
    ];
    await callInitiateAdvancedActionViaSession(
      sessionKeypair,
      wallet.walletPda,
      wallet.vaultPda,
      wallet.pendingActionPda,
      wallet.policyPda,
      wallet.passkeysPda,
      SystemProgram.programId,
      remainingAccounts,
      assignIx.data,
      [target]
    );
    return { ...wallet, secondPasskey, sessionKeypair, target, assignIx, remainingAccounts };
  }

  async function finalizeSessionAction(
    s: Awaited<ReturnType<typeof setupSessionInitiatedAction>>,
    signingPasskey: TestPasskey
  ) {
    return callFinalizeAdvancedAction(
      signingPasskey,
      s.walletPda,
      s.vaultPda,
      s.pendingActionPda,
      s.policyPda,
      s.passkeysPda,
      SystemProgram.programId,
      s.remainingAccounts,
      s.assignIx.data,
      [s.target]
    );
  }

  async function assertTargetUnassigned(target: Keypair) {
    const info = await provider.connection.getAccountInfo(target.publicKey);
    assert.equal(info!.owner.toBase58(), SystemProgram.programId.toBase58(), "er mocht nog geen CPI uitgevoerd zijn");
  }

  async function assertTargetAssigned(target: Keypair) {
    const info = await provider.connection.getAccountInfo(target.publicKey);
    assert.equal(info!.owner.toBase58(), program.programId.toBase58(), "de CPI had uitgevoerd moeten zijn");
  }

  const payerKeypair = () => (provider.wallet as anchor.Wallet).payer;

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
      // single-passkey-degradatie: confirmed moet al true zijn na initiate.
      assert.isTrue(pendingAfterInitiate.confirmed, "confirmed had na initiate met 1 passkey al true moeten zijn");

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

    // STATUS.md sectie 131 (vervolg op sectie 115/127-130): execute_advanced
    // is permanent geblokkeerd voor directe aanroep sinds die sectie - deze
    // twee tests vervangen tests/policy.ts se (verwijderde)
    // "execute_advanced voert een echte SPL Token::transfer-CPI uit"- en
    // tests/actionNonce.ts se (verwijderde) stale-nonce-test, nu via de
    // wachtrij. tests/policy.ts se andere directe-CPI-test (System::Assign)
    // bleek al 1:1 overlappen met "1. happy path" hierboven - GEEN losse
    // vervanging nodig daarvoor, zie STATUS.md sectie 131 voor de
    // bevestiging dat dat bewust geen duplicaat is, geen omissie.

    it("Token::transfer-CPI met de vault als PDA-signer-autoriteit, via de wachtrij (vervangt de nu geblokkeerde directe execute_advanced-test in tests/policy.ts)", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
        vaultPda,
        provider.wallet.publicKey,
        1_000
      );

      // Zelfde is_writable/is_signer-opzet als tests/policy.ts se
      // verwijderde equivalent: vault staat ook als het mut-gedeclareerde
      // `vault`-account in dezelfde instructie, dus isWritable:true hier
      // moet overeenkomen met wat het programma daadwerkelijk waarneemt.
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: vaultTokenAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: recipientTokenAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: vaultPda, isWritable: true, isSigner: false },
      ];
      const transferData = encodeTransferData(500);

      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        TOKEN_PROGRAM_ID,
        remainingAccounts,
        transferData
      );
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
        TOKEN_PROGRAM_ID,
        remainingAccounts,
        transferData
      );

      const vaultAcctInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
      const recipientAcctInfo = await provider.connection.getAccountInfo(recipientTokenAccount.publicKey);
      assert.equal(readTokenAccountAmount(vaultAcctInfo!.data), BigInt(500));
      assert.equal(readTokenAccountAmount(recipientAcctInfo!.data), BigInt(500));
    });

    it("stale action_nonce op initiate_advanced_action wordt geweigerd (StaleActionNonce), actuele nonce queued en (na finalize) voert de CPI echt uit (vervangt de nu geblokkeerde directe execute_advanced-test in tests/actionNonce.ts)", async () => {
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remainingAccounts: RemainingAccountSpec[] = [
        { pubkey: target.publicKey, isWritable: true, isSigner: true },
      ];

      // Hergebruikt callInitiateAdvancedAction zelf (via nonceOverride)
      // i.p.v. een eigen, losstaande challenge-opbouw te herhalen zoals
      // tests/actionNonce.ts se verwijderde equivalent nog deed - eerdere
      // versie van deze test dupliceerde de hele payload/accounts-opbouw
      // lokaal, wat op termijn uit elkaar had kunnen lopen met de gedeelde
      // helper zonder dat iets dat zou opmerken. check_current_action_nonce
      // wordt hier bewezen op initiate_advanced_action specifiek (een
      // ANDERE aanroeper dan execute), niet aangenomen vanuit regel 216 van
      // tests/actionNonce.ts se oude (inmiddels verwijderde) test.
      await expectAnchorError(
        callInitiateAdvancedAction(
          passkey,
          walletPda,
          vaultPda,
          pendingActionPda,
          policyPda,
          passkeysPda,
          SystemProgram.programId,
          remainingAccounts,
          assignIx.data,
          [target],
          9n
        ),
        "StaleActionNonce"
      );

      const currentNonce = await fetchActionNonce(provider.connection, walletPda);
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
        [target],
        currentNonce
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

      const targetInfo = await provider.connection.getAccountInfo(target.publicKey);
      assert.ok(
        targetInfo && targetInfo.owner.equals(program.programId),
        "de Assign-CPI had target's owner naar ons eigen programma-ID moeten zetten na finalize"
      );
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

    it("5. recovery tijdens pending: finalize faalt met PendingActionStaleEpoch na een voltooide recovery", async () => {
      const recoveryTimelockSeconds = 3;
      const { passkey, backupAuthority, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } =
        await createWallet(recoveryTimelockSeconds);
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

      await callInitiateRecovery(backupAuthority, walletPda, dummyNewOwnerPasskey());
      const walletAfterRecoveryInitiate = await program.account.walletAccount.fetch(walletPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        walletAfterRecoveryInitiate.recoveryState.initiatedAt.toNumber() + recoveryTimelockSeconds
      );
      await callFinalizeRecovery(walletPda, passkeysPda);

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
        "PendingActionStaleEpoch"
      );
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

  describe("sessie-geïnitieerde AdvancedAction (initiate_advanced_action_via_session / confirm_pending_action) - STATUS.md sectie 153", () => {
    it("finalize met een sessiesleutel is structureel onmogelijk: zonder passkey-precompile faalt finalize_advanced_action (InvalidPasskeySignature), en er bestaat geen _via_session-finalize", async () => {
      const s = await setupSessionInitiatedAction(false);
      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      const pending = await program.account.pendingAction.fetch(s.pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      const nonce = await fetchActionNonce(provider.connection, s.walletPda);
      const sig = await provider.connection.requestAirdrop(s.sessionKeypair.publicKey, 100_000_000);
      await provider.connection.confirmTransaction(sig, "confirmed");
      await expectAnchorError(
        program.methods
          .finalizeAdvancedAction(s.assignIx.data, new BN(nonce.toString()), Buffer.from("{}"))
          .accounts({
            wallet: s.walletPda,
            vault: s.vaultPda,
            pendingAction: s.pendingActionPda,
            policy: s.policyPda,
            cpiProgram: SystemProgram.programId,
            passkeys: s.passkeysPda,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            closer: s.sessionKeypair.publicKey,
          })
          .remainingAccounts(s.remainingAccounts)
          .signers([s.sessionKeypair, s.target])
          .rpc(),
        "InvalidPasskeySignature"
      );
      await assertTargetUnassigned(s.target);

      const instructionNames = (program.idl.instructions as { name: string }[]).map((i) => i.name);
      const sessionFinalizes = instructionNames.filter((n) => /finalize|confirm/i.test(n) && /session/i.test(n));
      assert.deepEqual(sessionFinalizes, [], "er mag geen finalize/confirm-variant voor sessiesleutels bestaan");
    });

    it("single passkey: finalize vóór confirm faalt (SessionInitiatedActionNeedsConfirmation), OOK als de timelock gerekend vanaf initiatie al verstreken is; na confirm + timelock slaagt finalize door dezelfde passkey", async () => {
      const s = await setupSessionInitiatedAction(false);
      const pendingAfterInitiate = await program.account.pendingAction.fetch(s.pendingActionPda);
      assert.isTrue(pendingAfterInitiate.confirmed, "1 passkey: confirmed=true (single-passkey-terugval)");

      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await expectAnchorError(finalizeSessionAction(s, s.passkey), "SessionInitiatedActionNeedsConfirmation");
      await assertTargetUnassigned(s.target);

      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      const pendingAfterConfirm = await program.account.pendingAction.fetch(s.pendingActionPda);
      assert.deepEqual(
        Array.from(pendingAfterConfirm.initiatorPasskey),
        Array.from(s.passkey.compressedPublicKey),
        "confirm legt de bevestigende passkey vast in initiator_passkey"
      );
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterConfirm.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await finalizeSessionAction(s, s.passkey);
      await assertTargetAssigned(s.target);
      assert.isNull(await provider.connection.getAccountInfo(s.pendingActionPda));
    });

    it("TIMELOCK-STARTMOMENT: de timelock telt vanaf confirm_pending_action, niet vanaf de sessie-initiatie - initiated_at blijft ongewijzigd", async () => {
      const s = await setupSessionInitiatedAction(false);
      const pendingAfterInitiate = await program.account.pendingAction.fetch(s.pendingActionPda);

      // Laat de volledige (test)timelock verstrijken gerekend vanaf initiatie.
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      const pendingAfterConfirm = await program.account.pendingAction.fetch(s.pendingActionPda);

      assert.equal(
        pendingAfterConfirm.initiatedAt.toString(),
        pendingAfterInitiate.initiatedAt.toString(),
        "initiated_at moet het moment van verschijnen blijven"
      );
      assert.isAtLeast(
        pendingAfterConfirm.timelockStartedAt.toNumber(),
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS,
        "timelock_started_at moet het (latere) confirm-moment zijn"
      );

      // Direct na confirm: gerekend vanaf initiatie zou dit mogen, gerekend
      // vanaf confirm niet - het programma moet weigeren.
      await expectAnchorError(finalizeSessionAction(s, s.passkey), "PendingActionTimelockNotElapsed");
      await assertTargetUnassigned(s.target);

      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterConfirm.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await finalizeSessionAction(s, s.passkey);
      await assertTargetAssigned(s.target);
    });

    it("TIMELOCK-STARTMOMENT: confirm + finalize in ÉÉN transactie is onmogelijk, ook lang na de initiatie", async () => {
      const s = await setupSessionInitiatedAction(true);
      const pendingAfterInitiate = await program.account.pendingAction.fetch(s.pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      // Het scenario uit de ontwerpkeuze (sectie 154): een lang onbevestigd
      // gebleven actie, daarna confirm (A) + finalize (B) in één transactie.
      const nonce = await fetchActionNonce(provider.connection, s.walletPda);
      const confirmIxs = await buildConfirmPendingActionIxs(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda, nonce);
      const pending = await program.account.pendingAction.fetch(s.pendingActionPda);
      const commitment = Buffer.from(pending.actionCommitment);
      const finalizeNonce = nonce + 1n;
      const payload = Buffer.concat([nonceLeBytes(finalizeNonce), s.pendingActionPda.toBuffer(), commitment]);
      const expectedChallenge = buildExpectedChallenge(program.programId, s.walletPda, "finalize_advanced_action", payload);
      const signed = signTestChallenge(s.secondPasskey!, expectedChallenge);
      const finalizePrecompile = buildSecp256r1Instruction(
        s.secondPasskey!.compressedPublicKey,
        signed.signedMessage,
        signed.rawSignature
      );
      const finalizeIx = await program.methods
        .finalizeAdvancedAction(s.assignIx.data, new BN(finalizeNonce.toString()), signed.clientDataJSON)
        .accounts({
          wallet: s.walletPda,
          vault: s.vaultPda,
          pendingAction: s.pendingActionPda,
          policy: s.policyPda,
          cpiProgram: SystemProgram.programId,
          passkeys: s.passkeysPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          closer: provider.wallet.publicKey,
        })
        .remainingAccounts(s.remainingAccounts)
        .instruction();

      // Zonder Address Lookup Table is deze transactie te groot (>1232
      // bytes). Een ALT is een gewoon beschikbaar middel, dus de test
      // gebruikt er een: pas dan toetst hij de programmaregel zelf i.p.v.
      // een toevallige transactiegrootte.
      const payer = payerKeypair();
      const recentSlot = await provider.connection.getSlot("finalized");
      const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot,
      });
      const extendAltIx = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: altAddress,
        addresses: [
          s.walletPda,
          s.vaultPda,
          s.pendingActionPda,
          s.policyPda,
          s.passkeysPda,
          SYSVAR_INSTRUCTIONS_PUBKEY,
          SystemProgram.programId,
          new PublicKey("Secp256r1SigVerify1111111111111111111111111"),
          program.programId,
        ],
      });
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(createAltIx, extendAltIx));
      // Een ALT is pas bruikbaar vanaf de slot ná de laatste extend.
      await advanceSlotPast(provider.connection, payer, (await provider.connection.getSlot()) + 1);
      const alt = (await provider.connection.getAddressLookupTable(altAddress)).value!;

      const { blockhash } = await provider.connection.getLatestBlockhash();
      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [...confirmIxs, finalizePrecompile, finalizeIx],
      }).compileToV0Message([alt]);
      const vtx = new VersionedTransaction(message);
      vtx.sign([payer, s.target]);

      let errString = "";
      try {
        const sig = await provider.connection.sendTransaction(vtx);
        await provider.connection.confirmTransaction(sig, "confirmed");
      } catch (err: any) {
        errString = String(err) + " " + String(err?.message ?? "") + " " + JSON.stringify(err?.logs ?? []);
      }
      assert.notInclude(errString, "too large", "met ALT hoort de transactie binnen de groottegrens te passen");
      assert.include(errString, "PendingActionTimelockNotElapsed", "verwachtte PendingActionTimelockNotElapsed, kreeg: " + errString);
      await assertTargetUnassigned(s.target);
    });

    it("2-VAN-2 (≥2 passkeys): finalize vóór confirm faalt; confirm(A) + finalize(A) faalt (SecondPasskeyMustDifferFromInitiator); confirm(A) + finalize(B) slaagt", async () => {
      const s = await setupSessionInitiatedAction(true);
      const pendingAfterInitiate = await program.account.pendingAction.fetch(s.pendingActionPda);
      assert.isFalse(pendingAfterInitiate.confirmed, "2 passkeys bij initiatie: confirmed=false");

      await expectAnchorError(finalizeSessionAction(s, s.passkey), "SessionInitiatedActionNeedsConfirmation");

      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      const pendingAfterConfirm = await program.account.pendingAction.fetch(s.pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterConfirm.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );

      await expectAnchorError(finalizeSessionAction(s, s.passkey), "SecondPasskeyMustDifferFromInitiator");
      await assertTargetUnassigned(s.target);

      await finalizeSessionAction(s, s.secondPasskey!);
      await assertTargetAssigned(s.target);
    });

    it("REGRESSIE (2-van-2 bij sessie-initiatie): met ≥2 passkeys volstaat één passkey nooit om een sessie-geïnitieerde actie uit te voeren", async () => {
      // Wallet met twee passkeys; alleen passkey A wordt gebruikt (voor de
      // sessie, de confirm en de finalize-poging).
      const s = await setupSessionInitiatedAction(true);
      // Eerst: de volledige timelock gerekend vanaf de initiatie verstrijkt,
      // daarna finalize met A zonder confirm - moet op de confirm-eis
      // stranden, niet op de timelock.
      const pendingAfterInitiate = await program.account.pendingAction.fetch(s.pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pendingAfterInitiate.initiatedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await expectAnchorError(finalizeSessionAction(s, s.passkey), "SessionInitiatedActionNeedsConfirmation");
      await assertTargetUnassigned(s.target);

      // En ook de route via een eigen confirm met A strandt: finalize moet
      // dan van een ANDERE passkey komen.
      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      const pending = await program.account.pendingAction.fetch(s.pendingActionPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS
      );
      await expectAnchorError(finalizeSessionAction(s, s.passkey), "SecondPasskeyMustDifferFromInitiator");
      await assertTargetUnassigned(s.target);
    });

    it("confirm_pending_action: alleen voor een sessie-geïnitieerde actie (PendingActionNotSessionInitiated), en maar één keer (PendingActionAlreadyConfirmed)", async () => {
      // Passkey-geïnitieerde actie: confirm is daar niet van toepassing.
      const { passkey, walletPda, vaultPda, policyPda, passkeysPda, pendingActionPda } = await createWallet();
      await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      await callInitiateAdvancedAction(
        passkey,
        walletPda,
        vaultPda,
        pendingActionPda,
        policyPda,
        passkeysPda,
        SystemProgram.programId,
        [{ pubkey: target.publicKey, isWritable: true, isSigner: true }],
        assignIx.data,
        [target]
      );
      const passkeyInitiated = await program.account.pendingAction.fetch(pendingActionPda);
      assert.equal(passkeyInitiated.initiatorSession.toBase58(), PublicKey.default.toBase58());
      await expectAnchorError(
        callConfirmPendingAction(passkey, walletPda, pendingActionPda, passkeysPda),
        "PendingActionNotSessionInitiated"
      );

      const s = await setupSessionInitiatedAction(true);
      await callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      await expectAnchorError(
        callConfirmPendingAction(s.secondPasskey!, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "PendingActionAlreadyConfirmed"
      );
    });

    it("[155] confirm_pending_action weigert als de initiërende sessie is ingetrokken (remove_session_key), ook als dezelfde sleutel daarna opnieuw als sessie zonder can_execute_advanced wordt toegevoegd", async () => {
      const s = await setupSessionInitiatedAction(false);
      await provider.sendAndConfirm(await buildRemoveSessionKeyTx(s.passkey, s.walletPda, s.passkeysPda, s.sessionKeypair.publicKey));
      await expectAnchorError(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "InitiatingSessionRevoked"
      );

      await callAddSpendSessionKey(s.passkey, s.walletPda, s.passkeysPda, s.policyPda, s.sessionKeypair.publicKey, { canExecute: true });
      await expectAnchorError(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "InitiatingSessionRevoked"
      );
      const pending = await program.account.pendingAction.fetch(s.pendingActionPda);
      assert.isTrue(Buffer.from(pending.initiatorPasskey).equals(Buffer.alloc(33)), "de actie moet onbevestigd blijven");

      // Opruimen blijft altijd mogelijk.
      await callCancelAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda);
      assert.isNull(await provider.connection.getAccountInfo(s.pendingActionPda, "processed"));
    });

    it("[155] confirm_pending_action weigert als de sessie zichzelf gesloten heeft (close_session)", async () => {
      const s = await setupSessionInitiatedAction(false);
      await program.methods
        .closeSession()
        .accounts({
          wallet: s.walletPda,
          session: deriveSessionPda(s.walletPda, s.sessionKeypair.publicKey),
          sessionKey: s.sessionKeypair.publicKey,
        })
        .signers([s.sessionKeypair])
        .rpc();
      await expectAnchorError(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "InitiatingSessionRevoked"
      );
    });

    it("[155] confirm_pending_action weigert na het verlopen van de initiërende sessie (SessionExpired), en ook nadat een derde de verlopen sessie heeft opgeruimd (InitiatingSessionRevoked)", async () => {
      const s = await setupSessionInitiatedAction(false, 40);
      const sessionPda = deriveSessionPda(s.walletPda, s.sessionKeypair.publicKey);
      const session = await program.account.sessionKeyAccount.fetch(sessionPda);
      await advanceSlotPast(provider.connection, payerKeypair(), session.expirySlot.toNumber());
      await expectAnchorError(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "SessionExpired"
      );

      const thirdParty = Keypair.generate();
      await provider.sendAndConfirm(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: thirdParty.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL / 100,
          })
        )
      );
      await program.methods
        .closeExpiredSession(s.sessionKeypair.publicKey)
        .accounts({ wallet: s.walletPda, session: sessionPda, closer: thirdParty.publicKey })
        .signers([thirdParty])
        .rpc();
      await expectAnchorError(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        "InitiatingSessionRevoked"
      );
    });

    it("confirm_pending_action na een voltooide recovery faalt met PendingActionStaleEpoch", async () => {
      const wallet = await createWallet(3);
      await callAddAllowedProgram(wallet.passkey, wallet.walletPda, wallet.policyPda, SystemProgram.programId);
      const sessionKeypair = Keypair.generate();
      await callAddAdvancedSessionKey(
        wallet.passkey,
        wallet.walletPda,
        wallet.passkeysPda,
        wallet.policyPda,
        sessionKeypair.publicKey,
        SystemProgram.programId
      );
      const { target, assignIx } = await setupAssignCpiFixture();
      await callInitiateAdvancedActionViaSession(
        sessionKeypair,
        wallet.walletPda,
        wallet.vaultPda,
        wallet.pendingActionPda,
        wallet.policyPda,
        wallet.passkeysPda,
        SystemProgram.programId,
        [{ pubkey: target.publicKey, isWritable: true, isSigner: true }],
        assignIx.data,
        [target]
      );

      const newOwner = generateTestPasskey();
      await callInitiateRecovery(wallet.backupAuthority, wallet.walletPda, Array.from(newOwner.compressedPublicKey));
      const afterInitiate = await program.account.walletAccount.fetch(wallet.walletPda);
      await advanceOnChainClockPast(
        provider.connection,
        payerKeypair(),
        afterInitiate.recoveryState!.initiatedAt.toNumber() + 3
      );
      await callFinalizeRecovery(wallet.walletPda, wallet.passkeysPda);

      await expectAnchorError(
        callConfirmPendingAction(newOwner, wallet.walletPda, wallet.pendingActionPda, wallet.passkeysPda),
        "PendingActionStaleEpoch"
      );
    });

    it("BEZET SLOT: de eigenaar maakt het altijd vrij (remove_session_key, dan cancel_action); de sessie kan daarna niet opnieuw initiëren; een VOORAF ondertekende remove_session_key blijft geldig ondanks sessie-activiteit (nonce onaangeroerd)", async () => {
      const wallet = await createWallet();
      await callAddAllowedProgram(wallet.passkey, wallet.walletPda, wallet.policyPda, SystemProgram.programId);
      const sessionKeypair = Keypair.generate();
      await callAddAdvancedSessionKey(
        wallet.passkey,
        wallet.walletPda,
        wallet.passkeysPda,
        wallet.policyPda,
        sessionKeypair.publicKey,
        SystemProgram.programId
      );

      // De eigenaar ondertekent de intrekking NU (nonce n)...
      const removeTx = await buildRemoveSessionKeyTx(
        wallet.passkey,
        wallet.walletPda,
        wallet.passkeysPda,
        sessionKeypair.publicKey
      );

      // ...de sessie bezet ondertussen de wachtrij...
      const first = await setupAssignCpiFixture();
      await callInitiateAdvancedActionViaSession(
        sessionKeypair,
        wallet.walletPda,
        wallet.vaultPda,
        wallet.pendingActionPda,
        wallet.policyPda,
        wallet.passkeysPda,
        SystemProgram.programId,
        [{ pubkey: first.target.publicKey, isWritable: true, isSigner: true }],
        first.assignIx.data,
        [first.target]
      );

      // ...en de vooraf ondertekende intrekking gaat nog steeds door.
      await provider.sendAndConfirm(removeTx);
      assert.isNull(
        await provider.connection.getAccountInfo(deriveSessionPda(wallet.walletPda, sessionKeypair.publicKey)),
        "sessie had ingetrokken moeten zijn"
      );

      const payerBalanceBefore = await provider.connection.getBalance(provider.wallet.publicKey);
      await callCancelAction(wallet.passkey, wallet.walletPda, wallet.pendingActionPda, wallet.passkeysPda);
      assert.isNull(await provider.connection.getAccountInfo(wallet.pendingActionPda), "slot had vrij moeten zijn");
      const payerBalanceAfter = await provider.connection.getBalance(provider.wallet.publicKey);
      assert.isAbove(payerBalanceAfter, payerBalanceBefore, "de rent van de sessie-initiatie gaat naar de eigenaar die annuleert");

      const second = await setupAssignCpiFixture();
      let threw = false;
      try {
        await callInitiateAdvancedActionViaSession(
          sessionKeypair,
          wallet.walletPda,
          wallet.vaultPda,
          wallet.pendingActionPda,
          wallet.policyPda,
          wallet.passkeysPda,
          SystemProgram.programId,
          [{ pubkey: second.target.publicKey, isWritable: true, isSigner: true }],
          second.assignIx.data,
          [second.target]
        );
      } catch {
        threw = true;
      }
      assert.isTrue(threw, "een ingetrokken sessie mag niet opnieuw kunnen initiëren");
      assert.isNull(await provider.connection.getAccountInfo(wallet.pendingActionPda));
    });

    it("BEZET SLOT tijdens een lopende recovery: cancel_action werkt, en de sessie kan dan niet opnieuw initiëren", async () => {
      const wallet = await createWallet();
      await callAddAllowedProgram(wallet.passkey, wallet.walletPda, wallet.policyPda, SystemProgram.programId);
      const sessionKeypair = Keypair.generate();
      await callAddAdvancedSessionKey(
        wallet.passkey,
        wallet.walletPda,
        wallet.passkeysPda,
        wallet.policyPda,
        sessionKeypair.publicKey,
        SystemProgram.programId
      );
      const first = await setupAssignCpiFixture();
      await callInitiateAdvancedActionViaSession(
        sessionKeypair,
        wallet.walletPda,
        wallet.vaultPda,
        wallet.pendingActionPda,
        wallet.policyPda,
        wallet.passkeysPda,
        SystemProgram.programId,
        [{ pubkey: first.target.publicKey, isWritable: true, isSigner: true }],
        first.assignIx.data,
        [first.target]
      );
      await callInitiateRecovery(wallet.backupAuthority, wallet.walletPda, dummyNewOwnerPasskey());

      await callCancelAction(wallet.passkey, wallet.walletPda, wallet.pendingActionPda, wallet.passkeysPda);
      assert.isNull(await provider.connection.getAccountInfo(wallet.pendingActionPda));

      const second = await setupAssignCpiFixture();
      await expectAnchorError(
        callInitiateAdvancedActionViaSession(
          sessionKeypair,
          wallet.walletPda,
          wallet.vaultPda,
          wallet.pendingActionPda,
          wallet.policyPda,
          wallet.passkeysPda,
          SystemProgram.programId,
          [{ pubkey: second.target.publicKey, isWritable: true, isSigner: true }],
          second.assignIx.data,
          [second.target]
        ),
        "RecoveryAlreadyInProgress"
      );
    });
  });

  describe("cancel_action: handmatige close met Anchor's close-semantiek (STATUS.md sectie 153)", () => {
    async function buildCancelActionIxs(
      signingPasskey: TestPasskey,
      walletPda: PublicKey,
      pendingActionPda: PublicKey,
      passkeysPda: PublicKey,
      nonce: bigint,
      rentReceiver: PublicKey = provider.wallet.publicKey
    ) {
      const payload = Buffer.concat([nonceLeBytes(nonce), pendingActionPda.toBuffer()]);
      const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "cancel_action", payload);
      const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(signingPasskey, expectedChallenge);
      const secp256r1Ix = buildSecp256r1Instruction(signingPasskey.compressedPublicKey, signedMessage, rawSignature);
      const cancelIx = await program.methods
        .cancelAction(new BN(nonce.toString()), clientDataJSON)
        .accounts({
          wallet: walletPda,
          pendingAction: pendingActionPda,
          passkeys: passkeysPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          payer: rentReceiver,
        })
        .instruction();
      return [secp256r1Ix, cancelIx];
    }

    it("na cancel_action: account weg (0 lamports), rent EXACT en volledig naar de payer van cancel_action", async () => {
      const s = await setupSessionInitiatedAction(false);
      // Alles op dezelfde commitment als de provider zelf bevestigt
      // ("processed"): gemengde commitments gaven hier eerder schijnbare
      // afwijkingen (stale reads), geen echte.
      const pendingLamports = (await provider.connection.getAccountInfo(s.pendingActionPda, "processed"))!.lamports;
      // Aparte, verse rent-ontvanger (niet de fee-payer), zodat de
      // saldowijziging exact de teruggegeven rent is - geen fee-rekensom.
      const rentReceiver = Keypair.generate();
      const nonce = await fetchActionNonce(provider.connection, s.walletPda);
      const ixs = await buildCancelActionIxs(
        s.passkey,
        s.walletPda,
        s.pendingActionPda,
        s.passkeysPda,
        nonce,
        rentReceiver.publicKey
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(...ixs), [rentReceiver]);
      const received = await provider.connection.getBalance(rentReceiver.publicKey, "processed");
      assert.equal(received, pendingLamports, "de payer van cancel_action ontvangt exact alle lamports van de PendingAction");
      assert.isNull(await provider.connection.getAccountInfo(s.pendingActionPda, "processed"));
    });

    it("REVIVAL in dezelfde transactie (lamports terugsturen na cancel): het account komt terug als leeg System-account, NIET als PendingAction - finalize/confirm werken er niet op, en het slot is gewoon opnieuw bruikbaar", async () => {
      const s = await setupSessionInitiatedAction(false);
      const rent = await provider.connection.getMinimumBalanceForRentExemption(164);
      const commitmentBeforeCancel = Buffer.from(
        (await program.account.pendingAction.fetch(s.pendingActionPda)).actionCommitment
      );
      const nonce = await fetchActionNonce(provider.connection, s.walletPda);
      const cancelIxs = await buildCancelActionIxs(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda, nonce);
      const revive = SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: s.pendingActionPda,
        lamports: rent,
      });
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(...cancelIxs, revive));

      const revived = await provider.connection.getAccountInfo(s.pendingActionPda);
      assert.isNotNull(revived, "het account bestaat weer (lamports teruggestuurd)");
      assert.equal(revived!.owner.toBase58(), SystemProgram.programId.toBase58(), "eigenaar moet het System Program zijn");
      assert.equal(revived!.data.length, 0, "data moet leeg zijn");
      let fetchFailed = false;
      try {
        await program.account.pendingAction.fetch(s.pendingActionPda);
      } catch {
        fetchFailed = true;
      }
      assert.isTrue(fetchFailed, "het gerevivede account mag niet als PendingAction deserialiseren");

      // Beide gebouwd met de vooraf vastgelegde commitment - de weigering
      // moet van het programma komen (typed Account<PendingAction> op een
      // System-owned account), niet van een client-side fetch.
      const nonceAfterCancel = await fetchActionNonce(provider.connection, s.walletPda);
      const confirmIxs = await buildConfirmPendingActionIxs(
        s.passkey,
        s.walletPda,
        s.pendingActionPda,
        s.passkeysPda,
        nonceAfterCancel,
        commitmentBeforeCancel,
        s.sessionKeypair.publicKey
      );
      await expectAnchorError(
        provider.sendAndConfirm(new anchor.web3.Transaction().add(...confirmIxs)),
        "AccountOwnedByWrongProgram"
      );

      const finalizePayload = Buffer.concat([
        nonceLeBytes(nonceAfterCancel),
        s.pendingActionPda.toBuffer(),
        commitmentBeforeCancel,
      ]);
      const finalizeSigned = signTestChallenge(
        s.passkey,
        buildExpectedChallenge(program.programId, s.walletPda, "finalize_advanced_action", finalizePayload)
      );
      const finalizeIx = await program.methods
        .finalizeAdvancedAction(s.assignIx.data, new BN(nonceAfterCancel.toString()), finalizeSigned.clientDataJSON)
        .accounts({
          wallet: s.walletPda,
          vault: s.vaultPda,
          pendingAction: s.pendingActionPda,
          policy: s.policyPda,
          cpiProgram: SystemProgram.programId,
          passkeys: s.passkeysPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          closer: provider.wallet.publicKey,
        })
        .remainingAccounts(s.remainingAccounts)
        .instruction();
      await expectAnchorError(
        provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            buildSecp256r1Instruction(
              s.passkey.compressedPublicKey,
              finalizeSigned.signedMessage,
              finalizeSigned.rawSignature
            ),
            finalizeIx
          ),
          [s.target]
        ),
        "AccountOwnedByWrongProgram"
      );
      await assertTargetUnassigned(s.target);

      // Het slot is gewoon opnieuw bruikbaar (init op een voorgefinancierd
      // system-account): geen permanente blokkade door de revival.
      const again = await setupAssignCpiFixture();
      await callInitiateAdvancedActionViaSession(
        s.sessionKeypair,
        s.walletPda,
        s.vaultPda,
        s.pendingActionPda,
        s.policyPda,
        s.passkeysPda,
        SystemProgram.programId,
        [{ pubkey: again.target.publicKey, isWritable: true, isSigner: true }],
        again.assignIx.data,
        [again.target]
      );
      const fresh = await program.account.pendingAction.fetch(s.pendingActionPda);
      assert.deepEqual(Array.from(fresh.initiatorPasskey), new Array(33).fill(0), "een verse, onbevestigde actie - geen overgebleven oude staat");
    });

    it("REVIVAL-poging binnen dezelfde transactie én hergebruik als PendingAction faalt atomisch: cancel + lamports terug + confirm op hetzelfde account in één tx wordt volledig teruggedraaid", async () => {
      const s = await setupSessionInitiatedAction(true);
      const rent = await provider.connection.getMinimumBalanceForRentExemption(164);
      const nonce = await fetchActionNonce(provider.connection, s.walletPda);
      const pendingBefore = await provider.connection.getAccountInfo(s.pendingActionPda);

      const cancelIxs = await buildCancelActionIxs(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda, nonce);
      const revive = SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: s.pendingActionPda,
        lamports: rent,
      });
      const confirmIxs = await buildConfirmPendingActionIxs(
        s.secondPasskey!,
        s.walletPda,
        s.pendingActionPda,
        s.passkeysPda,
        nonce + 1n
      );

      await expectAnchorError(
        provider.sendAndConfirm(new anchor.web3.Transaction().add(...cancelIxs, revive, ...confirmIxs)),
        "AccountOwnedByWrongProgram"
      );

      // Atomisch teruggedraaid: de oorspronkelijke PendingAction is er nog,
      // byte-voor-byte onveranderd, en nog steeds onbevestigd.
      const pendingAfter = await provider.connection.getAccountInfo(s.pendingActionPda);
      assert.isTrue(Buffer.from(pendingAfter!.data).equals(Buffer.from(pendingBefore!.data)));
      assert.equal(pendingAfter!.owner.toBase58(), program.programId.toBase58());
    });
  });

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
      // single-passkey-degradatie: confirmed moet al true zijn na initiate.
      assert.isTrue(pendingAfterInitiate.confirmed, "confirmed had na initiate met 1 passkey al true moeten zijn");
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

    it("5. recovery tijdens pending: finalize faalt met PendingActionStaleEpoch na een voltooide recovery", async () => {
      const recoveryTimelockSeconds = 3;
      const { passkey, backupAuthority, walletPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet(recoveryTimelockSeconds);
      const newThreshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      const newWindowCap = new BN(anchor.web3.LAMPORTS_PER_SOL);
      await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, newThreshold, newWindowCap);

      await callInitiateRecovery(backupAuthority, walletPda, dummyNewOwnerPasskey());
      const walletAfterRecoveryInitiate = await program.account.walletAccount.fetch(walletPda);
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        walletAfterRecoveryInitiate.recoveryState.initiatedAt.toNumber() + recoveryTimelockSeconds
      );
      await callFinalizeRecovery(walletPda, passkeysPda);

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
        "PendingActionStaleEpoch"
      );
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

  // ================= execute/hunt drempel-gating (STATUS.md sectie 127/128, stap A/Route 2) =================
  // Alleen de threshold > 0-gevallen - threshold = 0 (ongewijzigd gedrag)
  // staat in tests/spendThreshold.ts, dat geen wachtrij/timelock nodig
  // heeft. Hier WEL nodig: een niet-nul drempel zetten vereist
  // finalize_threshold_change, dus de verkorte testtimelock van dit
  // bestand.

  async function setThreshold(
    passkey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    spendWindowPda: PublicKey,
    threshold: BN,
    // STATUS.md sectie 132/133/134 (stap c): optioneel, standaard ruim
    // boven de drempel (zodat de bestaande drempel-gating-tests hierboven
    // nooit toevallig tegen de venstercap aanlopen) - de SpendWindow-
    // handhavingstests hieronder geven een expliciet KRAPPE cap mee.
    windowCap?: BN
  ) {
    const cap = windowCap ?? threshold.mul(new BN(10)).add(new BN(anchor.web3.LAMPORTS_PER_SOL));
    await callInitiateThresholdChange(passkey, walletPda, pendingActionPda, passkeysPda, threshold, cap);
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
      threshold,
      cap
    );
  }

  describe("execute/hunt drempel-gating, threshold > 0", () => {
    it("execute: bedrag op of onder de drempel gaat instant door", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold);

      const recipient = Keypair.generate().publicKey;
      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);
      const vaultAfter = await provider.connection.getBalance(vaultPda);

      assert.equal(vaultBefore - vaultAfter, threshold.toNumber());
      assert.equal(await provider.connection.getBalance(recipient), threshold.toNumber());
    });

    it("execute: bedrag boven de drempel wordt geweigerd met AmountExceedsInstantThreshold, aantoonbaar niets verplaatst", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold);

      const recipient = Keypair.generate().publicKey;
      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await expectAnchorError(
        callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold.add(new BN(1))),
        "AmountExceedsInstantThreshold"
      );
      const vaultAfter = await provider.connection.getBalance(vaultPda);

      assert.equal(vaultBefore, vaultAfter, "vault-balans had ongewijzigd moeten blijven na de weigering");
      assert.equal(await provider.connection.getBalance(recipient), 0, "recipient had niets moeten ontvangen");
    });

    it("hunt: to_user (wat naar rent_destination gaat) op of onder de drempel slaagt normaal", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);

      const tokenAccountRent = await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
      const toIncinerator = Math.floor(tokenAccountRent / 2);
      const toUser = tokenAccountRent - toIncinerator;
      const threshold = new BN(toUser); // exact op de grens - moet nog slagen (<=).
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold);

      const rentDestination = Keypair.generate().publicKey;
      await callHunt(passkey, walletPda, vaultPda, passkeysPda, tokenAccount.publicKey, mint.publicKey, rentDestination);

      const closedInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNull(closedInfo, "target_token_account had gesloten moeten zijn na hunt");
      assert.equal(await provider.connection.getBalance(rentDestination), toUser);
    });

    it("hunt: to_user boven de drempel wordt geweigerd met AmountExceedsInstantThreshold, aantoonbaar niets verplaatst/gesloten", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);

      const tokenAccountRent = await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
      const toIncinerator = Math.floor(tokenAccountRent / 2);
      const toUser = tokenAccountRent - toIncinerator;
      const threshold = new BN(toUser - 1); // net onder wat hunt zou uitkeren - moet weigeren.
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold);

      const rentDestination = Keypair.generate().publicKey;
      const vaultBefore = await provider.connection.getBalance(vaultPda);
      const tokenAccountInfoBefore = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNotNull(tokenAccountInfoBefore);

      await expectAnchorError(
        callHunt(passkey, walletPda, vaultPda, passkeysPda, tokenAccount.publicKey, mint.publicKey, rentDestination),
        "AmountExceedsInstantThreshold"
      );

      // Solana se transactie-atomiciteit: de burn/close-CPI's die vóór de
      // check in instructions.rs::hunt draaiden, zijn net zo goed
      // teruggedraaid als de rest van de instructie faalt - het
      // spam-token-account bestaat dus nog gewoon, ongewijzigd.
      const tokenAccountInfoAfter = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNotNull(tokenAccountInfoAfter, "target_token_account had NIET gesloten moeten zijn na de weigering");
      assert.equal(await provider.connection.getBalance(vaultPda), vaultBefore);
      assert.equal(await provider.connection.getBalance(rentDestination), 0);
    });

    it("symmetrie: een bedrag dat execute weigert wordt door initiate_withdrawal geaccepteerd, en omgekeerd", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold);

      const recipient = Keypair.generate().publicKey;

      // Boven de drempel: execute weigert, initiate_withdrawal accepteert.
      const amountOver = threshold.add(new BN(1));
      await expectAnchorError(
        callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, amountOver),
        "AmountExceedsInstantThreshold"
      );
      await callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amountOver);
      const queuedOver = await program.account.pendingAction.fetch(pendingActionPda);
      assert.equal(queuedOver.kind, 0, "initiate_withdrawal had moeten slagen voor het bedrag dat execute weigerde");
      // Opruimen zodat de singleton-PDA vrij is voor de volgende helft van
      // deze test - bewijst meteen dat cancel_action ook hier werkt.
      await callCancelAction(passkey, walletPda, pendingActionPda, passkeysPda);

      // Op of onder de drempel: execute accepteert, initiate_withdrawal weigert.
      const amountUnder = threshold;
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, amountUnder);
      await expectAnchorError(
        callInitiateWithdrawal(passkey, walletPda, pendingActionPda, passkeysPda, recipient, amountUnder),
        "AmountEligibleForInstantExecute"
      );
    });
  });

  // ================= SpendWindow-handhaving (STATUS.md sectie 132/133/134, stap B/stap c) =================
  // De drie tests hieronder testen de cap zelf (nooit een rollover) - ze
  // hebben geen korte WINDOW_DURATION_SECONDS nodig en draaien gewoon mee
  // onder de bestaande yarn test:pending-action. setThreshold's windowCap-
  // parameter (hierboven uitgebreid) geeft ze een expliciet KRAPPE cap,
  // i.p.v. de ruime 10x-standaard die de drempel-gating-tests hierboven
  // gebruiken - anders zou geen van die tests ooit de cap raken.
  describe("SpendWindow-handhaving (execute/hunt, threshold > 0)", () => {
    it("happy path: bedragen binnen de cap slagen, spent_lamports_this_window telt correct op over twee aanroepen", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      // Exact 2x threshold: twee aanroepen op de drempel passen precies,
      // bewijst dat de teller optelt over meerdere aanroepen, niet alleen
      // een enkele aanroep tegen de cap toetst.
      const windowCap = threshold.mul(new BN(2));
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold, windowCap);

      const recipient = Keypair.generate().publicKey;

      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);
      let spendWindow = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        spendWindow.spentLamportsThisWindow.toString(),
        threshold.toString(),
        "na de eerste aanroep moet de teller exact het eerste bedrag bevatten"
      );

      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);
      spendWindow = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        spendWindow.spentLamportsThisWindow.toString(),
        windowCap.toString(),
        "na de tweede aanroep moet de teller de SOM van beide bedragen bevatten, exact op de cap"
      );
      assert.equal(await provider.connection.getBalance(recipient), windowCap.toNumber());
    });

    it("weigering boven de cap: SpendWindowExceeded, aantoonbaar niets verplaatst, teller ongewijzigd", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      // Cap exact gelijk aan de drempel: de eerste aanroep gebruikt 'm
      // volledig op, dus ZELFS 1 lamport erbovenop moet nu weigeren.
      const windowCap = threshold;
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold, windowCap);

      const recipient = Keypair.generate().publicKey;
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);

      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await expectAnchorError(
        callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, new BN(1)),
        "SpendWindowExceeded"
      );
      const vaultAfter = await provider.connection.getBalance(vaultPda);

      assert.equal(vaultBefore, vaultAfter, "vault-balans had ongewijzigd moeten blijven na de weigering");
      const spendWindow = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        spendWindow.spentLamportsThisWindow.toString(),
        threshold.toString(),
        "de teller mag door de geweigerde poging niet zijn opgehoogd"
      );
    });

    it("hunt deelt dezelfde SpendWindow-teller als execute (één gedeeld venster voor beide instant-paden)", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
      const tokenAccountRent = await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
      const toIncinerator = Math.floor(tokenAccountRent / 2);
      const toUser = tokenAccountRent - toIncinerator;

      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10); // ruim boven executeAmount/toUser - nooit de reden van een weigering hier.
      const executeAmount = new BN(toUser);
      // Net te weinig ruimte over voor hunt's to_user na execute's bijdrage.
      const windowCap = executeAmount.add(new BN(toUser)).sub(new BN(1));
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold, windowCap);

      const recipient = Keypair.generate().publicKey;
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, executeAmount);

      const rentDestination = Keypair.generate().publicKey;
      await expectAnchorError(
        callHunt(passkey, walletPda, vaultPda, passkeysPda, tokenAccount.publicKey, mint.publicKey, rentDestination),
        "SpendWindowExceeded"
      );

      // Solana se transactie-atomiciteit: hunt's burn/close-CPI's die vóór
      // de check draaiden, zijn teruggedraaid - het spam-token-account
      // bestaat nog gewoon.
      const tokenAccountInfoAfter = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNotNull(
        tokenAccountInfoAfter,
        "target_token_account had NIET gesloten moeten zijn na de geweigerde hunt"
      );
      assert.equal(await provider.connection.getBalance(rentDestination), 0);

      // De teller bevat uitsluitend execute's geslaagde bijdrage - hunt's
      // geweigerde poging heeft 'm niet aangeraakt. Bewijst dat het
      // GEDEELDE venster is (hunt's poging zag execute's eerdere
      // bijdrage al), niet dat hunt zijn eigen, losse teller heeft.
      const spendWindow = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(spendWindow.spentLamportsThisWindow.toString(), executeAmount.toString());
    });
  });

  // ================= Noodstop (freeze/unfreeze) =================
  //
  // Zelfde per-bestand-onafhankelijkheidsconventie als hierboven. Bewust in
  // deze suite (fast timelock): ontdooien via de wachtrij vraagt de
  // verkorte testtimelock, en de blokkade-tests hergebruiken de helpers
  // voor alle vier de wachtrijsoorten.

  // Chrome voegt dit veld toe aan clientDataJSON; gebruikt voor een
  // realistische transactiegroottemeting.
  // Ruim boven het rent-minimum van een nieuw ontvangeraccount: zonder
  // bevriezing zou elke SOL-uitgave hieronder echt slagen, zodat een
  // WalletDisarmed-weigering niet toevallig samenvalt met een rent-fout.
  const NOODSTOP_SPEND = new BN(anchor.web3.LAMPORTS_PER_SOL / 100);

  const CHROME_LIKE_CLIENT_DATA_EXTRA = {
    other_keys_can_be_added_here:
      "do not compare clientDataJSON against a template. See https://goo.gl/yabPex",
  };

  async function passkeyIxs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    domain: string,
    payloadAfterNonce: Buffer,
    nonce: bigint,
    extraClientData: Record<string, unknown> = {}
  ) {
    const payload = Buffer.concat([nonceLeBytes(nonce), payloadAfterNonce]);
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, domain, payload);
    const signed = signTestChallenge(signingPasskey, expectedChallenge, undefined, undefined, extraClientData);
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signed.signedMessage,
      signed.rawSignature
    );
    return { secp256r1Ix, clientDataJSON: signed.clientDataJSON };
  }

  async function buildFreezeViaPasskeyIxs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    nonceOverride?: bigint
  ) {
    const nonce = nonceOverride ?? (await fetchActionNonce(provider.connection, walletPda));
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(signingPasskey, walletPda, "freeze", Buffer.alloc(0), nonce);
    const freezeIx = await program.methods
      .freezeViaPasskey(new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: walletPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return [secp256r1Ix, freezeIx];
  }

  async function callFreezeViaPasskey(signingPasskey: TestPasskey, walletPda: PublicKey, passkeysPda: PublicKey) {
    const ixs = await buildFreezeViaPasskeyIxs(signingPasskey, walletPda, passkeysPda);
    return provider.sendAndConfirm(new anchor.web3.Transaction().add(...ixs));
  }

  async function callFreezeViaBackup(backupAuthority: Keypair, walletPda: PublicKey) {
    return program.methods
      .freezeViaBackupAuthority()
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();
  }

  /// Met de hand opgebouwd (zie instructionDiscriminator): data = discriminator ||
  /// Vec<[u8; 33]> passkeys_to_remove, accounts in de volgorde van
  /// UnfreezeViaBackupAuthority.
  function buildUnfreezeViaBackupIx(
    backupAuthority: Keypair,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    passkeysToRemove: Buffer[] = []
  ) {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(passkeysToRemove.length, 0);
    return new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: pendingActionPda, isSigner: false, isWritable: true },
        { pubkey: backupAuthority.publicKey, isSigner: true, isWritable: true },
        { pubkey: passkeysPda, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([instructionDiscriminator("unfreeze_via_backup_authority"), count, ...passkeysToRemove]),
    });
  }

  async function callUnfreezeViaBackup(
    backupAuthority: Keypair,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    passkeysToRemove: Buffer[] = []
  ) {
    const ix = buildUnfreezeViaBackupIx(backupAuthority, walletPda, pendingActionPda, passkeysPda, passkeysToRemove);
    return provider.sendAndConfirm(new anchor.web3.Transaction().add(ix), [backupAuthority]);
  }

  async function callInitiateUnfreeze(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(
      signingPasskey,
      walletPda,
      "initiate_unfreeze",
      Buffer.alloc(0),
      nonce
    );
    return program.methods
      .initiateUnfreeze(new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function buildFinalizeUnfreezeIxs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey,
    nonce: bigint,
    extraClientData: Record<string, unknown> = {}
  ) {
    const pending = await program.account.pendingAction.fetch(pendingActionPda);
    const commitment = Buffer.from(pending.actionCommitment);
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(
      signingPasskey,
      walletPda,
      "finalize_unfreeze",
      Buffer.concat([pendingActionPda.toBuffer(), commitment]),
      nonce,
      extraClientData
    );
    const finalizeIx = await program.methods
      .finalizeUnfreeze(new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer: provider.wallet.publicKey,
      })
      .instruction();
    return [secp256r1Ix, finalizeIx];
  }

  async function callFinalizeUnfreeze(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    pendingActionPda: PublicKey,
    passkeysPda: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const ixs = await buildFinalizeUnfreezeIxs(signingPasskey, walletPda, pendingActionPda, passkeysPda, nonce);
    return provider.sendAndConfirm(new anchor.web3.Transaction().add(...ixs));
  }

  async function buildRemovePasskeyIxs(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    targetPasskey: Buffer,
    nonce: bigint,
    extraClientData: Record<string, unknown> = {}
  ) {
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(
      signingPasskey,
      walletPda,
      "remove_passkey",
      targetPasskey,
      nonce,
      extraClientData
    );
    const removeIx = await program.methods
      .removePasskey(Array.from(targetPasskey), new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: walletPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return [secp256r1Ix, removeIx];
  }

  async function callRemovePasskey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    targetPasskey: Buffer
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const ixs = await buildRemovePasskeyIxs(signingPasskey, walletPda, passkeysPda, targetPasskey, nonce);
    return provider.sendAndConfirm(new anchor.web3.Transaction().add(...ixs));
  }

  /// Sessie met can_execute en/of can_transfer_token (ruime caps), voor de
  /// _via_session-blokkadetests.
  async function callAddSpendSessionKey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    policyPda: PublicKey,
    sessionKey: PublicKey,
    opts: { canExecute: boolean; tokenMint?: PublicKey; expirySlots?: number }
  ) {
    const canTransferToken = opts.tokenMint !== undefined;
    const tokenMint = opts.tokenMint ?? PublicKey.default;
    const expirySlot = (await provider.connection.getSlot()) + (opts.expirySlots ?? 100_000);
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const expirySlotBuf = Buffer.alloc(8);
    expirySlotBuf.writeBigUInt64LE(BigInt(expirySlot), 0);
    const countBuf = Buffer.alloc(4);
    const zero = new BN(0);
    const tokenCap = canTransferToken ? MAX_U64 : zero;
    const payloadAfterNonce = Buffer.concat([
      sessionKey.toBuffer(),
      expirySlotBuf,
      Buffer.from([opts.canExecute ? 1 : 0, canTransferToken ? 1 : 0, 0]),
      countBuf,
      MAX_U64.toArrayLike(Buffer, "le", 8),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      tokenMint.toBuffer(),
      tokenCap.toArrayLike(Buffer, "le", 8),
      tokenCap.toArrayLike(Buffer, "le", 8),
    ]);
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(
      signingPasskey,
      walletPda,
      "add_session_key",
      payloadAfterNonce,
      nonce
    );
    return program.methods
      .addSessionKey(
        sessionKey,
        new BN(expirySlot),
        opts.canExecute,
        canTransferToken,
        false,
        [],
        MAX_U64,
        MAX_U64,
        tokenMint,
        tokenCap,
        tokenCap,
        new BN(nonce.toString()),
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        session: deriveSessionPda(walletPda, sessionKey),
        payer: provider.wallet.publicKey,
        policy: policyPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callCancelRecovery(signingPasskey: TestPasskey, walletPda: PublicKey, passkeysPda: PublicKey) {
    const wallet = await program.account.walletAccount.fetch(walletPda);
    const recovery = wallet.recoveryState!;
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const initiatedAt = Buffer.alloc(8);
    initiatedAt.writeBigInt64LE(BigInt(recovery.initiatedAt.toString()), 0);
    const { secp256r1Ix, clientDataJSON } = await passkeyIxs(
      signingPasskey,
      walletPda,
      "cancel_recovery",
      Buffer.concat([initiatedAt, Buffer.from(recovery.newOwnerPasskey)]),
      nonce
    );
    return program.methods
      .cancelRecovery(new BN(nonce.toString()), clientDataJSON)
      .accounts({ wallet: walletPda, passkeys: passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  /// action_nonce op "processed" (commitment van de provider): direct na
  /// een bevestigde transactie kan fetchActionNonce ("confirmed") nog de
  /// vorige waarde tonen.
  async function actionNonceProcessed(walletPda: PublicKey): Promise<bigint> {
    const info = await provider.connection.getAccountInfo(walletPda, "processed");
    return info!.data.readBigUInt64LE(actionNonceOffset(info!.data));
  }

  type AccountSnapshot = Map<string, string>;

  /// Volledige toestand (lamports, eigenaar, ruwe data) van de gegeven
  /// accounts - bewijs dat een geweigerde aanroep aantoonbaar niets
  /// veranderde. Op "processed", dezelfde commitment als de provider.
  async function snapshot(addresses: PublicKey[]): Promise<AccountSnapshot> {
    const out: AccountSnapshot = new Map();
    for (const a of addresses) {
      const info = await provider.connection.getAccountInfo(a, "processed");
      out.set(
        a.toBase58(),
        info === null ? "null" : `${info.lamports}|${info.owner.toBase58()}|${Buffer.from(info.data).toString("base64")}`
      );
    }
    return out;
  }

  function assertSnapshotsEqual(before: AccountSnapshot, after: AccountSnapshot, label: string) {
    for (const [k, v] of before) {
      assert.equal(after.get(k), v, `${label}: account ${k} is veranderd`);
    }
  }

  async function expectBlockedAndUnchanged(promise: Promise<unknown>, watched: PublicKey[], label: string) {
    const before = await snapshot(watched);
    await expectAnchorError(promise, "WalletDisarmed");
    assertSnapshotsEqual(before, await snapshot(watched), label);
  }

  describe("Noodstop: bevriezen blokkeert alle waardepaden en directe bevoegdheidsuitbreidingen", () => {
    // Elke test: bevries, roep de instructie aan met een verder geldige
    // handtekening, verwacht WalletDisarmed, en bewijs dat de relevante
    // accounts byte voor byte onveranderd zijn.

    it("execute", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const recipient = Keypair.generate().publicKey;
      await expectBlockedAndUnchanged(
        callExecute(w.passkey, w.walletPda, w.vaultPda, w.passkeysPda, recipient, NOODSTOP_SPEND),
        [w.walletPda, w.vaultPda, recipient],
        "execute"
      );
    });

    it("hunt", async () => {
      const w = await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(w.vaultPda, 5);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callHunt(w.passkey, w.walletPda, w.vaultPda, w.passkeysPda, tokenAccount.publicKey, mint.publicKey, provider.wallet.publicKey),
        [w.walletPda, w.vaultPda, tokenAccount.publicKey, mint.publicKey],
        "hunt"
      );
    });

    it("execute_via_session", async () => {
      const w = await createWallet();
      const session = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true });
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const recipient = Keypair.generate().publicKey;
      const sessionPda = deriveSessionPda(w.walletPda, session.publicKey);
      await expectBlockedAndUnchanged(
        program.methods
          .executeViaSession(NOODSTOP_SPEND)
          .accounts({ wallet: w.walletPda, vault: w.vaultPda, recipient, session: sessionPda, sessionKey: session.publicKey })
          .signers([session])
          .rpc(),
        [w.walletPda, w.vaultPda, sessionPda, recipient],
        "execute_via_session"
      );
    });

    it("transfer_token_via_session", async () => {
      const w = await createWallet();
      const recipientOwner = Keypair.generate().publicKey;
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(w.vaultPda, recipientOwner, 1000);
      const session = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, {
        canExecute: false,
        tokenMint: mint.publicKey,
      });
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const sessionPda = deriveSessionPda(w.walletPda, session.publicKey);
      await expectBlockedAndUnchanged(
        program.methods
          .transferTokenViaSession(new BN(10))
          .accounts({
            wallet: w.walletPda,
            vault: w.vaultPda,
            vaultTokenAccount: vaultTokenAccount.publicKey,
            recipientTokenAccount: recipientTokenAccount.publicKey,
            tokenMint: mint.publicKey,
            session: sessionPda,
            sessionKey: session.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([session])
          .rpc(),
        [w.walletPda, vaultTokenAccount.publicKey, recipientTokenAccount.publicKey, sessionPda],
        "transfer_token_via_session"
      );
    });

    it("initiate_withdrawal", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, Keypair.generate().publicKey, NOODSTOP_SPEND),
        [w.walletPda, w.pendingActionPda],
        "initiate_withdrawal"
      );
    });

    it("initiate_token_transfer", async () => {
      const w = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(w.vaultPda, Keypair.generate().publicKey, 1000);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callInitiateTokenTransfer(
          w.passkey,
          w.walletPda,
          w.pendingActionPda,
          w.passkeysPda,
          recipientTokenAccount.publicKey,
          mint.publicKey,
          new BN(10),
          vaultTokenAccount.publicKey
        ),
        [w.walletPda, w.pendingActionPda],
        "initiate_token_transfer"
      );
    });

    it("initiate_advanced_action", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callInitiateAdvancedAction(
          w.passkey,
          w.walletPda,
          w.vaultPda,
          w.pendingActionPda,
          w.policyPda,
          w.passkeysPda,
          SystemProgram.programId,
          [{ pubkey: target.publicKey, isWritable: true, isSigner: true }],
          assignIx.data,
          [target]
        ),
        [w.walletPda, w.pendingActionPda, target.publicKey],
        "initiate_advanced_action"
      );
    });

    it("initiate_threshold_change", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callInitiateThresholdChange(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, new BN(1000), new BN(10000)),
        [w.walletPda, w.pendingActionPda],
        "initiate_threshold_change"
      );
    });

    it("initiate_advanced_action_via_session", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const session = Keypair.generate();
      await callAddAdvancedSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callInitiateAdvancedActionViaSession(
          session,
          w.walletPda,
          w.vaultPda,
          w.pendingActionPda,
          w.policyPda,
          w.passkeysPda,
          SystemProgram.programId,
          [{ pubkey: target.publicKey, isWritable: true, isSigner: true }],
          assignIx.data,
          [target]
        ),
        [w.walletPda, w.pendingActionPda, target.publicKey],
        "initiate_advanced_action_via_session"
      );
    });

    it("confirm_pending_action", async () => {
      const s = await setupSessionInitiatedAction(false);
      await callFreezeViaPasskey(s.passkey, s.walletPda, s.passkeysPda);
      await expectBlockedAndUnchanged(
        callConfirmPendingAction(s.passkey, s.walletPda, s.pendingActionPda, s.passkeysPda),
        [s.walletPda, s.pendingActionPda],
        "confirm_pending_action"
      );
    });

    it("finalize_withdrawal (ook na verstreken timelock)", async () => {
      const w = await createWallet();
      const recipient = Keypair.generate().publicKey;
      await callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, recipient, NOODSTOP_SPEND);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callFinalizeWithdrawal(w.passkey, w.walletPda, w.vaultPda, w.pendingActionPda, w.passkeysPda, recipient, NOODSTOP_SPEND),
        [w.walletPda, w.vaultPda, w.pendingActionPda, recipient],
        "finalize_withdrawal"
      );
    });

    it("finalize_token_transfer (ook na verstreken timelock)", async () => {
      const w = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(w.vaultPda, Keypair.generate().publicKey, 1000);
      await callInitiateTokenTransfer(
        w.passkey,
        w.walletPda,
        w.pendingActionPda,
        w.passkeysPda,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        new BN(10),
        vaultTokenAccount.publicKey
      );
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callFinalizeTokenTransfer(
          w.passkey,
          w.walletPda,
          w.vaultPda,
          w.pendingActionPda,
          w.passkeysPda,
          vaultTokenAccount.publicKey,
          recipientTokenAccount.publicKey,
          mint.publicKey,
          new BN(10)
        ),
        [w.walletPda, w.pendingActionPda, vaultTokenAccount.publicKey, recipientTokenAccount.publicKey],
        "finalize_token_transfer"
      );
    });

    it("finalize_advanced_action (ook na verstreken timelock)", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const { target, assignIx } = await setupAssignCpiFixture();
      const remaining: RemainingAccountSpec[] = [{ pubkey: target.publicKey, isWritable: true, isSigner: true }];
      await callInitiateAdvancedAction(
        w.passkey,
        w.walletPda,
        w.vaultPda,
        w.pendingActionPda,
        w.policyPda,
        w.passkeysPda,
        SystemProgram.programId,
        remaining,
        assignIx.data,
        [target]
      );
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callFinalizeAdvancedAction(
          w.passkey,
          w.walletPda,
          w.vaultPda,
          w.pendingActionPda,
          w.policyPda,
          w.passkeysPda,
          SystemProgram.programId,
          remaining,
          assignIx.data,
          [target]
        ),
        [w.walletPda, w.pendingActionPda, target.publicKey],
        "finalize_advanced_action"
      );
    });

    it("finalize_threshold_change (ook na verstreken timelock)", async () => {
      const w = await createWallet();
      await callInitiateThresholdChange(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, new BN(1000), new BN(10000));
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callFinalizeThresholdChange(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, w.spendWindowPda, new BN(1000), new BN(10000)),
        [w.walletPda, w.pendingActionPda, w.spendWindowPda],
        "finalize_threshold_change"
      );
    });

    it("add_passkey", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, generateTestPasskey().compressedPublicKey),
        [w.walletPda, w.passkeysPda],
        "add_passkey"
      );
    });

    it("remove_passkey", async () => {
      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callRemovePasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey),
        [w.walletPda, w.passkeysPda],
        "remove_passkey"
      );
    });

    it("add_session_key", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const session = Keypair.generate();
      await expectBlockedAndUnchanged(
        callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true }),
        [w.walletPda, deriveSessionPda(w.walletPda, session.publicKey)],
        "add_session_key"
      );
    });

    it("add_allowed_program", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await expectBlockedAndUnchanged(
        callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId),
        [w.walletPda, w.policyPda],
        "add_allowed_program"
      );
    });

    // Sectie 155 (verdediging in de diepte): deze drie falen sowieso al
    // onvoorwaardelijk in de body. De noodstop-constraint moet er daarnaast
    // zelf op staan, zodat de blokkade niet afhangt van die ene regel in de
    // body. Bewijs: de weigering is WalletDisarmed (account-constraint, vóór
    // de body), niet de queue-foutcode uit de body. Handtekeningen zijn
    // bewust dummy - de constraint moet vóór elke verificatie weigeren.

    it("[155] transfer_token", async () => {
      const w = await createWallet();
      const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(w.vaultPda, Keypair.generate().publicKey, 1000);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const nonce = await fetchActionNonce(provider.connection, w.walletPda);
      await expectBlockedAndUnchanged(
        program.methods
          .transferToken(new BN(10), new BN(nonce.toString()), Buffer.from("{}"))
          .accounts({
            wallet: w.walletPda,
            vault: w.vaultPda,
            vaultTokenAccount: vaultTokenAccount.publicKey,
            recipientTokenAccount: recipientTokenAccount.publicKey,
            tokenMint: mint.publicKey,
            passkeys: w.passkeysPda,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
        [w.walletPda, vaultTokenAccount.publicKey, recipientTokenAccount.publicKey],
        "transfer_token"
      );
    });

    it("[155] execute_advanced", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const nonce = await fetchActionNonce(provider.connection, w.walletPda);
      await expectBlockedAndUnchanged(
        program.methods
          .executeAdvanced(Buffer.from([]), new BN(nonce.toString()), Buffer.from("{}"))
          .accounts({
            wallet: w.walletPda,
            vault: w.vaultPda,
            policy: w.policyPda,
            cpiProgram: SystemProgram.programId,
            passkeys: w.passkeysPda,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .rpc(),
        [w.walletPda, w.vaultPda],
        "execute_advanced"
      );
    });

    it("[155] execute_advanced_via_session", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const session = Keypair.generate();
      await callAddAdvancedSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, SystemProgram.programId);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const sessionPda = deriveSessionPda(w.walletPda, session.publicKey);
      await expectBlockedAndUnchanged(
        program.methods
          .executeAdvancedViaSession(Buffer.from([]))
          .accounts({
            wallet: w.walletPda,
            vault: w.vaultPda,
            policy: w.policyPda,
            cpiProgram: SystemProgram.programId,
            session: sessionPda,
            sessionKey: session.publicKey,
          })
          .signers([session])
          .rpc(),
        [w.walletPda, w.vaultPda, sessionPda],
        "execute_advanced_via_session"
      );
    });
  });

  describe("Noodstop: wat tijdens een bevriezing WEL blijft werken (versmallend of defensief)", () => {
    it("[155] freeze_via_passkey op een al bevroren wallet weigert (WalletAlreadyDisarmed) en laat de nonce ongemoeid; bevriezen via de backup authority blijft idempotent", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const nonceFrozen = await actionNonceProcessed(w.walletPda);
      await expectAnchorError(callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda), "WalletAlreadyDisarmed");
      assert.equal(await actionNonceProcessed(w.walletPda), nonceFrozen, "een geweigerde bevriezing mag de nonce niet verhogen");
      await callFreezeViaBackup(w.backupAuthority, w.walletPda);
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
    });

    it("cancel_action sluit een wachtende actie", async () => {
      const w = await createWallet();
      await callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, Keypair.generate().publicKey, NOODSTOP_SPEND);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await callCancelAction(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.isNull(await provider.connection.getAccountInfo(w.pendingActionPda));
    });

    it("remove_session_key, close_session en close_expired_session", async () => {
      const w = await createWallet();
      const a = Keypair.generate();
      const b = Keypair.generate();
      const c = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, a.publicKey, { canExecute: true });
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, b.publicKey, { canExecute: true });
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, c.publicKey, { canExecute: true, expirySlots: 3 });
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);

      await provider.sendAndConfirm(await buildRemoveSessionKeyTx(w.passkey, w.walletPda, w.passkeysPda, a.publicKey));
      assert.isNull(await provider.connection.getAccountInfo(deriveSessionPda(w.walletPda, a.publicKey)));

      await program.methods
        .closeSession()
        .accounts({ wallet: w.walletPda, session: deriveSessionPda(w.walletPda, b.publicKey), sessionKey: b.publicKey })
        .signers([b])
        .rpc();
      assert.isNull(await provider.connection.getAccountInfo(deriveSessionPda(w.walletPda, b.publicKey)));

      const cSession = await program.account.sessionKeyAccount.fetch(deriveSessionPda(w.walletPda, c.publicKey));
      await advanceSlotPast(provider.connection, payerKeypair(), cSession.expirySlot.toNumber());
      await program.methods
        .closeExpiredSession(c.publicKey)
        .accounts({ wallet: w.walletPda, session: deriveSessionPda(w.walletPda, c.publicKey), closer: provider.wallet.publicKey })
        .rpc();
      assert.isNull(await provider.connection.getAccountInfo(deriveSessionPda(w.walletPda, c.publicKey)));
    });

    it("remove_allowed_program", async () => {
      const w = await createWallet();
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await callRemoveAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const policy = await program.account.policyAccount.fetch(w.policyPda);
      assert.equal(policy.count, 0);
    });

    it("[155] migrate_wallet_account bestaat niet meer: het programma kent de instructie niet (InstructionFallbackNotFound), een bevroren wallet blijft bevroren, en de IDL noemt hem niet", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      // Met de hand opgebouwd, onafhankelijk van wat de IDL nog bevat.
      const discriminator = instructionDiscriminator("migrate_wallet_account");
      const ix = new TransactionInstruction({
        programId: program.programId,
        keys: [
          { pubkey: w.walletPda, isSigner: false, isWritable: true },
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(discriminator),
      });
      await expectAnchorError(provider.sendAndConfirm(new anchor.web3.Transaction().add(ix)), "InstructionFallbackNotFound");
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      const names = (program.idl.instructions as unknown as Array<{ name: string }>).map((i) => i.name);
      // Anchor-JS zet IDL-namen om naar camelCase; beide vormen uitgesloten.
      assert.notInclude(names, "migrate_wallet_account");
      assert.notInclude(names, "migrateWalletAccount");
    });

    it("recovery: initiate, cancel en finalize werken; na finalize_recovery blijft de wallet BEVROREN", async () => {
      const w = await createWallet(3);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);

      await callInitiateRecovery(w.backupAuthority, w.walletPda, dummyNewOwnerPasskey());
      await callCancelRecovery(w.passkey, w.walletPda, w.passkeysPda);
      assert.isNull((await program.account.walletAccount.fetch(w.walletPda)).recoveryState);

      await callInitiateRecovery(w.backupAuthority, w.walletPda, dummyNewOwnerPasskey());
      const afterInitiate = await program.account.walletAccount.fetch(w.walletPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), afterInitiate.recoveryState!.initiatedAt.toNumber() + 3);
      await callFinalizeRecovery(w.walletPda, w.passkeysPda);
      const after = await program.account.walletAccount.fetch(w.walletPda);
      assert.isNull(after.recoveryState);
      assert.isTrue(after.disarmed, "een voltooide recovery mag de wallet niet impliciet ontdooien");
    });
  });

  describe("Noodstop: bevriezen en ontdooien", () => {
    it("bevriezen door passkey en door backup authority slaagt; een sessiesleutel kan niet bevriezen", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);

      await callFreezeViaBackup(w.backupAuthority, w.walletPda);
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);

      // Een sessiesleutel als "backup authority" wordt geweigerd, en zonder
      // passkey-precompile faalt de passkey-route.
      const session = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true });
      await expectAnchorError(
        program.methods
          .freezeViaBackupAuthority()
          .accounts({ wallet: w.walletPda, backupAuthority: session.publicKey })
          .signers([session])
          .rpc(),
        "InvalidBackupAuthoritySignature"
      );
      const nonce = await fetchActionNonce(provider.connection, w.walletPda);
      await expectAnchorError(
        program.methods
          .freezeViaPasskey(new BN(nonce.toString()), Buffer.from("{}"))
          .accounts({ wallet: w.walletPda, passkeys: w.passkeysPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
          .rpc(),
        "InvalidPasskeySignature"
      );
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
    });

    it("ontdooien via backup authority: direct, en sluit een wachtende actie mee (rent naar de backup authority)", async () => {
      const w = await createWallet();
      const recipient = Keypair.generate().publicKey;
      await callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, recipient, NOODSTOP_SPEND);
      const pendingLamports = (await provider.connection.getAccountInfo(w.pendingActionPda, "processed"))!.lamports;
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const backupBefore = await provider.connection.getBalance(w.backupAuthority.publicKey, "processed");
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      assert.isNull(await provider.connection.getAccountInfo(w.pendingActionPda, "processed"), "de wachtende actie had mee gesloten moeten zijn");
      assert.equal(await provider.connection.getBalance(w.backupAuthority.publicKey, "processed"), backupBefore + pendingLamports);
    });

    it("ontdooien kan alleen als de wallet bevroren is (WalletNotDisarmed)", async () => {
      const w = await createWallet();
      await expectAnchorError(callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda), "WalletNotDisarmed");
      await expectAnchorError(callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda), "WalletNotDisarmed");
    });

    it("de nonce stijgt bij alle vijf de noodstop-instructies", async () => {
      // Op "processed" (commitment van de provider), niet via
      // fetchActionNonce ("confirmed"): die kan direct na een bevestigde
      // transactie nog de vorige waarde tonen, en hier telt elke stap.
      const nonceProcessed = async (walletPda: PublicKey) => {
        const info = await provider.connection.getAccountInfo(walletPda, "processed");
        return info!.data.readBigUInt64LE(actionNonceOffset(info!.data));
      };
      const w = await createWallet();
      const n0 = await nonceProcessed(w.walletPda);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const n1 = await nonceProcessed(w.walletPda);
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const n2 = await nonceProcessed(w.walletPda);
      await callFreezeViaBackup(w.backupAuthority, w.walletPda);
      const n3 = await nonceProcessed(w.walletPda);
      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const n4 = await nonceProcessed(w.walletPda);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const n5 = await nonceProcessed(w.walletPda);
      assert.deepEqual([n1 - n0, n2 - n1, n3 - n2, n4 - n3, n5 - n4], [1n, 1n, 1n, 1n, 1n]);
    });

    it("REPLAY (a): dezelfde bevries-instructies na ontdooien opnieuw indienen faalt, de wallet blijft ontdooid", async () => {
      const w = await createWallet();
      const freezeIxs = await buildFreezeViaPasskeyIxs(w.passkey, w.walletPda, w.passkeysPda);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(...freezeIxs));
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      await expectAnchorError(provider.sendAndConfirm(new anchor.web3.Transaction().add(...freezeIxs)), "StaleActionNonce");
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
    });

    it("REPLAY (b): een eerder ondertekende, NIET ingediende bevries-handtekening faalt na bevriezen + ontdooien via backup", async () => {
      const w = await createWallet();
      const unsubmitted = await buildFreezeViaPasskeyIxs(w.passkey, w.walletPda, w.passkeysPda);
      await callFreezeViaBackup(w.backupAuthority, w.walletPda);
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      await expectAnchorError(provider.sendAndConfirm(new anchor.web3.Transaction().add(...unsubmitted)), "StaleActionNonce");
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
    });

    it("REPLAY (c): exact dezelfde ondertekende backup-ontdooitransactie opnieuw indienen na opnieuw bevriezen wordt geweigerd", async () => {
      const w = await createWallet();
      await callFreezeViaBackup(w.backupAuthority, w.walletPda);
      const ix = buildUnfreezeViaBackupIx(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const tx = new anchor.web3.Transaction().add(ix);
      tx.feePayer = provider.wallet.publicKey;
      tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
      tx.partialSign(w.backupAuthority);
      const signed = await provider.wallet.signTransaction(tx);
      const raw = signed.serialize();
      const sig = await provider.connection.sendRawTransaction(raw);
      await provider.connection.confirmTransaction(sig, "confirmed");
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);

      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      let errString = "";
      try {
        const sig2 = await provider.connection.sendRawTransaction(raw);
        await provider.connection.confirmTransaction(sig2, "confirmed");
      } catch (err) {
        errString = String(err);
      }
      assert.match(errString, /already been processed|AlreadyProcessed|Blockhash not found/i, "verwachtte een runtime-weigering, kreeg: " + errString);
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed, "de wallet moet bevroren blijven");
    });

    it("STAAT NA ONTDOOIEN = STAAT BIJ BEVRIEZEN: na een reeks geweigerde pogingen is alles byte voor byte gelijk (behalve action_nonce)", async () => {
      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      await callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, SystemProgram.programId);
      const session = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true });
      const sessionPda = deriveSessionPda(w.walletPda, session.publicKey);

      // WalletAccount ruw, met alleen de 8 bytes van action_nonce gemaskeerd.
      const walletRawMasked = async () => {
        const info = (await provider.connection.getAccountInfo(w.walletPda, "processed"))!;
        const data = Buffer.from(info.data);
        data.fill(0, actionNonceOffset(data), actionNonceOffset(data) + 8);
        return `${info.lamports}|${info.owner.toBase58()}|${data.toString("base64")}`;
      };
      const walletBefore = await walletRawMasked();
      const rawBefore = await snapshot([w.vaultPda, w.passkeysPda, w.policyPda, sessionPda, w.pendingActionPda]);

      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      // Sequentieel (thunks): elke poging haalt de actuele nonce op en is
      // op zichzelf geldig ondertekend.
      const attempts: Array<() => Promise<unknown>> = [
        () => callExecute(w.passkey, w.walletPda, w.vaultPda, w.passkeysPda, Keypair.generate().publicKey, NOODSTOP_SPEND),
        () => callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, generateTestPasskey().compressedPublicKey),
        () => callRemovePasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey),
        () => callAddAllowedProgram(w.passkey, w.walletPda, w.policyPda, TOKEN_PROGRAM_ID),
        () => callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, Keypair.generate().publicKey, { canExecute: true }),
        () => program.methods
          .executeViaSession(NOODSTOP_SPEND)
          .accounts({ wallet: w.walletPda, vault: w.vaultPda, recipient: Keypair.generate().publicKey, session: sessionPda, sessionKey: session.publicKey })
          .signers([session])
          .rpc(),
        () => callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, Keypair.generate().publicKey, NOODSTOP_SPEND),
      ];
      for (const attempt of attempts) {
        await expectAnchorError(attempt(), "WalletDisarmed");
      }
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);

      assert.equal(await walletRawMasked(), walletBefore, "WalletAccount moet (op action_nonce na) byte voor byte identiek zijn");
      assertSnapshotsEqual(rawBefore, await snapshot([w.vaultPda, w.passkeysPda, w.policyPda, sessionPda, w.pendingActionPda]), "staat na ontdooien");
    });

    it("[155] ontsnappen: een passkey-houder die tijdens de bevriezing de nonce ophoogt, kan het ontdooien + verwijderen via de backup authority niet verhinderen", async () => {
      const w = await createWallet();
      const compromised = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, compromised.compressedPublicKey);
      // Een sessie aangemaakt met de gecompromitteerde passkey.
      const session = Keypair.generate();
      await callAddSpendSessionKey(compromised, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true });
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);

      // Route met een passkey-handtekening van de eigenaar (ontdooien +
      // remove_passkey, vooraf ondertekend voor nonce+1): die hangt af van
      // de nonce, en de nonce kan de andere passkey tijdens de bevriezing
      // blijven verhogen (initiate_unfreeze + cancel_action).
      const nonceAfterUnfreeze = (await actionNonceProcessed(w.walletPda)) + 1n;
      const ownerSignedIxs = await buildRemovePasskeyIxs(
        w.passkey,
        w.walletPda,
        w.passkeysPda,
        compromised.compressedPublicKey,
        nonceAfterUnfreeze
      );
      const ownerSignedBundle = new anchor.web3.Transaction().add(
        buildUnfreezeViaBackupIx(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda),
        ...ownerSignedIxs
      );
      await callInitiateUnfreeze(compromised, w.walletPda, w.pendingActionPda, w.passkeysPda);
      await callCancelAction(compromised, w.walletPda, w.pendingActionPda, w.passkeysPda);
      await expectAnchorError(provider.sendAndConfirm(ownerSignedBundle, [w.backupAuthority]), "StaleActionNonce");
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);

      // Backup-route met verwijdering in dezelfde instructie: geen
      // passkey-handtekening, dus geen afhankelijkheid van de nonce. Er
      // staat bovendien een wachtende ontdooi-actie van de andere passkey.
      await callInitiateUnfreeze(compromised, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const epochBefore = (await program.account.walletAccount.fetch(w.walletPda)).sessionEpoch;
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda, [
        compromised.compressedPublicKey,
      ]);

      const wallet = await program.account.walletAccount.fetch(w.walletPda);
      assert.isFalse(wallet.disarmed);
      assert.equal(wallet.sessionEpoch.toString(), epochBefore.addn(1).toString(), "session_epoch moet stijgen zodra er een passkey verwijderd wordt");
      const passkeys = await program.account.passkeysAccount.fetch(w.passkeysPda);
      assert.equal(passkeys.count, 0);
      assert.isFalse(passkeys.ownerPasskeyRevoked);
      assert.isNull(await provider.connection.getAccountInfo(w.pendingActionPda, "processed"), "de wachtende actie moet mee gesloten zijn");

      // De verwijderde passkey is geen geldige passkey meer, en de sessie
      // (net als elke andere sessie) is ongeldig.
      await expectAnchorError(callFreezeViaPasskey(compromised, w.walletPda, w.passkeysPda), "InvalidPasskeySignature");
      await expectAnchorError(
        program.methods
          .executeViaSession(NOODSTOP_SPEND)
          .accounts({
            wallet: w.walletPda,
            vault: w.vaultPda,
            recipient: Keypair.generate().publicKey,
            session: deriveSessionPda(w.walletPda, session.publicKey),
            sessionKey: session.publicKey,
          })
          .signers([session])
          .rpc(),
        "SessionRevokedByRecovery"
      );
    });

    it("[155] ontdooien met verwijdering: nooit de laatste geldige passkey, alles-of-niets, en de owner-passkey wordt ingetrokken", async () => {
      // Eén passkey (geen PasskeysAccount): die verwijderen weigert.
      const single = await createWallet();
      await callFreezeViaPasskey(single.passkey, single.walletPda, single.passkeysPda);
      await expectAnchorError(
        callUnfreezeViaBackup(single.backupAuthority, single.walletPda, single.pendingActionPda, single.passkeysPda, [
          single.passkey.compressedPublicKey,
        ]),
        "CannotRemoveLastPasskey"
      );
      assert.isTrue((await program.account.walletAccount.fetch(single.walletPda)).disarmed);

      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const before = await snapshot([w.walletPda, w.passkeysPda]);

      // Beide verwijderen: de tweede verwijdering zou de laatste zijn.
      await expectAnchorError(
        callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda, [
          w.passkey.compressedPublicKey,
          second.compressedPublicKey,
        ]),
        "CannotRemoveLastPasskey"
      );
      // Dezelfde sleutel twee keer, of een onbekende sleutel.
      await expectAnchorError(
        callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda, [
          second.compressedPublicKey,
          second.compressedPublicKey,
        ]),
        "PasskeyNotRegistered"
      );
      await expectAnchorError(
        callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda, [
          generateTestPasskey().compressedPublicKey,
        ]),
        "PasskeyNotRegistered"
      );
      assertSnapshotsEqual(before, await snapshot([w.walletPda, w.passkeysPda]), "na geweigerde verwijderingen");

      // De owner-passkey verwijderen, met een tweede geldige passkey.
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda, [
        w.passkey.compressedPublicKey,
      ]);
      const passkeys = await program.account.passkeysAccount.fetch(w.passkeysPda);
      assert.isTrue(passkeys.ownerPasskeyRevoked);
      assert.equal(passkeys.count, 1);
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      await expectAnchorError(callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda), "InvalidPasskeySignature");
      await callFreezeViaPasskey(second, w.walletPda, w.passkeysPda);
    });

    it("ontdooien via de backup authority zonder verwijdering laat passkeys, sessies en session_epoch ongemoeid", async () => {
      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      const session = Keypair.generate();
      await callAddSpendSessionKey(w.passkey, w.walletPda, w.passkeysPda, w.policyPda, session.publicKey, { canExecute: true });
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const epochBefore = (await program.account.walletAccount.fetch(w.walletPda)).sessionEpoch;
      const passkeysBefore = await snapshot([w.passkeysPda]);
      await callUnfreezeViaBackup(w.backupAuthority, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.equal((await program.account.walletAccount.fetch(w.walletPda)).sessionEpoch.toString(), epochBefore.toString());
      assertSnapshotsEqual(passkeysBefore, await snapshot([w.passkeysPda]), "passkeys");
      await program.methods
        .executeViaSession(new BN(1_000_000))
        .accounts({
          wallet: w.walletPda,
          vault: w.vaultPda,
          recipient: Keypair.generate().publicKey,
          session: deriveSessionPda(w.walletPda, session.publicKey),
          sessionKey: session.publicKey,
        })
        .signers([session])
        .rpc();
    });
  });

  describe("Noodstop: ontdooien via de wachtrij", () => {
    it("initiate_unfreeze werkt ondanks bevriezing; finalize faalt vóór de timelock en slaagt erna (één passkey)", async () => {
      const w = await createWallet();
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      assert.equal(pending.kind, 4);
      await expectAnchorError(callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda), "PendingActionTimelockNotElapsed");
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      assert.isNull(await provider.connection.getAccountInfo(w.pendingActionPda));
    });

    it("2-VAN-2: bij twee passkeys faalt finalize door dezelfde passkey (SecondPasskeyMustDifferFromInitiator), slaagt door de andere", async () => {
      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      assert.isFalse(pending.confirmed);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await expectAnchorError(callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda), "SecondPasskeyMustDifferFromInitiator");
      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      await callFinalizeUnfreeze(second, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
    });

    it("een actie waarvan de timelock tijdens de bevriezing verstreek, kan na ontdooien niet direct uitgevoerd worden", async () => {
      const w = await createWallet();
      const recipient = Keypair.generate().publicKey;
      await callInitiateWithdrawal(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda, recipient, NOODSTOP_SPEND);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const withdrawal = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), withdrawal.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);

      // Wachtrij-route: het slot is bezet, dus ontdooien via de wachtrij
      // kan pas na annuleren - de gerijpte opname verdwijnt daarmee.
      let threw = false;
      try {
        await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      } catch {
        threw = true;
      }
      assert.isTrue(threw, "initiate_unfreeze mag het bezette slot niet overschrijven");
      await callCancelAction(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const unfreeze = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), unfreeze.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      assert.isNull(await provider.connection.getAccountInfo(recipient), "de gerijpte opname mag nooit uitgevoerd zijn");
      assert.isNull(await provider.connection.getAccountInfo(w.pendingActionPda));
    });

    it("ATOMISCH (wachtrij-route, ≥3 passkeys): finalize_unfreeze + remove_passkey in één transactie, realistische clientDataJSON - grootte gemeten, zo nodig met ALT", async () => {
      const w = await createWallet();
      const b = generateTestPasskey();
      const toRemove = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, b.compressedPublicKey);
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, toRemove.compressedPublicKey);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);

      const nonce = await fetchActionNonce(provider.connection, w.walletPda);
      const finalizeIxs = await buildFinalizeUnfreezeIxs(b, w.walletPda, w.pendingActionPda, w.passkeysPda, nonce, CHROME_LIKE_CLIENT_DATA_EXTRA);
      const removeIxs = await buildRemovePasskeyIxs(
        b,
        w.walletPda,
        w.passkeysPda,
        toRemove.compressedPublicKey,
        nonce + 1n,
        CHROME_LIKE_CLIENT_DATA_EXTRA
      );
      const payer = payerKeypair();
      const { blockhash } = await provider.connection.getLatestBlockhash();
      const legacyMsg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [...finalizeIxs, ...removeIxs],
      }).compileToLegacyMessage();
      const legacyTx = new VersionedTransaction(legacyMsg);
      legacyTx.sign([payer]);
      const legacySize = legacyTx.serialize().length;
      // eslint-disable-next-line no-console
      console.log(`      [maat] finalize_unfreeze + remove_passkey (legacy): ${legacySize} bytes (limiet 1232)`);

      let vtx = legacyTx;
      if (legacySize > 1232) {
        const recentSlot = await provider.connection.getSlot("finalized");
        const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
          authority: payer.publicKey,
          payer: payer.publicKey,
          recentSlot,
        });
        const extendAltIx = AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: altAddress,
          addresses: [
            w.walletPda,
            w.pendingActionPda,
            w.passkeysPda,
            SYSVAR_INSTRUCTIONS_PUBKEY,
            new PublicKey("Secp256r1SigVerify1111111111111111111111111"),
            program.programId,
          ],
        });
        await provider.sendAndConfirm(new anchor.web3.Transaction().add(createAltIx, extendAltIx));
        await advanceSlotPast(provider.connection, payer, (await provider.connection.getSlot()) + 1);
        const alt = (await provider.connection.getAddressLookupTable(altAddress)).value!;
        const v0 = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: (await provider.connection.getLatestBlockhash()).blockhash,
          instructions: [...finalizeIxs, ...removeIxs],
        }).compileToV0Message([alt]);
        vtx = new VersionedTransaction(v0);
        vtx.sign([payer]);
        // eslint-disable-next-line no-console
        console.log(`      [maat] idem met ALT: ${vtx.serialize().length} bytes`);
      }
      assert.isAtMost(vtx.serialize().length, 1232);
      const sig = await provider.connection.sendTransaction(vtx);
      await provider.connection.confirmTransaction(sig, "confirmed");

      assert.isFalse((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      const passkeys = await program.account.passkeysAccount.fetch(w.passkeysPda);
      assert.equal(passkeys.count, 1, "alleen B mag overblijven naast de owner-passkey");
      assert.isTrue(Buffer.from(passkeys.additionalPasskeys[0]).equals(b.compressedPublicKey));
    });

    it("ontdooien via de wachtrij vereist medewerking van beide passkeys (2-van-2): finalize door de initiator faalt, de wallet blijft bevroren en er gaat niets uit", async () => {
      const w = await createWallet();
      const second = generateTestPasskey();
      await callAddPasskey(w.passkey, w.walletPda, w.passkeysPda, second.compressedPublicKey);
      await callFreezeViaPasskey(w.passkey, w.walletPda, w.passkeysPda);
      const vaultBefore = await provider.connection.getBalance(w.vaultPda, "processed");

      await callInitiateUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda);
      const pending = await program.account.pendingAction.fetch(w.pendingActionPda);
      await advanceOnChainClockPast(provider.connection, payerKeypair(), pending.timelockStartedAt.toNumber() + FAST_TIMELOCK_SECONDS);
      await expectAnchorError(callFinalizeUnfreeze(w.passkey, w.walletPda, w.pendingActionPda, w.passkeysPda), "SecondPasskeyMustDifferFromInitiator");

      assert.isTrue((await program.account.walletAccount.fetch(w.walletPda)).disarmed);
      assert.equal(await provider.connection.getBalance(w.vaultPda, "processed"), vaultBefore, "er mag niets uitgaan");
    });
  });

  // ================= SpendWindow-rollover (STATUS.md sectie 132/133/134) =================
  // Vereist de test-fast-spend-window-Cargo-feature (WINDOW_DURATION_SECONDS
  // 24u -> 3s) BOVENOP de al-actieve test-fast-pending-timelock - zonder
  // die verkorting zou deze test 24 echte uren moeten wachten
  // (advanceOnChainClockPast wacht ECHTE tijd af, warpt de klok niet, zie
  // STATUS.md sectie 124/132). Eigen guard, eigen commando
  // (yarn test:spend-window-rollover) - de drie tests hierboven hebben dit
  // niet nodig en blijven gewoon onder yarn test:pending-action draaien.
  describe("SpendWindow-rollover (vereist test-fast-spend-window)", function () {
    const FAST_WINDOW_DURATION_SECONDS = 3;

    before(function () {
      if (process.env.SPEND_WINDOW_FAST_DURATION !== "1") {
        // eslint-disable-next-line no-console
        console.warn(
          "\n    [pendingAction.ts] SpendWindow-rollover OVERGESLAGEN:\n" +
            "    deze test vereist de verkorte testvensterduur (Cargo-feature\n" +
            "    test-fast-spend-window, WINDOW_DURATION_SECONDS=3s i.p.v. de\n" +
            "    echte 24u). Draai 'yarn test:spend-window-rollover' om deze\n" +
            "    test daadwerkelijk uit te voeren.\n"
        );
        this.skip();
      }
    });

    it("reset-dan-optellen: een aanroep NA het verstrijken van het venster reset eerst, telt dan pas op - empirisch bewezen, niet aangenomen", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda, pendingActionPda, spendWindowPda } =
        await createWallet();
      const threshold = new BN(anchor.web3.LAMPORTS_PER_SOL / 10);
      // Cap exact gelijk aan de drempel: één aanroep vult 'm precies, dus
      // een tweede aanroep BINNEN hetzelfde venster moet al weigeren -
      // scherp contrast met wat NA de reset hoort te gebeuren.
      const windowCap = threshold;
      await setThreshold(passkey, walletPda, pendingActionPda, passkeysPda, spendWindowPda, threshold, windowCap);

      const recipient = Keypair.generate().publicKey;

      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);
      const windowAfterFirst = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        windowAfterFirst.spentLamportsThisWindow.toString(),
        threshold.toString(),
        "eerste aanroep moet de volledige cap opgebruiken"
      );

      // Binnen hetzelfde venster: nog een lamport erbovenop moet weigeren.
      await expectAnchorError(
        callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, new BN(1)),
        "SpendWindowExceeded"
      );

      // Venster laten verlopen (FAST_WINDOW_DURATION_SECONDS onder deze featurebuild).
      await advanceOnChainClockPast(
        provider.connection,
        (provider.wallet as anchor.Wallet).payer,
        windowAfterFirst.windowStartedAt.toNumber() + FAST_WINDOW_DURATION_SECONDS
      );

      // NA het verstrijken: dezelfde drempel moet weer volledig slagen -
      // bewijst reset-dan-optellen. Was de volgorde omgekeerd (optellen
      // tegen het oude, nog-niet-gereset totaal), dan zou dit alsnog
      // SpendWindowExceeded geven, want threshold + threshold > windowCap.
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, threshold);
      const windowAfterReset = await program.account.spendWindow.fetch(spendWindowPda);
      assert.equal(
        windowAfterReset.spentLamportsThisWindow.toString(),
        threshold.toString(),
        "na de reset moet de teller weer bij nul beginnen (dan optellen), niet doortellen vanaf het oude totaal"
      );
      assert.isTrue(
        windowAfterReset.windowStartedAt.toNumber() > windowAfterFirst.windowStartedAt.toNumber(),
        "window_started_at moet zijn opgeschoven naar het moment van de resettende aanroep"
      );
      assert.equal(
        await provider.connection.getBalance(recipient),
        threshold.toNumber() * 2,
        "recipient moet in totaal 2x threshold ontvangen hebben (twee losse, geslaagde vensters), niet meer"
      );
    });
  });
});
