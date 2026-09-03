import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { formatSolExact } from "./thresholdBanner";

const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface ThresholdChangeInitiatePreviewChoice {
  newSpendThresholdLamports: bigint;
  newWindowTotalCapLamports: bigint;
}

/**
 * Menselijk-leesbare bevestigingskaart voor initiate_threshold_change -
 * STATUS.md sectie 135 (vervolg op 99/115/134).
 *
 * GEEN voorgestelde richtwaarde op geen van beide velden (`defaultValue:
 * ""`) - zelfde onderbouwing als sectie 127 punt 3/132: een concreet
 * bedrag suggereert een autoriteit die er niet is, dit systeem kent het
 * daadwerkelijke gebruikspatroon van de eigenaar niet.
 *
 * HOOG-risicoklasse (tone:"danger", hold-to-confirm) - niet expliciet
 * gevraagd, maar consistent met sectie 58/61's indeling (sleutelbeheer,
 * allowlist-uitbreiding, execute_advanced): instructions.rs's eigen
 * commentaar bij deze instructie noemt expliciet dat een gekaapte
 * ceremonie de drempel in een klap zou kunnen verhogen om daarna instant
 * grote bedragen te laten passeren - precies de HOOG-risicoklasse-dreiging
 * (onomkeerbare bevoegdheidsuitbreiding), niet de MIDDEN-klasse van een
 * enkele overdracht.
 */
export async function showThresholdChangeInitiatePreview(): Promise<ThresholdChangeInitiatePreviewChoice | null> {
  function parseSolToLamports(raw: string): bigint | null {
    const solValue = Number(raw.trim().replace(",", "."));
    if (!Number.isFinite(solValue) || solValue < 0) return null;
    return BigInt(Math.round(solValue * Number(LAMPORTS_PER_SOL)));
  }

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen - start de 24-uurs-wachttijd",
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
        Nieuwe instant-drempel: <span class="preview-amount-echo">${escapeHtml(thresholdEcho)}</span><br />
        Nieuwe venstercap: <span class="preview-amount-echo">${escapeHtml(capEcho)}</span><br />
        Wordt PAS van kracht na de 24-uurs-wachttijd EN een aparte finalize_threshold_change-aanroep
        (stap 25) - deze aanroep zelf wijzigt nog niets.
      `;
    },
    fields: [
      { id: "threshold", label: "Nieuwe instant-drempel (SOL)", defaultValue: "" },
      { id: "windowCap", label: "Nieuwe venstercap (SOL)", defaultValue: "" },
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
      return { values: { threshold: thresholdLamports.toString(), windowCap: capLamports.toString() } };
    },
  });

  if (!result) return null;
  return {
    newSpendThresholdLamports: BigInt(result.threshold),
    newWindowTotalCapLamports: BigInt(result.windowCap),
  };
}
