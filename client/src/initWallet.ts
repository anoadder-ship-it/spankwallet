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

export { SPANKWALLET_PROGRAM_ID };

const INIT_WALLET_DISCRIMINATOR = Uint8Array.from([
  0x8d, 0x84, 0xe9, 0x82, 0xa8, 0xb7, 0x0a, 0x77,
]);

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

// Borsh Option<i64>-codering voor het INSTRUCTIE-ARGUMENT: variabele lengte
// (1 byte bij None, 9 bytes bij Some) - dit is WAT het programma daadwerkelijk
// als instructie-data leest.
function encodeInstructionOptionalI64(value: bigint | null): Uint8Array {
  if (value === null) {
    return Uint8Array.from([0x00]);
  }
  const buf = new Uint8Array(9);
  buf[0] = 0x01;
  new DataView(buf.buffer).setBigInt64(1, value, true);
  return buf;
}

// Vaste-breedte-codering (ALTIJD 9 bytes, nul-gevuld bij None) voor de
// CHALLENGE-PAYLOAD - exacte tegenhanger van encode_optional_i64() in
// instructions.rs. Dit is een ANDERE codering dan hierboven, gebruikt voor
// een ander doel (handtekening-binding, niet instructie-data) - zie
// STATUS.md sectie 22.
function encodeChallengeOptionalI64(value: bigint | null): Uint8Array {
  const out = new Uint8Array(9);
  if (value !== null) {
    out[0] = 1;
    new DataView(out.buffer).setBigInt64(1, value, true);
  }
  return out;
}

function encodeInitWalletArgs(
  seedKey: Uint8Array,
  walletSeedHash: Uint8Array,
  backupAuthority: PublicKey,
  recoveryTimelockSeconds: bigint | null,
  clientDataJSON: Uint8Array
): Uint8Array {
  if (seedKey.length !== 33) {
    throw new Error(`seed_key moet 33 bytes zijn, kreeg ${seedKey.length}`);
  }
  if (walletSeedHash.length !== 32) {
    throw new Error(`wallet_seed_hash moet 32 bytes zijn, kreeg ${walletSeedHash.length}`);
  }

  return concatBytes(
    INIT_WALLET_DISCRIMINATOR,
    seedKey,
    walletSeedHash,
    backupAuthority.toBytes(),
    encodeInstructionOptionalI64(recoveryTimelockSeconds),
    encodeBorshVecU8(clientDataJSON)
  );
}

export interface InitWalletPdas {
  walletPda: PublicKey;
  vaultPda: PublicKey;
  walletSeedHash: Uint8Array;
}

export async function deriveInitWalletPdas(seedKey: Uint8Array): Promise<InitWalletPdas> {
  const walletSeedHash = await sha256(seedKey);

  const [walletPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), walletSeedHash],
    SPANKWALLET_PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );

  return { walletPda, vaultPda, walletSeedHash };
}

/**
 * Bouwt de init_wallet-transactie. Vereist sinds STATUS.md sectie 22 een
 * ECHTE passkey-handtekening als bewijs van bezit (voorkomt het
 * front-running-risico uit Bevinding C: zonder dit zou een aanvaller een
 * onderschepte publieke sleutel kunnen claimen met een EIGEN
 * backup_authority voordat de rechtmatige eigenaar dat zelf doet).
 */
export async function buildInitWalletTransaction(
  connection: Connection,
  payer: PublicKey,
  seedKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string,
  backupAuthority: PublicKey,
  recoveryTimelockSeconds: bigint | null = null
): Promise<{ transaction: Transaction; pdas: InitWalletPdas }> {
  const pdas = await deriveInitWalletPdas(seedKey);

  const payload = concatBytes(
    backupAuthority.toBytes(),
    encodeChallengeOptionalI64(recoveryTimelockSeconds)
  );
  const expectedChallenge = buildExpectedChallenge(pdas.walletPda, "init_wallet", payload);

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(seedKey, signedMessage, rawSignature);

  const data = encodeInitWalletArgs(
    seedKey,
    pdas.walletSeedHash,
    backupAuthority,
    recoveryTimelockSeconds,
    clientDataJSON
  );

  const instruction = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: pdas.walletPda, isSigner: false, isWritable: true },
      { pubkey: pdas.vaultPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, instruction);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, pdas };
}
