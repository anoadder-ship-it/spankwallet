/**
 * Gedeeld primitief voor menselijk-leesbare bevestigingskaarten - 1:1
 * overgenomen van client/src/confirmationCard.ts (de browser-app), zie
 * STATUS.md / Tauri-migratie-ontwerp. Bewust een eigen kopie i.p.v. een
 * cross-package-import: desktop/ en client/ zijn losse projecten (aparte
 * package.json/Vite-build), geen gedeelde build-pipeline.
 *
 * Enige toevoeging t.o.v. het origineel: een optioneel `type`-veld per
 * ConfirmationCardField (default "text", ongewijzigd gedrag) - nodig voor
 * de fee-payer-wachtwoordkaarten (`type: "password"`), die als enige in
 * deze app een niet-zichtbaar invoerveld nodig hebben.
 *
 * STATUS.md sectie 196: escapeHtml escapet alle vijf de HTML-tekens (ook `"`
 * en `'`), zodat hij ook in een attribuutwaarde veilig is. De velden van de
 * kaart worden, net als in de client, met DOM-functies opgebouwd
 * (`textContent` en `.value`), nooit via innerHTML.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConfirmationCardField {
  id: string;
  label: string;
  defaultValue: string;
  type?: "text" | "password";
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
  headline: (rawValues: Record<string, string>) => string;
  fields: ConfirmationCardField[];
  validate: (rawValues: Record<string, string>) => ConfirmationCardValidateResult;
  denyLabel?: string;
  confirmLabel?: string;
  friction?: "click" | "hold";
  holdDurationMs?: number;
  tone?: "default" | "danger";
}

const DEFAULT_HOLD_DURATION_MS = 1800;

export function showConfirmationCard(
  options: ShowConfirmationCardOptions
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const previewRoot = document.getElementById("preview-root");
    if (!previewRoot) {
      resolve(null);
      return;
    }
    const root: HTMLElement = previewRoot;

    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = options.tone === "danger" ? "preview-card preview-card-danger" : "preview-card";

    const friction = options.friction ?? "click";
    const holdDurationMs = options.holdDurationMs ?? DEFAULT_HOLD_DURATION_MS;
    const confirmBtnClass = friction === "hold" ? "preview-btn preview-confirm preview-confirm-hold" : "preview-btn preview-confirm";
    const confirmBtnInner =
      friction === "hold"
        ? `<span class="preview-hold-fill" id="preview-hold-fill"></span><span class="preview-hold-label">${options.confirmLabel ?? "Ingedrukt houden om te bevestigen"}</span>`
        : (options.confirmLabel ?? "Bevestig en teken");

    // Velden (STATUS.md sectie 196): het geraamte hieronder is vaste opmaak
    // zonder enige variabele inhoud, met dezelfde witruimte als voorheen, zodat
    // de opgebouwde kaart gelijk blijft. Label, id, type en beginwaarde worden
    // daarna met DOM-functies gezet (textContent, htmlFor, id, .value), zoals
    // in client/src/confirmationCard.ts: ze worden nooit als HTML gelezen, dus
    // een `"` in een beginwaarde kan niet uit een attribuut breken.
    const fieldsHtml = options.fields
      .map(
        () => `
      <div class="preview-field">
        <label class="preview-label"></label>
        <input class="preview-input" autocomplete="off" spellcheck="false" />
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
        <button type="button" class="${confirmBtnClass}" id="preview-confirm-btn">${confirmBtnInner}</button>
      </div>
    `;
    root.appendChild(card);

    const fieldEls = Array.from(card.children).filter((el) => el.classList.contains("preview-field"));
    options.fields.forEach((f, i) => {
      const labelEl = fieldEls[i].querySelector<HTMLLabelElement>("label")!;
      labelEl.htmlFor = `preview-input-${f.id}`;
      labelEl.textContent = f.label;

      const inputEl = fieldEls[i].querySelector<HTMLInputElement>("input")!;
      inputEl.id = `preview-input-${f.id}`;
      inputEl.type = f.type ?? "text";
      // defaultValue zet het value-attribuut, zoals de oude opmaak deed; .value
      // de getoonde waarde. Geen van beide wordt als HTML gelezen.
      inputEl.defaultValue = f.defaultValue;
      inputEl.value = f.defaultValue;
    });

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
      const fillEl = card.querySelector<HTMLElement>("#preview-hold-fill")!;
      let holdTimer: number | null = null;
      let holdStartedAt = 0;

      function startHold() {
        if (holdTimer !== null) return;
        holdStartedAt = Date.now();
        fillEl.style.transitionDuration = holdDurationMs + "ms";
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
          e.preventDefault();
          startHold();
        }
      });
      confirmBtn.addEventListener("keyup", (e) => {
        if (e.key === "Enter" || e.key === " ") cancelHold();
      });
    }
  });
}
