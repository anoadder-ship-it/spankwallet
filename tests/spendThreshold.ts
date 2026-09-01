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

// spendThreshold.ts — STATUS.md sectie 127/128 (stap A, Route 2): bewijst
// tegen een echte validator dat spend_threshold_lamports == 0 (de
// fail-safe default, alle zeventien bestaande wallets vandaag) het gedrag
// van execute/hunt ONGEWIJZIGD laat na de nieuwe
// AmountExceedsInstantThreshold-gating. Draait onder het GEWONE `yarn
// test` - geen enkele test hier zet een drempel, dus geen afhankelijkheid
// van de test-fast-pending-timelock-feature.
//
// De THRESHOLD > 0-tests (daadwerkelijke gating + de symmetrie met
// initiate_withdrawal) staan bewust NIET hier, maar als een nieuw
// describe-blok in tests/pendingAction.ts: een niet-nul drempel zetten
// vereist finalize_threshold_change, dat de echte 24u-timelock zou
// afdwingen zonder de test-fast-pending-timelock-feature - dit bestand
// draait niet met die feature, tests/pendingAction.ts (via
// yarn test:pending-action) al wel.
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

describe("spankwallet: spend_threshold_lamports = 0 laat execute/hunt ongewijzigd (STATUS.md sectie 127/128)", () => {
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
    return { walletPda, vaultPda, passkeysPda, walletSeedHash: Array.from(seedHash) };
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
    const huntIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
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
    it("threshold = 0: gedrag exact ongewijzigd, elk bedrag gaat instant door (bewijst dat bestaande wallets niet breken)", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
      const recipient = Keypair.generate().publicKey;
      // Ruim boven wat ooit een redelijke drempel zou zijn - juist om te
      // bewijzen dat threshold=0 GEEN bovengrens is, geen enkel bedrag
      // wordt geweigerd.
      const amount = new BN(1.5 * anchor.web3.LAMPORTS_PER_SOL);

      const vaultBefore = await provider.connection.getBalance(vaultPda);
      await callExecute(passkey, walletPda, vaultPda, passkeysPda, recipient, amount);
      const vaultAfter = await provider.connection.getBalance(vaultPda);
      const recipientBalance = await provider.connection.getBalance(recipient);

      assert.equal(vaultBefore - vaultAfter, amount.toNumber());
      assert.equal(recipientBalance, amount.toNumber());
    });
  });

  describe("hunt", () => {
    it("threshold = 0: gedrag exact ongewijzigd, hunt slaagt normaal (bewijst dat bestaande wallets niet breken)", async () => {
      const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
      const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
      const rentDestination = Keypair.generate().publicKey;

      await callHunt(
        passkey,
        walletPda,
        vaultPda,
        passkeysPda,
        tokenAccount.publicKey,
        mint.publicKey,
        rentDestination
      );

      const closedInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
      assert.isNull(closedInfo, "target_token_account had gesloten moeten zijn na hunt");
      const rentDestBalance = await provider.connection.getBalance(rentDestination);
      assert.isAbove(rentDestBalance, 0, "rent_destination had iets moeten ontvangen");
    });
  });
});
