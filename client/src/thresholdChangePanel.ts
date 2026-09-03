import {
  ParsedPendingAction,
  PENDING_ACTION_KIND_THRESHOLD_CHANGE,
  PENDING_ACTION_TIMELOCK_SECONDS,
} from "./thresholdChange";

/**
 * STATUS.md sectie 135 (vervolg op 99/115/134): client-ingang voor
 * initiate_threshold_change/finalize_threshold_change - tot dit werd
 * gebouwd het enige van de vier initiate/finalize-paren zonder client-UI,
 * en het paar dat de eigenaar in de praktijk daadwerkelijk moet gebruiken
 * om het spend-cap-mechanisme te activeren (spend_threshold_lamports
 * staat vandaag op 0 voor alle bestaande wallets).
 *
 * Zelfde tweedeling als thresholdBanner.ts:
 * 1. thresholdChangePanelState() - PURE functie, geen DOM. Neemt de
 *    RECHTSTREEKS-van-de-keten-gelezen PendingAction (of null) en de
 *    huidige tijd, en bepaalt daaruit welke staat het paneel moet tonen.
 *    Dit is DEZELFDE functie voor "net initiate_threshold_change
 *    aangeroepen" en "pagina een dag later opnieuw geladen" - er is geen
 *    apart "ik heb net geinitieerd"-geheugen in de client. Apart getest
 *    (tests/thresholdChangePanel.ts) met een kunstmatig teruggedateerde
 *    initiated_at, GEEN validator nodig.
 * 2. renderThresholdChangePanel() - de DOM-effectkant, getest tegen een
 *    jsdom-gesimuleerde DOM in datzelfde testbestand. Aanroepen op precies
 *    drie momenten (main.ts): ná wallet-load, ná een geslaagde initiate,
 *    ná een geslaagde finalize/cancel - alle drie roepen dezelfde functie
 *    aan, met een verse keten-lezing, nooit met een lokaal bewaarde
 *    waarde.
 */

export type ThresholdChangePanelState =
  | { kind: "none" }
  | { kind: "blocked-other"; otherKind: number }
  | { kind: "waiting"; availableAt: Date; confirmed: boolean }
  | { kind: "ready"; confirmed: boolean };

export function thresholdChangePanelState(
  pending: ParsedPendingAction | null,
  nowUnixSeconds: number
): ThresholdChangePanelState {
  if (!pending) {
    return { kind: "none" };
  }
  if (pending.kind !== PENDING_ACTION_KIND_THRESHOLD_CHANGE) {
    return { kind: "blocked-other", otherKind: pending.kind };
  }
  const availableAtSeconds = Number(pending.initiatedAt) + PENDING_ACTION_TIMELOCK_SECONDS;
  if (nowUnixSeconds >= availableAtSeconds) {
    return { kind: "ready", confirmed: pending.confirmed };
  }
  return { kind: "waiting", availableAt: new Date(availableAtSeconds * 1000), confirmed: pending.confirmed };
}

function confirmedMessage(confirmed: boolean): string {
  return confirmed
    ? "Deze wallet had bij initiate maar 1 geldige passkey - dezelfde passkey mag finalize ook " +
        "tekenen (single-passkey-degradatie, STATUS.md sectie 115/118)."
    : "Deze wallet had bij initiate al 2+ geldige passkeys - finalize vereist een ANDERE, tweede " +
        "passkey dan die initiate tekende (2-of-2, STATUS.md sectie 115/118). Dezelfde passkey " +
        "opnieuw gebruiken wordt geweigerd (SecondPasskeyMustDifferFromInitiator).";

}

function remainingLabel(availableAt: Date, now: Date): string {
  const ms = availableAt.getTime() - now.getTime();
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + "u " + minutes + "m";
}

/**
 * Verwacht drie vaste ankerpunten in index.html: #threshold-change-status
 * (leestekst), #step25-btn (finalize, disabled/enabled + label), en
 * #step25-cancel-btn (cancel_action, altijd enabled zodra er iets te
 * annuleren valt). #step24-btn (initiate) wordt hier alleen UITGESCHAKELD
 * (nooit aangezet - dat blijft main.ts's eigen "wallet geladen"-check, dit
 * paneel mag dat nooit overschrijven, alleen verder inperken zodra er al
 * een openstaande actie is).
 */
export function renderThresholdChangePanel(state: ThresholdChangePanelState, now: Date = new Date()): void {
  const statusEl = document.getElementById("threshold-change-status");
  const initiateBtn = document.getElementById("step24-btn") as HTMLButtonElement | null;
  const finalizeBtn = document.getElementById("step25-btn") as HTMLButtonElement | null;
  const cancelBtn = document.getElementById("step25-cancel-btn") as HTMLButtonElement | null;
  if (!statusEl || !initiateBtn || !finalizeBtn || !cancelBtn) return;

  if (state.kind === "none") {
    statusEl.textContent = "Geen openstaande drempelwijziging.";
    finalizeBtn.disabled = true;
    cancelBtn.disabled = true;
    return;
  }

  if (state.kind === "blocked-other") {
    statusEl.textContent =
      "Er staat een ANDERE actie in de wachtrij (kind=" + state.otherKind + ", niet ThresholdChange) " +
      "die dezelfde pending-action-plek bezet houdt - deze wallet kan maar 1 openstaande actie " +
      "tegelijk hebben. Annuleer die eerst (cancel_action werkt voor elk kind) voordat je hier een " +
      "drempelwijziging kunt starten.";
    initiateBtn.disabled = true;
    finalizeBtn.disabled = true;
    cancelBtn.disabled = false;
    return;
  }

  if (state.kind === "waiting") {
    statusEl.textContent =
      "Openstaande drempelwijziging - nog NIET beschikbaar om te finalizen. Beschikbaar vanaf " +
      state.availableAt.toLocaleString() + " (nog " + remainingLabel(state.availableAt, now) +
      " te gaan). " + confirmedMessage(state.confirmed);
    initiateBtn.disabled = true;
    finalizeBtn.disabled = true;
    cancelBtn.disabled = false;
    return;
  }

  // state.kind === "ready"
  statusEl.textContent =
    "Openstaande drempelwijziging - de 24-uurs-wachttijd is verstreken, finalize_threshold_change " +
    "kan nu aangeroepen worden. " + confirmedMessage(state.confirmed);
  initiateBtn.disabled = true;
  finalizeBtn.disabled = false;
  cancelBtn.disabled = false;
}
