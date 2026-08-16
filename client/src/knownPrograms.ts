import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Gedeelde "bekende programma's"-tabel (STATUS.md sectie 58/59/62/66) -
 * ontleed uit `addAllowedProgramPreview.ts` toen `removeAllowedProgramPreview.ts`
 * dezelfde tabel een tweede keer nodig bleek te hebben (zelfde behandeling
 * als `escapeHtml`/`hex.ts`/`tokenAmount.ts` eerder).
 *
 * Puur lokaal, uit de al-bestaande dependencies van dit project - geen
 * externe databron, geen gokwerk. Alles buiten deze drie: eerlijk
 * "onbekend programma", nooit verzonnen.
 */
export const KNOWN_PROGRAMS: Record<string, string> = {
  [SystemProgram.programId.toBase58()]: "System Program (Solana native)",
  [TOKEN_PROGRAM_ID.toBase58()]: "SPL Token Program",
  [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()]: "SPL Associated Token Account Program",
};

export function knownProgramLabel(programId: PublicKey): string | undefined {
  return KNOWN_PROGRAMS[programId.toBase58()];
}
