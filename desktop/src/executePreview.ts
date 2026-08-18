import { PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";

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
 * Sinds fase 1 (sectie 58+): DOM-/gedragslogica ontleend naar het gedeelde
 * `confirmationCard.ts`-primitief - dit bestand bevat nu alleen nog de
 * execute-specifieke velden/validatie/headline. Gedrag bewust ONGEWIJZIGD
 * t.o.v. fase 0 (mechanische refactor).
 *
 * Bewust NIET meegenomen (zie het ontwerpvoorstel): risicoklassen,
 * geschiedenis-check, identiconbeeld - dat is fase 1 voor de OVERIGE
 * instructies (execute zelf blijft MIDDEN-frictie, gelijk aan fase 0).
 */
export async function showExecutePreview(
  defaultRecipient: PublicKey,
  defaultAmountLamports: bigint
): Promise<ExecutePreviewChoice | null> {
  const defaultSol = (Number(defaultAmountLamports) / Number(LAMPORTS_PER_SOL)).toString();

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: (v) => `
      Stuur <span class="preview-amount-echo">${escapeHtml(v.amount.trim() || "0")}</span> SOL<br />
      naar <span class="preview-recipient-echo">${escapeHtml(v.recipient.trim() || "(geen adres ingevuld)")}</span>
    `,
    fields: [
      { id: "amount", label: "Bedrag (SOL)", defaultValue: defaultSol },
      { id: "recipient", label: "Ontvanger (adres)", defaultValue: defaultRecipient.toBase58() },
    ],
    validate: (raw) => {
      let recipient: PublicKey;
      try {
        recipient = new PublicKey(raw.recipient.trim());
      } catch {
        return { error: "Ongeldig Solana-adres." };
      }
      const solValue = Number(raw.amount.trim().replace(",", "."));
      if (!Number.isFinite(solValue) || solValue <= 0) {
        return { error: "Ongeldig bedrag - moet een getal groter dan 0 zijn." };
      }
      return { values: { recipient: recipient.toBase58(), amount: raw.amount } };
    },
  });

  if (!result) return null;

  const solValue = Number(result.amount.trim().replace(",", "."));
  return {
    recipient: new PublicKey(result.recipient),
    amountLamports: BigInt(Math.round(solValue * Number(LAMPORTS_PER_SOL))),
  };
}
