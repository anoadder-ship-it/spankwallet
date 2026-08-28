import { Connection } from "@solana/web3.js";

// Solana's "nominale 400ms/slot" is een mikpunt, geen garantie, en is
// empirisch niet meer accuraat: gemeten 2026-08-28 (STATUS.md sectie 103,
// scripts/measureSlotDuration.ts, directe getBlockTime-meting over 50k-200k
// slots, geen extrapolatie) - mainnet-beta ~366ms/slot, devnet ~166ms/slot.
// Helius noemde diezelfde dag de verwachte overgang naar 300ms op mainnet,
// wat ook al niet zou kloppen voor devnet. Er bestaat dus geen enkele vaste
// constante die voor beide netwerken tegelijk juist is, laat staan blijft -
// vandaar `estimateSlotMs()` hieronder als primaire bron. Deze constante is
// uitsluitend de LAATSTE terugvaloptie als die live meting faalt.
const FALLBACK_SLOT_MS_ESTIMATE = 400;

/**
 * Meet de huidige slotduur direct tegen de meegegeven connectie
 * (`getRecentPerformanceSamples`, zelfde principe als
 * scripts/measureSlotDuration.ts: een directe meting, geen hardcoded
 * aanname). Valt terug op `FALLBACK_SLOT_MS_ESTIMATE` als de RPC-aanroep
 * faalt of geen samples oplevert, zodat de preview nooit hard breekt op een
 * trage/onbeschikbare RPC.
 */
export async function estimateSlotMs(connection: Connection): Promise<number> {
  try {
    const samples = await connection.getRecentPerformanceSamples(1);
    const sample = samples[0];
    if (!sample || sample.numSlots === 0) return FALLBACK_SLOT_MS_ESTIMATE;
    return (sample.samplePeriodSecs * 1000) / sample.numSlots;
  } catch {
    return FALLBACK_SLOT_MS_ESTIMATE;
  }
}

/**
 * Gedeelde slot-naar-leestijd-schatting (STATUS.md sectie 58/59/64/67) -
 * ontleed uit `addSessionKeyPreview.ts` toen `removeSessionKeyPreview.ts`
 * dezelfde omrekening een tweede keer nodig bleek te hebben (zelfde
 * behandeling als `escapeHtml`/`hex.ts`/`tokenAmount.ts`/`knownPrograms.ts`).
 *
 * `slotMsEstimate` is optioneel juist om bestaande/toekomstige aanroepers
 * zonder connectie niet te breken - geef 'm door (bij voorkeur via
 * `estimateSlotMs()`) waar een connectie voorhanden is.
 */
export function formatDurationEstimate(
  slots: bigint,
  slotMsEstimate: number = FALLBACK_SLOT_MS_ESTIMATE
): string {
  const ms = Number(slots) * slotMsEstimate;
  const minutes = ms / 60000;
  if (minutes < 1) return "< 1 minuut (schatting)";
  if (minutes < 60) return "~" + minutes.toFixed(1) + " minuten (schatting)";
  return "~" + (minutes / 60).toFixed(1) + " uur (schatting)";
}
