import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import type { FakeAccount } from "./fakeDevnetRpc";

/**
 * STATUS.md sectie 167/168: de Squads- en bufferaccounts van een upgrade-
 * voorstel, als bytes, voor tests/unit/preflightScripts.ts (het script
 * tegen een nep-RPC) en tests/unit/adminPageSelection.ts (de adminpagina
 * tegen een nep-connectie). Beide lezen zo precies dezelfde toestand.
 *
 * Basis zijn echte devnet-bytes (fixtures/devnetSquads20260929.json) en de
 * echte RC-binary van sectie 163 (fixtures/rc163-spankwallet.so.gz, sha256
 * 33598b…, dezelfde bytes die on-chain in de buffer komen); elke afwijking is
 * een gerichte patch daarop.
 */

// process.cwd(), niet __dirname: zie tests/verifyBinaryFresh.ts (ES-modulescope).
const FIXTURES = path.join(process.cwd(), "tests", "unit", "fixtures");
export const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, "devnetSquads20260929.json"), "utf8"));
export const RC_BINARY = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, "rc163-spankwallet.so.gz")));

export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SQUADS = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const MULTISIG = new PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
export const VAULT = new PublicKey("89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw");
export const RC_BUFFER = new PublicKey("F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5");
export const OLD_BUFFER = new PublicKey("HRccWBKjfiLrTAZ9JwnukTkesSqUk2F38cRyDTvV7szK"); // buffer van voorstel #13
export const CLOCK = "SysvarC1ock11111111111111111111111111111111";
export const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
export const NOW = 1_790_000_000;
export const TIME_LOCK = 259_200;

export const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export function txPda(index: number, suffix?: string): string {
  const seeds = [Buffer.from("multisig"), MULTISIG.toBuffer(), Buffer.from("transaction"), u64(index)];
  if (suffix) seeds.push(Buffer.from(suffix));
  return PublicKey.findProgramAddressSync(seeds, SQUADS)[0].toBase58();
}

export interface ProposalOpts {
  status?: number; // 1 = Active, 3 = Approved, 4 = Executing (zonder timestamp), 5 = Executed
  approvedAt?: number;
  buffer?: PublicKey;
  proposalOwner?: string;
  /**
   * Tweede instructie na de upgrade: SetAuthority op de ProgramData zonder
   * nieuwe authority (programma onveranderlijk maken). Raakt dezelfde buffer,
   * dus de oude selectie van de adminpagina telde hem als "dit voorstel".
   */
  extraInstruction?: boolean;
  /**
   * Extra bytes achter de Upgrade-opcode (03000000). De loader leest zijn
   * instructie met limited_deserialize (bincode, allow_trailing_bytes), dus
   * dit blijft een geldige Upgrade (review §168, scenario B).
   */
  upgradeDataSuffix?: Buffer;
  /**
   * Geen VaultTransaction maar een Batch (review §168, M-2: de losse
   * transacties staan in aparte accounts die de scan niet leest) of een
   * ConfigTransaction (hier: SetTimeLock 0).
   */
  kind?: "batch" | "config";
}

// VaultTransaction #13 (346 bytes): accountKeys-vec op offset 90 (7 sleutels),
// instructions-vec op 318, addressTableLookups-vec in de laatste 4 bytes.
const INSTRUCTIONS_OFFSET = 318;

function withSetAuthority(vtx: Buffer): Buffer {
  if (vtx.readUInt32LE(INSTRUCTIONS_OFFSET) !== 1) throw new Error("fixture: onverwachte VaultTransaction-layout");
  const out = Buffer.from(vtx);
  out.writeUInt32LE(2, INSTRUCTIONS_OFFSET);
  const setAuthority = Buffer.concat([
    Buffer.from([4]), // programIdIndex: de upgradeable loader
    Buffer.from([2, 0, 0, 0, 1, 0]), // accounts: programdata, huidige authority (de vault)
    Buffer.from([4, 0, 0, 0, 4, 0, 0, 0]), // data: SetAuthority (u32-LE 4)
  ]);
  return Buffer.concat([out.subarray(0, out.length - 4), setAuthority, out.subarray(out.length - 4)]);
}

/** De enige instructie van #13 met `suffix` achter de Upgrade-opcode. */
function withUpgradeDataSuffix(vtx: Buffer, suffix: Buffer): Buffer {
  if (vtx.readUInt32LE(INSTRUCTIONS_OFFSET) !== 1) throw new Error("fixture: onverwachte VaultTransaction-layout");
  const accountsLen = vtx.readUInt32LE(INSTRUCTIONS_OFFSET + 5);
  const dataLenAt = INSTRUCTIONS_OFFSET + 5 + 4 + accountsLen;
  if (vtx.readUInt32LE(dataLenAt) !== 4 || vtx.readUInt32LE(dataLenAt + 4) !== 3) throw new Error("fixture: geen Upgrade-instructie");
  const out = Buffer.from(vtx);
  out.writeUInt32LE(4 + suffix.length, dataLenAt);
  return Buffer.concat([out.subarray(0, dataLenAt + 8), suffix, out.subarray(dataLenAt + 8)]);
}

// Discriminators en layouts uit @sqds/multisig 2.1.4 (admin/vendor/multisig.mjs).
const BATCH_DISCRIMINATOR = Buffer.from([156, 194, 70, 44, 22, 88, 137, 44]);
const CONFIG_TRANSACTION_DISCRIMINATOR = Buffer.from([94, 8, 4, 35, 113, 139, 139, 112]);

/** Batch: multisig, creator, index, bump, vault_index, vault_bump, size (u32), executed_transaction_index (u32). */
function batchAccount(index: number): Buffer {
  return Buffer.concat([
    BATCH_DISCRIMINATOR,
    MULTISIG.toBuffer(),
    VAULT.toBuffer(), // creator: maakt niet uit
    u64(index),
    Buffer.from([255, 0, 255]),
    Buffer.from([1, 0, 0, 0]), // één transactie in de batch
    Buffer.from([0, 0, 0, 0]),
  ]);
}

/** ConfigTransaction: multisig, creator, index, bump, actions = [SetTimeLock { time_lock: 0 }]. */
function configAccount(index: number): Buffer {
  return Buffer.concat([
    CONFIG_TRANSACTION_DISCRIMINATOR,
    MULTISIG.toBuffer(),
    VAULT.toBuffer(),
    u64(index),
    Buffer.from([255]),
    Buffer.from([1, 0, 0, 0, 3, 0, 0, 0, 0]),
  ]);
}

/** Proposal #13 met een andere status; Executing heeft geen timestamp (de rest schuift op). */
function proposalAccount(index: number, status: number, timestamp: number): Buffer {
  const proposal = Buffer.from(fx.proposal13, "base64");
  proposal.writeBigUInt64LE(BigInt(index), 40);
  proposal[48] = status;
  if (status !== 4) {
    proposal.writeBigInt64LE(BigInt(timestamp), 49);
    return proposal;
  }
  return Buffer.concat([proposal.subarray(0, 49), proposal.subarray(57), Buffer.alloc(8)]);
}

export interface BufferOpts {
  absent?: boolean;
  owner?: string;
  tag?: number;
  /** null = authority None. */
  authority?: PublicKey | null;
  program?: Buffer;
  tail?: Buffer;
}

export function bufferAccount(o: BufferOpts = {}): FakeAccount | null {
  if (o.absent) return null;
  const header = Buffer.alloc(37);
  header.writeUInt32LE(o.tag ?? 1, 0);
  const authority = o.authority === undefined ? VAULT : o.authority;
  if (authority) {
    header[4] = 1;
    authority.toBuffer().copy(header, 5);
  }
  return { owner: o.owner ?? LOADER, data: Buffer.concat([header, o.program ?? RC_BINARY, o.tail ?? Buffer.alloc(0)]) };
}

/**
 * De echte stand op devnet op 2026-09-29 (STATUS.md sectie 169, read-only
 * gelezen): Active #1-4, 6, 7, 9 (oude buffers), Executed #5, 10, 11, 13,
 * Cancelled #8, Rejected #12 en #14. Plus `latest` als schoon, goedgekeurd
 * voorstel voor deze buffer. Geen enkel ander voorstel is Approved of
 * Executing, dus deze stand moet groen blijven.
 */
export function devnetLikeProposals(latest: number): Record<number, ProposalOpts> {
  const status: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 5, 6: 1, 7: 1, 8: 6, 9: 1, 10: 5, 11: 5, 12: 2, 13: 5, 14: 2 };
  const proposals: Record<number, ProposalOpts> = {};
  for (const [index, s] of Object.entries(status)) proposals[Number(index)] = { status: s, buffer: OLD_BUFFER };
  proposals[latest] = {};
  return proposals;
}

export interface SquadsOpts {
  latestIndex: number;
  /** multisig.staleTransactionIndex (standaard 0, zoals op devnet). */
  staleIndex?: number;
  proposals: Record<number, ProposalOpts>;
  buffer?: BufferOpts;
  /**
   * Sectie 170 (L-1): multisig-instellingen waarop de timelock-redenering
   * rust. Standaard de devnet-stand: config_authority de standaardwaarde
   * (autonoom), threshold 2, time_lock 259200.
   */
  configAuthority?: PublicKey;
  threshold?: number;
  timeLock?: number;
}

// Multisig-layout: discriminator (8), create_key (32), config_authority op
// 40, threshold (u16) op 72, time_lock (u32) op 74, transaction_index op 78,
// stale_transaction_index op 86.

/** Multisig, voorstellen, VaultTransactions, de RC-buffer en de Clock-sysvar. */
export function squadsAccounts(o: SquadsOpts): Map<string, FakeAccount> {
  const accounts = new Map<string, FakeAccount>();
  const multisig = Buffer.from(fx.multisig, "base64");
  if (o.configAuthority) o.configAuthority.toBuffer().copy(multisig, 40);
  if (o.threshold !== undefined) multisig.writeUInt16LE(o.threshold, 72);
  if (o.timeLock !== undefined) multisig.writeUInt32LE(o.timeLock, 74);
  multisig.writeBigUInt64LE(BigInt(o.latestIndex), 78);
  multisig.writeBigUInt64LE(BigInt(o.staleIndex ?? 0), 86);
  accounts.set(MULTISIG.toBase58(), { owner: SQUADS.toBase58(), data: multisig });
  for (const [key, p] of Object.entries(o.proposals)) {
    const index = Number(key);
    const proposal = proposalAccount(index, p.status ?? 3, p.approvedAt ?? NOW - TIME_LOCK - 3600);
    accounts.set(txPda(index, "proposal"), { owner: p.proposalOwner ?? SQUADS.toBase58(), data: proposal });
    if (p.kind === "batch" || p.kind === "config") {
      accounts.set(txPda(index), { owner: SQUADS.toBase58(), data: p.kind === "batch" ? batchAccount(index) : configAccount(index) });
      continue;
    }
    let vtx: Buffer = Buffer.from(fx.vaultTransaction13, "base64");
    vtx.writeBigUInt64LE(BigInt(index), 72);
    const at = vtx.indexOf(OLD_BUFFER.toBuffer());
    (p.buffer ?? RC_BUFFER).toBuffer().copy(vtx, at);
    if (p.upgradeDataSuffix) vtx = withUpgradeDataSuffix(vtx, p.upgradeDataSuffix);
    if (p.extraInstruction) vtx = withSetAuthority(vtx);
    accounts.set(txPda(index), { owner: SQUADS.toBase58(), data: vtx });
  }
  const buffer = bufferAccount(o.buffer);
  if (buffer) accounts.set(RC_BUFFER.toBase58(), buffer);
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(500_000_000n, 0);
  clock.writeBigInt64LE(BigInt(NOW), 32);
  accounts.set(CLOCK, { owner: SYSVAR_OWNER, data: clock });
  return accounts;
}
