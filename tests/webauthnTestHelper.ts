import { p256 } from "@noble/curves/p256";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash, randomBytes } from "crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const SECP256R1_PROGRAM_ID = new PublicKey(
  "Secp256r1SigVerify1111111111111111111111111"
);

export interface TestPasskey {
  privateKey: Uint8Array;
  compressedPublicKey: Buffer;
}

export function generateTestPasskey(): TestPasskey {
  const privateKey = p256.utils.randomPrivateKey();
  const compressedPublicKey = Buffer.from(p256.getPublicKey(privateKey, true));
  return { privateKey, compressedPublicKey };
}

function base64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildExpectedChallenge(
  programId: PublicKey,
  wallet: PublicKey,
  domain: string,
  payload: Buffer
): Buffer {
  const domainBytes = Buffer.from(domain, "utf-8");
  const combined = Buffer.concat([
    programId.toBuffer(),
    wallet.toBuffer(),
    domainBytes,
    payload,
  ]);
  return Buffer.from(keccak_256(combined));
}

export interface SignedTestChallenge {
  signedMessage: Buffer;
  rawSignature: Buffer;
  clientDataJSON: Buffer;
}

export function signTestChallenge(
  passkey: TestPasskey,
  expectedChallenge: Buffer
): SignedTestChallenge {
  const challengeB64url = base64url(expectedChallenge);
  const clientData = {
    type: "webauthn.get",
    challenge: challengeB64url,
    origin: "https://spankwallet-tests.local",
    crossOrigin: false,
  };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData), "utf-8");
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();

  const authenticatorData = randomBytes(37);

  const signedMessage = Buffer.concat([authenticatorData, clientDataHash]);
  const messageHash = createHash("sha256").update(signedMessage).digest();

  const signature = p256.sign(messageHash, passkey.privateKey, { lowS: true });
  const rawSignature = Buffer.from(signature.toCompactRawBytes());

  return { signedMessage, rawSignature, clientDataJSON };
}

export function buildSecp256r1Instruction(
  compressedPubkey: Buffer,
  message: Buffer,
  rawSignature: Buffer
): TransactionInstruction {
  if (compressedPubkey.length !== 33) {
    throw new Error(`publieke sleutel moet 33 bytes zijn, kreeg ${compressedPubkey.length}`);
  }
  if (rawSignature.length !== 64) {
    throw new Error(`handtekening moet 64 bytes zijn, kreeg ${rawSignature.length}`);
  }

  const NO_OWN_INSTRUCTION = 0xffff;
  const HEADER_LEN = 2;
  const OFFSETS_STRUCT_LEN = 14;
  const dataStart = HEADER_LEN + OFFSETS_STRUCT_LEN;

  const signatureOffset = dataStart;
  const publicKeyOffset = signatureOffset + rawSignature.length;
  const messageOffset = publicKeyOffset + compressedPubkey.length;
  const totalLen = messageOffset + message.length;

  const data = Buffer.alloc(totalLen);
  data[0] = 1;
  data[1] = 0;

  let o = HEADER_LEN;
  data.writeUInt16LE(signatureOffset, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;
  data.writeUInt16LE(publicKeyOffset, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;
  data.writeUInt16LE(messageOffset, o); o += 2;
  data.writeUInt16LE(message.length, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;

  rawSignature.copy(data, signatureOffset);
  compressedPubkey.copy(data, publicKeyOffset);
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Exacte TS-tegenhanger van encode_optional_i64() in instructions.rs - voor
 * de init_wallet-challenge-payload (bindt backup_authority en
 * recovery_timelock_seconds aan de handtekening, zie STATUS.md sectie 22).
 */
export function encodeOptionalI64(value: number | null): Buffer {
  const out = Buffer.alloc(9);
  if (value !== null) {
    out[0] = 1;
    out.writeBigInt64LE(BigInt(value), 1);
  }
  return out;
}
