import { Connection, PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

// Fase C-opschoning: deze drie helpers stonden eerder gedupliceerd in
// execute.ts, hunt.ts, recovery.ts en initWallet.ts (vier bijna-identieke
// kopieen). Samengevoegd tot dit ene gedeelde bestand - zie STATUS.md.

/**
 * PUNT 2 (STATUS.md sectie 78): regressiebewaking op de vier `new
 * Uint8Array(x)`-kopieerplekken op het Web-Crypto/WebAuthn-tekenpad
 * (initWallet.ts::sha256, webauthnSign.ts::sha256, webauthnSign.ts'
 * `challenge`/`allowCredentials[].id`). Vandaag is elke `x` daar aantoonbaar
 * al een echte Uint8Array (getraceerd tot een `.slice()`/verse-allocatie/
 * hash-output-oorsprong, zie STATUS.md), dus `new Uint8Array(x)` kopieert
 * altijd correct - het gevaar zit uitsluitend in het ANDERE geval (`x` een
 * kale ArrayBuffer, zero-copy over het hele buffer). Deze check maakt dat
 * geen aanname voor de toekomst: als een latere wijziging `x` ooit naar een
 * ArrayBuffer-achtig, byte-verschillend object verandert, faalt dit hard in
 * plaats van stilzwijgend verkeerde bytes te tekenen/hashen.
 */
export function assertByteIdentical(copy: Uint8Array, original: Uint8Array, label: string): void {
  if (copy.length !== original.length) {
    throw new Error(
      `${label}: kopie heeft afwijkende lengte (${copy.length} vs ${original.length}) - PUNT 2-regressie`
    );
  }
  for (let i = 0; i < copy.length; i++) {
    if (copy[i] !== original[i]) {
      throw new Error(`${label}: kopie wijkt af op byte ${i} - PUNT 2-regressie`);
    }
  }
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, bytes.length, true);
  return concatBytes(lenBytes, bytes);
}

/**
 * Exacte TS-tegenhanger van build_expected_challenge() in instructions.rs:
 * Keccak-256 (NIET NIST-SHA3) over program_id || wallet || domain || payload.
 */
export function buildExpectedChallenge(
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

/**
 * C-1-fix (STATUS.md sectie 69): geeft de 8 LE-bytes terug voor het
 * meebinden van action_nonce vooraan in elke challenge-payload - elke
 * challenge-based instructie (behalve init_wallet zelf, dat al structureel
 * replay-proof is) doet dit als allereerste stap van zijn payload.
 */
export function actionNonceLeBytes(nonce: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, nonce, true);
  return bytes;
}

// discriminator(8)+seed_key(33)+wallet_seed_hash(32)+owner_passkey(33)+bump(1)
// +vault_bump(1)+created_at(8)+backup_authority(32) - vaste prefix vóór het
// eerste variabele-lengte veld (recovery_state), zie offsetAfterDepositAuthority.
const OFFSET_RECOVERY_STATE_TAG = 148;
const RECOVERY_STATE_LEN = 41; // initiated_at(8) + new_owner_passkey(33), zonder de 1-byte Option-tag

/**
 * Berekent het offset van WalletAccount.action_nonce - NA twee Option<T>-
 * velden (recovery_state, deposit_authority). Borsh codeert Option::None als
 * exact 1 tagbyte, NIET als de "maximale" ruimte - een vast offset vanaf het
 * begin van het account werkt dus NIET zodra recovery_state/
 * deposit_authority niet allebei Some zijn (het normale geval). Daarom de
 * tag-bytes daadwerkelijk lezen en het echte offset opbouwen, zelfde aanpak
 * als recovery.ts al voor recovery_state deed - empirisch bevestigd nodig
 * tijdens het bouwen van de C-1-fix-tests (STATUS.md sectie 69): een naief
 * vast offset gaf stil een verkeerde (altijd-0) nonce terug.
 *
 * GECORRIGEERD (STATUS.md sectie 129): action_nonce is NIET meer het
 * laatste veld sinds sectie 115/116 - session_epoch, spend_threshold_lamports
 * en disarmed volgen erna. Gedeeld met readSpendThresholdLamports hieronder
 * i.p.v. de tag-walk daar te herhalen.
 */
function offsetAfterDepositAuthority(data: Buffer): number {
  let offset = OFFSET_RECOVERY_STATE_TAG;
  const recoveryStateTag = data[offset];
  offset += 1;
  if (recoveryStateTag === 1) offset += RECOVERY_STATE_LEN;
  offset += 8; // recovery_timelock_seconds: i64, geen Option, altijd aanwezig
  const depositAuthorityTag = data[offset];
  offset += 1;
  if (depositAuthorityTag === 1) offset += 32; // Pubkey
  return offset; // = offset van action_nonce
}

export async function readActionNonce(
  connection: Connection,
  walletPda: PublicKey
): Promise<bigint> {
  const accountInfo = await connection.getAccountInfo(walletPda, "confirmed");
  if (!accountInfo) {
    throw new Error("WalletAccount " + walletPda.toBase58() + " bestaat niet");
  }
  return accountInfo.data.readBigUInt64LE(offsetAfterDepositAuthority(accountInfo.data));
}

/**
 * Leest WalletAccount.spend_threshold_lamports (STATUS.md sectie 127/128/
 * 129, stap A) - action_nonce(8) + session_epoch(8) ná
 * offsetAfterDepositAuthority(), geen Option, dus geen verdere tag-checks
 * nodig. `0n` (de fail-safe default sinds sectie 115) betekent hier
 * expliciet "geen drempel geconfigureerd", zie thresholdBanner.ts.
 */
export async function readSpendThresholdLamports(
  connection: Connection,
  walletPda: PublicKey
): Promise<bigint> {
  const accountInfo = await connection.getAccountInfo(walletPda, "confirmed");
  if (!accountInfo) {
    throw new Error("WalletAccount " + walletPda.toBase58() + " bestaat niet");
  }
  const data = accountInfo.data;
  const offset = offsetAfterDepositAuthority(data) + 8 /* action_nonce */ + 8 /* session_epoch */;
  return data.readBigUInt64LE(offset);
}
