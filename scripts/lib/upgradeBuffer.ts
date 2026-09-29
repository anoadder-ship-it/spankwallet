import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { BPF_LOADER_UPGRADEABLE } from "./programDeploySlot";

/**
 * STATUS.md sectie 168 (review §167, M-B): de pre-flight bewijst niet alleen
 * dat het voorstel het juiste buffer-ADRES noemt, maar ook wat er in die
 * buffer staat en wie hem nog kan wijzigen.
 *
 * Layout (UpgradeableLoaderState::Buffer, bincode): tag u32-LE 1 (4) +
 * Option<Pubkey> authority (1 + 32) = 37-byte kop; de loader schrijft het
 * programma altijd vanaf offset 37, ook bij authority None. Daarna het
 * programma, en bij een ruimer gealloceerde buffer nullen.
 *
 * Eisen:
 * - eigenaar is de upgradeable loader, tag 1 (Buffer);
 * - authority = Some(vault): alleen dan kan niemand buiten de multisig de
 *   inhoud nog wijzigen tussen deze controle en het uitvoeren (de loader
 *   eist bij Upgrade bovendien buffer-authority == upgrade-authority);
 * - sha256 van de eerste `programLength` bytes na de kop = de reproduceerbare
 *   RC-build;
 * - de rest is nul.
 */

export const BUFFER_HEADER_LEN = 37;
const BUFFER_TAG = 1;

export interface ExpectedBuffer {
  address: PublicKey;
  authority: PublicKey;
  programLength: number;
  programSha256: string;
}

export interface BufferAccount {
  owner: PublicKey;
  data: Buffer;
}

export function bufferProblems(account: BufferAccount | null, expected: ExpectedBuffer): string[] {
  const name = `buffer ${expected.address.toBase58()}`;
  if (!account) return [`${name} bestaat niet`];
  if (!account.owner.equals(BPF_LOADER_UPGRADEABLE)) return [`${name} is niet van de upgradeable loader (owner ${account.owner.toBase58()})`];
  const { data } = account;
  if (data.length < BUFFER_HEADER_LEN) return [`${name} is ${data.length} bytes, korter dan de kop (${BUFFER_HEADER_LEN})`];
  const tag = data.readUInt32LE(0);
  if (tag !== BUFFER_TAG) return [`${name}: geen Buffer-account (tag ${tag})`];

  const problems: string[] = [];
  const authorityTag = data[4];
  if (authorityTag === 0) {
    problems.push(`buffer-authority is None, verwacht de vault ${expected.authority.toBase58()}`);
  } else if (authorityTag !== 1) {
    problems.push(`ongeldige buffer-authority-tag ${authorityTag}`);
  } else {
    const authority = new PublicKey(data.subarray(5, BUFFER_HEADER_LEN));
    if (!authority.equals(expected.authority)) {
      problems.push(`buffer-authority ${authority.toBase58()}, verwacht de vault ${expected.authority.toBase58()}`);
    }
  }

  const programEnd = BUFFER_HEADER_LEN + expected.programLength;
  if (data.length < programEnd) {
    problems.push(`buffer is ${data.length} bytes, verwacht minstens ${programEnd} (kop ${BUFFER_HEADER_LEN} + programma ${expected.programLength})`);
    return problems;
  }
  const sha = createHash("sha256").update(data.subarray(BUFFER_HEADER_LEN, programEnd)).digest("hex");
  if (sha !== expected.programSha256) {
    problems.push(`sha256 van de eerste ${expected.programLength} bytes na de kop is ${sha}, verwacht ${expected.programSha256}`);
  }
  const nonZero = data.subarray(programEnd).findIndex((b) => b !== 0);
  if (nonZero >= 0) problems.push(`niet-nul byte na het programma op offset ${programEnd + nonZero}`);
  return problems;
}
