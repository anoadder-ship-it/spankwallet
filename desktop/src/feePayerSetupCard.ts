import { invoke } from "@tauri-apps/api/core";
import { showConfirmationCard, escapeHtml } from "./confirmationCard";

// Verplichte UX-tekst (Tauri-migratie-ontwerp, Stronghold-deelplan punt 3) -
// vertaling van de instructions.rs-verificatie (STATUS.md) naar mensentaal.
// Herhaald in feePayerUnlockCard.ts - niet alleen bij de allereerste keer.
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
 * Eenmalige setup-kaart: gebruiker kiest een wachtwoord voor de lokale
 * Stronghold-fee-payer-vault. Bij bevestigen wordt het keypair aangemaakt
 * (setup_fee_payer) en de publieke sleutel getoond zodat de gebruiker weet
 * welk adres hij met devnet-SOL moet funden voor transactiekosten.
 */
export async function showFeePayerSetupCard(): Promise<string> {
  while (true) {
    const result = await showConfirmationCard({
      eyebrow: "Eenmalige installatie",
      headline: () => `
        Kies een wachtwoord voor je lokale fee-payer-sleuteltje<br />
        ${FEE_PAYER_EXPLANATION}
      `,
      fields: [
        { id: "password", label: "Wachtwoord", defaultValue: "", type: "password" },
        { id: "passwordConfirm", label: "Wachtwoord (nogmaals)", defaultValue: "", type: "password" },
      ],
      validate: (raw) => {
        if (raw.password.length < 8) {
          return { error: "Wachtwoord moet minstens 8 tekens zijn." };
        }
        if (raw.password !== raw.passwordConfirm) {
          return { error: "De twee wachtwoorden komen niet overeen." };
        }
        return { values: { password: raw.password } };
      },
      confirmLabel: "Aanmaken",
      denyLabel: "Later",
    });

    if (!result) {
      // "Later" geeft geen zinvolle app-toestand hier - de rest van de UI
      // heeft een ontgrendelde fee-payer nodig. Toon de kaart opnieuw i.p.v.
      // de gebruiker met een kapotte, halfklare app achter te laten.
      continue;
    }

    const info = await invoke<FeePayerInfo>("setup_fee_payer", { password: result.password });
    await showFeePayerFundingCard(info.pubkeyBase58);
    return info.pubkeyBase58;
  }
}

async function showFeePayerFundingCard(pubkeyBase58: string): Promise<void> {
  // "Bevestig" = airdrop aanvragen, "Weiger" = zelf funden - allebei
  // legitieme, gelijkwaardige vervolgstappen, geen echte weigering (het
  // confirm/deny-primitief geeft hier gewoon de enige twee knoppen die de
  // showConfirmationCard-primitief ondersteunt).
  const result = await showConfirmationCard({
    eyebrow: "Fee-payer aangemaakt",
    headline: () => `
      Stuur wat devnet-SOL naar dit adres om transactiekosten te dekken:<br />
      <span class="preview-recipient-echo">${escapeHtml(pubkeyBase58)}</span>
    `,
    fields: [],
    validate: () => ({ values: {} }),
    confirmLabel: "Vraag devnet-airdrop aan",
    denyLabel: "Ik fund zelf",
  });

  if (result) {
    try {
      const signature = await invoke<string>("request_fee_payer_airdrop");
      await showConfirmationCard({
        eyebrow: "Airdrop aangevraagd",
        headline: () => `Signature:<br /><span class="preview-recipient-echo">${escapeHtml(signature)}</span>`,
        fields: [],
        validate: () => ({ values: {} }),
        confirmLabel: "Doorgaan",
        denyLabel: "Doorgaan",
      });
    } catch (err: any) {
      // Rust-commands geven bij een fout de geserialiseerde foutenum terug
      // ({kind, message}), geen JS Error-object.
      const message = typeof err?.message === "string" ? err.message : JSON.stringify(err);
      await showConfirmationCard({
        eyebrow: "Airdrop mislukt",
        headline: () => escapeHtml(message),
        fields: [],
        validate: () => ({ values: {} }),
        confirmLabel: "Doorgaan",
        denyLabel: "Doorgaan",
      });
    }
  }
}
