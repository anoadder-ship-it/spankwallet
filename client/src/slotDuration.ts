const SLOT_MS_ESTIMATE = 400; // Solana's veelgeciteerde gemiddelde/doel-blokduur - een SCHATTING, geen garantie

/**
 * Gedeelde slot-naar-leestijd-schatting (STATUS.md sectie 58/59/64/67) -
 * ontleed uit `addSessionKeyPreview.ts` toen `removeSessionKeyPreview.ts`
 * dezelfde omrekening een tweede keer nodig bleek te hebben (zelfde
 * behandeling als `escapeHtml`/`hex.ts`/`tokenAmount.ts`/`knownPrograms.ts`).
 */
export function formatDurationEstimate(slots: bigint): string {
  const ms = Number(slots) * SLOT_MS_ESTIMATE;
  const minutes = ms / 60000;
  if (minutes < 1) return "< 1 minuut (schatting)";
  if (minutes < 60) return "~" + minutes.toFixed(1) + " minuten (schatting)";
  return "~" + (minutes / 60).toFixed(1) + " uur (schatting)";
}
