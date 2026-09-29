import { PublicKey } from "@solana/web3.js";
import { createUpgradeProposalCheck } from "../../admin/upgradeProposalCheck.mjs";
import type * as Shared from "../../admin/upgradeProposalCheck.mjs";

/**
 * STATUS.md sectie 167/168: wat checkProposalTimelock.ts over het voorstel
 * zelf moet bewijzen. Sinds sectie 168 (review §167, M-A) staat de logica in
 * admin/upgradeProposalCheck.mjs, dezelfde module die admin/wallet-signer.html
 * gebruikt; dit bestand bindt hem alleen aan de PublicKey van
 * @solana/web3.js. Eén selectieregel, niet twee.
 */

const check = createUpgradeProposalCheck(PublicKey);

export { APPROVED_TAG, PROPOSAL_STATUS_NAMES } from "../../admin/upgradeProposalCheck.mjs";
export const SQUADS_PROGRAM_ID = check.squadsProgramId;
export const {
  transactionPda,
  proposalPda,
  vaultPda,
  decodeMultisigHeader,
  decodeProposalHeader,
  decodeVaultTransaction,
  touchesBuffer,
  upgradeProposalProblems,
  selectProposal,
  loadAndSelect,
} = check;

export type VaultTransaction = Shared.VaultTransaction<PublicKey>;
export type ExpectedUpgrade = Shared.ExpectedUpgrade<PublicKey>;
export type ProposalEntry = Shared.ProposalEntry<PublicKey>;
