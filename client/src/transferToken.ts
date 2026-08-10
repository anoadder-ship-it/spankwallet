import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { concatBytes, encodeBorshVecU8, buildExpectedChallenge } from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

const TRANSFER_TOKEN_DISCRIMINATOR = Uint8Array.from([
  0xdb, 0x11, 0x7a, 0x35, 0xed, 0xab, 0xe8, 0xde,
]);

export interface TransferTokenResult {
  transaction: Transaction;
}

/**
 * Bouwt de transfer_token-transactie: stuurt exact `amount` van
 * `vaultTokenAccount` naar `recipientTokenAccount`, voor een gegeven
 * `tokenMint`. Tweede getypeerde actie na transfer_sol (STATUS.md sectie
 * 25) - dekt automatisch elke SPL-token (zBTC, BTCSOL, USDC, etc.) zonder
 * per-munt-configuratie, zie STATUS.md sectie 27.
 */
export async function buildTransferTokenTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  vaultTokenAccount: PublicKey,
  recipientTokenAccount: PublicKey,
  tokenMint: PublicKey,
  amount: bigint,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<TransferTokenResult> {
  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amount, true);
  const payload = concatBytes(
    recipientTokenAccount.toBytes(),
    tokenMint.toBytes(),
    amountBytes
  );

  const expectedChallenge = buildExpectedChallenge(walletPda, "transfer_token", payload);

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

  const transferData = concatBytes(
    TRANSFER_TOKEN_DISCRIMINATOR,
    amountBytes,
    encodeBorshVecU8(clientDataJSON)
  );

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );

  const transferIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(transferData),
  });

  const transaction = new Transaction().add(secp256r1Ix, transferIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}
