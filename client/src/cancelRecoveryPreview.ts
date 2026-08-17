import { Connection, PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { readWalletAccount, ParsedRecoveryState } from "./recovery";
import { bytesToHex } from "./hex";

const PASSKEY_LEN = 33;

export type CancelRecoveryPreviewResult =
  | { kind: "confirmed"; recoveryState: ParsedRecoveryState }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "no-recovery-in-progress" };

/**
 * Menselijk-leesbare bevestigingskaart voor cancel_recovery - STATUS.md
 * sectie 71, derde LAAG-risicoklasse-kaart. Dit is een veto/noodrem tegen
 * een AL LOPENDE recovery, geen actie die zelf bevoegdheid verbreedt of
 * versmalt - frictie zou hier averechts werken (elke seconde telt als een
 * kwaadwillende backup_authority een overname probeert door te zetten), dus
 * `friction: "click"`, geen `tone: "danger"`.
 *
 * Pre-flight-check is de INVERSE van elke andere kaart tot nu toe: deze
 * kaart bestaat uitsluitend om iets tegen te houden dat al loopt, dus
 * `would-fail` treedt op als er GEEN recovery loopt (in plaats van de
 * gebruikelijke "faalt als er wel een loopt"-constraint die alle andere
 * passkey-gated instructies delen).
 *
 * Toont expliciet WAT er tegengehouden wordt (STATUS.md-afspraak, geen
 * understatement): sinds wanneer de recovery loopt, en welke
 * new_owner_passkey er klaarstond - `new_owner_passkey` is 33 rauwe
 * secp256r1-bytes, geen Solana-Pubkey, dus hex-weergave (`hex.ts`), zelfde
 * conventie als `addPasskeyPreview.ts`/`removePasskeyPreview.ts`. Ook de
 * datum waarop `finalize_recovery` mogelijk zou zijn geworden (initiatedAt +
 * recoveryTimelockSeconds), zodat de gebruiker meteen ziet hoe dichtbij de
 * overname al was.
 */
export async function showCancelRecoveryPreview(
  connection: Connection,
  walletPda: PublicKey
): Promise<CancelRecoveryPreviewResult> {
  const wallet = await readWalletAccount(connection, walletPda);
  if (!wallet.recoveryState) {
    return { kind: "would-fail", reason: "no-recovery-in-progress" };
  }
  const recoveryState = wallet.recoveryState;

  const initiatedAtMs = Number(recoveryState.initiatedAt) * 1000;
  const initiatedAtDate = new Date(initiatedAtMs);
  const elapsedMs = Date.now() - initiatedAtMs;
  const elapsedHours = elapsedMs / 3600000;
  const elapsedLine =
    elapsedHours < 1
      ? "< 1 uur geleden"
      : elapsedHours < 48
        ? "~" + elapsedHours.toFixed(1) + " uur geleden"
        : "~" + (elapsedHours / 24).toFixed(1) + " dagen geleden";

  const finalizeAtMs = initiatedAtMs + Number(wallet.recoveryTimelockSeconds) * 1000;
  const finalizeAtDate = new Date(finalizeAtMs);
  const finalizeLine =
    finalizeAtMs <= Date.now()
      ? "al verstreken - finalize_recovery is al mogelijk, hoe eerder je annuleert hoe beter"
      : "nog niet verstreken";

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: () => `
      Lopende recovery annuleren (noodrem tegen een overname die nog niet is afgerond):<br />
      Gestart op: <strong>${escapeHtml(initiatedAtDate.toLocaleString("nl-NL"))}</strong> (${elapsedLine})<br />
      Nieuwe eigenaars-sleutel die klaarstond: <span class="preview-recipient-echo">${escapeHtml(bytesToHex(recoveryState.newOwnerPasskey))}</span> (${PASSKEY_LEN} bytes, hex)<br />
      finalize_recovery zou mogelijk zijn geworden op: <strong>${escapeHtml(finalizeAtDate.toLocaleString("nl-NL"))}</strong> (${finalizeLine})
    `,
    fields: [],
    validate: () => ({ values: {} }),
    friction: "click",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", recoveryState };
}
