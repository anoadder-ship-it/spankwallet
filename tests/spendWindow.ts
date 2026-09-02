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

// spendWindow.ts — STATUS.md sectie 132/133 (stap B, glijdende-
// vensterlimiet): stap b bewijs, niet aangenomen. execute/hunt kregen een
// nieuwe spend_window-account in hun accountlijst (UncheckedAccount, seeds/
// bump, geen init_if_needed), maar GEEN rollover-/optel-/cap-logica - dat
// is stap c, nog te bouwen, en heeft hier bewust NOG GEEN dekking.
//
// Dit bestand bewijst uitsluitend dat de accountlijst-uitbreiding zelf GEEN
// gedragswijziging is voor een drempel=0-wallet (de fail-safe default,
// alle zeventien bestaande wallets vandaag, en het enige moment waarop
// spend_window nog niet bestaat - zie sectie 132's vraag 1): execute/hunt
// slagen precies zoals vóór stap B, EN het spend_window-account blijft
// aantoonbaar niet-bestaand erna (geen stille/geforceerde initialisatie
// als bijeffect van simpelweg het adres meesturen). Draait onder het
// GEWONE `yarn test` - geen enkele test hier zet een drempel, dus geen
// afhankelijkheid van test-fast-pending-timelock ÓF test-fast-spend-window.
//
// Zelfde per-bestand-onafhankelijkheidsconventie als de rest van deze
// testsuite (bewust gedupliceerde helpers, geen gedeelde testmodule).

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const HUNT_DISCRIMINATOR = Buffer.from([0x94, 0x1e, 0x1c, 0x39, 0x31, 0xf9, 0x1d, 0x41]);

function encodeBorshVecU8(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

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

describe("spankwallet: spend_window-accountlijst-uitbreiding op execute/hunt (STATUS.md sectie 132/133, stap B)", () => {
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
    const [spendWindowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("spend_window"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, spendWindowPda, walletSeedHash: Array.from(seedHash) };
  }

  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const pdas = derivePdas(passkey.compressedPublicKey);

    const payload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
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
        null,
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

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: pdas.vaultPda,
          lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );

    return { passkey, backupAuthority, ...pdas };
  }

  async function callExecute(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    spendWindowPda: PublicKey,
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
    spendWindowPda: PublicKey,
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
    const huntIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: spendWindowPda, isSigner: false, isWritable: false },
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

  describe("execute", () => {
    it("drempel = 0: gedrag exact ongewijzigd, EN spend_window blijft niet-bestaand (geen geforceerde initialisatie, geen venstercontrole)", async () => {
      const { passkey, walletPda, vaultPda, spendWindowPda, passkeysPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      const amount = new BN(1.5 * anchor.web3.LAMPORTS_PER_SOL);

      const beforeInfo = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(beforeInfo, "spend_window mag vóór de eerste execute niet bestaan");

      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await callExecute(passkey, walletPda, vaultPda, spendWindowPda, passkeysPda, recipient, amount);
      const vaultAfter = await provider.connection.getBalance(vaultPda);
      const recipientBalance = await provider.connection.getBalance(recipient);

      assert.equal(
        vaultBefore - vaultAfter,
        amount.toNumber(),
        "execute moet nog steeds het volledige bedrag verplaatsen, ongeacht de nieuwe accountlijst-uitbreiding"
      );
      assert.equal(recipientBalance, amount.toNumber());

      const afterInfo = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(
        afterInfo,
        "spend_window mag NA een geslaagde execute nog steeds niet bestaan - stap B voegde alleen het adres toe aan de accountlijst, geen init_if_needed, geen handhaving"
      );
    });
  });

  describe("hunt", () => {
    it("drempel = 0: gedrag exact ongewijzigd, EN spend_window blijft niet-bestaand (geen geforceerde initialisatie, geen venstercontrole)", async () => {
      const { passkey, walletPda, vaultPda, spendWindowPda, passkeysPda } = await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
      const rentDestination = Keypair.generate().publicKey;

      const beforeInfo = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(beforeInfo, "spend_window mag vóór de eerste hunt niet bestaan");

      await callHunt(
        passkey,
        walletPda,
        vaultPda,
        spendWindowPda,
        passkeysPda,
        tokenAccount.publicKey,
        mint.publicKey,
        rentDestination
      );

      const closedInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNull(closedInfo, "target_token_account had gesloten moeten zijn na hunt - ongewijzigd gedrag");
      const rentDestBalance = await provider.connection.getBalance(rentDestination);
      assert.isAbove(rentDestBalance, 0, "rent_destination had iets moeten ontvangen - ongewijzigd gedrag");

      const afterInfo = await provider.connection.getAccountInfo(spendWindowPda);
      assert.isNull(
        afterInfo,
        "spend_window mag NA een geslaagde hunt nog steeds niet bestaan - stap B voegde alleen het adres toe aan de accountlijst, geen init_if_needed, geen handhaving"
      );
    });
  });
});
