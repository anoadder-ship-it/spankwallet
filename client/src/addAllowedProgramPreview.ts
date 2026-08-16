import { Connection, PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { derivePolicyPda, readPolicyAccount } from "./policy";
import { SPANKWALLET_PROGRAM_ID } from "./programId";
import { knownProgramLabel } from "./knownPrograms";

export type AddAllowedProgramPreviewResult =
  | { kind: "confirmed"; programId: PublicKey }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "self-cpi" | "already-allowed" | "allowlist-full" };

const MAX_ALLOWED_PROGRAMS = 32;

/**
 * Menselijk-leesbare bevestigingskaart voor add_allowed_program - STATUS.md
 * sectie 58/59/61, vijfde en laatste HOOG-risicoklasse-kaart. Deze
 * instructie voelt zelf onschuldig aan ("een adres aan een lijst
 * toevoegen"), maar breidt daadwerkelijk uit wat execute_advanced straks
 * namens de eigenaar mag aanraken - de headline maakt dat gevolg expliciet,
 * geen understatement.
 *
 * Drie on-chain-gegarandeerde afwijzingen (instructions.rs::
 * add_allowed_program, niet aangenomen), alle drie vooraf te bepalen zonder
 * simulatie: het programma is SpankWallet zelf (SelfCpiNotAllowed), staat
 * al op de allowlist (ProgramAlreadyAllowed, punt 2 uit de afspraak - dan
 * is toevoegen zinloos, geen kaart/frictie nodig), of de allowlist zit al
 * vol (AllowlistFull). Zelfde "vroeg zichtbaar maken"-principe als de
 * vorige twee kaarten.
 */
export async function showAddAllowedProgramPreview(
  connection: Connection,
  walletPda: PublicKey,
  programId: PublicKey
): Promise<AddAllowedProgramPreviewResult> {
  if (programId.equals(SPANKWALLET_PROGRAM_ID)) {
    return { kind: "would-fail", reason: "self-cpi" };
  }

  const policyPda = derivePolicyPda(walletPda);
  const policy = await readPolicyAccount(connection, policyPda);
  const allowedPrograms = policy?.allowedPrograms ?? [];
  const count = policy?.count ?? 0;

  function isAlreadyAllowed(id: PublicKey): boolean {
    return allowedPrograms.some((p) => p.equals(id));
  }

  if (isAlreadyAllowed(programId)) {
    return { kind: "would-fail", reason: "already-allowed" };
  }
  if (count >= MAX_ALLOWED_PROGRAMS) {
    return { kind: "would-fail", reason: "allowlist-full" };
  }

  const result = await showConfirmationCard({
    eyebrow: "HOOG RISICO - breidt uit wat deze wallet mag aanraken",
    tone: "danger",
    headline: (v) => {
      const raw = v.programId.trim();
      let target: PublicKey | null = null;
      try {
        target = new PublicKey(raw);
      } catch {
        target = null;
      }
      const knownLabel = target ? knownProgramLabel(target) : undefined;
      let statusLine: string;
      if (!target) {
        statusLine = "onbekend (ongeldig adres)";
      } else if (target.equals(SPANKWALLET_PROGRAM_ID)) {
        statusLine = "NEE - dit is SpankWallet zelf, zou on-chain geweigerd worden (SelfCpiNotAllowed)";
      } else if (isAlreadyAllowed(target)) {
        statusLine = "NEE - staat al op de allowlist, deze actie zou niets veranderen";
      } else if (count >= MAX_ALLOWED_PROGRAMS) {
        statusLine = "NEE - de allowlist zit al vol (" + MAX_ALLOWED_PROGRAMS + "/" + MAX_ALLOWED_PROGRAMS + ")";
      } else {
        statusLine = "JA, kan toegevoegd worden";
      }
      return `
        Programma toevoegen aan de allowlist:<br />
        <span class="preview-recipient-echo">${escapeHtml(raw || "(geen adres ingevuld)")}</span><br />
        ${knownLabel ? "Bekend als: <strong>" + escapeHtml(knownLabel) + "</strong>" : "Onbekend programma - geen aanvullende informatie beschikbaar"}<br />
        Toevoegen mogelijk: <strong>${statusLine}</strong>
        <div class="preview-raw-dump">
          <strong>Na deze actie kan execute_advanced namens jou met dit programma
          communiceren</strong> - met welke accounts en instructiedata dan ook, zolang
          jij (of een sessiesleutel binnen zijn scope) de aanroep ondertekent. Dit
          voegt geen directe uitgave toe, maar breidt wel het aanvalsoppervlak van
          deze wallet uit.
        </div>
      `;
    },
    fields: [{ id: "programId", label: "Programma-ID (adres)", defaultValue: programId.toBase58() }],
    validate: (raw) => {
      let target: PublicKey;
      try {
        target = new PublicKey(raw.programId.trim());
      } catch {
        return { error: "Ongeldig Solana-adres." };
      }
      if (target.equals(SPANKWALLET_PROGRAM_ID)) {
        return { error: "Dit is SpankWallet zelf - zou on-chain geweigerd worden (SelfCpiNotAllowed)." };
      }
      if (isAlreadyAllowed(target)) {
        return { error: "Dit programma staat al op de allowlist - er valt niets toe te voegen." };
      }
      if (count >= MAX_ALLOWED_PROGRAMS) {
        return { error: "De allowlist zit al vol (" + MAX_ALLOWED_PROGRAMS + "/" + MAX_ALLOWED_PROGRAMS + ")." };
      }
      return { values: { programId: target.toBase58() } };
    },
    friction: "hold",
    confirmLabel: "Ingedrukt houden om toe te voegen",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", programId: new PublicKey(result.programId) };
}
