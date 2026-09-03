import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
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

// STATUS.md sectie 135 (vervolg op 99/115/134): client-ingang voor het
// vierde en laatste initiate_*/finalize_*-paar - PendingAction kind=3
// (ThresholdChange). Zelfde bouwpatroon als policy.ts/passkeys.ts: geen
// Anchor-IDL-client in de browser, handmatig geëncodeerde instructies met
// een vaste 8-byte discriminator (geverifieerd tegen target/idl/
// spankwallet.json, niet zelf "waarschijnlijk goed" gegokt).
const INITIATE_THRESHOLD_CHANGE_DISCRIMINATOR = Uint8Array.from([
  185, 103, 207, 199, 122, 69, 182, 84,
]);
const FINALIZE_THRESHOLD_CHANGE_DISCRIMINATOR = Uint8Array.from([
  153, 176, 206, 143, 164, 146, 70, 149,
]);
const CANCEL_ACTION_DISCRIMINATOR = Uint8Array.from([
  228, 144, 170, 146, 66, 88, 133, 128,
]);

/** instructions.rs::PENDING_ACTION_KIND_THRESHOLD_CHANGE - geen manier om
 * dit van de keten te lezen (het is een Rust-compile-time-constante, geen
 * accountveld), dus deze waarde moet met de hand in sync blijven met
 * instructions.rs. Verandert alleen als er ooit een VIJFDE kind bijkomt
 * en de bestaande vier hernummerd worden, wat nu niets aan de orde is. */
export const PENDING_ACTION_KIND_THRESHOLD_CHANGE = 3;

/** instructions.rs::PENDING_ACTION_TIMELOCK_SECONDS, de ECHTE (niet de
 * test-fast-pending-timelock-Cargo-feature-versie). Kan niet van de keten
 * gelezen worden (zelfde reden als hierboven) - dit is een bewuste,
 * gedocumenteerde parallelle constante, geen aanname. Als deze ooit in de
 * Rust-bron verandert zonder dat deze regel meeverandert, telt de client
 * een verkeerde beschikbaarheidstijd - er is geen automatische bewaking
 * hiertegen (zie STATUS.md sectie 135's "wat is niet getest"-paragraaf). */
export const PENDING_ACTION_TIMELOCK_SECONDS = 24 * 60 * 60;

export function derivePendingActionPda(walletPda: PublicKey): PublicKey {
  const [pendingActionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_action"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return pendingActionPda;
}

// PendingAction-layout (state.rs): discriminator(8) + wallet(32) + bump(1)
// + kind(1) + initiated_at(8) + epoch(8) + action_commitment(32) +
// initiator_passkey(33) + confirmed(1) = 124 (PendingAction::LEN).
const OFFSET_KIND = 8 + 32 + 1;
const OFFSET_INITIATED_AT = OFFSET_KIND + 1;
const OFFSET_EPOCH = OFFSET_INITIATED_AT + 8;
const OFFSET_ACTION_COMMITMENT = OFFSET_EPOCH + 8;
const OFFSET_INITIATOR_PASSKEY = OFFSET_ACTION_COMMITMENT + 32;
const OFFSET_CONFIRMED = OFFSET_INITIATOR_PASSKEY + 33;

export interface ParsedPendingAction {
  kind: number;
  initiatedAt: bigint;
  epoch: bigint;
  actionCommitment: Uint8Array;
  initiatorPasskey: Uint8Array;
  confirmed: boolean;
}

/**
 * `null` betekent hier "geen openstaande actie" (singleton-PDA bestaat
 * niet) - het normale geval, geen fout. Dit is precies het account dat
 * ontwerpvraag 2 (STATUS.md sectie 135) rechtstreeks van de keten leest,
 * ongeacht of deze sessie het net zelf aanmaakte of dat het van een
 * eerder bezoek stamt.
 */
export async function readPendingAction(
  connection: Connection,
  pendingActionPda: PublicKey
): Promise<ParsedPendingAction | null> {
  const accountInfo = await connection.getAccountInfo(pendingActionPda, "confirmed");
  if (!accountInfo) {
    return null;
  }
  const data = accountInfo.data;
  return {
    kind: data[OFFSET_KIND],
    initiatedAt: data.readBigInt64LE(OFFSET_INITIATED_AT),
    epoch: data.readBigUInt64LE(OFFSET_EPOCH),
    actionCommitment: new Uint8Array(
      data.subarray(OFFSET_ACTION_COMMITMENT, OFFSET_ACTION_COMMITMENT + 32)
    ),
    initiatorPasskey: new Uint8Array(
      data.subarray(OFFSET_INITIATOR_PASSKEY, OFFSET_INITIATOR_PASSKEY + 33)
    ),
    confirmed: data[OFFSET_CONFIRMED] !== 0,
  };
}

function u64LeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/**
 * Exacte TS-tegenhanger van compute_threshold_change_commitment() in
 * instructions.rs. BELANGRIJK, en de reden dat dit hier apart bestaat:
 * PendingAction slaat de drempel/venstercap-waarden zelf NIET in platte
 * tekst op - alleen deze hash (action_commitment). Bij finalize (ook bij
 * een pagina-herlaad, zonder JS-geheugen van wat bij initiate is
 * ingevoerd) moet de eigenaar de twee waarden dus OPNIEUW invoeren; deze
 * functie laat de client dat LOKAAL tegen de echte on-chain commitment
 * verifiëren voordat er een passkey-ceremonie of transactie gestart wordt
 * (STATUS.md sectie 135) - een mismatch geeft zo een directe, duidelijke
 * kaartfout in plaats van een pas on-chain ontdekte
 * PendingActionCommitmentMismatch ná een al doorlopen passkey-prompt.
 */
export function computeThresholdChangeCommitment(
  wallet: PublicKey,
  newSpendThresholdLamports: bigint,
  newWindowTotalCapLamports: bigint
): Uint8Array {
  const combined = concatBytes(
    wallet.toBytes(),
    new TextEncoder().encode("pending_threshold_change"),
    u64LeBytes(newSpendThresholdLamports),
    u64LeBytes(newWindowTotalCapLamports)
  );
  return keccak_256(combined);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface InitiateThresholdChangeResult {
  transaction: Transaction;
  pendingActionPda: PublicKey;
}

/**
 * Bouwt de initiate_threshold_change-transactie. Legt uitsluitend de twee
 * nieuwe waarden vast (geen spend_window-account nodig - zie
 * instructions.rs's eigen commentaar bij FinalizeThresholdChange).
 */
export async function buildInitiateThresholdChangeTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  newSpendThresholdLamports: bigint,
  newWindowTotalCapLamports: bigint,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<InitiateThresholdChangeResult> {
  const pendingActionPda = derivePendingActionPda(walletPda);

  const nonce = await readActionNonce(connection, walletPda);
  const payload = concatBytes(
    actionNonceLeBytes(nonce),
    u64LeBytes(newSpendThresholdLamports),
    u64LeBytes(newWindowTotalCapLamports)
  );
  const expectedChallenge = buildExpectedChallenge(walletPda, "initiate_threshold_change", payload);

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(passkeyCompressedPublicKey, signedMessage, rawSignature);

  const data = concatBytes(
    INITIATE_THRESHOLD_CHANGE_DISCRIMINATOR,
    u64LeBytes(newSpendThresholdLamports),
    u64LeBytes(newWindowTotalCapLamports),
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const initiateIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: pendingActionPda, isSigner: false, isWritable: true },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, initiateIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, pendingActionPda };
}

export interface FinalizeThresholdChangeResult {
  transaction: Transaction;
  spendWindowPda: PublicKey;
}

/**
 * Bouwt de finalize_threshold_change-transactie. Leest action_commitment
 * VERS van de keten (niet uit een eerder bewaarde waarde) om de challenge
 * op te bouwen - zelfde discipline als tests/pendingAction.ts's
 * callFinalizeThresholdChange. `signingPasskeyCompressedPublicKey`/
 * `credentialId` zijn hier bewust een expliciete parameter i.p.v.
 * "altijd PASSKEY 1": de aanroeper (main.ts) beslist, op basis van
 * pending.confirmed, welke passkey moet tekenen (STATUS.md sectie 135,
 * single-passkey-degradatie vs. 2-of-2).
 */
export async function buildFinalizeThresholdChangeTransaction(
  connection: Connection,
  closer: PublicKey,
  walletPda: PublicKey,
  pendingActionPda: PublicKey,
  newSpendThresholdLamports: bigint,
  newWindowTotalCapLamports: bigint,
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<FinalizeThresholdChangeResult> {
  const spendWindowPda = deriveSpendWindowPda(walletPda);

  const nonce = await readActionNonce(connection, walletPda);
  const pending = await readPendingAction(connection, pendingActionPda);
  if (!pending) {
    throw new Error("Geen openstaande PendingAction gevonden voor " + walletPda.toBase58());
  }
  const payload = concatBytes(
    actionNonceLeBytes(nonce),
    pendingActionPda.toBytes(),
    pending.actionCommitment
  );
  const expectedChallenge = buildExpectedChallenge(walletPda, "finalize_threshold_change", payload);

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
    FINALIZE_THRESHOLD_CHANGE_DISCRIMINATOR,
    u64LeBytes(newSpendThresholdLamports),
    u64LeBytes(newWindowTotalCapLamports),
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const finalizeIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: spendWindowPda, isSigner: false, isWritable: true },
      { pubkey: pendingActionPda, isSigner: false, isWritable: true },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: closer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, finalizeIx);
  transaction.feePayer = closer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, spendWindowPda };
}

export interface CancelActionResult {
  transaction: Transaction;
}

/**
 * Bouwt de cancel_action-transactie. Kind-agnostisch (zelfde instructie
 * sluit ELKE openstaande PendingAction, ongeacht welke van de vier kinds -
 * zie instructions.rs's eigen commentaar bij CancelAction) - hergebruikt
 * hier zodat een verkeerd ingevoerde drempel/venstercap niet 24u hoeft te
 * blijven hangen (STATUS.md sectie 135, punt 5). Elke huidige geldige
 * passkey mag annuleren, geen 2-of-2-eis.
 */
export async function buildCancelActionTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  pendingActionPda: PublicKey,
  signingPasskeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<CancelActionResult> {
  const nonce = await readActionNonce(connection, walletPda);
  const payload = concatBytes(actionNonceLeBytes(nonce), pendingActionPda.toBytes());
  const expectedChallenge = buildExpectedChallenge(walletPda, "cancel_action", payload);

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
    CANCEL_ACTION_DISCRIMINATOR,
    actionNonceLeBytes(nonce),
    encodeBorshVecU8(clientDataJSON)
  );

  const cancelIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: pendingActionPda, isSigner: false, isWritable: true },
      { pubkey: derivePasskeysPda(walletPda), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, cancelIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}
