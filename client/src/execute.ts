import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import {
  concatBytes,
  encodeBorshVecU8,
  buildExpectedChallenge,
  actionNonceLeBytes,
  readActionNonce,
} from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
import { derivePasskeysPda } from "./passkeys";
import { deriveSpendWindowPda } from "./spendWindow";

const EXECUTE_DISCRIMINATOR = Uint8Array.from([
  0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d,
]);

export interface ExecuteResult {
  transaction: Transaction;
  signedMessage: Uint8Array;
  expectedChallenge: Uint8Array;
}

/**
 * Bouwt de execute-transactie (transfer_sol): stuurt exact `amountLamports`
 * van de vault naar `recipient`. GEEN generieke CPI-doorgeefluik meer sinds
 * STATUS.md sectie 25 - een gesloten, getypeerde actie, precies wat de
 * handtekening expliciet toestaat, structureel niets anders om te
 * misbruiken (mitigeert de "Arbitrary CPI"-kwetsbaarheidsklasse).
 */
export async function buildExecuteTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  recipient: PublicKey,
  amountLamports: bigint,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<ExecuteResult> {
  const nonce = await readActionNonce(connection, walletPda);
  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, amountLamports, true);
  const payload = concatBytes(actionNonceLeBytes(nonce), recipient.toBytes(), amountBytes);

  const expectedChallenge = buildExpectedChallenge(walletPda, "execute", payload);

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
    amountBytes,
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const executeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      // mut (C-1-fix, STATUS.md sectie 69): Execute#wallet schrijft
      // action_nonce nu atomisch bij - was hier ten onrechte false.
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      // STATUS.md sectie 132/133/134 (stap B/c): SpendWindow, de
      // glijdende-vensterlimiet-teller - gelezen/geschreven zodra de
      // wallet een drempel heeft ingesteld, zelfde volgorde als Execute
      // in instructions.rs.
      { pubkey: deriveSpendWindowPda(walletPda), isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
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
