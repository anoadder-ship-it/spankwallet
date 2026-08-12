import { PublicKey } from "@solana/web3.js";

export interface ExecutePreviewChoice {
  recipient: PublicKey;
  amountLamports: bigint;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Menselijk-leesbare bevestigingskaart voor execute (SOL versturen) - fase 0
 * van STATUS.md sectie 49/50: een technisch geldige handtekening beschermt
 * niemand als de ondertekenaar niet begrijpt waarvoor hij tekent. Toont
 * bedrag + ontvanger in gewone taal en wacht op een EXPLICIETE bevestiging
 * VOORDAT de aanroeper de passkey-ceremonie start - geen enkele
 * navigator.credentials.get()-aanroep gebeurt hier, dat blijft aan
 * buildExecuteTransaction() in execute.ts.
 *
 * Bewust NIET meegenomen (zie het ontwerpvoorstel): risicoklassen,
 * geschiedenis-check, identiconbeeld - dat is fase 1. Dit is uitsluitend
 * bedrag + ontvanger in mensentaal, de kleinste testbare stap.
 */
export function showExecutePreview(
  defaultRecipient: PublicKey,
  defaultAmountLamports: bigint
): Promise<ExecutePreviewChoice | null> {
  return new Promise((resolve) => {
    const previewRoot = document.getElementById("preview-root");
    if (!previewRoot) {
      // Geen ankerpunt in de HTML gevonden - val terug op de oude,
      // ongewijzigde aanname i.p.v. de hele teststap te breken.
      resolve({ recipient: defaultRecipient, amountLamports: defaultAmountLamports });
      return;
    }
    // Als const opnieuw gebonden zodat TypeScript de null-check ook binnen
    // de onderstaande, later-uitgevoerde event-listener-closures onthoudt -
    // die kunnen in theorie ná een eventuele hertoewijzing van `previewRoot`
    // draaien, dus TS vernauwt het type daar niet automatisch.
    const root: HTMLElement = previewRoot;

    const defaultSol = (Number(defaultAmountLamports) / Number(LAMPORTS_PER_SOL)).toString();

    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "preview-card";
    card.innerHTML = `
      <div class="preview-eyebrow">Voorstel om te ondertekenen</div>
      <div class="preview-headline">
        Stuur <span class="preview-amount-echo">${defaultSol}</span> SOL<br />
        naar <span class="preview-recipient-echo">${defaultRecipient.toBase58()}</span>
      </div>
      <div class="preview-field">
        <label class="preview-label" for="preview-amount-input">Bedrag (SOL)</label>
        <input id="preview-amount-input" class="preview-input" type="text" inputmode="decimal" value="${defaultSol}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="preview-field">
        <label class="preview-label" for="preview-recipient-input">Ontvanger (adres)</label>
        <input id="preview-recipient-input" class="preview-input" type="text" value="${defaultRecipient.toBase58()}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="preview-error" id="preview-error"></div>
      <div class="preview-actions">
        <button type="button" class="preview-btn preview-deny" id="preview-deny-btn">Weiger</button>
        <button type="button" class="preview-btn preview-confirm" id="preview-confirm-btn">Bevestig en teken</button>
      </div>
    `;
    root.appendChild(card);

    const amountInput = card.querySelector<HTMLInputElement>("#preview-amount-input")!;
    const recipientInput = card.querySelector<HTMLInputElement>("#preview-recipient-input")!;
    const amountEcho = card.querySelector<HTMLElement>(".preview-amount-echo")!;
    const recipientEcho = card.querySelector<HTMLElement>(".preview-recipient-echo")!;
    const errorEl = card.querySelector<HTMLElement>("#preview-error")!;

    function updateEcho() {
      amountEcho.textContent = amountInput.value.trim() || "0";
      recipientEcho.textContent = recipientInput.value.trim() || "(geen adres ingevuld)";
    }
    amountInput.addEventListener("input", updateEcho);
    recipientInput.addEventListener("input", updateEcho);

    function cleanup() {
      root.innerHTML = "";
    }

    card.querySelector("#preview-deny-btn")!.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });

    card.querySelector("#preview-confirm-btn")!.addEventListener("click", () => {
      errorEl.textContent = "";

      let recipient: PublicKey;
      try {
        recipient = new PublicKey(recipientInput.value.trim());
      } catch {
        errorEl.textContent = "Ongeldig Solana-adres.";
        return;
      }

      const solValue = Number(amountInput.value.trim().replace(",", "."));
      if (!Number.isFinite(solValue) || solValue <= 0) {
        errorEl.textContent = "Ongeldig bedrag - moet een getal groter dan 0 zijn.";
        return;
      }

      const amountLamports = BigInt(Math.round(solValue * Number(LAMPORTS_PER_SOL)));
      cleanup();
      resolve({ recipient, amountLamports });
    });
  });
}
