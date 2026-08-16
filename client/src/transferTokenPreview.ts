import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { formatTokenAmount, parseTokenAmount, defaultTokenAmountFieldValue } from "./tokenAmount";

export interface TransferTokenPreviewChoice {
  recipientTokenAccount: PublicKey;
  amount: bigint;
}

/**
 * Menselijk-leesbare bevestigingskaart voor transfer_token - STATUS.md
 * sectie 58/59/62, eerste MIDDEN-risicoklasse-kaart (zelfde tier als
 * execute/transfer_sol uit fase 0). GEEN tone:"danger", GEEN hold-to-
 * confirm - een enkele klik, zoals het sectie-49-ontwerp voor deze klasse
 * voorschrijft.
 *
 * Het oorspronkelijke ontwerp noemde een dynamische escalatie naar zwaardere
 * frictie bij een bedrag dat groot is t.o.v. de geschiedenis van de wallet.
 * Onderzocht en BEWUST niet gebouwd (STATUS.md sectie 63 voor de volledige
 * onderbouwing, inclusief het "zero-history wallet risk"-concept uit de
 * sector): deze testclient maakt bij elke doorloop een gloednieuwe wallet
 * aan (nieuwe passkey -> nieuwe seed_key -> nieuwe WalletAccount-PDA), dus
 * er is structureel NOOIT geschiedenis om tegen af te zetten - een
 * geschiedenis-mechanisme zou hier permanent dood/onbewezen code zijn. In
 * plaats daarvan (zoals professionele risicobeoordeling ook doet bij een
 * lege geschiedenis): overschakelen op transactie-inhoud, niet op
 * geschiedenis - vandaar de nadruk hieronder op een correct leesbaar bedrag
 * (echte mint-decimals, geen gok) en een expliciet zichtbare ontvanger.
 *
 * Sinds sectie 64: bedrag-<->leesbare-eenheden-logica ontleed naar het
 * gedeelde `tokenAmount.ts` - mechanische refactor, geen gedragswijziging.
 */
export async function showTransferTokenPreview(
  connection: Connection,
  tokenMint: PublicKey,
  defaultRecipientTokenAccount: PublicKey,
  defaultAmount: bigint
): Promise<TransferTokenPreviewChoice | null> {
  // Best-effort, on-chain (het mint-account is geen externe bron - het is
  // exact het account dat deze transactie zelf al aanraakt). Lukt de fetch
  // niet (ongeldig/niet-bestaand mint-adres): eerlijk ruwe eenheden tonen,
  // nooit een verzonnen decimalenaantal.
  let decimals: number | null = null;
  try {
    const mintInfo = await getMint(connection, tokenMint);
    decimals = mintInfo.decimals;
  } catch {
    decimals = null;
  }

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: (v) => {
      const amountBytes = parseTokenAmount(v.amount, decimals);
      const amountEcho = amountBytes === null ? "(ongeldig bedrag)" : formatTokenAmount(amountBytes, decimals);
      return `
        Stuur <span class="preview-amount-echo">${escapeHtml(amountEcho)}</span><br />
        van token <span class="preview-recipient-echo">${escapeHtml(tokenMint.toBase58())}</span><br />
        naar <span class="preview-recipient-echo">${escapeHtml(v.recipient.trim() || "(geen adres ingevuld)")}</span>
      `;
    },
    fields: [
      { id: "amount", label: decimals === null ? "Bedrag (ruwe eenheden - decimals onbekend)" : "Bedrag", defaultValue: defaultTokenAmountFieldValue(defaultAmount, decimals) },
      { id: "recipient", label: "Ontvanger (token-account-adres)", defaultValue: defaultRecipientTokenAccount.toBase58() },
    ],
    validate: (raw) => {
      let recipient: PublicKey;
      try {
        recipient = new PublicKey(raw.recipient.trim());
      } catch {
        return { error: "Ongeldig Solana-adres." };
      }
      const amount = parseTokenAmount(raw.amount, decimals);
      if (amount === null) {
        return {
          error:
            decimals === null
              ? "Ongeldig bedrag - moet een geheel getal ruwe eenheden zijn (decimals van dit mint zijn onbekend)."
              : `Ongeldig bedrag - moet een getal zijn met maximaal ${decimals} decimalen.`,
        };
      }
      if (amount <= 0n) {
        return { error: "Ongeldig bedrag - moet groter dan 0 zijn." };
      }
      return { values: { recipient: recipient.toBase58(), amount: amount.toString() } };
    },
  });

  if (!result) return null;
  return {
    recipientTokenAccount: new PublicKey(result.recipient),
    amount: BigInt(result.amount),
  };
}
