import { Connection, PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { derivePolicyPda, readPolicyAccount } from "./policy";
import { RemainingAccountSpec } from "./executeAdvanced";

export type ExecuteAdvancedPreviewResult =
  | { kind: "confirmed"; cpiProgramId: PublicKey }
  | { kind: "denied" }
  | { kind: "not-allowed"; cpiProgramId: PublicKey };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Menselijk-leesbare bevestigingskaart voor execute_advanced - STATUS.md
 * sectie 58/59, tweede HOOG-risicoklasse-kaart en de moeilijkste van de
 * reeks: de CPI-instructiedata is ondoorzichtig en kan NIET naar mensentaal
 * vertaald worden (in tegenstelling tot execute/transfer_token, waar bedrag
 * en ontvanger de volledige betekenis van de transactie AL zijn). Kern-
 * principe, expliciet afgesproken: geen verzonnen samenvatting van wat de
 * CPI "waarschijnlijk" doet. De enige harde, betrouwbare feiten die we
 * hebben zijn (1) het doelprogramma-ID en (2) of dat programma
 * daadwerkelijk op de wallet-eigen allowlist (PolicyAccount) staat - dat
 * wordt de headline. De ruwe accounts/instructiedata worden WEL getoond,
 * met een expliciete, eerlijke waarschuwing dat dit niet verder te
 * interpreteren is.
 *
 * De allowlist-check gebeurt VOORDAT er enige kaart/frictie getoond wordt:
 * een niet-toegestaan programma zou toch on-chain geweigerd worden
 * (bestaande, ongewijzigde bescherming - zie main.ts stap 9a voor het
 * losstaande on-chain-bewijs daarvan) - dan heeft het geen zin de
 * gebruiker door de hold-to-confirm-frictie te laten gaan voor een
 * gegarandeerde afwijzing. Zie main.ts voor hoe elk van de drie
 * uitkomsten hier gelogd wordt.
 */
export async function showExecuteAdvancedPreview(
  connection: Connection,
  walletPda: PublicKey,
  cpiProgramId: PublicKey,
  remainingAccounts: RemainingAccountSpec[],
  cpiInstructionData: Uint8Array
): Promise<ExecuteAdvancedPreviewResult> {
  const policyPda = derivePolicyPda(walletPda);
  const policy = await readPolicyAccount(connection, policyPda);
  const allowedPrograms = policy?.allowedPrograms ?? [];
  const isAllowed = (id: PublicKey) => allowedPrograms.some((p) => p.equals(id));

  if (!isAllowed(cpiProgramId)) {
    return { kind: "not-allowed", cpiProgramId };
  }

  const accountsDump =
    remainingAccounts.length === 0
      ? "(geen accounts)"
      : remainingAccounts
          .map((a) => `${a.pubkey.toBase58()} (writable=${a.isWritable}, signer=${a.isSigner})`)
          .join("\n");
  const dataHex = bytesToHex(cpiInstructionData);

  const result = await showConfirmationCard({
    eyebrow: "HOOG RISICO - ondoorzichtige aanroep naar een extern programma",
    tone: "danger",
    headline: (v) => {
      const raw = v.cpiProgramId.trim();
      let target: PublicKey | null = null;
      try {
        target = new PublicKey(raw);
      } catch {
        target = null;
      }
      const allowlistStatus =
        target === null
          ? "onbekend (ongeldig adres)"
          : isAllowed(target)
            ? "JA"
            : "NEE - zou on-chain geweigerd worden";
      return `
        Aanroep naar extern programma:<br />
        <span class="preview-recipient-echo">${escapeHtml(raw || "(geen programma-ID ingevuld)")}</span><br />
        Staat op de allowlist van deze wallet: <strong>${allowlistStatus}</strong>
        <div class="preview-raw-dump">
          <strong>SpankWallet kan de onderstaande ruwe data NIET naar mensentaal vertalen -
          controleer zelf, via de bron van deze aanroep, wat dit programma hiermee gaat
          doen.</strong>
          <br /><br />
          Accounts (${remainingAccounts.length}):<br />
          ${escapeHtml(accountsDump).replace(/\n/g, "<br />")}
          <br /><br />
          Instructiedata (${cpiInstructionData.length} bytes, hex):<br />
          ${escapeHtml(dataHex) || "(leeg)"}
        </div>
      `;
    },
    fields: [{ id: "cpiProgramId", label: "Doelprogramma (adres)", defaultValue: cpiProgramId.toBase58() }],
    validate: (raw) => {
      let target: PublicKey;
      try {
        target = new PublicKey(raw.cpiProgramId.trim());
      } catch {
        return { error: "Ongeldig Solana-adres." };
      }
      if (!isAllowed(target)) {
        return { error: "Dit programma staat niet op de allowlist - zou on-chain geweigerd worden." };
      }
      return { values: { cpiProgramId: target.toBase58() } };
    },
    friction: "hold",
    confirmLabel: "Ingedrukt houden om te bevestigen",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", cpiProgramId: new PublicKey(result.cpiProgramId) };
}
