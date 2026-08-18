import { invoke } from "@tauri-apps/api/core";
import { showConfirmationCard } from "./confirmationCard";

// Zelfde verplichte UX-tekst als feePayerSetupCard.ts - herhaald hier,
// niet alleen bij de allereerste keer getoond (Tauri-migratie-ontwerp,
// Stronghold-deelplan punt 3's expliciete eis).
const FEE_PAYER_EXPLANATION = `
  Dit sleuteltje betaalt alleen de kleine netwerkkosten voor je transacties -
  het kan <strong>NOOIT</strong> geld uit je wallet verplaatsen, want elke
  actie vereist alsnog jouw echte passkey-handtekening. Zelfs als dit
  sleuteltje ooit gestolen wordt, kan een aanvaller er niets anders mee dan
  het kleine saldo erin verliezen.
`;

interface FeePayerInfo {
  pubkeyBase58: string;
}

/**
 * Ontgrendel-kaart: getoond bij elke volgende app-start (fee_payer_exists()
 * === true). Bij een verkeerd wachtwoord (WrongPasswordOrCorrupt) blijft de
 * kaart gewoon opnieuw verschijnen - geen pogingslimiet in fase 0, zie het
 * technisch plan (het enige wat op het spel staat is het kleine
 * fee-payer-saldo).
 */
export async function showFeePayerUnlockCard(): Promise<string> {
  while (true) {
    const result = await showConfirmationCard({
      eyebrow: "Ontgrendelen",
      headline: () => `
        Voer je wachtwoord in om je fee-payer-sleuteltje te ontgrendelen<br />
        ${FEE_PAYER_EXPLANATION}
      `,
      fields: [{ id: "password", label: "Wachtwoord", defaultValue: "", type: "password" }],
      validate: (raw) => {
        if (raw.password.length === 0) {
          return { error: "Voer een wachtwoord in." };
        }
        return { values: { password: raw.password } };
      },
      confirmLabel: "Ontgrendelen",
      denyLabel: "Ontgrendelen",
    });

    if (!result) continue;

    try {
      const info = await invoke<FeePayerInfo>("unlock_fee_payer", { password: result.password });
      return info.pubkeyBase58;
    } catch (err: any) {
      const kind = err?.kind;
      const message =
        kind === "WrongPasswordOrCorrupt"
          ? "Verkeerd wachtwoord (of een beschadigd snapshot-bestand) - probeer opnieuw."
          : typeof err?.message === "string"
            ? err.message
            : JSON.stringify(err);
      await showConfirmationCard({
        eyebrow: "Ontgrendelen mislukt",
        headline: () => message,
        fields: [],
        validate: () => ({ values: {} }),
        confirmLabel: "Opnieuw proberen",
        denyLabel: "Opnieuw proberen",
      });
    }
  }
}
