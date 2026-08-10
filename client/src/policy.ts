import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { concatBytes, encodeBorshVecU8, buildExpectedChallenge } from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
import { derivePasskeysPda } from "./passkeys";

const ADD_ALLOWED_PROGRAM_DISCRIMINATOR = Uint8Array.from([
  81, 202, 134, 129, 247, 211, 122, 99,
]);
const REMOVE_ALLOWED_PROGRAM_DISCRIMINATOR = Uint8Array.from([
  145, 253, 69, 41, 255, 69, 248, 163,
]);

export function derivePolicyPda(walletPda: PublicKey): PublicKey {
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return policyPda;
}

// PolicyAccount-layout (state.rs): discriminator(8) + wallet(32) + bump(1) +
// count(1) + allowed_programs([Pubkey; 32]).
const OFFSET_POLICY_COUNT = 8 + 32 + 1;
const OFFSET_POLICY_ALLOWED_PROGRAMS = OFFSET_POLICY_COUNT + 1;

export interface ParsedPolicyAccount {
  count: number;
  allowedPrograms: PublicKey[];
}

export async function readPolicyAccount(
  connection: Connection,
  policyPda: PublicKey
): Promise<ParsedPolicyAccount | null> {
  const accountInfo = await connection.getAccountInfo(policyPda);
  if (!accountInfo) {
    return null;
  }
  const data = accountInfo.data;
  const count = data[OFFSET_POLICY_COUNT];
  const allowedPrograms: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    const start = OFFSET_POLICY_ALLOWED_PROGRAMS + i * 32;
    allowedPrograms.push(new PublicKey(data.subarray(start, start + 32)));
  }
  return { count, allowedPrograms };
}

export interface AddAllowedProgramResult {
  transaction: Transaction;
  policyPda: PublicKey;
}

/**
 * Bouwt de add_allowed_program-transactie. Vereist een ECHTE passkey-
 * handtekening (challenge bindt uitsluitend het programma-ID als payload) -
 * zelfde patroon als execute/transfer_token/hunt. Het policy-account wordt
 * lui aangemaakt (init_if_needed on-chain) als dit de eerste keer is voor
 * deze wallet - vandaar dat payer hier ook mut+signer is, precies zoals in
 * init_wallet.
 */
export async function buildAddAllowedProgramTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  programIdToAllow: PublicKey,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<AddAllowedProgramResult> {
  const policyPda = derivePolicyPda(walletPda);

  const expectedChallenge = buildExpectedChallenge(
    walletPda,
    "add_allowed_program",
    programIdToAllow.toBytes()
  );

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

  const data = concatBytes(
    ADD_ALLOWED_PROGRAM_DISCRIMINATOR,
    programIdToAllow.toBytes(),
    encodeBorshVecU8(clientDataJSON)
  );

  const addIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: policyPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
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

  return { transaction, policyPda };
}

export interface RemoveAllowedProgramResult {
  transaction: Transaction;
}

/**
 * Bouwt de remove_allowed_program-transactie. Zelfde passkey-vereiste als
 * add_allowed_program; het policy-account moet al bestaan (geen
 * init_if_needed hier - remove op een niet-bestaand account faalt
 * structureel via Anchors eigen accountdeserialisatie).
 */
export async function buildRemoveAllowedProgramTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  programIdToRemove: PublicKey,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<RemoveAllowedProgramResult> {
  const policyPda = derivePolicyPda(walletPda);

  const expectedChallenge = buildExpectedChallenge(
    walletPda,
    "remove_allowed_program",
    programIdToRemove.toBytes()
  );

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

  const data = concatBytes(
    REMOVE_ALLOWED_PROGRAM_DISCRIMINATOR,
    programIdToRemove.toBytes(),
    encodeBorshVecU8(clientDataJSON)
  );

  const removeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: policyPda, isSigner: false, isWritable: true },
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
