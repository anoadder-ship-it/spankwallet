import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { SPANKWALLET_PROGRAM_ID } from "./initWallet";

const EXECUTE_DISCRIMINATOR = Uint8Array.from([
  0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d,
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

function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, bytes.length, true);
  return concatBytes(lenBytes, bytes);
}

export interface ExecuteResult {
  transaction: Transaction;
  signedMessage: Uint8Array;
  expectedChallenge: Uint8Array;
}

export async function buildExecuteTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<ExecuteResult> {
  const cpiInstructionData = new Uint8Array(0);

  const expectedChallenge = buildExpectedChallenge(walletPda, "execute", cpiInstructionData);

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

  const executeData = concatBytes(
    EXECUTE_DISCRIMINATOR,
    encodeBorshVecU8(cpiInstructionData),
    encodeBorshVecU8(clientDataJSON)
  );

  const executeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(executeData),
  });

  const transaction = new Transaction().add(secp256r1Ix, executeIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, signedMessage, expectedChallenge };
}
