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
 *
 * Sectie 162 (review §161, L-4): alleen accountlengtes waarvoor deze offsets
 * bewezen gelden, worden beoordeeld; elke andere lengte is unverifiable. Zo
 * leest het script bij een toekomstige layoutwijziging niet stil verkeerd,
 * maar wordt het rood tot deze lijst (en de offsets) bewust zijn bijgewerkt.
 * - WalletAccount 256: alle bestaande devnet-wallets (allocatie van vóór
 *   sectie 159). 264: WalletAccount::LEN sinds sectie 159, dus elke wallet
 *   die init_wallet na de upgrade aanmaakt.
 * - PendingAction 124: de oude layout (vóór sectie 153). 164:
 *   PendingAction::LEN.
 *
 * Sectie 162 (L-3): evaluateProgramScan beoordeelt het ongefilterde
 * getProgramAccounts-antwoord en eist dat het volledig oogt, zodat een leeg
 * of haperend RPC-antwoord nooit als groen telt.
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

export const KNOWN_WALLET_ACCOUNT_LENGTHS = [256, 264];
export const KNOWN_PENDING_ACTION_LENGTHS = [124, 164];

export interface DecodedWallet {
  recoverySome: boolean;
  sessionEpoch: bigint;
}

/** Leest recovery_state en session_epoch; `string` = reden waarom het niet lukte. */
export function decodeWalletForInvariant(data: Buffer): DecodedWallet | string {
  if (data.length < 8 || !data.subarray(0, 8).equals(WALLET_ACCOUNT_DISCRIMINATOR)) {
    return "geen WalletAccount-discriminator";
  }
  if (!KNOWN_WALLET_ACCOUNT_LENGTHS.includes(data.length)) {
    return `onbekende lengte ${data.length} bytes (bekend: ${KNOWN_WALLET_ACCOUNT_LENGTHS.join(", ")})`;
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
  if (!KNOWN_PENDING_ACTION_LENGTHS.includes(data.length)) {
    return `onbekende lengte ${data.length} bytes (bekend: ${KNOWN_PENDING_ACTION_LENGTHS.join(", ")})`;
  }
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

export const VAULT_ACCOUNT_DISCRIMINATOR = disc("VaultAccount");

export interface ProgramScanResult {
  violations: InvariantViolation[];
  censusProblems: string[];
  walletCount: number;
  vaultCount: number;
  pendingCount: number;
  inRecovery: string[];
}

function hasDiscriminator(data: Buffer, discriminator: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(discriminator);
}

/**
 * Sectie 162 (L-3): de volledige beslissing achter het script.
 * `allAccounts` is het ONGEFILTERDE getProgramAccounts-antwoord (één
 * momentopname: wallets en PendingActions komen uit dezelfde RPC-ronde);
 * `filteredPendingAddresses` komt uit een aparte, op de discriminator
 * gefilterde aanroep en dient alleen als tegencontrole op het filterpad.
 *
 * Tellingsproblemen (censusProblems) maken de scan onbetrouwbaar, los van
 * eventuele treffers:
 * - minder dan `minWalletAccounts` WalletAccounts. WalletAccounts zijn niet
 *   te sluiten (er bestaat geen instructie voor), dus het aantal kan alleen
 *   groeien; minder dan eerder gemeten betekent een onvolledig antwoord;
 * - een ander aantal VaultAccounts dan WalletAccounts (init_wallet maakt ze
 *   altijd samen aan, geen van beide is te sluiten);
 * - een account in het antwoord dat niet van het programma is;
 * - een WalletAccount die niet te decoderen is (o.a. een onbekende lengte);
 * - verschil tussen de gefilterde en de ongefilterde PendingAction-lijst.
 */
export function evaluateProgramScan(
  programId: PublicKey,
  allAccounts: ProgramAccountBytes[],
  filteredPendingAddresses: string[],
  minWalletAccounts: number
): ProgramScanResult {
  const censusProblems: string[] = [];
  const wallets = allAccounts.filter((a) => hasDiscriminator(a.data, WALLET_ACCOUNT_DISCRIMINATOR));
  const vaults = allAccounts.filter((a) => hasDiscriminator(a.data, VAULT_ACCOUNT_DISCRIMINATOR));
  const pending = allAccounts.filter((a) => hasDiscriminator(a.data, PENDING_ACTION_DISCRIMINATOR));

  if (wallets.length < minWalletAccounts) {
    censusProblems.push(
      `${wallets.length} WalletAccounts, minder dan het bekende minimum ${minWalletAccounts} (leeg of onvolledig RPC-antwoord?)`
    );
  }
  if (vaults.length !== wallets.length) {
    censusProblems.push(`${vaults.length} VaultAccounts tegenover ${wallets.length} WalletAccounts`);
  }
  for (const a of allAccounts) {
    if (!a.owner.equals(programId)) censusProblems.push(`account ${a.address} is niet van dit programma`);
  }

  const inRecovery: string[] = [];
  for (const w of wallets) {
    const decoded = decodeWalletForInvariant(w.data);
    if (typeof decoded === "string") censusProblems.push(`WalletAccount ${w.address}: ${decoded}`);
    else if (decoded.recoverySome) inRecovery.push(w.address);
  }

  const unfiltered = new Set(pending.map((p) => p.address));
  const filtered = new Set(filteredPendingAddresses);
  for (const address of unfiltered) {
    if (!filtered.has(address)) censusProblems.push(`PendingAction ${address} ontbreekt in de gefilterde lijst`);
  }
  for (const address of filtered) {
    if (!unfiltered.has(address)) censusProblems.push(`PendingAction ${address} ontbreekt in de ongefilterde lijst`);
  }

  const byAddress = new Map<string, ProgramAccountBytes | null>(allAccounts.map((a) => [a.address, a]));
  return {
    violations: findInvariantViolations(programId, pending, byAddress),
    censusProblems,
    walletCount: wallets.length,
    vaultCount: vaults.length,
    pendingCount: pending.length,
    inRecovery,
  };
}
