import { Connection, PublicKey } from "@solana/web3.js";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

/**
 * STATUS.md sectie 132/133/134 (stap B/c): PDA-derivatie voor SpendWindow,
 * de glijdende-vensterlimiet-teller. Uitsluitend de adresafleiding hier -
 * dit account bestaat niet voor een wallet die nog nooit een drempel
 * heeft gezet (execute/hunt lezen/schrijven het pas dan), maar
 * execute/hunt moeten het adres altijd meesturen (UncheckedAccount, geen
 * bestaand account vereist voor een drempel=0-wallet).
 */
export function deriveSpendWindowPda(walletPda: PublicKey): PublicKey {
  const [spendWindowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("spend_window"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return spendWindowPda;
}

// SpendWindow-layout (state.rs): discriminator(8) + wallet(32) + bump(1) +
// window_total_cap_lamports(8) + window_started_at(8) +
// spent_lamports_this_window(8) = 65 (SpendWindow::LEN).
const OFFSET_WINDOW_TOTAL_CAP = 8 + 32 + 1;
const OFFSET_WINDOW_STARTED_AT = OFFSET_WINDOW_TOTAL_CAP + 8;
const OFFSET_SPENT_THIS_WINDOW = OFFSET_WINDOW_STARTED_AT + 8;

export interface ParsedSpendWindow {
  windowTotalCapLamports: bigint;
  windowStartedAt: bigint;
  spentLamportsThisWindow: bigint;
}

/**
 * STATUS.md sectie 135 (vervolg op 99/115/134): nodig om ná
 * finalize_threshold_change de daadwerkelijk op de keten geschreven
 * venstercap terug te lezen - niet aannemen op basis van wat verstuurd is
 * (finalize_threshold_change kan `init_if_needed` het account net voor het
 * eerst aanmaken). `null` betekent hier "bestaat nog niet" (een wallet die
 * nog nooit een drempel heeft gezet) - geen fout.
 */
export async function readSpendWindow(
  connection: Connection,
  spendWindowPda: PublicKey
): Promise<ParsedSpendWindow | null> {
  const accountInfo = await connection.getAccountInfo(spendWindowPda, "confirmed");
  if (!accountInfo) {
    return null;
  }
  const data = accountInfo.data;
  return {
    windowTotalCapLamports: data.readBigUInt64LE(OFFSET_WINDOW_TOTAL_CAP),
    windowStartedAt: data.readBigInt64LE(OFFSET_WINDOW_STARTED_AT),
    spentLamportsThisWindow: data.readBigUInt64LE(OFFSET_SPENT_THIS_WINDOW),
  };
}
