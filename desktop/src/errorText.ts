/**
 * Tekst voor een fout die uit een Tauri-command of uit JS komt. Eerder stond
 * op drie plekken `typeof err?.message === "string" ? err.message :
 * JSON.stringify(err)`. JSON.stringify kan zelf gooien (een BigInt, een
 * kringverwijzing, een toJSON of getter die gooit), en dan veroorzaakte de
 * foutmelding een tweede fout, buiten de afhandeling om.
 *
 * Gedrag, gelijk aan de oude regel zolang die niet gooide:
 * - `err.message` als dat tekst is (ook bij de Rust-fouten `{kind, message}`);
 * - anders `JSON.stringify(err)`;
 * - is dat undefined (err undefined, een functie, een Symbol): "". De
 *   foutkaarten toonden dan al een lege kop (escapeHtml maakt van undefined
 *   ""); alleen de logregel in main.ts toont nu "" in plaats van "undefined".
 * - gooit er iets: een vaste tekst. Deze functie gooit nooit.
 */
export const UNREADABLE_ERROR_TEXT = "(de foutmelding kon niet als tekst worden weergegeven)";

export function errorText(err: unknown): string {
  try {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    if (typeof message === "string") return message;
    const json = JSON.stringify(err);
    return typeof json === "string" ? json : "";
  } catch {
    return UNREADABLE_ERROR_TEXT;
  }
}
