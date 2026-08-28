import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { readWalletAccount } from "./recovery";
import { deriveSessionPda, readSessionKeyAccount } from "./sessionKeys";
import { formatTokenAmount } from "./tokenAmount";
import { formatDurationEstimate, estimateSlotMs } from "./slotDuration";

const LAMPORT_DECIMALS = 9; // 1 SOL = 10^9 lamports - wiskundig identiek aan een token met 9 decimalen

export type RemoveSessionKeyPreviewResult =
  | { kind: "confirmed" }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "not-found" | "recovery-in-progress" };

/**
 * Menselijk-leesbare bevestigingskaart voor remove_session_key - STATUS.md
 * sectie 58/59/67, tweede LAAG-risicoklasse-kaart: dit trekt alleen in
 * (versmalt bevoegdheid, verbreedt nooit) - de veilige richting, net als
 * `remove_allowed_program`. `friction: "click"`, geen `tone:"danger"`.
 *
 * Twee on-chain-gegarandeerde afwijzingen (instructions.rs::
 * RemoveSessionKey, niet aangenomen), beide vooraf te bepalen zonder
 * simulatie:
 * - de sessie bestaat niet (meer): geen `init_if_needed` op `session`, seeds
 *   verwijzen naar `session.bump` zelf - zelfde patroon als
 *   `remove_passkey`/`remove_allowed_program`.
 * - er loopt een recovery (`wallet.recovery_state.is_none()`-constraint) -
 *   een constraint die op ELKE passkey-ondertekende instructie in dit
 *   programma staat, hier voor het eerst als pre-flight-check meegenomen.
 *
 * Wie mag intrekken (nagelezen in `verify_passkey_signature_multi`, niet
 * aangenomen): elke actieve passkey van de eigenaar (owner OF additional,
 * mits niet ingetrokken) - GEEN restrictie tot wie de sessie oorspronkelijk
 * aanmaakte.
 *
 * De sessiesleutel zelf is bewust GEEN bewerkbaar veld (in tegenstelling tot
 * `remove_allowed_program`/`remove_passkey`): die twee valideren een getypt
 * doel tegen een al-opgehaalde LIJST binnen één singleton-account, maar een
 * sessie is een aparte PDA per sleutel - een ander getypt adres zou een
 * verse RPC-call binnen de synchrone `validate()` vergen en daarmee het
 * "wat je ziet is wat je ondertekent"-snapshot-principe breken. De kaart is
 * daarom puur informatief/read-only (`fields: []`).
 */
export async function showRemoveSessionKeyPreview(
  connection: Connection,
  walletPda: PublicKey,
  sessionKeyPubkey: PublicKey
): Promise<RemoveSessionKeyPreviewResult> {
  const wallet = await readWalletAccount(connection, walletPda);
  if (wallet.recoveryState) {
    return { kind: "would-fail", reason: "recovery-in-progress" };
  }

  const sessionPda = deriveSessionPda(walletPda, sessionKeyPubkey);
  const session = await readSessionKeyAccount(connection, sessionPda);
  if (!session) {
    return { kind: "would-fail", reason: "not-found" };
  }

  const currentSlot = BigInt(await connection.getSlot());
  const remainingSlots = session.expirySlot - currentSlot;
  // STATUS.md sectie 103: live gemeten i.p.v. een hardcoded aanname.
  const slotMsEstimate = await estimateSlotMs(connection);
  const durationLine =
    remainingSlots <= 0n
      ? "al verlopen (kan nog steeds ingetrokken/opgeruimd worden)"
      : `nog ${remainingSlots} slot(s) geldig (${formatDurationEstimate(remainingSlots, slotMsEstimate)})`;

  // Alleen opvragen als de sessie uberhaupt token-scope heeft - geen
  // onnodige RPC-call voor een sessie die toch geen tokens mag versturen.
  let tokenDecimals: number | null = null;
  if (session.canTransferToken) {
    try {
      const mintInfo = await getMint(connection, session.tokenMint);
      tokenDecimals = mintInfo.decimals;
    } catch {
      tokenDecimals = null;
    }
  }

  const remainingLamports = session.maxLamportsTotal - session.spentLamports;
  const remainingTokenAmount = session.maxTokenAmountTotal - session.spentTokenAmount;

  let capsLines = "";
  if (session.canExecute) {
    capsLines += `
      <br />Resterend budget (SOL, totaal): <span class="preview-amount-echo">${escapeHtml(formatTokenAmount(remainingLamports, LAMPORT_DECIMALS))} SOL</span>
      <br />Max. per transactie: <span class="preview-amount-echo">${escapeHtml(formatTokenAmount(session.maxLamportsPerTx, LAMPORT_DECIMALS))} SOL</span>`;
  }
  if (session.canTransferToken) {
    capsLines += `
      <br />Resterend budget (token, totaal): <span class="preview-amount-echo">${escapeHtml(formatTokenAmount(remainingTokenAmount, tokenDecimals))}</span>
      <br />Max. per transactie (token): <span class="preview-amount-echo">${escapeHtml(formatTokenAmount(session.maxTokenAmountPerTx, tokenDecimals))}</span>
      <br />Token-mint: <span class="preview-recipient-echo">${escapeHtml(session.tokenMint.toBase58())}</span>`;
  }

  const scopeLines = `
    <div class="preview-raw-dump">
      Execute (SOL versturen): <strong>${session.canExecute ? "JA" : "NEE"}</strong><br />
      Token versturen: <strong>${session.canTransferToken ? "JA" : "NEE"}</strong><br />
      execute_advanced (extern programma aanroepen): <strong>${session.canExecuteAdvanced ? "JA" : "NEE"}</strong>
      ${session.canExecuteAdvanced ? "<br />Toegestane programma's: " + escapeHtml(session.allowedPrograms.map((p) => p.toBase58()).join(", ") || "(geen)") : ""}
      ${session.canExecuteAdvanced ? '<br /><strong>Let op: het getoonde resterende budget hierboven gold NOOIT voor execute_advanced_via_session - een CPI naar een toegestaan programma kent geen spend-cap (STATUS.md sectie 53). Deze sessie kon dus meer dan de caps alleen suggereren.</strong>' : ""}
    </div>`;

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: () => `
      Sessiesleutel intrekken (verliest per direct alle onderstaande bevoegdheid):<br />
      <span class="preview-recipient-echo">${escapeHtml(sessionKeyPubkey.toBase58())}</span><br />
      Geldigheid: <strong>${durationLine}</strong>${capsLines}
      ${scopeLines}
    `,
    fields: [],
    validate: () => ({ values: {} }),
    friction: "click",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed" };
}
