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
  status?: number; // 1 = Active, 3 = Approved
  approvedAt?: number;
  buffer?: PublicKey;
  proposalOwner?: string;
  /**
   * Tweede instructie na de upgrade: SetAuthority op de ProgramData zonder
   * nieuwe authority (programma onveranderlijk maken). Raakt dezelfde buffer,
   * dus de oude selectie van de adminpagina telde hem als "dit voorstel".
   */
  extraInstruction?: boolean;
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

export interface SquadsOpts {
  latestIndex: number;
  /** multisig.staleTransactionIndex (standaard 0, zoals op devnet). */
  staleIndex?: number;
  proposals: Record<number, ProposalOpts>;
  buffer?: BufferOpts;
}

/** Multisig, voorstellen, VaultTransactions, de RC-buffer en de Clock-sysvar. */
export function squadsAccounts(o: SquadsOpts): Map<string, FakeAccount> {
  const accounts = new Map<string, FakeAccount>();
  const multisig = Buffer.from(fx.multisig, "base64");
  multisig.writeBigUInt64LE(BigInt(o.latestIndex), 78);
  multisig.writeBigUInt64LE(BigInt(o.staleIndex ?? 0), 86);
  accounts.set(MULTISIG.toBase58(), { owner: SQUADS.toBase58(), data: multisig });
  for (const [key, p] of Object.entries(o.proposals)) {
    const index = Number(key);
    const proposal = Buffer.from(fx.proposal13, "base64");
    proposal.writeBigUInt64LE(BigInt(index), 40);
    proposal[48] = p.status ?? 3;
    proposal.writeBigInt64LE(BigInt(p.approvedAt ?? NOW - TIME_LOCK - 3600), 49);
    accounts.set(txPda(index, "proposal"), { owner: p.proposalOwner ?? SQUADS.toBase58(), data: proposal });
    let vtx: Buffer = Buffer.from(fx.vaultTransaction13, "base64");
    vtx.writeBigUInt64LE(BigInt(index), 72);
    const at = vtx.indexOf(OLD_BUFFER.toBuffer());
    (p.buffer ?? RC_BUFFER).toBuffer().copy(vtx, at);
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
