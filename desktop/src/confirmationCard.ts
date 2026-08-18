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
 */
export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
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

    const fieldsHtml = options.fields
      .map(
        (f) => `
      <div class="preview-field">
        <label class="preview-label" for="preview-input-${f.id}">${f.label}</label>
        <input id="preview-input-${f.id}" class="preview-input" type="${f.type ?? "text"}" value="${f.defaultValue}" autocomplete="off" spellcheck="false" />
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
