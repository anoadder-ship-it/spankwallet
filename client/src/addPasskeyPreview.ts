import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { bytesToHex, hexToBytes } from "./hex";

const PASSKEY_LEN = 33;

export interface AddPasskeyPreviewChoice {
  newPasskeyBytes: Uint8Array;
}

/**
 * Menselijk-leesbare bevestigingskaart voor add_passkey - STATUS.md sectie
 * 58/fase 1, eerste HOOG-risicoklasse-kaart. Deze instructie verleent een
 * NIEUWE sleutel volledige, gelijkwaardige toegang tot de wallet (dezelfde
 * rechten als elke andere geregistreerde passkey) - vandaar hold-to-confirm
 * i.p.v. een enkele klik, en de "danger"-tone (STATUS.md sectie 49's
 * oplopende-frictie-ontwerp).
 *
 * Zelfde contract als executePreview.ts: geen enkele
 * navigator.credentials.get()-aanroep gebeurt hier - dat blijft aan
 * buildAddPasskeyTransaction() in passkeys.ts, pas aangeroepen NA een
 * expliciete, volledig uitgezeten bevestiging.
 *
 * Het hex-veld is bewust bewerkbaar (zelfde "wat je ziet is wat je
 * ondertekent"-principe als het bedragveld bij execute): de teruggegeven
 * bytes - niet per se de oorspronkelijk meegegeven newPasskeyBytes - zijn
 * wat de aanroeper daadwerkelijk moet gebruiken bij het bouwen van de
 * transactie, zodat de kaart nooit iets anders bevestigt dan wat
 * uiteindelijk ondertekend wordt.
 */
export async function showAddPasskeyPreview(
  newPasskeyBytes: Uint8Array
): Promise<AddPasskeyPreviewChoice | null> {
  const defaultHex = bytesToHex(newPasskeyBytes);

  const result = await showConfirmationCard({
    eyebrow: "HOOG RISICO - wijzigt wie toegang heeft tot deze wallet",
    tone: "danger",
    headline: (v) => `
      Nieuwe sleutel toevoegen - krijgt VOLLEDIGE, gelijkwaardige toegang
      tot deze wallet (zelfde rechten als je bestaande sleutel(s)):<br />
      <span class="preview-recipient-echo">${escapeHtml(v.newPasskeyHex.trim() || "(geen sleutel ingevuld)")}</span>
    `,
    fields: [
      { id: "newPasskeyHex", label: `Nieuwe sleutel (${PASSKEY_LEN} bytes, hex)`, defaultValue: defaultHex },
    ],
    validate: (raw) => {
      const bytes = hexToBytes(raw.newPasskeyHex);
      if (!bytes) {
        return { error: "Ongeldige hex-invoer - alleen 0-9/a-f, even aantal tekens." };
      }
      if (bytes.length !== PASSKEY_LEN) {
        return {
          error: `Moet exact ${PASSKEY_LEN} bytes zijn (${PASSKEY_LEN * 2} hex-tekens), kreeg ${bytes.length}.`,
        };
      }
      return { values: { newPasskeyHex: bytesToHex(bytes) } };
    },
    friction: "hold",
    confirmLabel: "Ingedrukt houden om toe te voegen",
  });

  if (!result) return null;
  return { newPasskeyBytes: hexToBytes(result.newPasskeyHex)! };
}
