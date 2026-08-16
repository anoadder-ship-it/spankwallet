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
}

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
    card.className = "preview-card";

    const fieldsHtml = options.fields
      .map(
        (f) => `
      <div class="preview-field">
        <label class="preview-label" for="preview-input-${f.id}">${f.label}</label>
        <input id="preview-input-${f.id}" class="preview-input" type="text" value="${f.defaultValue}" autocomplete="off" spellcheck="false" />
      </div>`
      )
      .join("");

    card.innerHTML = `
      <div class="preview-eyebrow">${options.eyebrow}</div>
      <div class="preview-headline" id="preview-headline"></div>
      ${fieldsHtml}
      <div class="preview-error" id="preview-error"></div>
      <div class="preview-actions">
        <button type="button" class="preview-btn preview-deny" id="preview-deny-btn">${options.denyLabel ?? "Weiger"}</button>
        <button type="button" class="preview-btn preview-confirm" id="preview-confirm-btn">${options.confirmLabel ?? "Bevestig en teken"}</button>
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

    card.querySelector("#preview-confirm-btn")!.addEventListener("click", () => {
      errorEl.textContent = "";
      const result = options.validate(currentRawValues());
      if ("error" in result) {
        errorEl.textContent = result.error;
        return;
      }
      cleanup();
      resolve(result.values);
    });
  });
}
