import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4mE8U2TFRpDDPR3681KdPCwgQMVr2xhaMebvBp9gKW58");
const RPC_URL = "http://127.0.0.1:8899";

const INIT_WALLET_DISCRIMINATOR = Buffer.from([
  0x8d, 0x84, 0xe9, 0x82, 0xa8, 0xb7, 0x0a, 0x77,
]);

function loadCliKeypair() {
  const keypairPath = path.join(homedir(), ".config", "solana", "id.json");
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf-8")));
  return Keypair.fromSecretKey(secretKey);
}

function encodeInitWalletArgs(seedKey, walletSeedHash, backupAuthority) {
  return Buffer.concat([
    INIT_WALLET_DISCRIMINATOR,
    Buffer.from(seedKey),
    Buffer.from(walletSeedHash),
    backupAuthority.toBuffer(),
    Buffer.from([0x00]),
  ]);
}

async function main() {
  const seedKeyHex = process.argv[2];
  if (!seedKeyHex || seedKeyHex.length !== 66) {
    console.error(
      "Gebruik: node scripts/cli-init-wallet-check.mjs <66-hex-char (33-byte) seed_key>"
    );
    process.exit(1);
  }
  const seedKey = Buffer.from(seedKeyHex, "hex");
  if (seedKey.length !== 33) {
    console.error(`seed_key moet 33 bytes zijn, kreeg ${seedKey.length}`);
    process.exit(1);
  }

  const walletSeedHash = createHash("sha256").update(seedKey).digest();

  const [walletPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), walletSeedHash],
    PROGRAM_ID
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), walletPda.toBuffer()],
    PROGRAM_ID
  );

  console.log("wallet PDA:", walletPda.toBase58());
  console.log("vault PDA: ", vaultPda.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadCliKeypair();
  console.log("payer (CLI-keypair):", payer.publicKey.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log("payer saldo:", balance / 1e9, "SOL");
  if (balance === 0) {
    console.error("FOUT: payer heeft geen SOL. Draai eerst: solana airdrop 10");
    process.exit(1);
  }

  const backupAuthority = Keypair.generate();
  console.log(
    "backup_authority (willekeurig, alleen voor deze test):",
    backupAuthority.publicKey.toBase58()
  );

  const data = encodeInitWalletArgs(seedKey, walletSeedHash, backupAuthority.publicKey);

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const transaction = new Transaction().add(instruction);

  console.log("Transactie versturen...");
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log("Bevestigd. Signature:", signature);

  const accountInfo = await connection.getAccountInfo(walletPda);
  if (!accountInfo) {
    console.error("FOUT: wallet-PDA bestaat niet na bevestigde transactie.");
    process.exit(1);
  }
  console.log("");
  console.log("SUCCES - WalletAccount aangemaakt on-chain met echte passkey-sleutel.");
  console.log("Account-eigenaar:", accountInfo.owner.toBase58());
  console.log("Account-grootte:", accountInfo.data.length, "bytes");
}

main().catch((err) => {
  console.error("FOUT:", err);
  process.exit(1);
});
