import { PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { BPF_LOADER_UPGRADEABLE } from "./programDeploySlot";

/**
 * STATUS.md sectie 167 (review §162, M-3): wat checkProposalTimelock.ts over
 * het voorstel zelf moet bewijzen, als pure functies op accountbytes.
 *
 * Layouts uit @sqds/multisig 2.1.4, src/generated/accounts/{Multisig,
 * Proposal,VaultTransaction}.ts en types/{VaultTransactionMessage,
 * MultisigCompiledInstruction,MultisigMessageAddressTableLookup}.ts; PDA-
 * seeds uit src/pda.ts. Gecontroleerd tegen de echte VaultTransactions #11,
 * #13 en #14 op devnet: elk 346 bytes, door de decoder hieronder exact
 * verbruikt (fixture devnetSquads20260929.json).
 */

export const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

const MULTISIG_DISCRIMINATOR = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
const PROPOSAL_DISCRIMINATOR = Buffer.from([26, 94, 189, 187, 116, 136, 53, 33]);
const VAULT_TRANSACTION_DISCRIMINATOR = Buffer.from([168, 250, 162, 100, 81, 14, 162, 207]);

// ProposalStatus-tag (1 byte): Draft=0, Active=1, Rejected=2, Approved=3,
// Executing=4, Executed=5, Cancelled=6. Alle behalve Executing dragen een
// i64-timestamp.
export const PROPOSAL_STATUS_NAMES = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"];
export const APPROVED_TAG = 3;

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export function transactionPda(multisig: PublicKey, index: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("transaction"), u64le(index)],
    SQUADS_PROGRAM_ID
  )[0];
}

export function proposalPda(multisig: PublicKey, index: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("transaction"), u64le(index), Buffer.from("proposal")],
    SQUADS_PROGRAM_ID
  )[0];
}

export function vaultPda(multisig: PublicKey, vaultIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("vault"), Buffer.from([vaultIndex])],
    SQUADS_PROGRAM_ID
  )[0];
}

/** Leest begrensd: elke lezing voorbij het einde gooit, zodat een afgekapt account nooit half gedecodeerd wordt. */
class Reader {
  offset = 0;
  private readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  private take(n: number): Buffer {
    if (this.offset + n > this.data.length) throw new Error(`afgekapt op offset ${this.offset} (+${n} > ${this.data.length})`);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u16(): number {
    return this.take(2).readUInt16LE(0);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  pubkey(): PublicKey {
    return new PublicKey(this.take(32));
  }
  bytes(): Buffer {
    return Buffer.from(this.take(this.u32()));
  }
  vec<T>(item: () => T): T[] {
    const n = this.u32();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item());
    return out;
  }
  get atEnd(): boolean {
    return this.offset === this.data.length;
  }
}

function withDiscriminator<T>(data: Buffer, discriminator: Buffer, name: string, decode: (r: Reader) => T): T | string {
  if (data.length < 8 || !data.subarray(0, 8).equals(discriminator)) return `geen ${name}-discriminator`;
  const r = new Reader(data);
  r.offset = 8;
  try {
    return decode(r);
  } catch (e) {
    return `${name}: ${(e as Error).message}`;
  }
}

export interface MultisigHeader {
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
}

export function decodeMultisigHeader(data: Buffer): MultisigHeader | string {
  return withDiscriminator(data, MULTISIG_DISCRIMINATOR, "Multisig", (r) => {
    r.pubkey(); // create_key
    r.pubkey(); // config_authority
    return { threshold: r.u16(), timeLockSeconds: r.u32(), transactionIndex: r.u64(), staleTransactionIndex: r.u64() };
  });
}

export interface ProposalHeader {
  multisig: PublicKey;
  transactionIndex: bigint;
  statusTag: number;
  statusTimestamp: bigint | null;
}

export function decodeProposalHeader(data: Buffer): ProposalHeader | string {
  return withDiscriminator(data, PROPOSAL_DISCRIMINATOR, "Proposal", (r) => {
    const multisig = r.pubkey();
    const transactionIndex = r.u64();
    const statusTag = r.u8();
    if (statusTag >= PROPOSAL_STATUS_NAMES.length) throw new Error(`onbekende status-tag ${statusTag}`);
    const statusTimestamp = statusTag === 4 ? null : r.i64();
    return { multisig, transactionIndex, statusTag, statusTimestamp };
  });
}

export interface CompiledInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Buffer;
}

export interface VaultTransaction {
  multisig: PublicKey;
  index: bigint;
  vaultIndex: number;
  ephemeralSignerBumps: Buffer;
  numSigners: number;
  accountKeys: PublicKey[];
  instructions: CompiledInstruction[];
  addressTableLookupCount: number;
}

/** Volledige decode; bytes over na het bericht = afwijking (Squads alloceert exact). */
export function decodeVaultTransaction(data: Buffer): VaultTransaction | string {
  return withDiscriminator(data, VAULT_TRANSACTION_DISCRIMINATOR, "VaultTransaction", (r) => {
    const multisig = r.pubkey();
    r.pubkey(); // creator
    const index = r.u64();
    r.u8(); // bump
    const vaultIndex = r.u8();
    r.u8(); // vault_bump
    const ephemeralSignerBumps = r.bytes();
    const numSigners = r.u8();
    r.u8(); // num_writable_signers
    r.u8(); // num_writable_non_signers
    const accountKeys = r.vec(() => r.pubkey());
    const instructions = r.vec(() => ({ programIdIndex: r.u8(), accountIndexes: [...r.bytes()], data: r.bytes() }));
    const addressTableLookups = r.vec(() => ({ accountKey: r.pubkey(), writable: r.bytes(), readonly: r.bytes() }));
    if (!r.atEnd) throw new Error(`${data.length - r.offset} onverwachte bytes na het bericht`);
    return {
      multisig,
      index,
      vaultIndex,
      ephemeralSignerBumps,
      numSigners,
      accountKeys,
      instructions,
      addressTableLookupCount: addressTableLookups.length,
    };
  });
}

export interface ExpectedUpgrade {
  multisig: PublicKey;
  transactionIndex: bigint;
  vaultIndex: number;
  programId: PublicKey;
  programData: PublicKey;
  buffer: PublicKey;
}

// UpgradeableLoaderInstruction::Upgrade (u32-LE 3), accountvolgorde zoals
// admin/wallet-signer.html hem opbouwt en zoals #11/#13/#14 on-chain staan:
// programdata, program, buffer, spill, rent, clock, authority.
const UPGRADE_OPCODE = Buffer.from([3, 0, 0, 0]);

/**
 * Eist dat de VaultTransaction precies één ding doet: programma
 * `expected.programId` upgraden vanaf `expected.buffer`, met de vault als
 * enige ondertekenaar, upgrade-authority en spill. Alles daarbuiten (een
 * tweede instructie, een lookup-table, ephemeral signers, een andere
 * accountvolgorde) is een afwijking, ook als het onschuldig zou kunnen zijn.
 */
export function upgradeProposalProblems(vtx: VaultTransaction, expected: ExpectedUpgrade): string[] {
  const problems: string[] = [];
  const vault = vaultPda(expected.multisig, expected.vaultIndex);
  if (!vtx.multisig.equals(expected.multisig)) problems.push(`multisig ${vtx.multisig.toBase58()}, verwacht ${expected.multisig.toBase58()}`);
  if (vtx.index !== expected.transactionIndex) problems.push(`index ${vtx.index}, verwacht ${expected.transactionIndex}`);
  if (vtx.vaultIndex !== expected.vaultIndex) problems.push(`vault-index ${vtx.vaultIndex}, verwacht ${expected.vaultIndex}`);
  if (vtx.ephemeralSignerBumps.length !== 0) problems.push(`${vtx.ephemeralSignerBumps.length} ephemeral signer(s), verwacht 0`);
  if (vtx.addressTableLookupCount !== 0) problems.push(`${vtx.addressTableLookupCount} address lookup table(s), verwacht 0`);
  if (vtx.numSigners !== 1 || !vtx.accountKeys[0]?.equals(vault)) {
    problems.push(`ondertekenaars: ${vtx.numSigners}, eerste sleutel ${vtx.accountKeys[0]?.toBase58() ?? "-"}; verwacht alleen de vault ${vault.toBase58()}`);
  }
  if (vtx.instructions.length !== 1) {
    problems.push(`${vtx.instructions.length} instructies, verwacht precies 1 (de upgrade)`);
    return problems;
  }
  const ix = vtx.instructions[0];
  const key = (i: number): PublicKey | undefined => vtx.accountKeys[i];
  if (!key(ix.programIdIndex)?.equals(BPF_LOADER_UPGRADEABLE)) {
    problems.push(`instructie roept ${key(ix.programIdIndex)?.toBase58() ?? "?"} aan, niet de upgradeable loader`);
  }
  if (!ix.data.equals(UPGRADE_OPCODE)) problems.push(`instructiedata ${ix.data.toString("hex")}, verwacht Upgrade (03000000)`);
  const expectedAccounts: [string, PublicKey][] = [
    ["programdata", expected.programData],
    ["programma", expected.programId],
    ["buffer", expected.buffer],
    ["spill", vault],
    ["rent-sysvar", SYSVAR_RENT_PUBKEY],
    ["clock-sysvar", SYSVAR_CLOCK_PUBKEY],
    ["upgrade-authority", vault],
  ];
  if (ix.accountIndexes.length !== expectedAccounts.length) {
    problems.push(`${ix.accountIndexes.length} accounts in de instructie, verwacht ${expectedAccounts.length}`);
    return problems;
  }
  expectedAccounts.forEach(([name, want], i) => {
    const got = key(ix.accountIndexes[i]);
    if (!got?.equals(want)) problems.push(`${name}: ${got?.toBase58() ?? "ongeldige index"}, verwacht ${want.toBase58()}`);
  });
  return problems;
}
