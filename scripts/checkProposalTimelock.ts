import { Connection, PublicKey } from "@solana/web3.js";

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
// Geen @sqds/multisig-dependency nodig (bewust, zelfde reden als
// checkWorstCaseAccountSafety.ts: geen anchor-build, geen nieuwe dependency
// in het hoofdproject) - alle byte-offsets hieronder zijn rechtstreeks
// overgenomen uit @sqds/multisig's GEGENEREERDE beet-structuurdefinities
// (node_modules/@sqds/multisig/src/generated/accounts/{Multisig,Proposal}.ts),
// niet aangenomen. PDA-seeds idem, overgenomen uit src/pda.ts.

const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const MULTISIG_PDA = new PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

// Pas aan per voorstel dat gecontroleerd wordt.
const TRANSACTION_INDEX = 11n;

const MULTISIG_DISCRIMINATOR = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
const PROPOSAL_DISCRIMINATOR = Buffer.from([26, 94, 189, 187, 116, 136, 53, 33]);

// ProposalStatus-dataEnum-tag-volgorde (types/ProposalStatus.ts, 1-byte tag,
// index = volgorde in het variants-array dat aan beet.dataEnum() wordt
// gegeven): Draft=0, Active=1, Rejected=2, Approved=3, Executing=4,
// Executed=5, Cancelled=6. Alleen Draft/Active/Rejected/Approved/Executed/
// Cancelled hebben een { timestamp: i64 } payload; Executing heeft geen payload.
const STATUS_NAMES = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"];
const APPROVED_TAG = 3;

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // --- Multisig-account: timeLock rechtstreeks decoderen ---
  const multisigInfo = await connection.getAccountInfo(MULTISIG_PDA);
  if (!multisigInfo) throw new Error(`Multisig-account ${MULTISIG_PDA.toBase58()} niet gevonden.`);
  if (!multisigInfo.data.subarray(0, 8).equals(MULTISIG_DISCRIMINATOR)) {
    throw new Error("Multisig-account discriminator komt niet overeen - verkeerd account of programma-layout gewijzigd.");
  }
  // Layout: disc(8) + createKey(32) + configAuthority(32) + threshold(u16,2) + timeLock(u32,4) + ...
  const threshold = multisigInfo.data.readUInt16LE(72);
  const timeLockSeconds = multisigInfo.data.readUInt32LE(74);
  console.log(`Multisig: threshold=${threshold}, timeLock=${timeLockSeconds}s (${(timeLockSeconds / 3600).toFixed(2)}u)`);

  // --- Proposal-PDA afleiden en account rechtstreeks decoderen ---
  const [proposalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), MULTISIG_PDA.toBytes(), Buffer.from("transaction"), u64le(TRANSACTION_INDEX), Buffer.from("proposal")],
    SQUADS_PROGRAM_ID
  );
  console.log(`\nProposal #${TRANSACTION_INDEX} PDA = ${proposalPda.toBase58()}`);

  const proposalInfo = await connection.getAccountInfo(proposalPda);
  if (!proposalInfo) throw new Error(`Proposal-account ${proposalPda.toBase58()} niet gevonden.`);
  if (!proposalInfo.data.subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
    throw new Error("Proposal-account discriminator komt niet overeen - verkeerd account of programma-layout gewijzigd.");
  }
  // Layout: disc(8) + multisig(32) + transactionIndex(u64,8) + status(tag u8 + payload) + ...
  const proposalMultisig = new PublicKey(proposalInfo.data.subarray(8, 40));
  if (!proposalMultisig.equals(MULTISIG_PDA)) {
    throw new Error(`Proposal.multisig (${proposalMultisig.toBase58()}) komt niet overeen met verwachte multisig (${MULTISIG_PDA.toBase58()}).`);
  }
  const proposalTxIndex = proposalInfo.data.readBigUInt64LE(40);
  if (proposalTxIndex !== TRANSACTION_INDEX) {
    throw new Error(`Proposal.transactionIndex (${proposalTxIndex}) komt niet overeen met verwachte index (${TRANSACTION_INDEX}).`);
  }
  const statusTag = proposalInfo.data.readUInt8(48);
  const statusName = STATUS_NAMES[statusTag] ?? `onbekend(${statusTag})`;

  if (statusTag !== APPROVED_TAG) {
    throw new Error(
      `Proposal #${TRANSACTION_INDEX} staat op status "${statusName}", niet "Approved". ` +
        `Timelock-check niet van toepassing - uitvoeren nu sowieso niet mogelijk.`
    );
  }
  const approvedAtUnix = proposalInfo.data.readBigInt64LE(49); // i64 LE, seconden sinds epoch
  console.log(`Proposal #${TRANSACTION_INDEX}: status=${statusName}, goedgekeurd op unix=${approvedAtUnix} (${new Date(Number(approvedAtUnix) * 1000).toISOString()})`);

  // --- Actuele on-chain tijd: Clock-sysvar, NIET Date.now() / getBlockTime() ---
  const clockInfo = await connection.getAccountInfo(CLOCK_SYSVAR);
  if (!clockInfo) throw new Error("Clock-sysvar niet gevonden - onverwacht, kan niet doorgaan zonder actuele ketentijd.");
  // Clock-layout (native runtime-serialisatie, alle velden LE):
  // slot(u64,8) + epoch_start_timestamp(i64,8) + epoch(u64,8) + leader_schedule_epoch(u64,8) + unix_timestamp(i64,8)
  const chainSlot = clockInfo.data.readBigUInt64LE(0);
  const chainUnixNow = clockInfo.data.readBigInt64LE(32);
  console.log(`\nClock-sysvar: slot=${chainSlot}, unix_timestamp=${chainUnixNow} (${new Date(Number(chainUnixNow) * 1000).toISOString()})`);

  // --- Vergelijking ---
  const executableAtUnix = approvedAtUnix + BigInt(timeLockSeconds);
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
