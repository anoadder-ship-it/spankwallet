// Meet de daadwerkelijke slotduur (ms/slot) direct via getBlockTime over een
// reeks recente slots - geen aanname, geen extrapolatie van kwantisatieruis
// (zelfde correctie als STATUS.md sectie 99's klokdrift-meting,
// scripts/measureClockDrift.ts: één directe meting over een venster dat groot
// genoeg is dat de ±1s secondenkwantisatie van getBlockTime verwaarloosbaar
// wordt, in plaats van een korte meting lineair doortrekken).
//
// Gebruikt voor STATUS.md sectie 103: SLOT_MS_ESTIMATE (client/src/slotDuration.ts)
// en MAX_SESSION_DURATION_SLOTS (programs/spankwallet/src/state.rs) gingen beide
// uit van Solana's "nominale" 400ms/slot - Helius noemde 2026-08-28 als verwachte
// overgangsdatum naar 300ms op mainnet.
import { Connection } from "@solana/web3.js";

// getBlockTime(slot) geeft null terug voor een geskipte slot (geen blok
// geproduceerd) - loop vooruit/achteruit tot een echt blok gevonden wordt,
// in plaats van een enkele slot blind aan te nemen.
async function findBlockTime(
  connection: Connection,
  startSlot: number,
  direction: 1 | -1,
  maxAttempts = 20
): Promise<{ slot: number; time: number }> {
  let slot = startSlot;
  for (let i = 0; i < maxAttempts; i++) {
    const t = await connection.getBlockTime(slot);
    if (t !== null) return { slot, time: t };
    slot += direction;
  }
  throw new Error(`geen blockTime gevonden binnen ${maxAttempts} slots vanaf ${startSlot}`);
}

async function measure(label: string, rpcUrl: string, lookbackSlots: number) {
  const connection = new Connection(rpcUrl, "confirmed");

  const currentSlot = await connection.getSlot("confirmed");
  const targetOldSlot = currentSlot - lookbackSlots;

  const end = await findBlockTime(connection, currentSlot, -1);
  const start = await findBlockTime(connection, targetOldSlot, 1);

  const slotDelta = end.slot - start.slot;
  const secondsDelta = end.time - start.time;
  const msPerSlot = (secondsDelta * 1000) / slotDelta;

  console.log(
    `[${label}] currentSlot=${currentSlot} start_slot=${start.slot} (blockTime=${start.time}) ` +
      `end_slot=${end.slot} (blockTime=${end.time})`
  );
  console.log(
    `[${label}] slot_delta=${slotDelta} seconden_delta=${secondsDelta}s -> ` +
      `${msPerSlot.toFixed(2)}ms/slot (kwantisatiefout op secondsDelta is max ±1s op ` +
      `${secondsDelta}s = ${((1 / secondsDelta) * 100).toFixed(3)}%)`
  );
  return msPerSlot;
}

async function main() {
  const label = process.argv[2] ?? "devnet";
  const rpcUrl = process.argv[3] ?? "https://api.devnet.solana.com";
  const lookbackSlots = Number(process.argv[4] ?? 200_000);
  console.log(`Slotduurmeting tegen ${label} (${rpcUrl}), lookback ${lookbackSlots} slots`);
  await measure(label, rpcUrl, lookbackSlots);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
