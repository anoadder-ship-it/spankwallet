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
import {
  concatBytes,
  encodeBorshVecU8,
  buildExpectedChallenge,
  actionNonceLeBytes,
  readActionNonce,
} from "./challenge";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

const ADD_PASSKEY_DISCRIMINATOR = Uint8Array.from([
  173, 230, 84, 153, 54, 144, 214, 37,
]);
const REMOVE_PASSKEY_DISCRIMINATOR = Uint8Array.from([
  121, 198, 177, 145, 248, 134, 170, 239,
]);

/**
 * Multi-passkey-model (STATUS.md): elke instructie die een passkey-
 * handtekening verifieert (execute, transfer_token, add/remove_allowed_
 * program, execute_advanced, hunt, cancel_recovery) heeft dit PasskeysAccount
 * nodig als extra account - de PDA hoeft niet te bestaan (een wallet die
 * nooit add_passkey heeft aangeroepen gedraagt zich exact als voorheen,
 * alleen owner_passkey geldig). Daarom deze ene gedeelde derive-functie,
 * gebruikt door alle client-bestanden die zo'n instructie opbouwen.
 */
export function derivePasskeysPda(walletPda: PublicKey): PublicKey {
  const [passkeysPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("passkeys"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return passkeysPda;
}

// PasskeysAccount-layout (state.rs): discriminator(8) + wallet(32) + bump(1)
// + owner_passkey_revoked(1) + count(1) + additional_passkeys([[u8;33];8]).
const OFFSET_OWNER_REVOKED = 8 + 32 + 1;
const OFFSET_COUNT = OFFSET_OWNER_REVOKED + 1;
const OFFSET_ADDITIONAL_PASSKEYS = OFFSET_COUNT + 1;
const PASSKEY_LEN = 33;

export interface ParsedPasskeysAccount {
  ownerPasskeyRevoked: boolean;
  count: number;
  additionalPasskeys: Uint8Array[];
}

export async function readPasskeysAccount(
  connection: Connection,
  passkeysPda: PublicKey
): Promise<ParsedPasskeysAccount | null> {
  const accountInfo = await connection.getAccountInfo(passkeysPda);
  if (!accountInfo) {
    return null;
  }
  const data = accountInfo.data;
  const ownerPasskeyRevoked = data[OFFSET_OWNER_REVOKED] !== 0;
  const count = data[OFFSET_COUNT];
  const additionalPasskeys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = OFFSET_ADDITIONAL_PASSKEYS + i * PASSKEY_LEN;
    additionalPasskeys.push(new Uint8Array(data.subarray(start, start + PASSKEY_LEN)));
  }
  return { ownerPasskeyRevoked, count, additionalPasskeys };
}

export interface AddPasskeyResult {
  transaction: Transaction;
  passkeysPda: PublicKey;
}

/**
 * Bouwt de add_passkey-transactie. Vereist een ECHTE passkey-handtekening
 * van EEN VAN de al geldige sleutels (owner_passkey, of een al eerder
 * toegevoegde extra sleutel) - challenge bindt uitsluitend de nieuwe
 * passkey-bytes als payload, zelfde patroon als add_allowed_program.
 * PasskeysAccount wordt lui aangemaakt (init_if_needed on-chain) bij de
 * eerste aanroep voor deze wallet.
 */
export async function buildAddPasskeyTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  newPasskey: Uint8Array,
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<AddPasskeyResult> {
  if (newPasskey.length !== PASSKEY_LEN) {
    throw new Error("newPasskey moet 33 bytes zijn, kreeg " + newPasskey.length);
  }
  const passkeysPda = derivePasskeysPda(walletPda);

  const nonce = await readActionNonce(connection, walletPda);
  const payload = concatBytes(actionNonceLeBytes(nonce), newPasskey);
  const expectedChallenge = buildExpectedChallenge(walletPda, "add_passkey", payload);

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
    ADD_PASSKEY_DISCRIMINATOR,
    newPasskey,
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const addIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      // mut (C-1-fix, STATUS.md sectie 69): AddPasskey#wallet schrijft
      // action_nonce nu atomisch bij - was hier ten onrechte false.
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: passkeysPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, addIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, passkeysPda };
}

export interface RemovePasskeyResult {
  transaction: Transaction;
}

/**
 * Bouwt de remove_passkey-transactie. Kan zowel een extra sleutel
 * verwijderen als owner_passkey zelf intrekken (afhankelijk van welke bytes
 * als targetPasskey worden meegegeven) - on-chain lockout-bescherming
 * verbiedt het verwijderen van de allerlaatste geldige sleutel. Geen
 * init_if_needed hier: een geldige aanroep impliceert altijd dat
 * PasskeysAccount al bestaat (zie STATUS.md).
 */
export async function buildRemovePasskeyTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  targetPasskey: Uint8Array,
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<RemovePasskeyResult> {
  if (targetPasskey.length !== PASSKEY_LEN) {
    throw new Error("targetPasskey moet 33 bytes zijn, kreeg " + targetPasskey.length);
  }
  const passkeysPda = derivePasskeysPda(walletPda);

  const nonce = await readActionNonce(connection, walletPda);
  const payload = concatBytes(actionNonceLeBytes(nonce), targetPasskey);
  const expectedChallenge = buildExpectedChallenge(walletPda, "remove_passkey", payload);

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
    REMOVE_PASSKEY_DISCRIMINATOR,
    targetPasskey,
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const removeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      // mut (C-1-fix, STATUS.md sectie 69): RemovePasskey#wallet schrijft
      // action_nonce nu atomisch bij - was hier ten onrechte false.
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: passkeysPda, isSigner: false, isWritable: true },
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
