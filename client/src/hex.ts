/**
 * Gedeelde hex-<->bytes-hulpfuncties (STATUS.md sectie 58/59) - ontleed uit
 * `addPasskeyPreview.ts` toen `removePasskeyPreview.ts` dezelfde logica een
 * derde keer nodig bleek te hebben (zelfde behandeling als `escapeHtml` in
 * `confirmationCard.ts`). `main.ts` heeft zijn eigen, oudere, private
 * `bytesToHex` - bewust ongemoeid gelaten, dat is een grotere, losstaande
 * opschoning die geen onderdeel is van deze wijziging.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return null;
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
