import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getMint, TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from "@solana/spl-token";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { formatTokenAmount } from "./tokenAmount";
import { INCINERATOR } from "./hunt";

export type HuntPreviewResult =
  | { kind: "confirmed"; targetTokenAccount: PublicKey; tokenMint: PublicKey }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "not-found" | "invalid-target" };

/**
 * Menselijk-leesbare bevestigingskaart voor hunt - STATUS.md sectie 73, de
 * laatste LAAG-risicoklasse-kaart (sluit UI-fase 1 af). Anders dan de meeste
 * LAAG-kaarten IS dit een instructie die on-chain zelf geen
 * `recovery_state.is_none()`-constraint heeft (instructions.rs::Hunt,
 * nagelezen, niet aangenomen) - de kaart voegt daarom bewust GEEN
 * kunstmatige recovery-in-progress-weigering toe die het echte on-chain
 * gedrag niet weerspiegelt.
 *
 * `rent_destination` is on-chain een kale, niet-vastgepinde SystemAccount,
 * maar de bestaande `buildHuntTransaction` (hunt.ts) gebruikt daar altijd
 * `payer` (de verbonden wallet zelf) voor - geen apart parameter om te
 * kiezen. Deze kaart voegt daarom GEEN nieuw bewerkbaar veld toe dat de
 * onderliggende clientfunctie niet eens ondersteunt (zelfde scope-
 * discipline als transfer_token, sectie 63).
 *
 * Doelaccount is bewust GEEN bewerkbaar veld (zelfde reden als
 * `remove_session_key`'s sessiesleutel): het is al vóór de kaart gekozen,
 * een tekstveld zou een verse RPC-call midden in de bevestiging vergen en
 * daarmee het "wat je ziet is wat je ondertekent"-snapshot-principe breken.
 * De mint wordt rechtstreeks uit het doelaccount zelf gelezen (niet als
 * apart, potentieel inconsistent caller-argument aangenomen) en in het
 * bevestigde resultaat teruggegeven, zodat de daadwerkelijk verstuurde
 * instructie nooit kan afwijken van wat de kaart toonde.
 */
export async function showHuntPreview(
  connection: Connection,
  vaultPda: PublicKey,
  targetTokenAccount: PublicKey
): Promise<HuntPreviewResult> {
  let account;
  try {
    account = await getAccount(connection, targetTokenAccount);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) {
      return { kind: "would-fail", reason: "not-found" };
    }
    throw err;
  }

  if (!account.owner.equals(vaultPda)) {
    return { kind: "would-fail", reason: "invalid-target" };
  }

  let decimals: number | null = null;
  try {
    const mintInfo = await getMint(connection, account.mint);
    decimals = mintInfo.decimals;
  } catch {
    decimals = null;
  }

  const balanceLine =
    account.amount === 0n
      ? "Saldo: <strong>0</strong> - dit account is al leeg, wordt alleen gesloten (geen burn-CPI nodig)."
      : "Saldo dat verbrand wordt: <strong>" +
        escapeHtml(formatTokenAmount(account.amount, decimals)) +
        "</strong>";

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: () => `
      Spam-token-account opruimen (hunt):<br />
      Doelaccount: <span class="preview-recipient-echo">${escapeHtml(targetTokenAccount.toBase58())}</span><br />
      Mint: <span class="preview-recipient-echo">${escapeHtml(account.mint.toBase58())}</span><br />
      ${balanceLine}<br />
      Dit token-account wordt gesloten; de teruggewonnen rent wordt 50/50 gesplitst tussen
      jou en Solana's vaste incinerator-adres (<span class="preview-recipient-echo">${escapeHtml(INCINERATOR.toBase58())}</span>, permanent uit omloop).
    `,
    fields: [],
    validate: () => ({ values: {} }),
    friction: "click",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", targetTokenAccount, tokenMint: account.mint };
}
