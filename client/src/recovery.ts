import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { SPANKWALLET_PROGRAM_ID } from "./initWallet";

const INITIATE_RECOVERY_DISCRIMINATOR = Uint8Array.from([
  0x84, 0x94, 0x3c, 0x4a, 0x31, 0xb2, 0xeb, 0xbb,
]);
const CANCEL_RECOVERY_DISCRIMINATOR = Uint8Array.from([
  0xb0, 0x17, 0xcb, 0x25, 0x79, 0xfb, 0xe3, 0x53,
]);

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, bytes.length, true);
  return concatBytes(lenBytes, bytes);
}

function buildExpectedChallenge(
  wallet: PublicKey,
  domain: string,
  payload: Uint8Array
): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const combined = concatBytes(
    SPANKWALLET_PROGRAM_ID.toBytes(),
    wallet.toBytes(),
    domainBytes,
    payload
  );
  return keccak_256(combined);
}

const OFFSET_RECOVERY_STATE_TAG = 148;
const OFFSET_RECOVERY_INITIATED_AT = 149;
const OFFSET_RECOVERY_NEW_OWNER_PASSKEY = 157;

export interface ParsedRecoveryState {
  initiatedAt: bigint;
  newOwnerPasskey: Uint8Array;
}

export interface ParsedWalletAccount {
  recoveryState: ParsedRecoveryState | null;
}

export async function readWalletAccount(
  connection: Connection,
  walletPda: PublicKey
): Promise<ParsedWalletAccount> {
  const accountInfo = await connection.getAccountInfo(walletPda);
  if (!accountInfo) {
    throw new Error("WalletAccount " + walletPda.toBase58() + " bestaat niet");
  }
  const data = accountInfo.data;

  const tag = data[OFFSET_RECOVERY_STATE_TAG];
  if (tag === 0) {
    return { recoveryState: null };
  }

  const initiatedAtBytes = data.subarray(
    OFFSET_RECOVERY_INITIATED_AT,
    OFFSET_RECOVERY_INITIATED_AT + 8
  );
  const initiatedAt = initiatedAtBytes.readBigInt64LE(0);
  const newOwnerPasskey = new Uint8Array(
    data.subarray(
      OFFSET_RECOVERY_NEW_OWNER_PASSKEY,
      OFFSET_RECOVERY_NEW_OWNER_PASSKEY + 33
    )
  );

  return { recoveryState: { initiatedAt, newOwnerPasskey } };
}

export async function buildInitiateRecoveryTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  backupAuthority: Keypair,
  newOwnerPasskey: Uint8Array
): Promise<Transaction> {
  if (newOwnerPasskey.length !== 33) {
    throw new Error("new_owner_passkey moet 33 bytes zijn, kreeg " + newOwnerPasskey.length);
  }

  const data = concatBytes(INITIATE_RECOVERY_DISCRIMINATOR, newOwnerPasskey);

  const instruction = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: backupAuthority.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(instruction);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  transaction.partialSign(backupAuthority);

  return transaction;
}

export interface CancelRecoveryResult {
  transaction: Transaction;
}

export async function buildCancelRecoveryTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string,
  recoveryState: ParsedRecoveryState
): Promise<CancelRecoveryResult> {
  const initiatedAtBytes = new Uint8Array(8);
  new DataView(initiatedAtBytes.buffer).setBigInt64(0, recoveryState.initiatedAt, true);
  const payload = concatBytes(initiatedAtBytes, recoveryState.newOwnerPasskey);

  const expectedChallenge = buildExpectedChallenge(walletPda, "cancel_recovery", payload);

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(
    passkeyCompressedPublicKey,
    signedMessage,
    rawSignature
  );

  const data = concatBytes(CANCEL_RECOVERY_DISCRIMINATOR, encodeBorshVecU8(clientDataJSON));

  const cancelIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, cancelIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}
