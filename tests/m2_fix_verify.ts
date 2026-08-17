import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
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
} from "./webauthnTestHelper";
import {
  buildExecuteViaSessionTransaction,
  buildTransferTokenViaSessionTransaction,
} from "../client/src/sessionKeys";

// M-2-fix-verificatie: roept de ECHTE, gepatchte productieclient-functies
// (client/src/sessionKeys.ts) rechtstreeks aan - niet een losstaande
// reconstructie zoals writability_check.ts (dat isoleerde alleen de
// hypothese). Dit bevestigt dat de daadwerkelijk gecommitte client-code nu
// werkt. Vereist tijdelijk dat client/src/programId.ts naar hetzelfde
// lokale-only programma-ID wijst als Anchor.toml/declare_id! (zelfde
// anchor-keys-sync-truc als STATUS.md sectie 41, teruggedraaid na afloop).
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

function encodeInitializeMintIx(mint: PublicKey, decimals: number, mintAuthority: PublicKey): TransactionInstruction {
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

function encodeInitializeAccountIx(account: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
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

function encodeMintToIx(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: number): TransactionInstruction {
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

describe("M-2 FIX VERIFY: echte client/src/sessionKeys.ts-functies tegen de lokale validator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), seedHash], program.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), walletPda.toBuffer()], program.programId);
    const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("policy"), walletPda.toBuffer()], program.programId);
    const [passkeysPda] = PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], program.programId);
    return { walletPda, vaultPda, policyPda, passkeysPda, walletSeedHash: Array.from(seedHash) };
  }

  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, policyPda, passkeysPda, walletSeedHash } = derivePdas(passkey.compressedPublicKey);

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

    return { passkey, walletPda, vaultPda, policyPda, passkeysPda };
  }

  async function addSession(
    passkey: ReturnType<typeof generateTestPasskey>,
    walletPda: PublicKey,
    policyPda: PublicKey,
    passkeysPda: PublicKey,
    sessionKeypair: Keypair,
    canExecute: boolean,
    canTransferToken: boolean,
    tokenMint: PublicKey
  ) {
    const MAX_U64 = new BN("18446744073709551615");
    const currentSlot = await provider.connection.getSlot();
    const expirySlot = currentSlot + 10000;
    const addPayload = Buffer.concat([
      sessionKeypair.publicKey.toBuffer(),
      new BN(expirySlot).toArrayLike(Buffer, "le", 8),
      Buffer.from([canExecute ? 1 : 0]),
      Buffer.from([canTransferToken ? 1 : 0]),
      Buffer.from([0]),
      Buffer.from([0, 0, 0, 0]),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      MAX_U64.toArrayLike(Buffer, "le", 8),
      tokenMint.toBuffer(),
      canTransferToken ? MAX_U64.toArrayLike(Buffer, "le", 8) : new BN(0).toArrayLike(Buffer, "le", 8),
      canTransferToken ? MAX_U64.toArrayLike(Buffer, "le", 8) : new BN(0).toArrayLike(Buffer, "le", 8),
    ]);
    const addChallenge = buildExpectedChallenge(program.programId, walletPda, "add_session_key", addPayload);
    const addSigned = signTestChallenge(passkey, addChallenge);
    const addSecpIx = buildSecp256r1Instruction(passkey.compressedPublicKey, addSigned.signedMessage, addSigned.rawSignature);
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), walletPda.toBuffer(), sessionKeypair.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .addSessionKey(
        sessionKeypair.publicKey,
        new BN(expirySlot),
        canExecute,
        canTransferToken,
        false,
        [],
        MAX_U64,
        MAX_U64,
        tokenMint,
        canTransferToken ? MAX_U64 : new BN(0),
        canTransferToken ? MAX_U64 : new BN(0),
        addSigned.clientDataJSON
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
      .preInstructions([addSecpIx])
      .rpc();

    return sessionPda;
  }

  it("buildExecuteViaSessionTransaction (gepatcht) slaagt on-chain en werkt spent_lamports bij", async () => {
    const { passkey, walletPda, vaultPda, policyPda, passkeysPda } = await createWallet();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }))
    );

    const sessionKeypair = Keypair.generate();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: sessionKeypair.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }))
    );
    const sessionPda = await addSession(passkey, walletPda, policyPda, passkeysPda, sessionKeypair, true, false, PublicKey.default);

    const amount = 1000n;
    const { transaction } = await buildExecuteViaSessionTransaction(
      provider.connection,
      walletPda,
      vaultPda,
      provider.wallet.publicKey,
      amount,
      sessionKeypair
    );

    const sig = await provider.connection.sendRawTransaction(transaction.serialize());
    await provider.connection.confirmTransaction(sig, "confirmed");

    const session = await program.account.sessionKeyAccount.fetch(sessionPda);
    assert.equal(session.spentLamports.toNumber(), 1000, "spent_lamports had via de echte client-functie bijgewerkt moeten zijn");
  });

  it("buildTransferTokenViaSessionTransaction (gepatcht) slaagt on-chain en werkt spent_token_amount bij", async () => {
    const { passkey, walletPda, vaultPda, policyPda, passkeysPda } = await createWallet();

    const mint = Keypair.generate();
    const vaultTokenAccount = Keypair.generate();
    const recipientTokenAccount = Keypair.generate();
    const mintRent = await provider.connection.getMinimumBalanceForRentExemption(MINT_LEN);
    const tokenAccountRent = await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({ fromPubkey: provider.wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: mintRent, space: MINT_LEN, programId: TOKEN_PROGRAM_ID }),
        encodeInitializeMintIx(mint.publicKey, 0, provider.wallet.publicKey),
        SystemProgram.createAccount({ fromPubkey: provider.wallet.publicKey, newAccountPubkey: vaultTokenAccount.publicKey, lamports: tokenAccountRent, space: TOKEN_ACCOUNT_LEN, programId: TOKEN_PROGRAM_ID }),
        encodeInitializeAccountIx(vaultTokenAccount.publicKey, mint.publicKey, vaultPda),
        SystemProgram.createAccount({ fromPubkey: provider.wallet.publicKey, newAccountPubkey: recipientTokenAccount.publicKey, lamports: tokenAccountRent, space: TOKEN_ACCOUNT_LEN, programId: TOKEN_PROGRAM_ID }),
        encodeInitializeAccountIx(recipientTokenAccount.publicKey, mint.publicKey, provider.wallet.publicKey),
        encodeMintToIx(mint.publicKey, vaultTokenAccount.publicKey, provider.wallet.publicKey, 10_000)
      ),
      [mint, vaultTokenAccount, recipientTokenAccount]
    );

    const sessionKeypair = Keypair.generate();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: sessionKeypair.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }))
    );
    const sessionPda = await addSession(passkey, walletPda, policyPda, passkeysPda, sessionKeypair, false, true, mint.publicKey);

    const amount = 500n;
    const { transaction } = await buildTransferTokenViaSessionTransaction(
      provider.connection,
      walletPda,
      vaultPda,
      vaultTokenAccount.publicKey,
      recipientTokenAccount.publicKey,
      mint.publicKey,
      amount,
      sessionKeypair
    );

    const sig = await provider.connection.sendRawTransaction(transaction.serialize());
    await provider.connection.confirmTransaction(sig, "confirmed");

    const session = await program.account.sessionKeyAccount.fetch(sessionPda);
    assert.equal(session.spentTokenAmount.toNumber(), 500, "spent_token_amount had via de echte client-functie bijgewerkt moeten zijn");
  });
});
