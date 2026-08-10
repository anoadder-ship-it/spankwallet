import {
  AccountMeta,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { concatBytes, encodeBorshVecU8, buildExpectedChallenge } from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
import { derivePasskeysPda } from "./passkeys";

const EXECUTE_ADVANCED_DISCRIMINATOR = Uint8Array.from([
  94, 218, 17, 226, 51, 145, 100, 203,
]);

export interface RemainingAccountSpec {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

export interface ExecuteAdvancedResult {
  transaction: Transaction;
}

/**
 * Bouwt de execute_advanced-transactie: een ECHTE CPI naar `cpiProgramId`,
 * uitsluitend toegestaan als dat programma-ID op de allowlist van deze
 * wallet staat (policy.ts). De challenge bindt het VOLLEDIGE CPI-target -
 * programma-ID + elke account (sleutel + schrijf-/signer-vlag) + de
 * instructiedata - exact zoals instructions.rs::execute_advanced verwacht.
 *
 * Elke account in `remainingAccounts` wiens sleutel gelijk is aan de vault
 * wordt hier, net als on-chain, als GEFORCEERD signer meegeteld in de
 * challenge-berekening - anders komt de hier berekende challenge niet
 * overeen met wat het programma zelf waarneemt (zie STATUS.md sectie 34,
 * de isWritable-testbug-les uit de lokale Rust-tests: Solana's
 * transactie-compilatie merget schrijf-/signer-vlaggen van eenzelfde
 * sleutel over alle voorkomens binnen een instructie).
 */
export async function buildExecuteAdvancedTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  policyPda: PublicKey,
  cpiProgramId: PublicKey,
  remainingAccounts: RemainingAccountSpec[],
  cpiInstructionData: Uint8Array,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<ExecuteAdvancedResult> {
  const payloadParts: Uint8Array[] = [cpiProgramId.toBytes()];
  const countBytes = new Uint8Array(2);
  new DataView(countBytes.buffer).setUint16(0, remainingAccounts.length, true);
  payloadParts.push(countBytes);

  for (const acc of remainingAccounts) {
    const isSigner = acc.pubkey.equals(vaultPda) || acc.isSigner;
    payloadParts.push(acc.pubkey.toBytes());
    payloadParts.push(Uint8Array.from([acc.isWritable ? 1 : 0]));
    payloadParts.push(Uint8Array.from([isSigner ? 1 : 0]));
  }

  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, cpiInstructionData.length, true);
  payloadParts.push(lenBytes);
  payloadParts.push(cpiInstructionData);

  const payload = concatBytes(...payloadParts);
  const expectedChallenge = buildExpectedChallenge(walletPda, "execute_advanced", payload);

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
    EXECUTE_ADVANCED_DISCRIMINATOR,
    encodeBorshVecU8(cpiInstructionData),
    encodeBorshVecU8(clientDataJSON)
  );

  const keys: AccountMeta[] = [
    { pubkey: walletPda, isSigner: false, isWritable: false },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: policyPda, isSigner: false, isWritable: false },
    { pubkey: cpiProgramId, isSigner: false, isWritable: false },
    { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...remainingAccounts.map((a) => ({
      pubkey: a.pubkey,
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
  ];

  const executeAdvancedIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, executeAdvancedIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}
