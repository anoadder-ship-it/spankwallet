import { ChildProcess, spawn } from "child_process";
import { Connection } from "@solana/web3.js";
import * as fs from "fs";

/**
 * STATUS.md sectie 143 (live-validator-integratietest van
 * migrate_wallet_account): een eigen, apart beheerde solana-test-validator,
 * los van de ambient validator die `anchor test` zelf al start (poort 8899
 * per Anchor.toml). Nodig omdat deze tests EXACTE byte-content op EXACTE,
 * vooraf-berekende PDA-adressen moeten kunnen laten bestaan VOORDAT er ooit
 * een transactie plaatsvindt (de account-genesis-techniek via
 * `--account <ADRES> <bestand.json>`) - dat kan alleen bij het opstarten van
 * de validator, niet achteraf via een gewone transactie (een programma kan
 * nooit willekeurige, van tevoren gekozen bytes op een eigen PDA schrijven
 * zonder een eigen instructie die dat expliciet doet, en precies DAT
 * structurele onvermogen is wat deze migratie-instructie moet overbruggen).
 *
 * Gebruikt expliciet ANDERE poorten dan de ambient validator, zodat beide
 * gelijktijdig kunnen draaien binnen dezelfde `anchor test`-run.
 */
export interface LocalValidatorHandle {
  connection: Connection;
  rpcUrl: string;
  stop: () => Promise<void>;
}

export interface AccountGenesisFile {
  address: string;
  filepath: string;
}

export async function startLocalValidator(opts: {
  ledgerDir: string;
  rpcPort: number;
  gossipPort: number;
  faucetPort: number;
  dynamicPortRange: string;
  programId: string;
  programSoPath: string;
  accounts?: AccountGenesisFile[];
}): Promise<LocalValidatorHandle> {
  // Altijd een schone ledger: `--account`/`--bpf-program` worden door
  // solana-test-validator STIL genegeerd als de ledger al bestaat (zie
  // `solana-test-validator --help`) - zonder deze opruiming zou een tweede
  // testrun stilzwijgend de fixtures van de EERSTE run blijven gebruiken.
  fs.rmSync(opts.ledgerDir, { recursive: true, force: true });

  const args: string[] = [
    "--reset",
    "--ledger", opts.ledgerDir,
    "--rpc-port", String(opts.rpcPort),
    "--gossip-port", String(opts.gossipPort),
    "--faucet-port", String(opts.faucetPort),
    "--dynamic-port-range", opts.dynamicPortRange,
    "--bind-address", "127.0.0.1",
    "--quiet",
    "--bpf-program", opts.programId, opts.programSoPath,
  ];
  for (const a of opts.accounts ?? []) {
    args.push("--account", a.address, a.filepath);
  }

  const proc: ChildProcess = spawn("solana-test-validator", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
  });
  proc.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
  });

  const rpcUrl = `http://127.0.0.1:${opts.rpcPort}`;
  const connection = new Connection(rpcUrl, "confirmed");

  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 60000) {
    if (proc.exitCode !== null) {
      throw new Error(
        `solana-test-validator (ledger=${opts.ledgerDir}) stopte vroegtijdig (code ${proc.exitCode}):\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`
      );
    }
    try {
      await connection.getVersion();
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ready) {
    proc.kill("SIGKILL");
    throw new Error(
      `solana-test-validator (ledger=${opts.ledgerDir}) niet gereed binnen 60s:\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`
    );
  }

  return {
    connection,
    rpcUrl,
    stop: async () => {
      // @solana/web3.js' Connection houdt intern een auto-reconnecterende
      // websocket-client (`_rpcWebSocket`) open, ook als er nooit
      // expliciet op iets geabonneerd is (`.rpc()`/confirmTransaction
      // gebruiken 'm intern voor "confirmed"-commitment). Zonder deze
      // expliciete close blijft die client, NA het doden van de validator
      // hieronder, voor altijd proberen te reconnecten - mocha's
      // event-loop drainde daardoor nooit leeg en het testproces bleef na
      // "6 passing" onbeperkt hangen (empirisch aangetroffen tijdens het
      // bouwen van deze test). Geen publieke API hiervoor in deze
      // web3.js-versie, vandaar het directe, interne `.close()`-veld.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connection as any)?._rpcWebSocket?.close();
      proc.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      fs.rmSync(opts.ledgerDir, { recursive: true, force: true });
    },
  };
}
