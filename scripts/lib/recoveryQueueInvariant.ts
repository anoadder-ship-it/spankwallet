import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

/**
 * STATUS.md sectie 161: pure beslislogica achter
 * scripts/checkRecoveryQueueInvariant.ts, los van RPC zodat hij met
 * synthetische bytes te testen is (tests/recoveryQueueInvariant.ts).
 *
 * De invariant van sectie 160 ("zolang recovery_state Some is, is de
 * wachtrij leeg"; en daarmee: geen wachtende actie met een verouderde epoch)
 * vestigt initiate_recovery zelf, maar alleen voor recoveries die NA de
 * upgrade starten. Toestand van vóór de upgrade moet apart gecontroleerd
 * worden: een treffer hier is een PendingAction die
 * - hoort bij een wallet met recovery_state Some (recovery_in_progress: het
 *   M-1-scenario van review §159 blijft dan open voor die wallet), of
 * - een epoch heeft die afwijkt van wallet.session_epoch (stale_epoch:
 *   PendingActionStaleEpoch is dan via de publieke instructies bereikbaar).
 *
 * Fail-closed: wat niet te verifiëren is (wallet ontbreekt, bytes te kort,
 * ongeldige Option-tag, niet het canonieke PDA), telt als treffer
 * (unverifiable). Het script mag nooit groen zijn op basis van iets dat het
 * niet heeft kunnen lezen.
 *
 * Offsets (state.rs), stabiel voor elke WalletAccount sinds de migratie van
 * sectie 141/144 en ongewijzigd door sectie 159 (recovery_nonce_snapshot staat
 * achteraan): recovery_state-tag op 148; bij Some volgen 41 bytes payload;
 * dan recovery_timelock_seconds (8), deposit_authority (tag + evt. 32),
 * action_nonce (8), session_epoch (8). PendingAction.epoch staat op 50, in
 * zowel de oude 124-byte- als de huidige 164-byte-layout.
 */

export type ViolationReason = "recovery_in_progress" | "stale_epoch" | "unverifiable";

export interface InvariantViolation {
  pendingAction: string;
  wallet: string | null;
  reasons: ViolationReason[];
  detail: string;
}

export interface ProgramAccountBytes {
  address: string;
  data: Buffer;
  owner: PublicKey;
}

function disc(name: string): Buffer {
  return createHash("sha256").update("account:" + name).digest().subarray(0, 8);
}

export const WALLET_ACCOUNT_DISCRIMINATOR = disc("WalletAccount");
export const PENDING_ACTION_DISCRIMINATOR = disc("PendingAction");

const WALLET_RECOVERY_TAG_OFFSET = 148;
const RECOVERY_STATE_PAYLOAD_LEN = 41;
const PENDING_WALLET_OFFSET = 8;
const PENDING_EPOCH_OFFSET = 50;

export interface DecodedWallet {
  recoverySome: boolean;
  sessionEpoch: bigint;
}

/** Leest recovery_state en session_epoch; `string` = reden waarom het niet lukte. */
export function decodeWalletForInvariant(data: Buffer): DecodedWallet | string {
  if (data.length < 8 || !data.subarray(0, 8).equals(WALLET_ACCOUNT_DISCRIMINATOR)) {
    return "geen WalletAccount-discriminator";
  }
  let o = WALLET_RECOVERY_TAG_OFFSET;
  if (data.length <= o) return `te kort (${data.length} bytes) voor recovery_state`;
  const recoveryTag = data[o];
  o += 1;
  if (recoveryTag === 1) o += RECOVERY_STATE_PAYLOAD_LEN;
  else if (recoveryTag !== 0) return `ongeldige recovery_state-tag ${recoveryTag}`;
  o += 8; // recovery_timelock_seconds
  if (data.length <= o) return `te kort (${data.length} bytes) voor deposit_authority`;
  const depositTag = data[o];
  o += 1;
  if (depositTag === 1) o += 32;
  else if (depositTag !== 0) return `ongeldige deposit_authority-tag ${depositTag}`;
  o += 8; // action_nonce
  if (data.length < o + 8) return `te kort (${data.length} bytes) voor session_epoch`;
  return { recoverySome: recoveryTag === 1, sessionEpoch: data.readBigUInt64LE(o) };
}

export interface DecodedPending {
  wallet: PublicKey;
  epoch: bigint;
}

export function decodePendingForInvariant(data: Buffer): DecodedPending | string {
  if (data.length < 8 || !data.subarray(0, 8).equals(PENDING_ACTION_DISCRIMINATOR)) {
    return "geen PendingAction-discriminator";
  }
  if (data.length < PENDING_EPOCH_OFFSET + 8) return `te kort (${data.length} bytes) voor epoch`;
  return {
    wallet: new PublicKey(data.subarray(PENDING_WALLET_OFFSET, PENDING_WALLET_OFFSET + 32)),
    epoch: data.readBigUInt64LE(PENDING_EPOCH_OFFSET),
  };
}

/**
 * `walletsByAddress` moet voor elke wallet waarnaar een PendingAction
 * verwijst een entry hebben (null = bestaat niet).
 */
export function findInvariantViolations(
  programId: PublicKey,
  pendingActions: ProgramAccountBytes[],
  walletsByAddress: Map<string, ProgramAccountBytes | null>
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const p of pendingActions) {
    const pending = decodePendingForInvariant(p.data);
    if (typeof pending === "string") {
      violations.push({ pendingAction: p.address, wallet: null, reasons: ["unverifiable"], detail: `PendingAction: ${pending}` });
      continue;
    }
    const walletAddress = pending.wallet.toBase58();
    const [canonical] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_action"), pending.wallet.toBuffer()],
      programId
    );
    if (canonical.toBase58() !== p.address) {
      violations.push({
        pendingAction: p.address,
        wallet: walletAddress,
        reasons: ["unverifiable"],
        detail: `niet het canonieke pending_action-PDA van de wallet (verwacht ${canonical.toBase58()})`,
      });
      continue;
    }
    const walletAccount = walletsByAddress.get(walletAddress);
    if (!walletAccount) {
      violations.push({ pendingAction: p.address, wallet: walletAddress, reasons: ["unverifiable"], detail: "wallet bestaat niet" });
      continue;
    }
    if (!walletAccount.owner.equals(programId)) {
      violations.push({ pendingAction: p.address, wallet: walletAddress, reasons: ["unverifiable"], detail: "wallet is niet van dit programma" });
      continue;
    }
    const wallet = decodeWalletForInvariant(walletAccount.data);
    if (typeof wallet === "string") {
      violations.push({ pendingAction: p.address, wallet: walletAddress, reasons: ["unverifiable"], detail: `WalletAccount: ${wallet}` });
      continue;
    }
    const reasons: ViolationReason[] = [];
    if (wallet.recoverySome) reasons.push("recovery_in_progress");
    if (pending.epoch !== wallet.sessionEpoch) reasons.push("stale_epoch");
    if (reasons.length > 0) {
      violations.push({
        pendingAction: p.address,
        wallet: walletAddress,
        reasons,
        detail: `recovery_state ${wallet.recoverySome ? "Some" : "None"}, pending.epoch ${pending.epoch}, wallet.session_epoch ${wallet.sessionEpoch}`,
      });
    }
  }
  return violations;
}
