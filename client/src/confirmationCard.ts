/**
 * Gedeeld primitief voor menselijk-leesbare bevestigingskaarten (STATUS.md
 * sectie 49/50, fase 1) - ontleed uit `executePreview.ts` (fase 0) zodat
 * elke instructie-specifieke kaart (execute, add_passkey, ...) dezelfde
 * DOM-/gedragslogica hergebruikt i.p.v. hem te kopiëren. Deze module weet
 * niets over specifieke instructies (geen "bedrag"/"ontvanger"-concepten) -
 * elke aanroeper levert zijn eigen velden, headline-markup en validatie.
 *
 * Contract, ongewijzigd t.o.v. fase 0: de kaart wordt getoond, wacht op een
 * EXPLICIETE "Bevestig"-klik, en pas DAARNA mag de aanroeper een
 * passkey-ceremonie starten. Bij "Weiger" of een ongeldige invoer gebeurt
 * er niets on-chain.
 */
// Headline-HTML wordt via innerHTML ingevoegd (voor live-echo-spans) -
// aanroepers die gebruikersinvoer in de headline echoën MOETEN die eerst
// hierdoorheen halen, anders is getypte HTML/scripttekens een
// opmaak-injectiegat (zie STATUS.md sectie 58 - eerder gevonden en
// gefixt in executePreview.ts, hier gedeeld zodat elke volgende kaart
// hem niet zelf hoeft te herimplementeren of te vergeten).
export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export interface ConfirmationCardField {
  id: string;
  label: string;
  defaultValue: string;
}

export interface ConfirmationCardValidateOk {
  values: Record<string, string>;
}
export interface ConfirmationCardValidateError {
  error: string;
}
export type ConfirmationCardValidateResult = ConfirmationCardValidateOk | ConfirmationCardValidateError;

export interface ShowConfirmationCardOptions {
  eyebrow: string;
  /** Geeft de innerHTML voor de headline terug, gegeven de HUIDIGE (nog niet
   * gevalideerde) veldwaarden - opnieuw aangeroepen bij elke invoerwijziging
   * zodat de headline live meeloopt (zelfde live-echo-gedrag als fase 0). */
  headline: (rawValues: Record<string, string>) => string;
  fields: ConfirmationCardField[];
  validate: (rawValues: Record<string, string>) => ConfirmationCardValidateResult;
  denyLabel?: string;
  confirmLabel?: string;
  /** "click" (default, fase 0-gedrag) of "hold" - voor HOOG-risicoklasse-
   * acties (STATUS.md sectie 58/fase 1: sleutelbeheer, allowlist-uitbreiding,
   * execute_advanced) waar een enkele per-ongeluk-klik niet de bedoelde
   * drempel is. Bij "hold" moet de knop ~holdDurationMs ingedrukt gehouden
   * worden (muis, touch, of Enter/Spatie) - loslaten vóór die tijd annuleert
   * zonder enig effect, geen halve/gedeeltelijke bevestiging mogelijk. */
  friction?: "click" | "hold";
  holdDurationMs?: number;
  /** "default" of "danger" - puur visueel (STATUS.md sectie 58/fase 1's
   * risicoklassen): "danger" geeft de kaart een rode accentrand zodat een
   * HOOG-risico-actie er ook op het eerste gezicht anders uitziet dan een
   * gewone MIDDEN/LAAG-kaart, los van de hold-vs-click-frictie zelf. */
  tone?: "default" | "danger";
}

const DEFAULT_HOLD_DURATION_MS = 1800;

export function showConfirmationCard(
  options: ShowConfirmationCardOptions
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const previewRoot = document.getElementById("preview-root");
    if (!previewRoot) {
      // Geen ankerpunt gevonden - bewust GEEN stille fallback die de
      // bevestigingsstap overslaat (dat zou precies de bescherming
      // omzeilen die deze kaart moet bieden). De aanroeper ziet de
      // afwijzing en kan dat zelf loggen/afhandelen.
      resolve(null);
      return;
    }
    const root: HTMLElement = previewRoot;

    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = options.tone === "danger" ? "preview-card preview-card-danger" : "preview-card";

    const fieldsHtml = options.fields
      .map(
        (f) => `
      <div class="preview-field">
        <label class="preview-label" for="preview-input-${f.id}">${f.label}</label>
        <input id="preview-input-${f.id}" class="preview-input" type="text" value="${f.defaultValue}" autocomplete="off" spellcheck="false" />
      </div>`
      )
      .join("");

    const friction = options.friction ?? "click";
    const holdDurationMs = options.holdDurationMs ?? DEFAULT_HOLD_DURATION_MS;
    const confirmBtnClass = friction === "hold" ? "preview-btn preview-confirm preview-confirm-hold" : "preview-btn preview-confirm";
    const confirmBtnInner =
      friction === "hold"
        ? `<span class="preview-hold-fill" id="preview-hold-fill"></span><span class="preview-hold-label">${options.confirmLabel ?? "Ingedrukt houden om te bevestigen"}</span>`
        : (options.confirmLabel ?? "Bevestig en teken");

    card.innerHTML = `
      <div class="preview-eyebrow">${options.eyebrow}</div>
      <div class="preview-headline" id="preview-headline"></div>
      ${fieldsHtml}
      <div class="preview-error" id="preview-error"></div>
      <div class="preview-actions">
        <button type="button" class="preview-btn preview-deny" id="preview-deny-btn">${options.denyLabel ?? "Weiger"}</button>
        <button type="button" class="${confirmBtnClass}" id="preview-confirm-btn">${confirmBtnInner}</button>
      </div>
    `;
    root.appendChild(card);

    const headlineEl = card.querySelector<HTMLElement>("#preview-headline")!;
    const errorEl = card.querySelector<HTMLElement>("#preview-error")!;
    const inputs = options.fields.map(
      (f) => card.querySelector<HTMLInputElement>(`#preview-input-${f.id}`)!
    );

    function currentRawValues(): Record<string, string> {
      const raw: Record<string, string> = {};
      options.fields.forEach((f, i) => {
        raw[f.id] = inputs[i].value;
      });
      return raw;
    }

    function updateHeadline() {
      headlineEl.innerHTML = options.headline(currentRawValues());
    }
    updateHeadline();
    inputs.forEach((input) => input.addEventListener("input", updateHeadline));

    function cleanup() {
      root.innerHTML = "";
    }

    card.querySelector("#preview-deny-btn")!.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });

    function attemptConfirm() {
      errorEl.textContent = "";
      const result = options.validate(currentRawValues());
      if ("error" in result) {
        errorEl.textContent = result.error;
        return;
      }
      cleanup();
      resolve(result.values);
    }

    const confirmBtn = card.querySelector<HTMLButtonElement>("#preview-confirm-btn")!;

    if (friction === "click") {
      confirmBtn.addEventListener("click", attemptConfirm);
    } else {
      // Hold-to-confirm: geen enkele losse klik/toets mag ooit bevestigen -
      // alleen het VOLLEDIG uitzitten van holdDurationMs telt. Loslaten,
      // de cursor wegslepen, of de knop verliezen (blur) annuleert altijd
      // zonder gedeeltelijk effect - er is geen tussenstap die per ongeluk
      // als bevestiging geinterpreteerd kan worden.
      const fillEl = card.querySelector<HTMLElement>("#preview-hold-fill")!;
      let holdTimer: number | null = null;
      let holdStartedAt = 0;

      function startHold() {
        if (holdTimer !== null) return; // al bezig - geen dubbele timer bij herhaalde keydown-repeats
        holdStartedAt = Date.now();
        fillEl.style.transitionDuration = holdDurationMs + "ms";
        // Force reflow zodat de browser de 0%-startstaat echt toepast
        // voordat de transitie naar 100% begint (anders wordt de eerste
        // aanroep soms stilzwijgend samengevoegd en springt de vulling
        // meteen naar 100% i.p.v. te animeren).
        void fillEl.offsetWidth;
        fillEl.style.width = "100%";
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          attemptConfirm();
        }, holdDurationMs);
      }

      function cancelHold() {
        if (holdTimer === null && Date.now() - holdStartedAt > holdDurationMs) return;
        if (holdTimer !== null) {
          window.clearTimeout(holdTimer);
          holdTimer = null;
        }
        fillEl.style.transitionDuration = "150ms";
        fillEl.style.width = "0%";
      }

      confirmBtn.addEventListener("pointerdown", startHold);
      confirmBtn.addEventListener("pointerup", cancelHold);
      confirmBtn.addEventListener("pointerleave", cancelHold);
      confirmBtn.addEventListener("pointercancel", cancelHold);
      confirmBtn.addEventListener("blur", cancelHold);
      confirmBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // voorkomt dat Spatie ALSNOG een click-event triggert na keyup
          startHold();
        }
      });
      confirmBtn.addEventListener("keyup", (e) => {
        if (e.key === "Enter" || e.key === " ") cancelHold();
      });
    }
  });
}
