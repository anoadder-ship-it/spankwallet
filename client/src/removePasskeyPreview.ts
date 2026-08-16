import { Connection, PublicKey } from "@solana/web3.js";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";
import { derivePasskeysPda, readPasskeysAccount } from "./passkeys";
import { bytesToHex, hexToBytes } from "./hex";

const PASSKEY_LEN = 33;

export type RemovePasskeyPreviewResult =
  | { kind: "confirmed"; targetPasskeyBytes: Uint8Array }
  | { kind: "denied" }
  | { kind: "would-fail"; reason: "last-passkey" | "target-not-registered" };

/**
 * Menselijk-leesbare bevestigingskaart voor remove_passkey - STATUS.md
 * sectie 58/59, vierde HOOG-risicoklasse-kaart. In tegenstelling tot
 * add_passkey (dat altijd risico TOEVOEGT) is dit een instructie met een
 * gemengd risicoprofiel: de VEILIGE richting is toegang intrekken van een
 * verloren/gecompromitteerd apparaat, maar de VERKEERDE sleutel intrekken
 * is moeilijk terug te draaien (opnieuw toevoegen vereist een nog-geldige
 * sleutel om te ondertekenen) - vandaar nog steeds hold-to-confirm/danger,
 * ondanks de "beschermende" framing.
 *
 * Kernprincipe (afgesproken, on-chain nagelezen in instructions.rs::
 * remove_passkey, niet aangenomen): de lockout-bescherming
 * (CannotRemoveLastPasskey) en de "bestaat deze sleutel uberhaupt"-check
 * (PasskeyNotRegistered) zijn BEIDE vooraf, zonder simulatie, te bepalen
 * uit het al bestaande readPasskeysAccount() + de huidige owner_passkey-
 * bytes (die de aanroeper al lokaal kent - er is geen on-chain leesfunctie
 * voor owner_passkey zelf, dat staat in WalletAccount, niet PasskeysAccount).
 * Zelfde "vroeg zichtbaar maken"-principe als execute_advanced's
 * not-allowed-pad: geen kaart, geen hold-to-confirm-frictie, geen
 * passkey-prompt voor een aanroep die toch al gegarandeerd zou falen.
 */
export async function showRemovePasskeyPreview(
  connection: Connection,
  walletPda: PublicKey,
  ownerPasskeyBytes: Uint8Array,
  targetPasskeyBytes: Uint8Array
): Promise<RemovePasskeyPreviewResult> {
  const passkeysPda = derivePasskeysPda(walletPda);
  const passkeys = await readPasskeysAccount(connection, passkeysPda);

  // Geen PasskeysAccount -> remove_passkey heeft geen init_if_needed, zou
  // sowieso al falen op Anchors eigen accountdeserialisatie (zie
  // instructions.rs's toelichting bij RemovePasskey).
  if (!passkeys) {
    return { kind: "would-fail", reason: "target-not-registered" };
  }

  const ownerActive = !passkeys.ownerPasskeyRevoked;
  const totalBefore = (ownerActive ? 1 : 0) + passkeys.count;

  function isRegistered(target: Uint8Array): boolean {
    const targetHex = bytesToHex(target);
    if (ownerActive && bytesToHex(ownerPasskeyBytes) === targetHex) return true;
    return passkeys!.additionalPasskeys.some((p) => bytesToHex(p) === targetHex);
  }

  if (!isRegistered(targetPasskeyBytes)) {
    return { kind: "would-fail", reason: "target-not-registered" };
  }
  if (totalBefore <= 1) {
    return { kind: "would-fail", reason: "last-passkey" };
  }

  const totalAfter = totalBefore - 1;

  const result = await showConfirmationCard({
    eyebrow: "HOOG RISICO - trekt toegang tot deze wallet in",
    tone: "danger",
    headline: (v) => {
      const raw = v.targetPasskeyHex.trim();
      const bytes = hexToBytes(raw);
      const valid = bytes !== null && bytes.length === PASSKEY_LEN;
      const registered = valid && isRegistered(bytes!);
      const statusText = !valid
        ? "onbekend (ongeldige hex-invoer)"
        : registered
          ? `JA - blijft na deze actie over: ${totalAfter} van de ${totalBefore} huidige geldige sleutel(s)`
          : "NEE - is geen geldig geregistreerde sleutel, zou on-chain geweigerd worden";
      return `
        Sleutel intrekken (verliest volledig toegang tot deze wallet):<br />
        <span class="preview-recipient-echo">${escapeHtml(raw || "(geen sleutel ingevuld)")}</span><br />
        Momenteel geregistreerd en geldig: <strong>${statusText}</strong>
      `;
    },
    fields: [
      { id: "targetPasskeyHex", label: `Sleutel om in te trekken (${PASSKEY_LEN} bytes, hex)`, defaultValue: bytesToHex(targetPasskeyBytes) },
    ],
    validate: (raw) => {
      const bytes = hexToBytes(raw.targetPasskeyHex);
      if (!bytes) {
        return { error: "Ongeldige hex-invoer - alleen 0-9/a-f, even aantal tekens." };
      }
      if (bytes.length !== PASSKEY_LEN) {
        return {
          error: `Moet exact ${PASSKEY_LEN} bytes zijn (${PASSKEY_LEN * 2} hex-tekens), kreeg ${bytes.length}.`,
        };
      }
      if (!isRegistered(bytes)) {
        return { error: "Deze sleutel is niet (meer) geregistreerd - zou on-chain geweigerd worden." };
      }
      return { values: { targetPasskeyHex: bytesToHex(bytes) } };
    },
    friction: "hold",
    confirmLabel: "Ingedrukt houden om in te trekken",
  });

  if (!result) return { kind: "denied" };
  return { kind: "confirmed", targetPasskeyBytes: hexToBytes(result.targetPasskeyHex)! };
}
