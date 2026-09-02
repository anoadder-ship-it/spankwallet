import { PublicKey } from "@solana/web3.js";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

/**
 * STATUS.md sectie 132/133 (stap B): PDA-derivatie voor SpendWindow, de
 * glijdende-vensterlimiet-teller. Uitsluitend de adresafleiding hier - dit
 * account bestaat niet voor een wallet die nog nooit een drempel heeft
 * gezet (execute/hunt lezen/schrijven het pas vanaf stap c), maar
 * execute/hunt moeten het adres al wel meesturen sinds stap B's
 * accountlijst-uitbreiding (UncheckedAccount, geen bestaand account
 * vereist).
 */
export function deriveSpendWindowPda(walletPda: PublicKey): PublicKey {
  const [spendWindowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("spend_window"), walletPda.toBytes()],
    SPANKWALLET_PROGRAM_ID
  );
  return spendWindowPda;
}
