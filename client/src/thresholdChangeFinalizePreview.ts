import { PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { formatSolExact } from "./thresholdBanner";
import { computeThresholdChangeCommitment, bytesEqual } from "./thresholdChange";

const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface ThresholdChangeFinalizePreviewChoice {
  newSpendThresholdLamports: bigint;
  newWindowTotalCapLamports: bigint;
}

/**
 * Menselijk-leesbare bevestigingskaart voor finalize_threshold_change -
 * STATUS.md sectie 135.
 *
 * PendingAction bewaart de drempel/venstercap-waarden zelf niet in platte
 * tekst, alleen hun hash (action_commitment) - de eigenaar moet de twee
 * waarden die bij stap 24 zijn ingevoerd hier dus OPNIEUW intypen (geen
 * voorgestelde waarde, om dezelfde reden als stap 24: geen gesuggereerd
 * anker). `expectedCommitment` is de VERS van de keten gelezen
 * action_commitment (aangeroepen vóór deze kaart) - validate() rekent
 * lokaal na of de ingevoerde waarden daarmee overeenkomen, VOORDAT er een
 * passkey-ceremonie start. Een mismatch (getypte fout, of een ander
 * geheugen van wat destijds is ingevoerd) geeft zo direct een duidelijke
 * kaartfout, niet een pas on-chain ontdekte PendingActionCommitmentMismatch
 * na een al doorlopen prompt.
 */
export async function showThresholdChangeFinalizePreview(
  walletPda: PublicKey,
  expectedCommitment: Uint8Array
): Promise<ThresholdChangeFinalizePreviewChoice | null> {
  function parseSolToLamports(raw: string): bigint | null {
    const solValue = Number(raw.trim().replace(",", "."));
    if (!Number.isFinite(solValue) || solValue < 0) return null;
    return BigInt(Math.round(solValue * Number(LAMPORTS_PER_SOL)));
  }

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen - bevestigt de bij stap 24 voorgestelde wijziging",
    tone: "danger",
    friction: "hold",
    confirmLabel: "Ingedrukt houden om te bevestigen",
    headline: (v) => {
      const thresholdLamports = parseSolToLamports(v.threshold);
      const capLamports = parseSolToLamports(v.windowCap);
      const thresholdEcho =
        thresholdLamports === null ? "(ongeldig bedrag)" : formatSolExact(thresholdLamports) + " SOL";
      const capEcho = capLamports === null ? "(ongeldig bedrag)" : formatSolExact(capLamports) + " SOL";
      return `
        Voer OPNIEUW dezelfde twee waarden in als bij stap 24:<br />
        Instant-drempel: <span class="preview-amount-echo">${escapeHtml(thresholdEcho)}</span><br />
        Venstercap: <span class="preview-amount-echo">${escapeHtml(capEcho)}</span><br />
        Wijken deze af van wat destijds is ingevoerd, dan weigert deze kaart (niet de keten) het
        voorstel - de openstaande wijziging zelf blijft dan ongewijzigd staan.
      `;
    },
    fields: [
      { id: "threshold", label: "Instant-drempel (SOL) - zoals bij stap 24 ingevoerd", defaultValue: "" },
      { id: "windowCap", label: "Venstercap (SOL) - zoals bij stap 24 ingevoerd", defaultValue: "" },
    ],
    validate: (raw) => {
      const thresholdLamports = parseSolToLamports(raw.threshold);
      if (thresholdLamports === null) {
        return { error: "Ongeldige drempel - moet een getal zijn, 0 of groter." };
      }
      const capLamports = parseSolToLamports(raw.windowCap);
      if (capLamports === null) {
        return { error: "Ongeldige venstercap - moet een getal zijn, 0 of groter." };
      }
      const commitment = computeThresholdChangeCommitment(walletPda, thresholdLamports, capLamports);
      if (!bytesEqual(commitment, expectedCommitment)) {
        return {
          error:
            "Deze waarden komen niet overeen met de openstaande wijziging - controleer wat je bij " +
            "stap 24 hebt ingevoerd. (Lokaal geverifieerd tegen de on-chain commitment, geen " +
            "passkey-prompt gestart.)",
        };
      }
      return { values: { threshold: thresholdLamports.toString(), windowCap: capLamports.toString() } };
    },
  });

  if (!result) return null;
  return {
    newSpendThresholdLamports: BigInt(result.threshold),
    newWindowTotalCapLamports: BigInt(result.windowCap),
  };
}
