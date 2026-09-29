import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_RPC_URL, exitUnlessDevnet } from "./lib/devnetCluster";
import { loadAndSelect, vaultPda } from "./lib/squadsUpgradeProposal";
import { bufferProblems } from "./lib/upgradeBuffer";

// Stap 1 van de pre-flight vóór "4. Uitvoeren" - MOET vóór de andere drie
// stappen (sessie-check, voorstel/buffer-check, adminpagina-check) en MOET
// hard falen (non-zero exit) zolang de 72u-timelock niet is verstreken.
//
// Ontstaan uit een pre-flight op 2026-08-25 die "klaar om uit te voeren"
// meldde terwijl de timelock nog ~23 uur liep: de sessies, de voorstelstatus,
// de buffer en de adminpagina werden gecontroleerd, maar niet de enige
// voorwaarde die op dat moment het uitvoeren blokkeerde. De adminpagina zelf
// weigerde correct (zie wallet-signer.html's eigen executableAt-check), maar
// dat is een tweede vangnet, geen vervanging voor een sluitende pre-flight.
//
// Rekent NIET met een eerder genoteerde datum/timestamp - meet elke keer
// opnieuw rechtstreeks van de keten: de goedkeuringstimestamp uit het
// Proposal-account, de timeLock-waarde uit het Multisig-account, en de
// "actuele tijd" uit de Clock-sysvar (niet lokale Date.now(), niet
// getBlockTime() van een RPC-node) - de Clock-sysvar is letterlijk wat het
// Squads-programma zelf leest via Clock::get()?.unix_timestamp op het moment
// dat het de timelock toetst bij uitvoering, dus de enige "actuele tijd" die
// er echt toe doet.
//
// STATUS.md sectie 167 (review §162): het script bewijst nu ook WELK voorstel
// het toetst, niet alleen dat "een" voorstel uitvoerbaar is.
// - M-1: eerst de genesis-hash; alleen devnet (exit 2 bij een andere cluster).
//   RPC_URL mag een andere devnet-node kiezen, dezelfde variabele als
//   checkRecoveryQueueInvariant.ts. De controle vertrouwt op wat de RPC
//   antwoordt: ze weert een verkeerde URL of een lokale test-validator, maar
//   is geen absolute garantie tegen een simulator die devnet forkt en diens
//   genesis-hash doorgeeft (review §167, L-2).
// - M-3: TRANSACTION_INDEX moet het LAATSTE voorstel zijn
//   (multisig.transactionIndex), niet verouderd (> staleTransactionIndex),
//   en de VaultTransaction moet precies de upgrade van PROGRAM_ID vanaf
//   EXPECTED_BUFFER zijn, met de vault als authority en spill. Squads voert
//   een goedgekeurde vault-transactie ook uit als hij stale is, dus
//   "verlopen" is geen vangnet; dit script wel.
// - L-1: geen standaardvoorstel meer; zonder TRANSACTION_INDEX exit 2.
// - L-2: owner-controle op het multisig-, proposal- en transactie-account.
//
// STATUS.md sectie 168 (review §167):
// - M-A: dezelfde selectie als knop 3/4 van admin/wallet-signer.html, uit
//   dezelfde module (admin/upgradeProposalCheck.mjs): alle voorstellen
//   1..transactionIndex worden gelezen (ook stale), en precies één
//   goedgekeurd voorstel mag deze buffer raken - het laatste. Een groen
//   script gaat zo over precies het voorstel dat knop 4 uitvoert.
// - M-B: de buffer zelf wordt gelezen: van de loader, authority = de vault,
//   sha256 van het programma = de RC-build, rest nul (scripts/lib/upgradeBuffer.ts).
//
// Geen @sqds/multisig-dependency nodig (bewust, zelfde reden als
// checkWorstCaseAccountSafety.ts: geen anchor-build, geen nieuwe dependency
// in het hoofdproject) - de layouts staan in admin/upgradeProposalCheck.mjs,
// overgenomen uit @sqds/multisig's GEGENEREERDE beet-structuurdefinities en
// getest tegen echte devnet-accounts. Vereist Node >= 20.19 / 22.12 (require
// van een ES-module).
//
//   TRANSACTION_INDEX=<n> npx ts-node --transpile-only scripts/checkProposalTimelock.ts
//
// Exit-code: 0 = uitvoerbaar voorstel voor precies deze upgrade; 1 = niet
// (of fout); 2 = verkeerde aanroep of een andere cluster dan devnet.

const RPC_URL = process.env.RPC_URL ?? DEVNET_RPC_URL;
const MULTISIG_PDA = new PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const PROGRAM_DATA = new PublicKey("5bqcgypDa4fa4oVAYPLeYFocy9dyg1b49G9zmaGnwKEq");
const VAULT_INDEX = 0;
// Per upgrade bijwerken, in dezelfde commit als de STATUS-sectie die de
// buffer vastlegt, en gelijk aan BUFFER in admin/wallet-signer.html
// (tests/unit/adminPageSelection.ts bewaakt dat). Upgrade 1: sectie 163
// (reproduceerbare build van commit 63e993a, keypair uit de tweede run).
const EXPECTED_BUFFER = new PublicKey("F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5");
// Sectie 168 (M-B): wat er in die buffer moet staan. Lengte en sha256 van
// de RC-binary uit sectie 163 (`scripts/build-devnet-buffer.sh 63e993a…`, twee
// onafhankelijke runs identiek; tests/unit/fixtures/rc163-spankwallet.so.gz).
const EXPECTED_BUFFER_PROGRAM_LENGTH = 737_080;
const EXPECTED_BUFFER_PROGRAM_SHA256 = "33598b3ddb179d680cc26e8318ac9b60002808e7044234c472481a00974ae76f";

function usage(message: string): never {
  console.error(`checkProposalTimelock: ${message}`);
  process.exit(2);
}

const TRANSACTION_INDEX = (() => {
  const fromEnv = process.env.TRANSACTION_INDEX;
  if (fromEnv === undefined || fromEnv === "") usage("TRANSACTION_INDEX ontbreekt (het nummer van het voorstel dat uitgevoerd gaat worden).");
  if (!/^[0-9]+$/.test(fromEnv)) usage(`TRANSACTION_INDEX "${fromEnv}" is geen niet-negatief geheel getal.`);
  return BigInt(fromEnv);
})();

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  await exitUnlessDevnet(connection, RPC_URL);

  // --- Multisig en alle voorstellen: dezelfde scan en regel als knop 3/4 ---
  const selection = await loadAndSelect(connection, {
    multisigAddress: MULTISIG_PDA,
    expected: { multisig: MULTISIG_PDA, vaultIndex: VAULT_INDEX, programId: PROGRAM_ID, programData: PROGRAM_DATA, buffer: EXPECTED_BUFFER },
    purpose: "execute",
  });
  const { multisig } = selection;
  console.log(
    `Multisig: threshold=${multisig.threshold}, timeLock=${multisig.timeLockSeconds}s (${(multisig.timeLockSeconds / 3600).toFixed(2)}u), ` +
      `transactionIndex=${multisig.transactionIndex}, staleTransactionIndex=${multisig.staleTransactionIndex}`
  );

  if (TRANSACTION_INDEX !== multisig.transactionIndex) {
    throw new Error(
      `TRANSACTION_INDEX ${TRANSACTION_INDEX} is niet het laatste voorstel (multisig.transactionIndex = ${multisig.transactionIndex}). ` +
        `NIET UITVOEREN: controleer welk voorstel bedoeld is.`
    );
  }
  if (selection.problems.length > 0 || !selection.target) {
    throw new Error(
      `Voorstel #${TRANSACTION_INDEX} is niet het enige uitvoerbare voorstel voor precies de upgrade van ${PROGRAM_ID.toBase58()} ` +
        `vanaf buffer ${EXPECTED_BUFFER.toBase58()}:\n  - ` +
        selection.problems.join("\n  - ") +
        `\nNIET UITVOEREN.`
    );
  }
  const target = selection.target;
  if (target.index !== TRANSACTION_INDEX || target.statusTimestamp === null) {
    throw new Error(`Interne fout: selectie gaf voorstel #${target.index}, verwacht #${TRANSACTION_INDEX}.`);
  }
  const approvedAtUnix = target.statusTimestamp; // i64, seconden sinds epoch
  console.log(`Proposal #${TRANSACTION_INDEX}: status=${target.statusName}, goedgekeurd op unix=${approvedAtUnix} (${new Date(Number(approvedAtUnix) * 1000).toISOString()})`);
  console.log(
    `VaultTransaction #${TRANSACTION_INDEX}: alleen Upgrade van ${PROGRAM_ID.toBase58()} vanaf buffer ${EXPECTED_BUFFER.toBase58()}, authority en spill de vault; ` +
      `geen ander goedgekeurd voorstel voor deze buffer (voorstellen 1..${multisig.transactionIndex} gelezen).`
  );

  // --- De buffer zelf: inhoud en authority ---
  const vault = vaultPda(MULTISIG_PDA, VAULT_INDEX);
  const bufferInfo = await connection.getAccountInfo(EXPECTED_BUFFER);
  const bufferIssues = bufferProblems(bufferInfo && { owner: bufferInfo.owner, data: bufferInfo.data }, {
    address: EXPECTED_BUFFER,
    authority: vault,
    programLength: EXPECTED_BUFFER_PROGRAM_LENGTH,
    programSha256: EXPECTED_BUFFER_PROGRAM_SHA256,
  });
  if (bufferIssues.length > 0) {
    throw new Error(`Buffer ${EXPECTED_BUFFER.toBase58()} is niet de verwachte RC-build:\n  - ${bufferIssues.join("\n  - ")}\nNIET UITVOEREN.`);
  }
  console.log(
    `Buffer ${EXPECTED_BUFFER.toBase58()}: authority de vault, sha256 ${EXPECTED_BUFFER_PROGRAM_SHA256} over ${EXPECTED_BUFFER_PROGRAM_LENGTH} bytes, rest nul.`
  );

  // --- Actuele on-chain tijd: Clock-sysvar, NIET Date.now() / getBlockTime() ---
  const clockInfo = await connection.getAccountInfo(CLOCK_SYSVAR);
  if (!clockInfo) throw new Error("Clock-sysvar niet gevonden - onverwacht, kan niet doorgaan zonder actuele ketentijd.");
  // Clock-layout (native runtime-serialisatie, alle velden LE):
  // slot(u64,8) + epoch_start_timestamp(i64,8) + epoch(u64,8) + leader_schedule_epoch(u64,8) + unix_timestamp(i64,8)
  const chainSlot = clockInfo.data.readBigUInt64LE(0);
  const chainUnixNow = clockInfo.data.readBigInt64LE(32);
  console.log(`\nClock-sysvar: slot=${chainSlot}, unix_timestamp=${chainUnixNow} (${new Date(Number(chainUnixNow) * 1000).toISOString()})`);

  // --- Vergelijking ---
  const executableAtUnix = approvedAtUnix + BigInt(multisig.timeLockSeconds);
  console.log(`\nUitvoerbaar vanaf (goedkeuring + timeLock): unix=${executableAtUnix} (${new Date(Number(executableAtUnix) * 1000).toISOString()})`);

  if (chainUnixNow < executableAtUnix) {
    const remainingSeconds = executableAtUnix - chainUnixNow;
    const remainingHours = (Number(remainingSeconds) / 3600).toFixed(2);
    console.error(
      `\nTIMELOCK NIET VERSTREKEN. Nog ${remainingSeconds}s (~${remainingHours}u) te gaan, gemeten tegen de Clock-sysvar. ` +
        `NIET UITVOEREN.`
    );
    process.exit(1);
  }

  const elapsedSeconds = chainUnixNow - executableAtUnix;
  console.log(`\nTIMELOCK VERSTREKEN sinds ${elapsedSeconds}s (~${(Number(elapsedSeconds) / 3600).toFixed(2)}u). Uitvoeren is on-chain toegestaan.`);
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(1);
});
