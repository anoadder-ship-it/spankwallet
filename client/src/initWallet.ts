import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const SPANKWALLET_PROGRAM_ID = new PublicKey(
  "4mE8U2TFRpDDPR3681KdPCwgQMVr2xhaMebvBp9gKW58"
);

const INIT_WALLET_DISCRIMINATOR = Uint8Array.from([
  0x8d, 0x84, 0xe9, 0x82, 0xa8, 0xb7, 0x0a, 0x77,
]);

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

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

function encodeInitWalletArgs(
  seedKey: Uint8Array,
  walletSeedHash: Uint8Array,
  backupAuthority: PublicKey,
  recoveryTimelockSeconds: bigint | null
): Uint8Array {
  if (seedKey.length !== 33) {
    throw new Error(`seed_key moet 33 bytes zijn, kreeg ${seedKey.length}`);
  }
  if (walletSeedHash.length !== 32) {
    throw new Error(`wallet_seed_hash moet 32 bytes zijn, kreeg ${walletSeedHash.length}`);
  }

  const timelockBytes =
    recoveryTimelockSeconds === null
      ? Uint8Array.from([0x00])
      : (() => {
          const buf = new Uint8Array(9);
          buf[0] = 0x01;
          const view = new DataView(buf.buffer);
          view.setBigInt64(1, recoveryTimelockSeconds, true);
          return buf;
        })();

  return concatBytes(
    INIT_WALLET_DISCRIMINATOR,
    seedKey,
    walletSeedHash,
    backupAuthority.toBytes(),
    timelockBytes
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

export async function buildInitWalletTransaction(
  connection: Connection,
  payer: PublicKey,
  seedKey: Uint8Array,
  backupAuthority: PublicKey,
  recoveryTimelockSeconds: bigint | null = null
): Promise<{ transaction: Transaction; pdas: InitWalletPdas }> {
  const pdas = await deriveInitWalletPdas(seedKey);

  const data = encodeInitWalletArgs(
    seedKey,
    pdas.walletSeedHash,
    backupAuthority,
    recoveryTimelockSeconds
  );

  const instruction = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: pdas.walletPda, isSigner: false, isWritable: true },
      { pubkey: pdas.vaultPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(instruction);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, pdas };
}
