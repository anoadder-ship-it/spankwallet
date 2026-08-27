// Meet het verschil tussen Solana's Clock-sysvar (unix_timestamp, exact wat
// Clock::get()?.unix_timestamp on-chain teruggeeft) en de lokale, NTP-
// gesynchroniseerde systeemklok (bevestigd via `timedatectl show -p
// NTPSynchronized`: yes). Gebruikt voor STATUS.md sectie 99, vraag 3.
import { Connection, PublicKey } from "@solana/web3.js";

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

function decodeClock(data: Buffer): { slot: bigint; unixTimestamp: bigint } {
  // Layout: slot(8) + epoch_start_timestamp(8) + epoch(8) + leader_schedule_epoch(8) + unix_timestamp(8)
  const slot = data.readBigInt64LE(0);
  const unixTimestamp = data.readBigInt64LE(32);
  return { slot, unixTimestamp };
}

async function measure(label: string, rpcUrl: string, samples: number, intervalMs: number) {
  const connection = new Connection(rpcUrl, "confirmed");
  const deltasMs: number[] = [];
  const rtts: number[] = [];

  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const info = await connection.getAccountInfo(CLOCK_SYSVAR);
    const t1 = Date.now();
    if (!info) {
      console.log(`  [${label}] sample ${i}: geen Clock-sysvar-data`);
      continue;
    }
    const { unixTimestamp } = decodeClock(info.data);
    const chainMs = Number(unixTimestamp) * 1000;
    const localMidpoint = (t0 + t1) / 2;
    const delta = chainMs - localMidpoint; // positief = chain loopt voor op lokale klok
    const rtt = t1 - t0;
    deltasMs.push(delta);
    rtts.push(rtt);
    console.log(
      `  [${label}] sample ${i}: chain_unix=${unixTimestamp} delta=${delta}ms rtt=${rtt}ms`
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (deltasMs.length === 0) {
    console.log(`  [${label}] GEEN samples gelukt`);
    return;
  }
  const min = Math.min(...deltasMs);
  const max = Math.max(...deltasMs);
  const mean = deltasMs.reduce((a, b) => a + b, 0) / deltasMs.length;
  const rttMin = Math.min(...rtts);
  const rttMax = Math.max(...rtts);
  console.log(
    `  [${label}] SAMENVATTING n=${deltasMs.length} delta_min=${min.toFixed(0)}ms delta_max=${max.toFixed(0)}ms delta_mean=${mean.toFixed(0)}ms spread=${(max - min).toFixed(0)}ms rtt_min=${rttMin}ms rtt_max=${rttMax}ms`
  );
}

async function main() {
  const target = process.argv[2] ?? "devnet";
  const rpcUrl = process.argv[3] ?? "https://api.devnet.solana.com";
  const samples = Number(process.argv[4] ?? 20);
  const intervalMs = Number(process.argv[5] ?? 3000);
  console.log(`Meting tegen ${target} (${rpcUrl}), ${samples} samples, interval ${intervalMs}ms`);
  await measure(target, rpcUrl, samples, intervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
