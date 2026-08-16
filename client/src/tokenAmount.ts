/**
 * Gedeelde SPL-token-bedrag-<->leesbare-eenheden-hulpfuncties (STATUS.md
 * sectie 58/59/63/64) - ontleed uit `transferTokenPreview.ts` toen
 * `addSessionKeyPreview.ts` dezelfde logica een tweede keer nodig bleek te
 * hebben (zelfde behandeling als `escapeHtml`/`hex.ts` eerder).
 *
 * `decimals: null` betekent altijd "onbekend" (bijv. de mint-fetch is
 * mislukt) - dan wordt nooit een schaling aangenomen, alleen een geheel
 * getal ruwe eenheden geaccepteerd/getoond, expliciet zo gelabeld.
 */
export function formatTokenAmount(raw: bigint, decimals: number | null): string {
  if (decimals === null) return raw.toString() + " ruwe eenheden (decimals onbekend)";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return whole.toString() + (fracStr ? "." + fracStr : "");
}

export function parseTokenAmount(raw: string, decimals: number | null): bigint | null {
  const trimmed = raw.trim().replace(",", ".");
  if (decimals === null) {
    if (!/^\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) return null; // meer precisie dan de mint toestaat
  const paddedFrac = fracPart.padEnd(decimals, "0");
  try {
    return BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
  } catch {
    return null;
  }
}

/** Defaultwaarde voor een BEWERKBAAR veld moet een kale invoerbare waarde
 * zijn (geen bijschrift) - bij bekende decimals de leesbare vorm, anders
 * gewoon de ruwe eenheden als geheel getal. */
export function defaultTokenAmountFieldValue(raw: bigint, decimals: number | null): string {
  return decimals === null ? raw.toString() : formatTokenAmount(raw, decimals);
}
