import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_RPC_URL, exitUnlessDevnet } from "./lib/devnetCluster";
import {
  contextSlotProblems,
  decodeProgramAccount,
  decodeProgramDataHeader,
  postReferenceProblem,
  PROGRAM_DATA_HEADER_LEN,
} from "./lib/programDeploySlot";
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
// Cluster en versheid (sectie 167, review §162 M-1/M-2), vóór de scan:
// - de genesis-hash moet die van devnet zijn (exit 2 anders); RPC_URL kan
//   dus een andere devnet-node kiezen, nooit een lokale test-validator. De
//   hash komt van de RPC zelf: geen absolute garantie tegen een simulator
//   die devnet forkt (review §167 L-2, zie scripts/lib/devnetCluster.ts);
// - referentieslot: bij --pre de last_deploy_slot uit de ProgramData, bij
//   --post de slot van de uitvoertransactie (EXECUTE_SIGNATURE), die gelijk
//   moet zijn aan de last_deploy_slot die dezelfde node teruggeeft. Beide
//   getProgramAccounts-aanroepen moeten daarna gelezen zijn (minContextSlot,
//   en hun context.slot wordt zelf nagekeken); anders exit 2. Zo dekt --post
//   aantoonbaar het venster tot en met de deploy. --pre is daarmee alleen
//   begrensd tot na de vorige deploy: een node die daarna achterloopt, wordt
//   door --pre niet herkend. --pre garandeert dus GEEN verse staat; de echte
//   versheidsgarantie is --post (review §167 L-1, STATUS.md sectie 168).
//
//   npx ts-node --transpile-only scripts/checkRecoveryQueueInvariant.ts --pre
//   EXECUTE_SIGNATURE=<handtekening van de uitvoertransactie> npx ts-node --transpile-only scripts/checkRecoveryQueueInvariant.ts --post

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const RPC_URL = process.env.RPC_URL ?? DEVNET_RPC_URL;
// Aantal WalletAccounts op devnet, gemeten 2026-09-26 (sectie 161/162).
// WalletAccounts zijn niet te sluiten, dus dit is een ondergrens. Alleen
// verhogen, en alleen na een eigen meting.
const MIN_WALLET_ACCOUNTS = 19;

function toBytes(a: { pubkey: PublicKey; account: { data: Buffer; owner: PublicKey } }): ProgramAccountBytes {
  return { address: a.pubkey.toBase58(), data: a.account.data, owner: a.account.owner };
}

function unreliable(message: string): never {
  console.log(`CONTROLE ONBETROUWBAAR: ${message}`);
  process.exit(2);
}

/** De slot waarna de gelezen staat moet liggen (zie het commentaar bovenaan). */
async function referenceSlot(connection: Connection, mode: "--pre" | "--post"): Promise<bigint> {
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program) unreliable(`programma ${PROGRAM_ID.toBase58()} niet gevonden op ${RPC_URL}`);
  const programData = decodeProgramAccount(program.data, program.owner, program.executable);
  if (typeof programData === "string") unreliable(`programma ${PROGRAM_ID.toBase58()}: ${programData}`);
  const header = await connection.getAccountInfo(programData, { dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER_LEN } });
  if (!header) unreliable(`ProgramData ${programData.toBase58()} niet gevonden`);
  const decoded = decodeProgramDataHeader(header.data, header.owner);
  if (typeof decoded === "string") unreliable(`ProgramData ${programData.toBase58()}: ${decoded}`);
  console.log(`ProgramData ${programData.toBase58()}: last_deploy_slot ${decoded.lastDeploySlot}`);
  if (mode === "--pre") return decoded.lastDeploySlot;

  const signature = process.env.EXECUTE_SIGNATURE;
  if (!signature) unreliable("--post vereist EXECUTE_SIGNATURE (de handtekening van de uitvoertransactie)");
  const { value: status } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  const problem = postReferenceProblem(decoded.lastDeploySlot, status);
  if (problem) unreliable(problem);
  console.log(`Uitvoertransactie ${signature}: slot ${status!.slot}, ${status!.confirmationStatus}, gelijk aan last_deploy_slot`);
  return decoded.lastDeploySlot;
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "--pre" && mode !== "--post")) {
    unreliable("gebruik: checkRecoveryQueueInvariant.ts --pre | --post (precies één van beide)");
  }
  const connection = new Connection(RPC_URL, "confirmed");
  await exitUnlessDevnet(connection, RPC_URL);
  const reference = await referenceSlot(connection, mode);
  const minContextSlot = Number(reference) + 1;

  const all = await connection.getProgramAccounts(PROGRAM_ID, { withContext: true, minContextSlot });
  const filtered = await connection.getProgramAccounts(PROGRAM_ID, {
    withContext: true,
    minContextSlot,
    filters: [{ memcmp: { offset: 0, encoding: "base64", bytes: PENDING_ACTION_DISCRIMINATOR.toString("base64") } }],
  });
  const stale = contextSlotProblems(reference, [
    { label: "ongefilterde getProgramAccounts", slot: all.context.slot },
    { label: "gefilterde getProgramAccounts", slot: filtered.context.slot },
  ]);
  if (stale.length > 0) unreliable(stale.join("; "));

  const result = evaluateProgramScan(
    PROGRAM_ID,
    all.value.map(toBytes),
    filtered.value.map((a) => a.pubkey.toBase58()),
    MIN_WALLET_ACCOUNTS
  );

  console.log(`RPC: ${RPC_URL} (${mode}, referentieslot ${reference}; ongefilterd op slot ${all.context.slot}, gefilterd op slot ${filtered.context.slot})`);
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
