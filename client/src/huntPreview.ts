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
 * laatste LAAG-risicoklasse-kaart (sluit UI-fase 1 af).
 *
 * CORRECTIE (PUNT C2, STATUS.md sectie 78): deze kaart claimde eerder dat
 * `Hunt` on-chain GEEN `recovery_state.is_none()`-constraint heeft, als
 * verklaring waarom hier bewust geen pre-flight recovery-in-progress-check
 * zit. Dat klopte tot en met FASE A, maar B4 (statische-audit-bevinding A4)
 * heeft die constraint sindsdien juist TOEGEVOEGD - hunt was destijds de
 * ENIGE passkey-gated instructie die hem miste, en juist de meest
 * onomkeerbare (verbrandt de volledige balans, geen spam-criterium). Deze
 * kaart geeft dus nu geen vroege waarschuwing voor een geval dat on-chain
 * wél wordt geweigerd (`RecoveryAlreadyInProgress`) - functioneel onschadelijk
 * (de aanroep faalt alsnog, gewoon pas on-chain in plaats van hier), maar
 * een inconsistentie t.o.v. removeSessionKeyPreview.ts/
 * removeAllowedProgramPreview.ts die dit wel pre-flight controleren. Niet
 * stilzwijgend hersteld naar "wel een pre-flight check" - dat is een
 * gedragswijziging (nieuwe `would-fail`-tak + main.ts-aanpassing), hier
 * bewust alleen de foutieve claim gecorrigeerd; zie STATUS.md sectie 78 voor
 * de open-punt-status.
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
