import { PublicKey } from "@solana/web3.js";

/**
 * STATUS.md sectie 167 (review §162, M-2): de invariant-controle telt alleen
 * als de gelezen staat NA een bekende referentieslot ligt.
 * - --pre: de last_deploy_slot uit de ProgramData (de node moet minstens de
 *   laatste deploy gezien hebben);
 * - --post: de slot van de uitvoertransactie, en die moet gelijk zijn aan de
 *   last_deploy_slot die dezelfde node teruggeeft. Een node die de deploy
 *   nog niet gezien heeft, levert een oudere last_deploy_slot en wordt zo
 *   geweigerd, ook al kent hij de handtekening.
 * Beide getProgramAccounts-aanroepen krijgen minContextSlot = referentie + 1,
 * en hun context.slot wordt daarnaast zelf gecontroleerd (een node die
 * minContextSlot negeert, valt dan alsnog door de mand).
 *
 * Layout (UpgradeableLoaderState, bincode, u32-LE enum-tag):
 * - Program:     tag 2 (4) + programdata_address (32) = 36 bytes
 * - ProgramData: tag 3 (4) + slot u64 (8) + Option<Pubkey> (1 + 32) = 45-byte kop, dan de ELF
 * Gecontroleerd tegen de echte accounts van 9ma6 (fixture devnetSquads20260929.json).
 */

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const PROGRAM_DATA_HEADER_LEN = 45;

export function decodeProgramAccount(data: Buffer, owner: PublicKey, executable: boolean): PublicKey | string {
  if (!owner.equals(BPF_LOADER_UPGRADEABLE)) return `programma-account is niet van de upgradeable loader (${owner.toBase58()})`;
  if (!executable) return "programma-account is niet executable";
  if (data.length !== 36 || data.readUInt32LE(0) !== 2) return `geen Program-account (lengte ${data.length})`;
  return new PublicKey(data.subarray(4, 36));
}

export interface ProgramDataHeader {
  lastDeploySlot: bigint;
}

/** `data` = de eerste PROGRAM_DATA_HEADER_LEN bytes (dataSlice). */
export function decodeProgramDataHeader(data: Buffer, owner: PublicKey): ProgramDataHeader | string {
  if (!owner.equals(BPF_LOADER_UPGRADEABLE)) return `ProgramData is niet van de upgradeable loader (${owner.toBase58()})`;
  if (data.length !== PROGRAM_DATA_HEADER_LEN || data.readUInt32LE(0) !== 3) {
    return `geen ProgramData-kop (lengte ${data.length})`;
  }
  if (data[12] !== 0 && data[12] !== 1) return `ongeldige upgrade_authority-tag ${data[12]}`;
  return { lastDeploySlot: data.readBigUInt64LE(4) };
}

export interface ExecutionStatus {
  slot: number;
  err: unknown;
  confirmationStatus?: string | null;
}

/** --post: de uitvoertransactie is geslaagd, bevestigd, en is de laatste deploy die deze node ziet. */
export function postReferenceProblem(lastDeploySlot: bigint, status: ExecutionStatus | null): string | null {
  if (!status) return "uitvoertransactie onbekend bij deze node (achterlopend, of verkeerde handtekening)";
  if (status.err !== null) return `uitvoertransactie is mislukt: ${JSON.stringify(status.err)}`;
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") {
    return `uitvoertransactie is nog niet bevestigd (${status.confirmationStatus ?? "onbekend"})`;
  }
  if (BigInt(status.slot) !== lastDeploySlot) {
    return `last_deploy_slot ${lastDeploySlot} is niet de slot van de uitvoertransactie (${status.slot}): deze node heeft de deploy niet (of een andere) gezien`;
  }
  return null;
}

/** Elke gelezen context.slot moet strikt groter zijn dan de referentie. */
export function contextSlotProblems(reference: bigint, reads: { label: string; slot: number }[]): string[] {
  return reads
    .filter((r) => BigInt(r.slot) <= reference)
    .map((r) => `${r.label} gelezen op slot ${r.slot}, niet na de referentieslot ${reference}`);
}
