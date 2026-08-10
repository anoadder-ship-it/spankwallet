import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { concatBytes, encodeBorshVecU8, buildExpectedChallenge } from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
import { derivePasskeysPda } from "./passkeys";
import { derivePolicyPda } from "./policy";

// Session keys (STATUS.md): een LazorKit-geinspireerd, slot-gebonden
// autorisatiemechanisme naast passkeys. Een sessiesleutel is een GEWONE
// Ed25519 Solana-Keypair, geen passkey - add_session_key/remove_session_key
// zijn nog steeds passkey-gated (ze wijzigen WIE toegang heeft), maar de
// zeven "_via_session"-achtige spend-instructies hieronder ondertekenen met
// een gewone Solana-transactiehandtekening: geen secp256r1Ix, geen
// clientDataJSON, geen instructions_sysvar - Solana's eigen
// transactie-ondertekening bindt de sessiesleutel al aan exact deze
// instructie. Dat is het hele punt: geen WebAuthn-ceremonie per spend.

const ADD_SESSION_KEY_DISCRIMINATOR = Uint8Array.from([
  48, 71, 165, 97, 37, 22, 181, 59,
]);
const REMOVE_SESSION_KEY_DISCRIMINATOR = Uint8Array.from([
  118, 217, 88, 144, 49, 67, 0, 243,
]);
const CLOSE_SESSION_DISCRIMINATOR = Uint8Array.from([
  68, 114, 178, 140, 222, 38, 248, 211,
]);
const CLOSE_EXPIRED_SESSION_DISCRIMINATOR = Uint8Array.from([
  95, 15, 88, 127, 40, 196, 140, 184,
]);
const EXECUTE_VIA_SESSION_DISCRIMINATOR = Uint8Array.from([
  49, 33, 195, 54, 230, 149, 61, 4,
]);
const TRANSFER_TOKEN_VIA_SESSION_DISCRIMINATOR = Uint8Array.from([
  217, 28, 58, 34, 67, 161, 9, 163,
]);
const EXECUTE_ADVANCED_VIA_SESSION_DISCRIMINATOR = Uint8Array.from([
  149, 143, 107, 127, 142, 135, 245, 42,
]);

function encodeVecPubkey(pubkeys: PublicKey[]): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, pubkeys.length, true);
  return concatBytes(lenBytes, ...pubkeys.map((p) => p.toBytes()));
}

export function deriveSessionPda(walletPda: PublicKey, sessionKey: PublicKey): PublicKey {
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session"), walletPda.toBytes(), sessionKey.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return sessionPda;
}

// SessionKeyAccount-layout (state.rs): discriminator(8) + wallet(32) +
// session_key(32) + bump(1) + expiry_slot(8) + can_execute(1) +
// can_transfer_token(1) + can_execute_advanced(1) + count(1) +
// allowed_programs([Pubkey; 8]).
const OFFSET_SESSION_KEY = 8 + 32;
const OFFSET_BUMP = OFFSET_SESSION_KEY + 32;
const OFFSET_EXPIRY_SLOT = OFFSET_BUMP + 1;
const OFFSET_CAN_EXECUTE = OFFSET_EXPIRY_SLOT + 8;
const OFFSET_CAN_TRANSFER_TOKEN = OFFSET_CAN_EXECUTE + 1;
const OFFSET_CAN_EXECUTE_ADVANCED = OFFSET_CAN_TRANSFER_TOKEN + 1;
const OFFSET_COUNT = OFFSET_CAN_EXECUTE_ADVANCED + 1;
const OFFSET_ALLOWED_PROGRAMS = OFFSET_COUNT + 1;

export interface ParsedSessionKeyAccount {
  sessionKey: PublicKey;
  expirySlot: bigint;
  canExecute: boolean;
  canTransferToken: boolean;
  canExecuteAdvanced: boolean;
  count: number;
  allowedPrograms: PublicKey[];
}

export async function readSessionKeyAccount(
  connection: Connection,
  sessionPda: PublicKey
): Promise<ParsedSessionKeyAccount | null> {
  const accountInfo = await connection.getAccountInfo(sessionPda);
  if (!accountInfo) {
    return null;
  }
  const data = accountInfo.data;
  const sessionKey = new PublicKey(data.subarray(OFFSET_SESSION_KEY, OFFSET_SESSION_KEY + 32));
  const expirySlot = data.readBigUInt64LE(OFFSET_EXPIRY_SLOT);
  const canExecute = data[OFFSET_CAN_EXECUTE] !== 0;
  const canTransferToken = data[OFFSET_CAN_TRANSFER_TOKEN] !== 0;
  const canExecuteAdvanced = data[OFFSET_CAN_EXECUTE_ADVANCED] !== 0;
  const count = data[OFFSET_COUNT];
  const allowedPrograms: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    const start = OFFSET_ALLOWED_PROGRAMS + i * 32;
    allowedPrograms.push(new PublicKey(data.subarray(start, start + 32)));
  }
  return { sessionKey, expirySlot, canExecute, canTransferToken, canExecuteAdvanced, count, allowedPrograms };
}

export interface AddSessionKeyResult {
  transaction: Transaction;
  sessionPda: PublicKey;
}

/**
 * Bouwt de add_session_key-transactie - vereist een ECHTE passkey-
 * handtekening van een van de al geldige sleutels. De challenge bindt de
 * VOLLEDIGE scope (session_key, expiry_slot, de drie instructie-vlaggen, de
 * sub-allowlist) - een onderschepte handtekening voor "sta scope X toe" kan
 * nooit hergebruikt worden voor een bredere scope. Geen zelf-verlenging
 * mogelijk: elke verlenging is simpelweg een nieuwe add_session_key-aanroep,
 * die opnieuw een echte passkey-handtekening vereist.
 */
export async function buildAddSessionKeyTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  sessionKey: PublicKey,
  expirySlot: bigint,
  canExecute: boolean,
  canTransferToken: boolean,
  canExecuteAdvanced: boolean,
  sessionAllowedPrograms: PublicKey[],
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<AddSessionKeyResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKey);
  const policyPda = derivePolicyPda(walletPda);

  const expirySlotBytes = new Uint8Array(8);
  new DataView(expirySlotBytes.buffer).setBigUint64(0, expirySlot, true);
  const payload = concatBytes(
    sessionKey.toBytes(),
    expirySlotBytes,
    Uint8Array.from([canExecute ? 1 : 0, canTransferToken ? 1 : 0, canExecuteAdvanced ? 1 : 0]),
    encodeVecPubkey(sessionAllowedPrograms)
  );

  const expectedChallenge = buildExpectedChallenge(walletPda, "add_session_key", payload);

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(
    signingPasskeyCompressedPublicKey,
    signedMessage,
    rawSignature
  );

  const data = concatBytes(
    ADD_SESSION_KEY_DISCRIMINATOR,
    sessionKey.toBytes(),
    expirySlotBytes,
    Uint8Array.from([canExecute ? 1 : 0, canTransferToken ? 1 : 0, canExecuteAdvanced ? 1 : 0]),
    encodeVecPubkey(sessionAllowedPrograms),
    encodeBorshVecU8(clientDataJSON)
  );

  const addIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: policyPda, isSigner: false, isWritable: false },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, addIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, sessionPda };
}

export interface RemoveSessionKeyResult {
  transaction: Transaction;
}

/** Bouwt de remove_session_key-transactie - passkey-gated vroegtijdige intrekking. */
export async function buildRemoveSessionKeyTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  sessionKey: PublicKey,
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<RemoveSessionKeyResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKey);

  const expectedChallenge = buildExpectedChallenge(
    walletPda,
    "remove_session_key",
    sessionKey.toBytes()
  );

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(
    signingPasskeyCompressedPublicKey,
    signedMessage,
    rawSignature
  );

  const data = concatBytes(
    REMOVE_SESSION_KEY_DISCRIMINATOR,
    sessionKey.toBytes(),
    encodeBorshVecU8(clientDataJSON)
  );

  const removeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, removeIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}

export interface CloseSessionResult {
  transaction: Transaction;
}

/**
 * Bouwt EN ondertekent de close_session-transactie - de sessiesleutel zelf
 * is zowel de enige benodigde Signer als de fee payer, geen wallet-extensie
 * of passkey-prompt nodig. Het enige dat een sessiesleutel zelfstandig mag
 * doen: eigen bevoegdheid intrekken, nooit verbreden.
 */
export async function buildCloseSessionTransaction(
  connection: Connection,
  walletPda: PublicKey,
  sessionKeypair: Keypair
): Promise<CloseSessionResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  const closeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: sessionKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(CLOSE_SESSION_DISCRIMINATOR),
  });

  const transaction = new Transaction().add(closeIx);
  transaction.feePayer = sessionKeypair.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(sessionKeypair);

  return { transaction };
}

export interface CloseExpiredSessionResult {
  transaction: Transaction;
}

/**
 * Bouwt EN ondertekent de close_expired_session-transactie - permissionless,
 * `closer` mag een compleet willekeurige, gefunde Keypair zijn die nooit
 * iets met deze wallet te maken heeft gehad. Faalt on-chain (SessionNotYetExpired)
 * als expiry_slot nog niet gepasseerd is.
 */
export async function buildCloseExpiredSessionTransaction(
  connection: Connection,
  walletPda: PublicKey,
  sessionKey: PublicKey,
  closer: Keypair
): Promise<CloseExpiredSessionResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKey);

  const data = concatBytes(CLOSE_EXPIRED_SESSION_DISCRIMINATOR, sessionKey.toBytes());

  const closeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: closer.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(closeIx);
  transaction.feePayer = closer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(closer);

  return { transaction };
}

export interface ExecuteViaSessionResult {
  transaction: Transaction;
}

/**
 * Bouwt EN ondertekent de execute_via_session-transactie - GEEN
 * secp256r1Ix, GEEN clientDataJSON, GEEN instructions_sysvar: de
 * sessiesleutel ondertekent de Solana-transactie rechtstreeks, net als elke
 * gewone walletsleutel. Dit is het hele punt van session keys.
 */
export async function buildExecuteViaSessionTransaction(
  connection: Connection,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  recipient: PublicKey,
  amountLamports: bigint,
  sessionKeypair: Keypair
): Promise<ExecuteViaSessionResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amountLamports, true);
  const data = concatBytes(EXECUTE_VIA_SESSION_DISCRIMINATOR, amountBytes);

  const executeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: false },
      { pubkey: sessionKeypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(executeIx);
  transaction.feePayer = sessionKeypair.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(sessionKeypair);

  return { transaction };
}

export interface TransferTokenViaSessionResult {
  transaction: Transaction;
}

export async function buildTransferTokenViaSessionTransaction(
  connection: Connection,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  vaultTokenAccount: PublicKey,
  recipientTokenAccount: PublicKey,
  tokenMint: PublicKey,
  amount: bigint,
  sessionKeypair: Keypair
): Promise<TransferTokenViaSessionResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amount, true);
  const data = concatBytes(TRANSFER_TOKEN_VIA_SESSION_DISCRIMINATOR, amountBytes);

  const transferIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: sessionPda, isSigner: false, isWritable: false },
      { pubkey: sessionKeypair.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(transferIx);
  transaction.feePayer = sessionKeypair.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(sessionKeypair);

  return { transaction };
}

export interface SessionRemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

export interface ExecuteAdvancedViaSessionResult {
  transaction: Transaction;
}

/**
 * Bouwt EN ondertekent de execute_advanced_via_session-transactie. Geen
 * challenge-binding nodig (zie boven) - het CPI-doel wordt uitsluitend
 * on-chain gecontroleerd, tegen ZOWEL de sessie's eigen sub-scope ALS de
 * live PolicyAccount (geen cache).
 */
export async function buildExecuteAdvancedViaSessionTransaction(
  walletPda: PublicKey,
  vaultPda: PublicKey,
  policyPda: PublicKey,
  cpiProgramId: PublicKey,
  remainingAccounts: SessionRemainingAccountSpec[],
  cpiInstructionData: Uint8Array,
  connection: Connection,
  sessionKeypair: Keypair
): Promise<ExecuteAdvancedViaSessionResult> {
  const sessionPda = deriveSessionPda(walletPda, sessionKeypair.publicKey);

  const data = concatBytes(
    EXECUTE_ADVANCED_VIA_SESSION_DISCRIMINATOR,
    encodeBorshVecU8(cpiInstructionData)
  );

  const keys: AccountMeta[] = [
    { pubkey: walletPda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: policyPda, isSigner: false, isWritable: false },
    { pubkey: cpiProgramId, isSigner: false, isWritable: false },
    { pubkey: sessionPda, isSigner: false, isWritable: false },
    { pubkey: sessionKeypair.publicKey, isSigner: true, isWritable: false },
    ...remainingAccounts.map((a) => ({
      pubkey: a.pubkey,
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
  ];

  const executeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(executeIx);
  transaction.feePayer = sessionKeypair.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(sessionKeypair);

  return { transaction };
}
