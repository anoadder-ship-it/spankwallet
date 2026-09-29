import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_RPC_URL, exitUnlessDevnet } from "./lib/devnetCluster";
import {
  APPROVED_TAG,
  decodeMultisigHeader,
  decodeProposalHeader,
  decodeVaultTransaction,
  PROPOSAL_STATUS_NAMES,
  proposalPda,
  SQUADS_PROGRAM_ID,
  transactionPda,
  upgradeProposalProblems,
} from "./lib/squadsUpgradeProposal";

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
//   checkRecoveryQueueInvariant.ts, zodat beide stappen dezelfde node lezen.
// - M-3: TRANSACTION_INDEX moet het LAATSTE voorstel zijn
//   (multisig.transactionIndex), niet verouderd (> staleTransactionIndex),
//   en de VaultTransaction moet precies de upgrade van PROGRAM_ID vanaf
//   EXPECTED_BUFFER zijn, met de vault als authority en spill. Squads voert
//   een goedgekeurde vault-transactie ook uit als hij stale is, dus
//   "verlopen" is geen vangnet; dit script wel.
// - L-1: geen standaardvoorstel meer; zonder TRANSACTION_INDEX exit 2.
// - L-2: owner-controle op het multisig-, proposal- en transactie-account.
//
// Geen @sqds/multisig-dependency nodig (bewust, zelfde reden als
// checkWorstCaseAccountSafety.ts: geen anchor-build, geen nieuwe dependency
// in het hoofdproject) - de layouts staan in scripts/lib/squadsUpgradeProposal.ts,
// overgenomen uit @sqds/multisig's GEGENEREERDE beet-structuurdefinities en
// getest tegen echte devnet-accounts.
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
// buffer vastlegt. Upgrade 1: sectie 163 (build 33598b…, keypair uit de
// tweede run).
const EXPECTED_BUFFER = new PublicKey("F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5");

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

function requireSquadsOwner(name: string, address: PublicKey, owner: PublicKey) {
  if (!owner.equals(SQUADS_PROGRAM_ID)) {
    throw new Error(`${name} ${address.toBase58()} is niet van het Squads-programma (owner ${owner.toBase58()}).`);
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  await exitUnlessDevnet(connection, RPC_URL);

  // --- Multisig-account ---
  const multisigInfo = await connection.getAccountInfo(MULTISIG_PDA);
  if (!multisigInfo) throw new Error(`Multisig-account ${MULTISIG_PDA.toBase58()} niet gevonden.`);
  requireSquadsOwner("Multisig-account", MULTISIG_PDA, multisigInfo.owner);
  const multisig = decodeMultisigHeader(multisigInfo.data);
  if (typeof multisig === "string") throw new Error(`Multisig-account: ${multisig}`);
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
  if (TRANSACTION_INDEX <= multisig.staleTransactionIndex) {
    throw new Error(`Voorstel #${TRANSACTION_INDEX} is stale (staleTransactionIndex = ${multisig.staleTransactionIndex}).`);
  }

  // --- Proposal-account ---
  const proposalAddress = proposalPda(MULTISIG_PDA, TRANSACTION_INDEX);
  console.log(`\nProposal #${TRANSACTION_INDEX} PDA = ${proposalAddress.toBase58()}`);
  const proposalInfo = await connection.getAccountInfo(proposalAddress);
  if (!proposalInfo) throw new Error(`Proposal-account ${proposalAddress.toBase58()} niet gevonden.`);
  requireSquadsOwner("Proposal-account", proposalAddress, proposalInfo.owner);
  const proposal = decodeProposalHeader(proposalInfo.data);
  if (typeof proposal === "string") throw new Error(`Proposal-account: ${proposal}`);
  if (!proposal.multisig.equals(MULTISIG_PDA)) {
    throw new Error(`Proposal.multisig (${proposal.multisig.toBase58()}) komt niet overeen met verwachte multisig (${MULTISIG_PDA.toBase58()}).`);
  }
  if (proposal.transactionIndex !== TRANSACTION_INDEX) {
    throw new Error(`Proposal.transactionIndex (${proposal.transactionIndex}) komt niet overeen met verwachte index (${TRANSACTION_INDEX}).`);
  }
  const statusName = PROPOSAL_STATUS_NAMES[proposal.statusTag];
  if (proposal.statusTag !== APPROVED_TAG || proposal.statusTimestamp === null) {
    throw new Error(
      `Proposal #${TRANSACTION_INDEX} staat op status "${statusName}", niet "Approved". ` +
        `Timelock-check niet van toepassing - uitvoeren nu sowieso niet mogelijk.`
    );
  }
  const approvedAtUnix = proposal.statusTimestamp; // i64, seconden sinds epoch
  console.log(`Proposal #${TRANSACTION_INDEX}: status=${statusName}, goedgekeurd op unix=${approvedAtUnix} (${new Date(Number(approvedAtUnix) * 1000).toISOString()})`);

  // --- VaultTransaction: is dit precies de bedoelde upgrade? ---
  const transactionAddress = transactionPda(MULTISIG_PDA, TRANSACTION_INDEX);
  const transactionInfo = await connection.getAccountInfo(transactionAddress);
  if (!transactionInfo) throw new Error(`VaultTransaction-account ${transactionAddress.toBase58()} niet gevonden.`);
  requireSquadsOwner("VaultTransaction-account", transactionAddress, transactionInfo.owner);
  const vaultTransaction = decodeVaultTransaction(transactionInfo.data);
  if (typeof vaultTransaction === "string") throw new Error(`VaultTransaction-account: ${vaultTransaction}`);
  const problems = upgradeProposalProblems(vaultTransaction, {
    multisig: MULTISIG_PDA,
    transactionIndex: TRANSACTION_INDEX,
    vaultIndex: VAULT_INDEX,
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    buffer: EXPECTED_BUFFER,
  });
  if (problems.length > 0) {
    throw new Error(
      `Voorstel #${TRANSACTION_INDEX} is niet precies de upgrade van ${PROGRAM_ID.toBase58()} vanaf buffer ${EXPECTED_BUFFER.toBase58()}:\n  - ` +
        problems.join("\n  - ") +
        `\nNIET UITVOEREN.`
    );
  }
  console.log(`VaultTransaction #${TRANSACTION_INDEX}: alleen Upgrade van ${PROGRAM_ID.toBase58()} vanaf buffer ${EXPECTED_BUFFER.toBase58()}, authority en spill de vault.`);

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
