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
  advanceSlotPast,
  TestPasskey,
} from "./webauthnTestHelper";

// Zelfde vaste SPL-Token-programma-ID en handmatige instructie-encodering als
// tests/policy.ts - geen @solana/spl-token dependency nodig, puur voor
// testopbouw (zie de toelichting daar).
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

describe("spankwallet: session keys (add_session_key/remove_session_key/close_session/close_expired_session + _via_session)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;
  const payerKeypair = (provider.wallet as anchor.Wallet).payer;

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

  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, policyPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );

    const payload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
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
        walletSeedHash,
        backupAuthority.publicKey,
        null,
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();

    return { passkey, backupAuthority, walletPda, vaultPda, passkeysPda, policyPda };
  }

  async function fundVault(vaultPda: PublicKey, extraLamports: number) {
    const rentExempt = await provider.connection.getMinimumBalanceForRentExemption(41); // VaultAccount::LEN
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: vaultPda,
          lamports: rentExempt + extraLamports,
        })
      )
    );
  }

  async function callAddAllowedProgram(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    programIdToAllow: PublicKey
  ) {
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_allowed_program",
      programIdToAllow.toBuffer()
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
      .addAllowedProgram(programIdToAllow, clientDataJSON)
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
    programId: PublicKey
  ) {
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_allowed_program",
      programId.toBuffer()
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
      .removeAllowedProgram(programId, clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // Exacte TS-tegenhanger van de challenge-payload die
  // instructions.rs::add_session_key opbouwt: session_key + expiry_slot (u64
  // LE) + de drie instructie-vlaggen + u32 LE aantal sub-scope-programma's +
  // de programma's zelf.
  function buildAddSessionKeyPayload(
    sessionKey: PublicKey,
    expirySlot: number,
    canExecute: boolean,
    canTransferToken: boolean,
    canExecuteAdvanced: boolean,
    sessionAllowedPrograms: PublicKey[]
  ): Buffer {
    const expirySlotBuf = Buffer.alloc(8);
    expirySlotBuf.writeBigUInt64LE(BigInt(expirySlot), 0);
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(sessionAllowedPrograms.length, 0);
    return Buffer.concat([
      sessionKey.toBuffer(),
      expirySlotBuf,
      Buffer.from([canExecute ? 1 : 0, canTransferToken ? 1 : 0, canExecuteAdvanced ? 1 : 0]),
      countBuf,
      ...sessionAllowedPrograms.map((p) => p.toBuffer()),
    ]);
  }

  async function callAddSessionKey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    policyPda: PublicKey,
    sessionKey: PublicKey,
    expirySlot: number,
    canExecute: boolean,
    canTransferToken: boolean,
    canExecuteAdvanced: boolean,
    sessionAllowedPrograms: PublicKey[] = []
  ) {
    const payload = buildAddSessionKeyPayload(
      sessionKey,
      expirySlot,
      canExecute,
      canTransferToken,
      canExecuteAdvanced,
      sessionAllowedPrograms
    );
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_session_key",
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

    const sessionPda = deriveSessionPda(walletPda, sessionKey);

    return program.methods
      .addSessionKey(
        sessionKey,
        new BN(expirySlot),
        canExecute,
        canTransferToken,
        canExecuteAdvanced,
        sessionAllowedPrograms,
        clientDataJSON
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
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function callRemoveSessionKey(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    passkeysPda: PublicKey,
    sessionKey: PublicKey
  ) {
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_session_key",
      sessionKey.toBuffer()
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
      .removeSessionKey(sessionKey, clientDataJSON)
      .accounts({
        wallet: walletPda,
        session: deriveSessionPda(walletPda, sessionKey),
        payer: provider.wallet.publicKey,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  function dummyNewOwnerPasskey(): number[] {
    const bytes = require("crypto").randomBytes(33);
    bytes[0] = 0x02;
    return Array.from(bytes);
  }

  it("add_session_key maakt een nieuw sessie-account aan met de juiste velden", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = currentSlot + 1000;

    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      expirySlot,
      true,
      false,
      false
    );

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const session = await program.account.sessionKeyAccount.fetch(sessionPda);
    assert.equal(session.wallet.toBase58(), walletPda.toBase58());
    assert.equal(session.sessionKey.toBase58(), sessionKeypair.publicKey.toBase58());
    assert.equal(session.expirySlot.toNumber(), expirySlot);
    assert.isTrue(session.canExecute);
    assert.isFalse(session.canTransferToken);
    assert.isFalse(session.canExecuteAdvanced);
    assert.equal(session.count, 0);
  });

  it("een net toegevoegde sessiesleutel kan zelfstandig execute_via_session ondertekenen (spend-bewijs, geen passkey nodig)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await fundVault(vaultPda, 10_000_000);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    const recipient = Keypair.generate().publicKey;
    const amount = new BN(1_000_000);

    // Puur een gewone Solana-transactiehandtekening van de sessiesleutel -
    // geen secp256r1Ix, geen clientDataJSON, geen instructions_sysvar nodig
    // (ontwerppunt 5).
    await program.methods
      .executeViaSession(amount)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        recipient,
        session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
        sessionKey: sessionKeypair.publicKey,
      })
      .signers([sessionKeypair])
      .rpc();

    const recipientBalance = await provider.connection.getBalance(recipient);
    assert.equal(recipientBalance, 1_000_000);
  });

  it("execute_via_session faalt als de sessie niet gescoped is voor execute (SessionInstructionNotAllowed)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await fundVault(vaultPda, 10_000_000);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    // can_execute = false - alleen transfer_token toegestaan.
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      false,
      true,
      false
    );

    let threw = false;
    try {
      await program.methods
        .executeViaSession(new BN(1000))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          recipient: Keypair.generate().publicKey,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "execute_via_session met can_execute=false had moeten falen"
    );
  });

  it("execute_via_session faalt na expiry_slot (SessionExpired)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await fundVault(vaultPda, 10_000_000);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = currentSlot + 1;
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      expirySlot,
      true,
      false,
      false
    );

    await advanceSlotPast(provider.connection, payerKeypair, expirySlot);

    let threw = false;
    try {
      await program.methods
        .executeViaSession(new BN(1000))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          recipient: Keypair.generate().publicKey,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "execute_via_session na expiry_slot had moeten falen");
  });

  it("add_session_key faalt als expiry_slot niet in de toekomst ligt (SessionExpirySlotNotInFuture)", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();

    let threw = false;
    try {
      await callAddSessionKey(
        passkey,
        walletPda,
        passkeysPda,
        policyPda,
        sessionKeypair.publicKey,
        currentSlot,
        true,
        false,
        false
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "add_session_key met expiry_slot <= huidige slot had moeten falen"
    );
  });

  it("add_session_key faalt bij een niet-lege sub-allowlist zonder can_execute_advanced (SessionInstructionNotAllowed)", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();

    let threw = false;
    try {
      await callAddSessionKey(
        passkey,
        walletPda,
        passkeysPda,
        policyPda,
        sessionKeypair.publicKey,
        currentSlot + 1000,
        true,
        false,
        false,
        [Keypair.generate().publicKey]
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een niet-lege sub-allowlist zonder can_execute_advanced had moeten falen"
    );
  });

  it("add_session_key faalt bij meer sub-scope-programma's dan MAX_SESSION_PROGRAMS (SessionAllowlistFull)", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    const tooMany = Array.from({ length: 9 }, () => Keypair.generate().publicKey);

    let threw = false;
    try {
      await callAddSessionKey(
        passkey,
        walletPda,
        passkeysPda,
        policyPda,
        sessionKeypair.publicKey,
        currentSlot + 1000,
        false,
        false,
        true,
        tooMany
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "meer dan MAX_SESSION_PROGRAMS sub-scope-entries had moeten falen");
  });

  it("add_session_key faalt bij een sub-scope-programma dat niet op de live PolicyAccount staat (SessionProgramNotAllowed)", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    // Geen add_allowed_program aangeroepen - policy bestaat niet, dus ELK
    // gevraagd sub-scope-programma hoort te falen.
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();

    let threw = false;
    try {
      await callAddSessionKey(
        passkey,
        walletPda,
        passkeysPda,
        policyPda,
        sessionKeypair.publicKey,
        currentSlot + 1000,
        false,
        false,
        true,
        [SystemProgram.programId]
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een sub-scope-programma buiten de live allowlist had moeten falen"
    );
  });

  it("execute_advanced_via_session faalt met SessionInstructionNotAllowed, NIET met AccountNotInitialized, als er nog geen PolicyAccount bestaat (regressietest)", async () => {
    // Gevonden tijdens live devnet-testen (STATUS.md): policy stond ooit als
    // Account<PolicyAccount> (typed) - Anchor deserialiseert zo'n veld altijd
    // in try_accounts(), VOORDAT de instructie-body draait, dus de
    // autorisatie-check (can_execute_advanced) kwam nooit aan bod als
    // PolicyAccount nog niet bestond: elke aanroep faalde met
    // AccountNotInitialized, ongeacht sessie-scope. Fix: policy is nu
    // UncheckedAccount, tolerant gelezen NA de autorisatie-checks. Dit test
    // expliciet de FOUTCODE, niet enkel "er was een fout" - anders vangt
    // geen enkele test een regressie van precies dit probleem.
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    // Bewust GEEN callAddAllowedProgram - policy bestaat nog niet.
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    // can_execute_advanced = false.
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    let errString = "";
    try {
      await program.methods
        .executeAdvancedViaSession(Buffer.from([]))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          policy: policyPda,
          cpiProgram: SystemProgram.programId,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      errString = String(err);
    }
    assert.include(
      errString,
      "SessionInstructionNotAllowed",
      "verwachtte specifiek SessionInstructionNotAllowed, kreeg: " + errString
    );
    assert.notInclude(
      errString,
      "AccountNotInitialized",
      "de autorisatie-check had moeten falen VOORDAT het ontbrekende PolicyAccount ooit relevant werd"
    );
  });

  it("execute_advanced_via_session voert een echte CPI uit (System Program: Assign) als de sessie correct gescoped is", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      false,
      false,
      true,
      [SystemProgram.programId]
    );

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

    const assignIx = SystemProgram.assign({
      accountPubkey: target.publicKey,
      programId: program.programId,
    });

    await program.methods
      .executeAdvancedViaSession(assignIx.data)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        policy: policyPda,
        cpiProgram: SystemProgram.programId,
        session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
        sessionKey: sessionKeypair.publicKey,
      })
      .remainingAccounts([{ pubkey: target.publicKey, isWritable: true, isSigner: true }])
      .signers([sessionKeypair, target])
      .rpc();

    const info = await provider.connection.getAccountInfo(target.publicKey);
    assert.isNotNull(info);
    assert.equal(info.owner.toBase58(), program.programId.toBase58());
  });

  it("execute_advanced_via_session faalt zodra het programma van de LIVE PolicyAccount verwijderd is, ook al staat het nog in de sessie's eigen sub-scope (ProgramNotAllowed, geen cache)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      false,
      false,
      true,
      [SystemProgram.programId]
    );

    // Eigenaar verwijdert System Program weer van de wallet-brede allowlist -
    // de sessie's EIGEN sub-scope-lijst weet daar niets van (bevat het nog
    // steeds), maar de live herverificatie moet dit toch tegenhouden.
    await callRemoveAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);

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
    const assignIx = SystemProgram.assign({
      accountPubkey: target.publicKey,
      programId: program.programId,
    });

    let threw = false;
    try {
      await program.methods
        .executeAdvancedViaSession(assignIx.data)
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          policy: policyPda,
          cpiProgram: SystemProgram.programId,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
        })
        .remainingAccounts([{ pubkey: target.publicKey, isWritable: true, isSigner: true }])
        .signers([sessionKeypair, target])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "execute_advanced_via_session had moeten falen nadat de live policy het programma niet meer toestaat"
    );
  });

  it("transfer_token_via_session voert een echte SPL-transfer uit als can_transfer_token=true", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();

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
      encodeInitializeAccountIx(
        recipientTokenAccount.publicKey,
        mint.publicKey,
        provider.wallet.publicKey
      ),
      encodeMintToIx(mint.publicKey, vaultTokenAccount.publicKey, provider.wallet.publicKey, 1000)
    );
    await provider.sendAndConfirm(setupTx, [mint, vaultTokenAccount, recipientTokenAccount]);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      false,
      true,
      false
    );

    await program.methods
      .transferTokenViaSession(new BN(500))
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccount.publicKey,
        recipientTokenAccount: recipientTokenAccount.publicKey,
        tokenMint: mint.publicKey,
        session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
        sessionKey: sessionKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sessionKeypair])
      .rpc();

    const vaultAcctInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
    const recipientAcctInfo = await provider.connection.getAccountInfo(
      recipientTokenAccount.publicKey
    );
    assert.equal(readTokenAccountAmount(vaultAcctInfo.data), BigInt(500));
    assert.equal(readTokenAccountAmount(recipientAcctInfo.data), BigInt(500));
  });

  it("transfer_token_via_session faalt als de sessie niet gescoped is voor transfer_token (SessionInstructionNotAllowed)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();

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
      encodeInitializeAccountIx(
        recipientTokenAccount.publicKey,
        mint.publicKey,
        provider.wallet.publicKey
      ),
      encodeMintToIx(mint.publicKey, vaultTokenAccount.publicKey, provider.wallet.publicKey, 1000)
    );
    await provider.sendAndConfirm(setupTx, [mint, vaultTokenAccount, recipientTokenAccount]);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    // can_transfer_token = false.
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    let threw = false;
    try {
      await program.methods
        .transferTokenViaSession(new BN(500))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccount.publicKey,
          recipientTokenAccount: recipientTokenAccount.publicKey,
          tokenMint: mint.publicKey,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "transfer_token_via_session met can_transfer_token=false had moeten falen"
    );
  });

  it("remove_session_key trekt een sessie vroegtijdig in - daarna faalt execute_via_session", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda, policyPda } = await createWallet();
    await fundVault(vaultPda, 10_000_000);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    await callRemoveSessionKey(passkey, walletPda, passkeysPda, sessionKeypair.publicKey);

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const sessionInfo = await provider.connection.getAccountInfo(sessionPda);
    assert.isNull(sessionInfo, "session-account had gesloten moeten zijn na remove_session_key");

    let threw = false;
    try {
      await program.methods
        .executeViaSession(new BN(1000))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          recipient: Keypair.generate().publicKey,
          session: sessionPda,
          sessionKey: sessionKeypair.publicKey,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "execute_via_session na remove_session_key had moeten falen");
  });

  it("close_session: de sessiesleutel zelf sluit haar eigen account en claimt de rent, zonder passkey", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const rentLamportsBefore = (await provider.connection.getAccountInfo(sessionPda)).lamports;

    // De sessiesleutel heeft zelf geen SOL om als fee-payer op te treden -
    // funden zodat hij zijn eigen close_session-transactie kan betalen.
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: sessionKeypair.publicKey,
          lamports: 5_000_000,
        })
      )
    );

    await program.methods
      .closeSession()
      .accounts({
        wallet: walletPda,
        session: sessionPda,
        sessionKey: sessionKeypair.publicKey,
      })
      .signers([sessionKeypair])
      .rpc();

    const sessionInfo = await provider.connection.getAccountInfo(sessionPda);
    assert.isNull(sessionInfo, "session-account had gesloten moeten zijn na close_session");

    const sessionKeyBalance = await provider.connection.getBalance(sessionKeypair.publicKey);
    assert.isTrue(
      sessionKeyBalance >= rentLamportsBefore,
      "de teruggewonnen rent had naar session_key zelf moeten gaan"
    );
  });

  it("close_expired_session faalt vóór expiry (SessionNotYetExpired)", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    // Ruime marge (i.t.t. de "erna"-test hieronder) - dit test uitsluitend
    // het "nog niet verlopen"-pad, dus moet ruim vóór expiry blijven, ook
    // als de bevestiging van bovenstaande setup-transacties een paar slots
    // kost.
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const closer = Keypair.generate();
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: closer.publicKey,
          lamports: 5_000_000,
        })
      )
    );

    let threw = false;
    try {
      await program.methods
        .closeExpiredSession(sessionKeypair.publicKey)
        .accounts({
          wallet: walletPda,
          session: sessionPda,
          closer: closer.publicKey,
        })
        .signers([closer])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "close_expired_session vóór expiry had moeten falen");
  });

  it("close_expired_session slaagt na expiry, permissionless door een willekeurige derde", async () => {
    const { passkey, walletPda, passkeysPda, policyPda } = await createWallet();
    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = currentSlot + 1;
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      expirySlot,
      true,
      false,
      false
    );

    const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);
    const closer = Keypair.generate();
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: closer.publicKey,
          lamports: 5_000_000,
        })
      )
    );

    await advanceSlotPast(provider.connection, payerKeypair, expirySlot);

    // Permissionless: `closer` heeft nooit iets met deze wallet te maken
    // gehad, geen passkey, geen sessiesleutel - puur een willekeurige derde
    // die de verlopen sessie opruimt en de rent claimt.
    await program.methods
      .closeExpiredSession(sessionKeypair.publicKey)
      .accounts({
        wallet: walletPda,
        session: sessionPda,
        closer: closer.publicKey,
      })
      .signers([closer])
      .rpc();

    const sessionInfo = await provider.connection.getAccountInfo(sessionPda);
    assert.isNull(sessionInfo, "session-account had gesloten moeten zijn na close_expired_session");
  });

  it("add_session_key faalt tijdens een lopende recovery (RecoveryAlreadyInProgress)", async () => {
    const { passkey, backupAuthority, walletPda, passkeysPda, policyPda } = await createWallet();

    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();

    let threw = false;
    try {
      await callAddSessionKey(
        passkey,
        walletPda,
        passkeysPda,
        policyPda,
        sessionKeypair.publicKey,
        currentSlot + 1000,
        true,
        false,
        false
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "add_session_key tijdens een lopende recovery had moeten falen");
  });

  it("execute_via_session faalt tijdens een lopende recovery (RecoveryAlreadyInProgress)", async () => {
    const { passkey, backupAuthority, walletPda, vaultPda, passkeysPda, policyPda } =
      await createWallet();
    await fundVault(vaultPda, 10_000_000);

    const sessionKeypair = Keypair.generate();
    const currentSlot = await provider.connection.getSlot();
    await callAddSessionKey(
      passkey,
      walletPda,
      passkeysPda,
      policyPda,
      sessionKeypair.publicKey,
      currentSlot + 1000,
      true,
      false,
      false
    );

    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .executeViaSession(new BN(1000))
        .accounts({
          wallet: walletPda,
          vault: vaultPda,
          recipient: Keypair.generate().publicKey,
          session: deriveSessionPda(walletPda, sessionKeypair.publicKey),
          sessionKey: sessionKeypair.publicKey,
        })
        .signers([sessionKeypair])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "execute_via_session tijdens een lopende recovery had moeten falen"
    );
  });
});
