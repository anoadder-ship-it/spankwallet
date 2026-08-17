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
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
} from "./webauthnTestHelper";

// SPL Token (niet 2022) - vast, algemeen bekend adres. Geen @solana/spl-token
// dependency nodig: de instructielay-outs hieronder (InitializeMint=0,
// InitializeAccount=1, MintTo=7, Transfer=3) zijn de stabiele, native
// byte-lay-outs van het Token-programma, puur voor testopbouw - hetzelfde
// principe als webauthnTestHelper.ts de secp256r1-precompile-instructie
// handmatig opbouwt i.p.v. een library toe te voegen. Lokaal bevestigd
// aanwezig op de standaard solana-test-validator-genesis.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

function encodeInitializeMintIx(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(0, 0); // InitializeMint tag
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // freeze_authority: COption::None, bytes 35..67 blijven nul (ongebruikt)
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
    data: Buffer.from([1]), // InitializeAccount tag
  });
}

function encodeMintToIx(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: number
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo tag
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

function encodeTransferData(amount: number): Buffer {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer tag
  data.writeBigUInt64LE(BigInt(amount), 1);
  return data;
}

function readTokenAccountAmount(data: Buffer): bigint {
  // SPL Token Account-layout: mint(32) + owner(32) + amount(u64 LE @ offset 64) + ...
  return data.readBigUInt64LE(64);
}

interface RemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

describe("spankwallet: programma-allowlist (add/remove_allowed_program) + execute_advanced", () => {
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

  // init_wallet vereist een echte secp256r1-handtekening (STATUS.md sectie
  // 22) - zelfde aanpak als tests/spankwallet.ts en tests/recovery.ts.
  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, policyPda, walletSeedHash } = derivePdas(
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

    return { passkey, walletPda, vaultPda, policyPda };
  }

  async function callAddAllowedProgram(
    passkey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    programId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), programId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "add_allowed_program",
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

    return program.methods
      .addAllowedProgram(programId, new BN(nonce.toString()), clientDataJSON)
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
    passkey: TestPasskey,
    walletPda: PublicKey,
    policyPda: PublicKey,
    programId: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), programId.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "remove_allowed_program",
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

    return program.methods
      .removeAllowedProgram(programId, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        policy: policyPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  // Exacte TS-tegenhanger van de challenge-payload die
  // instructions.rs::execute_advanced opbouwt: cpi_program_id + u16 LE
  // aantal remaining accounts + per account (pubkey + is_writable +
  // is_signer) + u32 LE data-lengte + data. De vault wordt hier, net als
  // on-chain, GEFORCEERD als signer meegeteld ongeacht wat de aanroeper
  // opgeeft - anders zou de client een andere challenge berekenen dan het
  // programma verwacht en zou elke aanroep met de vault in de accountlijst
  // altijd falen.
  function buildExecuteAdvancedPayload(
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

  async function callExecuteAdvanced(
    passkey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    policyPda: PublicKey,
    cpiProgramId: PublicKey,
    remainingAccounts: RemainingAccountSpec[],
    data: Buffer,
    extraSigners: Keypair[] = []
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const rawPayload = buildExecuteAdvancedPayload(cpiProgramId, vaultPda, remainingAccounts, data);
    const payload = Buffer.concat([nonceLeBytes(nonce), rawPayload]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "execute_advanced",
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

    return program.methods
      .executeAdvanced(data, new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        policy: policyPda,
        cpiProgram: cpiProgramId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(
        remainingAccounts.map((a) => ({
          pubkey: a.pubkey,
          isWritable: a.isWritable,
          isSigner: a.isSigner,
        }))
      )
      .preInstructions([secp256r1Ix])
      .signers(extraSigners)
      .rpc();
  }

  it("add_allowed_program voegt een programma toe aan een nieuw (init_if_needed) policy-account", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();

    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    const policy = await program.account.policyAccount.fetch(policyPda);
    assert.equal(policy.count, 1);
    assert.equal(policy.allowedPrograms[0].toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(policy.wallet.toBase58(), walletPda.toBase58());
  });

  it("add_allowed_program faalt bij het toevoegen van het eigen SpankWallet-programma-ID (SelfCpiNotAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();

    let threw = false;
    try {
      await callAddAllowedProgram(passkey, walletPda, policyPda, program.programId);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "add_allowed_program met het eigen programma-ID had moeten falen");
  });

  it("add_allowed_program faalt bij een duplicaat (ProgramAlreadyAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "een tweede add_allowed_program met hetzelfde programma-ID had moeten falen"
    );
  });

  it("remove_allowed_program verwijdert een programma en houdt de lijst aaneengesloten (swap-remove)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    const progA = Keypair.generate().publicKey;
    const progB = Keypair.generate().publicKey;
    await callAddAllowedProgram(passkey, walletPda, policyPda, progA);
    await callAddAllowedProgram(passkey, walletPda, policyPda, progB);

    await callRemoveAllowedProgram(passkey, walletPda, policyPda, progA);

    const policy = await program.account.policyAccount.fetch(policyPda);
    assert.equal(policy.count, 1);
    assert.equal(policy.allowedPrograms[0].toBase58(), progB.toBase58());
  });

  it("remove_allowed_program faalt als het programma niet op de lijst staat (ProgramNotAllowed)", async () => {
    const { passkey, walletPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callRemoveAllowedProgram(passkey, walletPda, policyPda, Keypair.generate().publicKey);
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "remove_allowed_program voor een niet-toegestaan programma had moeten falen"
    );
  });

  it("execute_advanced faalt tegen een programma dat niet op de allowlist staat (ProgramNotAllowed)", async () => {
    const { passkey, walletPda, vaultPda, policyPda } = await createWallet();
    // Policy-account bestaat (met een ANDER programma erop), zodat dit
    // specifiek de ProgramNotAllowed-tak test, niet een ontbrekend account.
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    let threw = false;
    try {
      await callExecuteAdvanced(
        passkey,
        walletPda,
        vaultPda,
        policyPda,
        SystemProgram.programId,
        [],
        Buffer.from([])
      );
    } catch (err) {
      threw = true;
    }
    assert.isTrue(
      threw,
      "execute_advanced tegen een niet-toegestaan programma had moeten falen"
    );
  });

  it("execute_advanced voert een echte CPI uit naar een toegestaan extern programma (System Program: Assign)", async () => {
    const { passkey, walletPda, vaultPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, SystemProgram.programId);

    const target = Keypair.generate();
    // Eerst funden zodat het account na de transactie niet als
    // 0-lamport-account wordt opgeruimd door de runtime (anders is de
    // owner-wijziging niet meer waarneembaar achteraf).
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
    const remainingAccounts: RemainingAccountSpec[] = [
      { pubkey: target.publicKey, isWritable: true, isSigner: true },
    ];

    await callExecuteAdvanced(
      passkey,
      walletPda,
      vaultPda,
      policyPda,
      SystemProgram.programId,
      remainingAccounts,
      assignIx.data,
      [target]
    );

    const info = await provider.connection.getAccountInfo(target.publicKey);
    assert.isNotNull(info);
    assert.equal(info.owner.toBase58(), program.programId.toBase58());
  });

  it("execute_advanced voert een echte SPL Token::transfer-CPI uit met de vault als PDA-signer-autoriteit", async () => {
    const { passkey, walletPda, vaultPda, policyPda } = await createWallet();
    await callAddAllowedProgram(passkey, walletPda, policyPda, TOKEN_PROGRAM_ID);

    const mint = Keypair.generate();
    const vaultTokenAccount = Keypair.generate();
    const recipientTokenAccount = Keypair.generate();

    const mintRent = await provider.connection.getMinimumBalanceForRentExemption(MINT_LEN);
    const tokenAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);

    // Setup buiten SpankWallet om (mint aanmaken, vault- en
    // ontvanger-token-accounts aanmaken, vault-account vullen) - dit is
    // gewone SPL-Token-boekhouding, geen SpankWallet-instructie. De vault
    // (PDA, eigendom van ons programma) staat hier gewoon als de
    // token-account-`owner`, precies zoals transfer_token dat ook doet.
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

    // De daadwerkelijke test: execute_advanced doet de Token::transfer-CPI.
    // vault staat in remaining_accounts als authority - het Rust-programma
    // forceert is_signer=true zodra de sleutel gelijk is aan de vault, via
    // invoke_signed met de vault-PDA-seeds (zelfde mechanisme als
    // transfer_token/hunt). isWritable staat hier bewust op true: vault is
    // in DEZELFDE instructie ook het genoemde, mut-gedeclareerde
    // `vault`-account (zie ExecuteAdvanced in instructions.rs) - Solana's
    // transactie-compilatie merget de schrijf-vlag van eenzelfde sleutel
    // over alle voorkomens in de instructie, dus dit moet overeenkomen met
    // wat het Rust-programma daadwerkelijk waarneemt, anders komt de
    // challenge hier niet overeen met wat on-chain berekend wordt.
    const remainingAccounts: RemainingAccountSpec[] = [
      { pubkey: vaultTokenAccount.publicKey, isWritable: true, isSigner: false },
      { pubkey: recipientTokenAccount.publicKey, isWritable: true, isSigner: false },
      { pubkey: vaultPda, isWritable: true, isSigner: false },
    ];

    await callExecuteAdvanced(
      passkey,
      walletPda,
      vaultPda,
      policyPda,
      TOKEN_PROGRAM_ID,
      remainingAccounts,
      encodeTransferData(500)
    );

    const vaultAcctInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
    const recipientAcctInfo = await provider.connection.getAccountInfo(
      recipientTokenAccount.publicKey
    );
    assert.equal(readTokenAccountAmount(vaultAcctInfo.data), BigInt(500));
    assert.equal(readTokenAccountAmount(recipientAcctInfo.data), BigInt(500));
  });
});
