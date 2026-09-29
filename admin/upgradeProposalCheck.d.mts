// Typen voor admin/upgradeProposalCheck.mjs (STATUS.md sectie 168), voor de
// TypeScript-scripts die hem importeren. De module zelf is gewoon JavaScript,
// zodat de adminpagina hem zonder build-stap laadt.

export declare const SQUADS_PROGRAM_ID: string;
export declare const BPF_LOADER_UPGRADEABLE: string;
export declare const PROPOSAL_STATUS_NAMES: string[];
export declare const ACTIVE_TAG: number;
export declare const APPROVED_TAG: number;

export interface KeyLike {
  equals(other: KeyLike): boolean;
  toBase58(): string;
  toBytes(): Uint8Array;
}

export interface KeyClass<K extends KeyLike> {
  new (value: Uint8Array | string): K;
  findProgramAddressSync(seeds: Uint8Array[], programId: K): [K, number];
}

export interface MultisigHeader {
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
}

export interface ProposalHeader<K> {
  multisig: K;
  transactionIndex: bigint;
  statusTag: number;
  statusTimestamp: bigint | null;
}

export interface CompiledInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface VaultTransaction<K> {
  multisig: K;
  index: bigint;
  vaultIndex: number;
  ephemeralSignerBumps: Uint8Array;
  numSigners: number;
  accountKeys: K[];
  instructions: CompiledInstruction[];
  addressTableLookupCount: number;
}

export interface ExpectedUpgrade<K> {
  multisig: K;
  transactionIndex: bigint;
  vaultIndex: number;
  programId: K;
  programData: K;
  buffer: K;
}

export interface AccountBytes<K> {
  address: K;
  owner: K;
  data: Uint8Array;
}

export interface ProposalEntry<K> {
  index: bigint;
  proposal: AccountBytes<K> | null;
  transaction: AccountBytes<K> | null;
}

export type Purpose = "execute" | "approve" | "propose";
export type Commitment = "processed" | "confirmed" | "finalized";

export interface Candidate {
  index: bigint;
  statusName: string;
}

export interface SelectedProposal<K> {
  index: bigint;
  statusName: string;
  statusTimestamp: bigint | null;
  vtx: VaultTransaction<K>;
}

export interface Selection<K> {
  target: SelectedProposal<K> | null;
  candidates: Candidate[];
  problems: string[];
}

export interface SelectArgs<K> {
  multisig: MultisigHeader;
  multisigAddress: K;
  entries: ProposalEntry<K>[];
  expected: Omit<ExpectedUpgrade<K>, "transactionIndex">;
  purpose: Purpose;
}

/** Het deel van een @solana/web3.js-Connection dat de scan gebruikt. */
export interface ConnectionLike<K> {
  getAccountInfoAndContext(
    address: K,
    config: { commitment?: Commitment }
  ): Promise<{ context: { slot: number }; value: { owner: K; data: Uint8Array } | null }>;
  getMultipleAccountsInfoAndContext(
    addresses: K[],
    config: { commitment?: Commitment; minContextSlot?: number }
  ): Promise<{ context: { slot: number }; value: ({ owner: K; data: Uint8Array } | null)[] }>;
}

export interface UpgradeProposalCheck<K extends KeyLike> {
  squadsProgramId: K;
  transactionPda(multisig: K, index: bigint): K;
  proposalPda(multisig: K, index: bigint): K;
  vaultPda(multisig: K, vaultIndex: number): K;
  decodeMultisigHeader(data: Uint8Array): MultisigHeader | string;
  decodeProposalHeader(data: Uint8Array): ProposalHeader<K> | string;
  decodeVaultTransaction(data: Uint8Array): VaultTransaction<K> | string;
  touchesBuffer(vtx: VaultTransaction<K>, buffer: K): boolean;
  upgradeProposalProblems(vtx: VaultTransaction<K>, expected: ExpectedUpgrade<K>): string[];
  selectProposal(args: SelectArgs<K>): Selection<K>;
  loadProposalEntries(
    connection: ConnectionLike<K>,
    multisigAddress: K,
    commitment: Commitment
  ): Promise<{ multisig: MultisigHeader; entries: ProposalEntry<K>[] }>;
  loadAndSelect(
    connection: ConnectionLike<K>,
    args: { multisigAddress: K; expected: Omit<ExpectedUpgrade<K>, "transactionIndex">; purpose: Purpose; commitment?: Commitment }
  ): Promise<Selection<K> & { multisig: MultisigHeader }>;
}

export declare function createUpgradeProposalCheck<K extends KeyLike>(PublicKey: KeyClass<K>): UpgradeProposalCheck<K>;
