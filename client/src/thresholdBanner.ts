/**
 * STATUS.md sectie 127/128/129 (stap A, Route 2): niet-blokkerende
 * indicator voor spend_threshold_lamports. Twee delen, bewust gescheiden:
 *
 * 1. thresholdBannerState() - PURE functie, geen DOM, geen import van
 *    "document" - bepaalt WAT getoond moet worden gegeven de huidige
 *    drempel. Apart getest (tests/thresholdBanner.ts) zonder validator of
 *    DOM nodig te hebben.
 * 2. renderThresholdBanner() - de DOM-effectkant. Getest in datzelfde
 *    tests/thresholdBanner.ts tegen een jsdom-gesimuleerde DOM (geen
 *    validator nodig, wel een echte browser-DOM-implementatie) - wire dit
 *    één keer aan nadat de wallet geladen is.
 *
 * BEWUST GEEN link/knop naar initiate_threshold_change: die instructie
 * heeft vandaag geen client-flow (geen knop, geen CLI-route, geen
 * admin-paginaroute - alleen bewezen tegen een validator in
 * tests/pendingAction.ts). Een knop die naar niets leidt zou precies het
 * soort overclaim zijn dat deze banner juist moet vermijden.
 */

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Leesbare SOL-weergave, geen precisie-overclaim - toont alleen zoveel
 * decimalen als daadwerkelijk niet-nul zijn, geen afronding die een
 * bedrag zou kunnen laten lijken alsof het "rond" was terwijl het dat
 * niet is. */
export function formatSolExact(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return whole.toString() + "." + fracStr;
}

export interface ThresholdBannerState {
  /** true = drempel op 0 (fail-safe default), de dismissible nudge-banner
   * hoort getoond te worden. false = een drempel is al actief, alleen de
   * altijd-zichtbare statusregel is relevant. */
  showNudge: boolean;
  /** Korte statusregel, ALTIJD relevant (punt 4: een eigenaar die niet
   * weet wat zijn drempel is, kan een weigering niet beoordelen) -
   * onafhankelijk van showNudge, apart te renderen. */
  statusLine: string;
  /** Alleen relevant als showNudge true is. */
  nudgeHeadline: string;
  nudgeBody: string;
}

const SCOPE_DISCLAIMER =
  "Dit dekt uitsluitend SOL via execute/hunt. transfer_token en execute_advanced blijven " +
  "altijd direct, ongeacht deze drempel (STATUS.md sectie 127, punt 3 - nog niet besloten). " +
  "Een cumulatieve limiet over meerdere transacties (de \"glijdende-vensterlimiet\") bestaat " +
  "nog niet (stap B, nog niet gebouwd).";

/**
 * STATUS.md sectie 127 punt 3: BEWUST geen voorgestelde richtwaarde. Een
 * concreet bedrag suggereert een autoriteit die er niet is ("waarom
 * juist dit bedrag?") - dit systeem kent de eigenaar se daadwerkelijke
 * gebruikspatroon niet, en een verkeerd gekozen suggestie zou zelf als
 * een impliciete aanbeveling gelezen kunnen worden. De eigenaar kiest
 * zelf, zonder gesuggereerd anker.
 */
export function thresholdBannerState(spendThresholdLamports: bigint): ThresholdBannerState {
  if (spendThresholdLamports === 0n) {
    return {
      showNudge: true,
      statusLine: "Instant-drempel: geen (0) - elk SOL-bedrag via execute/hunt gaat direct door.",
      nudgeHeadline: "Geen bestedingsdrempel ingesteld",
      nudgeBody:
        "SOL-overdrachten via execute/hunt gaan vandaag direct door, ongeacht bedrag, zonder " +
        "wachttijd. Een drempel instellen dwingt bedragen ERBOVEN door een 24-uurs wachtrij " +
        "(initiate_withdrawal/finalize_withdrawal) - bedragen erop of eronder blijven direct " +
        "gaan. " +
        SCOPE_DISCLAIMER +
        " Dit testpagina biedt nog geen knop om een drempel te zetten - " +
        "initiate_threshold_change/finalize_threshold_change zijn bewezen tegen een echte " +
        "validator (STATUS.md sectie 125/128) maar hebben nog geen client-ingang.",
    };
  }
  return {
    showNudge: false,
    statusLine:
      "Instant-drempel: " +
      formatSolExact(spendThresholdLamports) +
      " SOL - bedragen erboven vereisen de wachtrij. " +
      SCOPE_DISCLAIMER,
    nudgeHeadline: "",
    nudgeBody: "",
  };
}

/**
 * DOM-effectkant - getest tegen jsdom in tests/thresholdBanner.ts.
 * Verwacht twee vaste ankerpunten in index.html: #threshold-status
 * (altijd zichtbaar, punt 4) en #threshold-nudge (dismissible, punt 1).
 * Idempotent: opnieuw aanroepen (bijv. na een ander step-1-herstart)
 * overschrijft de vorige staat i.p.v. te stapelen.
 */
export function renderThresholdBanner(spendThresholdLamports: bigint): void {
  const state = thresholdBannerState(spendThresholdLamports);

  const statusEl = document.getElementById("threshold-status");
  if (statusEl) {
    statusEl.textContent = state.statusLine;
  }

  const nudgeRoot = document.getElementById("threshold-nudge");
  if (!nudgeRoot) return;
  nudgeRoot.innerHTML = "";
  if (!state.showNudge) return;

  const banner = document.createElement("div");
  banner.className = "threshold-nudge-banner";
  banner.innerHTML = `
    <button type="button" class="threshold-nudge-dismiss" aria-label="Sluiten">&times;</button>
    <div class="threshold-nudge-headline"></div>
    <div class="threshold-nudge-body"></div>
  `;
  banner.querySelector<HTMLElement>(".threshold-nudge-headline")!.textContent = state.nudgeHeadline;
  banner.querySelector<HTMLElement>(".threshold-nudge-body")!.textContent = state.nudgeBody;
  banner.querySelector<HTMLButtonElement>(".threshold-nudge-dismiss")!.addEventListener("click", () => {
    nudgeRoot.innerHTML = "";
  });
  nudgeRoot.appendChild(banner);
}
