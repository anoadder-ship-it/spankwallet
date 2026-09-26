import { Connection, PublicKey } from "@solana/web3.js";
import {
  evaluateProgramScan,
  PENDING_ACTION_DISCRIMINATOR,
  ProgramAccountBytes,
} from "./lib/recoveryQueueInvariant";

// Leesalleen: getAccountInfo + getProgramAccounts, nooit een transactie.
//
// STATUS.md sectie 161/162: harde voorwaarde bij elke upgrade van dit
// programma, via scripts/preUpgradeChecks.ts (--pre direct vóór het
// uitvoeren, --post direct erna; zie docs/upgradevoorstel-sjabloon.md).
// Sectie 160 laat initiate_recovery de wachtrij sluiten; daardoor geldt
// "zolang recovery_state Some is, is de wachtrij leeg" voor elke recovery die
// NA de upgrade start. Toestand die de oude binary heeft achtergelaten, valt
// daar niet onder en wordt hier gecontroleerd. Tot het laatste moment draait
// de oude binary, en daaronder overleeft een wachtende actie
// initiate_recovery nog: de run vóór de upgrade alleen dekt het venster tot
// de deploy niet af.
//
// Exit-code: 0 = groen; 1 = minstens één treffer (zie
// scripts/lib/recoveryQueueInvariant.ts, fail-closed bij alles wat niet te
// verifiëren is); 2 = de controle zelf is onbetrouwbaar of faalde (o.a. een
// leeg of onvolledig RPC-antwoord, sectie 162).
//
// Een treffer is DETECTIE, geen herstel (sectie 162, review §161 L-2).
// - recovery_in_progress (een recovery die onder de oude binary startte, met
//   een wachtende actie): heeft de eigenaar alleen de backup-sleutel, dan is
//   er onder de nieuwe binary GEEN herstelpad. cancel_action vereist een
//   passkey; initiate_recovery kan niet opnieuw (recovery loopt al);
//   unfreeze_via_backup_authority weigert tijdens een recovery. Het M-1-
//   scenario blijft voor die wallet open tot de recovery is afgerond (dan
//   maakt de epoch-verhoging de actie onbruikbaar) of iemand met een passkey
//   ingrijpt. Structurele fix (cancel_recovery sluit ook de wachtrij) staat
//   genoteerd voor upgrade 2, niet in deze upgrade.
// - Alleen wie een geldige passkey van die wallet heeft, kan de actie
//   weghalen (cancel_action, geen recovery- of disarmed-constraint). Bij een
//   treffer vóór de upgrade: niet uitvoeren voordat de toestand begrepen is.
//
// Tegencontrole (sectie 162, L-3): de beoordeling gebruikt het ONGEFILTERDE
// getProgramAccounts-antwoord (wallets en PendingActions uit één
// momentopname) en eist minstens MIN_WALLET_ACCOUNTS WalletAccounts,
// evenveel VaultAccounts, en dezelfde PendingActions als een aparte,
// gefilterde aanroep. Die twee aanroepen zijn niet atomair: een verschil
// daartussen geeft exit 2, gewoon opnieuw draaien.
//
//   RPC_URL=https://api.devnet.solana.com npx ts-node --transpile-only scripts/checkRecoveryQueueInvariant.ts

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
// Aantal WalletAccounts op devnet, gemeten 2026-09-26 (sectie 161/162).
// WalletAccounts zijn niet te sluiten, dus dit is een ondergrens. Alleen
// verhogen, en alleen na een eigen meting.
const MIN_WALLET_ACCOUNTS = 19;

function toBytes(a: { pubkey: PublicKey; account: { data: Buffer; owner: PublicKey } }): ProgramAccountBytes {
  return { address: a.pubkey.toBase58(), data: a.account.data, owner: a.account.owner };
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program || !program.executable) {
    throw new Error(`programma ${PROGRAM_ID.toBase58()} niet gevonden of niet executable op ${RPC_URL}`);
  }

  const all = await connection.getProgramAccounts(PROGRAM_ID, { withContext: true });
  const filtered = await connection.getProgramAccounts(PROGRAM_ID, {
    withContext: true,
    filters: [{ memcmp: { offset: 0, encoding: "base64", bytes: PENDING_ACTION_DISCRIMINATOR.toString("base64") } }],
  });

  const result = evaluateProgramScan(
    PROGRAM_ID,
    all.value.map(toBytes),
    filtered.value.map((a) => a.pubkey.toBase58()),
    MIN_WALLET_ACCOUNTS
  );

  console.log(`RPC: ${RPC_URL} (ongefilterd op slot ${all.context.slot}, gefilterd op slot ${filtered.context.slot})`);
  console.log(`Programma-accounts: ${all.value.length}`);
  console.log(`WalletAccounts: ${result.walletCount} (minimum ${MIN_WALLET_ACCOUNTS}), VaultAccounts: ${result.vaultCount}`);
  console.log(`PendingAction-accounts: ${result.pendingCount}`);
  console.log(
    `Wallets met lopende recovery: ${result.inRecovery.length}${result.inRecovery.length ? " - " + result.inRecovery.join(", ") : ""}`
  );

  if (result.violations.length > 0) {
    console.log(`ROOD: ${result.violations.length} treffer(s):`);
    for (const v of result.violations) {
      console.log(`  - pending_action ${v.pendingAction}, wallet ${v.wallet ?? "?"}: ${v.reasons.join(" + ")} (${v.detail})`);
    }
  }
  if (result.censusProblems.length > 0) {
    console.log(`CONTROLE ONBETROUWBAAR: ${result.censusProblems.length} tellingsprobleem/-problemen:`);
    for (const p of result.censusProblems) console.log(`  - ${p}`);
  }
  if (result.violations.length > 0) return 1;
  if (result.censusProblems.length > 0) return 2;
  console.log("GROEN: geen PendingAction bij een wallet met een lopende recovery, geen afwijkende epoch, telling consistent.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("Controle mislukt:", err);
    process.exit(2);
  }
);
