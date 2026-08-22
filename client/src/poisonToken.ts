/**
 * Active Defense - Client Library
 * 
 * Program ID: G1D5ckPj3ZMBeYNfEz24dGhvPExqNP6Y3SFNx3V7RbK5
 * Upgrade Authority: 9W3CGKhd7hgywf3xfP8snNmB2AgmzwQ3rdDFDV3hUurK
 * 
 * This module provides functions to interact with the active-defense program.
 * It does NOT modify spankwallet - it only reads owner_passkey from the
 * spankwallet WalletAccount (read-only).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMint2Instruction,
  createInitializeTransferHookInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

// ============================================================
// CONSTANTS
// ============================================================

export const ACTIVE_DEFENSE_PROGRAM_ID = new PublicKey(
  "G1D5ckPj3ZMBeYNfEz24dGhvPExqNP6Y3SFNx3V7RbK5"
);

export const INSTRUCTIONS_SYSVAR = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

// Anchor discriminators: sha256("global:<instruction_name>").slice(0, 8)
const DISCRIMINATORS = {
  create_poison_token: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x0d, 0x00, 0x00, 0x00, 0x00,
  ]),
  add_poison_authorized: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x0e, 0x00, 0x00, 0x00, 0x00,
  ]),
  remove_poison_authorized: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x0f, 0x00, 0x00, 0x00, 0x00,
  ]),
  poison_transfer_hook: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x10, 0x00, 0x00, 0x00, 0x00,
  ]),
  mark_malicious: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x11, 0x00, 0x00, 0x00, 0x00,
  ]),
  unmark_malicious: new Uint8Array([
    0x11, 0xb8, 0xc3, 0x12, 0x00, 0x00, 0x00, 0x00,
  ]),
} as const;

// ============================================================
// PDA DERIVATION
// ============================================================

/**
 * Derives the PoisonTokenAccount PDA.
 * Seeds: ["poison_token", wallet_pda, mint]
 */
export function derivePoisonTokenPda(
  walletPda: PublicKey,
  mint: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("poison_token"),
      walletPda.toBuffer(),
      mint.toBuffer(),
    ],
    ACTIVE_DEFENSE_PROGRAM_ID
  );
}

/**
 * Derives the MaliciousAddressesAccount PDA.
 * Seeds: ["malicious", wallet_pda]
 */
export function deriveMaliciousPda(
  walletPda: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("malicious"),
      walletPda.toBuffer(),
    ],
    ACTIVE_DEFENSE_PROGRAM_ID
  );
}

// ============================================================
// ACCOUNT READING
// ============================================================

export interface PoisonTokenInfo {
  wallet: PublicKey;
  mint: PublicKey;
  bump: number;
  count: number;
  authorizedRecipients: PublicKey[];
  triggered: boolean;
  triggeredAt: number;
}

export interface MaliciousAddressesInfo {
  wallet: PublicKey;
  bump: number;
  count: number;
  addresses: PublicKey[];
}

/**
 * Reads the PoisonTokenAccount from the blockchain.
 * Returns null if the account doesn't exist.
 */
export async function readPoisonTokenAccount(
  connection: Connection,
  walletPda: PublicKey,
  mint: PublicKey
): Promise<PoisonTokenInfo | null> {
  const [poisonTokenPda] = derivePoisonTokenPda(walletPda, mint);
  const info = await connection.getAccountInfo(poisonTokenPda);
  if (!info) return null;

  const d = info.data;
  // Layout:
  //   discriminator(8) + wallet(32) + mint(32) + bump(1) + count(1)
  //   + authorized_recipients(32 * count) + triggered(1) + triggered_at(8)

  const wallet = new PublicKey(d.subarray(8, 40));
  const mint_ = new PublicKey(d.subarray(40, 72));
  const bump = d[72];
  const count = d[73];

  const authorizedRecipients: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 74 + i * 32;
    authorizedRecipients.push(new PublicKey(d.subarray(offset, offset + 32)));
  }

  const triggeredOffset = 74 + count * 32;
  const triggered = d[triggeredOffset] === 1;
  const triggeredAt = Number(d.readBigInt64LE(triggeredOffset + 1));

  return { wallet, mint: mint_, bump, count, authorizedRecipients, triggered, triggeredAt };
}

/**
 * Reads the MaliciousAddressesAccount from the blockchain.
 * Returns null if the account doesn't exist.
 */
export async function readMaliciousAddresses(
  connection: Connection,
  walletPda: PublicKey
): Promise<MaliciousAddressesInfo | null> {
  const [maliciousPda] = deriveMaliciousPda(walletPda);
  const info = await connection.getAccountInfo(maliciousPda);
  if (!info) return null;

  const d = info.data;
  // Layout:
  //   discriminator(8) + wallet(32) + bump(1) + count(1)
  //   + addresses(32 * count)

  const wallet = new PublicKey(d.subarray(8, 40));
  const bump = d[40];
  const count = d[41];

  const addresses: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 42 + i * 32;
    addresses.push(new PublicKey(d.subarray(offset, offset + 32)));
  }

  return { wallet, bump, count, addresses };
}

// ============================================================
// INSTRUCTION BUILDERS
// ============================================================

/**
 * Builds the create_poison_token instruction.
 * 
 * NOTE: This requires a valid spankwallet WalletAccount PDA and
 * a WebAuthn passkey signature. The full flow is:
 * 1. Client generates a challenge
 * 2. User authenticates with passkey (WebAuthn)
 * 3. secp256r1 precompile instruction is added BEFORE this instruction
 * 4. This instruction verifies the signature on-chain
 */
export function buildCreatePoisonTokenIx(
  walletPda: PublicKey,
  mint: PublicKey,
  payer: PublicKey,
  clientActionNonce: number,
  clientDataJson: Buffer
): TransactionInstruction {
  const [poisonTokenPda] = derivePoisonTokenPda(walletPda, mint);

  // Data: discriminator(8) + nonce(u64 LE) + client_data_json_len(u32 LE) + client_data_json
  const data = Buffer.alloc(8 + 8 + 4 + clientDataJson.length);
  data.set(DISCRIMINATORS.create_poison_token, 0);
  data.writeBigUInt64LE(BigInt(clientActionNonce), 8);
  data.writeUInt32LE(clientDataJson.length, 16);
  clientDataJson.copy(data, 20);

  return new TransactionInstruction({
    programId: ACTIVE_DEFENSE_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: poisonTokenPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Builds the add_poison_authorized instruction.
 */
export function buildAddPoisonAuthorizedIx(
  walletPda: PublicKey,
  mint: PublicKey,
  recipient: PublicKey,
  clientActionNonce: number,
  clientDataJson: Buffer
): TransactionInstruction {
  const [poisonTokenPda] = derivePoisonTokenPda(walletPda, mint);

  // Data: discriminator(8) + nonce(u64 LE) + recipient(32) + json_len(u32 LE) + json
  const data = Buffer.alloc(8 + 8 + 32 + 4 + clientDataJson.length);
  data.set(DISCRIMINATORS.add_poison_authorized, 0);
  data.writeBigUInt64LE(BigInt(clientActionNonce), 8);
  recipient.toBuffer().copy(data, 16);
  data.writeUInt32LE(clientDataJson.length, 48);
  clientDataJson.copy(data, 52);

  return new TransactionInstruction({
    programId: ACTIVE_DEFENSE_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: poisonTokenPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Builds the remove_poison_authorized instruction.
 */
export function buildRemovePoisonAuthorizedIx(
  walletPda: PublicKey,
  mint: PublicKey,
  recipient: PublicKey,
  clientActionNonce: number,
  clientDataJson: Buffer
): TransactionInstruction {
  const [poisonTokenPda] = derivePoisonTokenPda(walletPda, mint);

  const data = Buffer.alloc(8 + 8 + 32 + 4 + clientDataJson.length);
  data.set(DISCRIMINATORS.remove_poison_authorized, 0);
  data.writeBigUInt64LE(BigInt(clientActionNonce), 8);
  recipient.toBuffer().copy(data, 16);
  data.writeUInt32LE(clientDataJson.length, 48);
  clientDataJson.copy(data, 52);

  return new TransactionInstruction({
    programId: ACTIVE_DEFENSE_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: poisonTokenPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Builds the mark_malicious instruction.
 */
export function buildMarkMaliciousIx(
  walletPda: PublicKey,
  address: PublicKey,
  payer: PublicKey,
  clientActionNonce: number,
  clientDataJson: Buffer
): TransactionInstruction {
  const [maliciousPda] = deriveMaliciousPda(walletPda);

  const data = Buffer.alloc(8 + 8 + 32 + 4 + clientDataJson.length);
  data.set(DISCRIMINATORS.mark_malicious, 0);
  data.writeBigUInt64LE(BigInt(clientActionNonce), 8);
  address.toBuffer().copy(data, 16);
  data.writeUInt32LE(clientDataJson.length, 48);
  clientDataJson.copy(data, 52);

  return new TransactionInstruction({
    programId: ACTIVE_DEFENSE_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: maliciousPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Builds the unmark_malicious instruction.
 */
export function buildUnmarkMaliciousIx(
  walletPda: PublicKey,
  address: PublicKey,
  clientActionNonce: number,
  clientDataJson: Buffer
): TransactionInstruction {
  const [maliciousPda] = deriveMaliciousPda(walletPda);

  const data = Buffer.alloc(8 + 8 + 32 + 4 + clientDataJson.length);
  data.set(DISCRIMINATORS.unmark_malicious, 0);
  data.writeBigUInt64LE(BigInt(clientActionNonce), 8);
  address.toBuffer().copy(data, 16);
  data.writeUInt32LE(clientDataJson.length, 48);
  clientDataJson.copy(data, 52);

  return new TransactionInstruction({
    programId: ACTIVE_DEFENSE_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: maliciousPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ============================================================
// HIGH-LEVEL HELPERS
// ============================================================

/**
 * Creates a Token-2022 mint with transfer hook pointing to active-defense.
 * Returns the mint keypair and the initialized transaction (not yet signed).
 */
export function createMintWithTransferHook(
  payer: PublicKey,
  decimals: number = 6
): { mintKeypair: Keypair; tx: Transaction } {
  const mintKeypair = Keypair.generate();
  const tx = new Transaction();

  // Create mint account
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: 0, // Set by caller after getMinimumBalanceForRentExemption
      space: MINT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // Initialize mint
  tx.add(
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      decimals,
      payer,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  // Initialize transfer hook -> active-defense program
  tx.add(
    createInitializeTransferHookInstruction(
      mintKeypair.publicKey,
      ACTIVE_DEFENSE_PROGRAM_ID,
      payer,
      undefined,
      TOKEN_2022_PROGRAM_ID
    )
  );

  return { mintKeypair, tx };
}
