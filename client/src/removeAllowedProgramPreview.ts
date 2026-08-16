import { Connection, PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { derivePolicyPda, readPolicyAccount } from "./policy";
import { knownProgramLabel } from "./knownPrograms";

export type RemoveAllowedProgramPreviewResult =
  | { kind: "confirmed"; programId: PublicKey }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "not-allowed" };

/**
 * Menselijk-leesbare bevestigingskaart voor remove_allowed_program -
 * STATUS.md sectie 58/59/66, eerste LAAG-risicoklasse-kaart: deze
 * instructie BEPERKT alleen (trekt een eerder toegestaan CPI-doel weer in)
 * - de veilige richting, net als `remove_session_key`/`cancel_recovery`
 * verderop. `friction: "click"`, geen `tone:"danger"`.
 *
 * Enige on-chain-gegarandeerde afwijzing (instructions.rs::
 * remove_allowed_program, niet aangenomen): het adres staat niet in
 * `allowed_programs` (`ProgramNotAllowed`) - dat geldt ook als er nog
 * nooit een `PolicyAccount` bestaan heeft (geen `init_if_needed` op deze
 * instructie, zelfde patroon als `remove_passkey`). Vooraf te bepalen
 * zonder simulatie - zelfde "vroeg zichtbaar maken"-principe als de
 * HOOG-klasse-kaarten: geen kaart/frictie voor een verwijdering die toch
 * al niets zou veranderen.
 */
export async function showRemoveAllowedProgramPreview(
  connection: Connection,
  walletPda: PublicKey,
  programId: PublicKey
): Promise<RemoveAllowedProgramPreviewResult> {
  const policyPda = derivePolicyPda(walletPda);
  const policy = await readPolicyAccount(connection, policyPda);
  const allowedPrograms = policy?.allowedPrograms ?? [];

  function isAllowed(id: PublicKey): boolean {
    return allowedPrograms.some((p) => p.equals(id));
  }

  if (!isAllowed(programId)) {
    return { kind: "would-fail", reason: "not-allowed" };
  }

  const result = await showConfirmationCard({
    eyebrow: "Voorstel om te ondertekenen",
    headline: (v) => {
      const raw = v.programId.trim();
      let target: PublicKey | null = null;
      try {
        target = new PublicKey(raw);
      } catch {
        target = null;
      }
      const knownLabel = target ? knownProgramLabel(target) : undefined;
      const statusLine = !target
        ? "onbekend (ongeldig adres)"
        : isAllowed(target)
          ? "JA, kan verwijderd worden"
          : "NEE - staat niet (meer) op de allowlist, deze actie zou niets veranderen";
      return `
        Programma verwijderen van de allowlist:<br />
        <span class="preview-recipient-echo">${escapeHtml(raw || "(geen adres ingevuld)")}</span><br />
        ${knownLabel ? "Bekend als: <strong>" + escapeHtml(knownLabel) + "</strong>" : "Onbekend programma - geen aanvullende informatie beschikbaar"}<br />
        Verwijderen mogelijk: <strong>${statusLine}</strong><br />
        <strong>execute_advanced kan dit programma na deze actie niet meer aanroepen.</strong>
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
      if (!isAllowed(target)) {
        return { error: "Dit programma staat niet (meer) op de allowlist - er valt niets te verwijderen." };
      }
      return { values: { programId: target.toBase58() } };
    },
    friction: "click",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", programId: new PublicKey(result.programId) };
}
