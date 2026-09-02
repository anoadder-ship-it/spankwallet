import { PublicKey } from "@solana/web3.js";
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
