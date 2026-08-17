import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { showConfirmationCard, escapeHtml, ConfirmationCardField } from "./confirmationCard";
import { formatTokenAmount, parseTokenAmount, defaultTokenAmountFieldValue } from "./tokenAmount";
import { formatDurationEstimate } from "./slotDuration";

const LAMPORT_DECIMALS = 9; // 1 SOL = 10^9 lamports - wiskundig identiek aan een token met 9 decimalen

export interface AddSessionKeyPreviewParams {
  connection: Connection;
  currentSlot: bigint;
  defaultDurationSlots: bigint;
  canExecute: boolean;
  canTransferToken: boolean;
  canExecuteAdvanced: boolean;
  sessionAllowedPrograms: PublicKey[];
  tokenMint: PublicKey;
  defaultMaxLamportsPerTx: bigint;
  defaultMaxLamportsTotal: bigint;
  defaultMaxTokenAmountPerTx: bigint;
  defaultMaxTokenAmountTotal: bigint;
}

export interface AddSessionKeyPreviewChoice {
  expirySlot: bigint;
  maxLamportsPerTx: bigint;
  maxLamportsTotal: bigint;
  maxTokenAmountPerTx: bigint;
  maxTokenAmountTotal: bigint;
}

/**
 * Menselijk-leesbare bevestigingskaart voor add_session_key - STATUS.md
 * sectie 58/59/64, laatste MIDDEN-risicoklasse-kaart. Het risico van deze
 * instructie is BEGRENSD door de caps die hier zelf ingesteld worden
 * (spend-limits-ontwerpdocument, sectie 53) - vandaar dat de caps de
 * headline zijn, niet een detail, en waarom dit MIDDEN blijft (geen
 * hold-to-confirm) i.p.v. HOOG: een sessie kan nooit meer doen dan wat hier
 * expliciet wordt toegestaan.
 *
 * Scope (canExecute/canTransferToken/canExecuteAdvanced + de execute_
 * advanced-sub-allowlist) is een VASTE, door de aanroepende code
 * voorafingestelde beslissing - geen bewerkbaar veld hier (dat zou een
 * hele nieuwe klasse UI - een scope-editor - zijn, buiten deze kaart se
 * scope). Wel altijd expliciet getoond, INCLUSIEF wat NIET is toegestaan -
 * geen understatement door iets stilzwijgend weg te laten.
 */
export async function showAddSessionKeyPreview(
  params: AddSessionKeyPreviewParams
): Promise<AddSessionKeyPreviewChoice | null> {
  const {
    connection,
    currentSlot,
    defaultDurationSlots,
    canExecute,
    canTransferToken,
    canExecuteAdvanced,
    sessionAllowedPrograms,
    tokenMint,
    defaultMaxLamportsPerTx,
    defaultMaxLamportsTotal,
    defaultMaxTokenAmountPerTx,
    defaultMaxTokenAmountTotal,
  } = params;

  // Alleen opvragen als de sessie uberhaupt token-scope heeft - geen
  // onnodige RPC-call voor een sessie die toch geen tokens mag versturen.
  let tokenDecimals: number | null = null;
  if (canTransferToken) {
    try {
      const mintInfo = await getMint(connection, tokenMint);
      tokenDecimals = mintInfo.decimals;
    } catch {
      tokenDecimals = null;
    }
  }

  const fields: ConfirmationCardField[] = [
    { id: "durationSlots", label: "Geldigheidsduur (aantal slots)", defaultValue: defaultDurationSlots.toString() },
  ];
  if (canExecute) {
    fields.push(
      { id: "maxLamportsPerTx", label: "Max. per transactie (SOL)", defaultValue: defaultTokenAmountFieldValue(defaultMaxLamportsPerTx, LAMPORT_DECIMALS) },
      { id: "maxLamportsTotal", label: "Max. totaal (SOL)", defaultValue: defaultTokenAmountFieldValue(defaultMaxLamportsTotal, LAMPORT_DECIMALS) }
    );
  }
  if (canTransferToken) {
    fields.push(
      { id: "maxTokenAmountPerTx", label: "Max. per transactie (token)", defaultValue: defaultTokenAmountFieldValue(defaultMaxTokenAmountPerTx, tokenDecimals) },
      { id: "maxTokenAmountTotal", label: "Max. totaal (token)", defaultValue: defaultTokenAmountFieldValue(defaultMaxTokenAmountTotal, tokenDecimals) }
    );
  }

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: (v) => {
      const durationSlots = /^\d+$/.test(v.durationSlots.trim()) ? BigInt(v.durationSlots.trim()) : null;
      const durationLine =
        durationSlots === null
          ? "(ongeldige duur)"
          : `${durationSlots} slots (${formatDurationEstimate(durationSlots)})`;

      let capsLines = "";
      if (canExecute) {
        const perTx = parseTokenAmount(v.maxLamportsPerTx, LAMPORT_DECIMALS);
        const total = parseTokenAmount(v.maxLamportsTotal, LAMPORT_DECIMALS);
        capsLines += `
          <br />Max. per transactie: <span class="preview-amount-echo">${perTx === null ? "(ongeldig)" : escapeHtml(formatTokenAmount(perTx, LAMPORT_DECIMALS)) + " SOL"}</span>
          <br />Max. totaal: <span class="preview-amount-echo">${total === null ? "(ongeldig)" : escapeHtml(formatTokenAmount(total, LAMPORT_DECIMALS)) + " SOL"}</span>`;
      }
      if (canTransferToken) {
        const perTx = parseTokenAmount(v.maxTokenAmountPerTx, tokenDecimals);
        const total = parseTokenAmount(v.maxTokenAmountTotal, tokenDecimals);
        capsLines += `
          <br />Max. per transactie (token): <span class="preview-amount-echo">${perTx === null ? "(ongeldig)" : escapeHtml(formatTokenAmount(perTx, tokenDecimals))}</span>
          <br />Max. totaal (token): <span class="preview-amount-echo">${total === null ? "(ongeldig)" : escapeHtml(formatTokenAmount(total, tokenDecimals))}</span>
          <br />Token-mint: <span class="preview-recipient-echo">${escapeHtml(tokenMint.toBase58())}</span>`;
      }

      const scopeLines = `
        <div class="preview-raw-dump">
          Execute (SOL versturen): <strong>${canExecute ? "JA" : "NEE"}</strong><br />
          Token versturen: <strong>${canTransferToken ? "JA" : "NEE"}</strong><br />
          execute_advanced (extern programma aanroepen): <strong>${canExecuteAdvanced ? "JA" : "NEE"}</strong>
          ${canExecuteAdvanced ? "<br />Toegestane programma's: " + escapeHtml(sessionAllowedPrograms.map((p) => p.toBase58()).join(", ") || "(geen)") : ""}
        </div>`;

      return `
        Nieuwe sessiesleutel registreren, geldig voor ${durationLine}:${capsLines}
        ${scopeLines}
      `;
    },
    fields,
    validate: (raw) => {
      if (!/^\d+$/.test(raw.durationSlots.trim())) {
        return { error: "Ongeldige duur - moet een positief geheel getal (aantal slots) zijn." };
      }
      const durationSlots = BigInt(raw.durationSlots.trim());
      if (durationSlots <= 0n) {
        return { error: "Ongeldige duur - moet groter dan 0 zijn." };
      }

      const values: Record<string, string> = { durationSlots: durationSlots.toString() };

      if (canExecute) {
        const perTx = parseTokenAmount(raw.maxLamportsPerTx, LAMPORT_DECIMALS);
        const total = parseTokenAmount(raw.maxLamportsTotal, LAMPORT_DECIMALS);
        if (perTx === null || total === null) {
          return { error: "Ongeldige SOL-cap - moet een getal zijn met maximaal 9 decimalen (0 is geldig: betekent letterlijk nul toegestaan)." };
        }
        values.maxLamportsPerTx = perTx.toString();
        values.maxLamportsTotal = total.toString();
      }
      if (canTransferToken) {
        const perTx = parseTokenAmount(raw.maxTokenAmountPerTx, tokenDecimals);
        const total = parseTokenAmount(raw.maxTokenAmountTotal, tokenDecimals);
        if (perTx === null || total === null) {
          return {
            error:
              tokenDecimals === null
                ? "Ongeldige token-cap - moet een geheel getal ruwe eenheden zijn (decimals van dit mint zijn onbekend)."
                : `Ongeldige token-cap - moet een getal zijn met maximaal ${tokenDecimals} decimalen (0 is geldig: betekent letterlijk nul toegestaan).`,
          };
        }
        values.maxTokenAmountPerTx = perTx.toString();
        values.maxTokenAmountTotal = total.toString();
      }

      return { values };
    },
  });

  if (!result) return null;

  return {
    expirySlot: currentSlot + BigInt(result.durationSlots),
    maxLamportsPerTx: canExecute ? BigInt(result.maxLamportsPerTx) : 0n,
    maxLamportsTotal: canExecute ? BigInt(result.maxLamportsTotal) : 0n,
    maxTokenAmountPerTx: canTransferToken ? BigInt(result.maxTokenAmountPerTx) : 0n,
    maxTokenAmountTotal: canTransferToken ? BigInt(result.maxTokenAmountTotal) : 0n,
  };
}
