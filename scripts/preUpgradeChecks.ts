import { spawnSync } from "child_process";
import * as path from "path";

// STATUS.md sectie 162 (review §161, L-1): de verplichte controles rond het
// uitvoeren van een programma-upgrade, als één commando dat bij de eerste
// fout stopt met een non-zero exit-code. Stap 1 van de pre-flight in
// docs/upgradevoorstel-sjabloon.md en README "Deployen naar devnet".
//
//   --pre   direct vóór het uitvoeren (knop 4 op de adminpagina):
//           1. checkProposalTimelock.ts (72u-timelock verstreken, gemeten
//              tegen de Clock-sysvar; sectie 94)
//           2. checkRecoveryQueueInvariant.ts (sectie 161/162)
//   --post  direct ná het uitvoeren:
//           1. checkRecoveryQueueInvariant.ts
//           (de timelock-check hoort hier niet: het voorstel staat dan op
//           Executed, en dat script faalt daar terecht op.)
//
// Leesalleen; stuurt nooit een transactie.
//
//   TRANSACTION_INDEX=<n> npx ts-node --transpile-only scripts/preUpgradeChecks.ts --pre
//   npx ts-node --transpile-only scripts/preUpgradeChecks.ts --post
//
// Exit-code: 0 = alle stappen groen; anders de exit-code van de eerste
// stap die faalde (of 2 bij een fout in de aanroep zelf).

const ROOT = path.join(__dirname, "..");
const TS_NODE = path.join(ROOT, "node_modules", ".bin", "ts-node");

interface Step {
  name: string;
  script: string;
}

const TIMELOCK: Step = { name: "timelock van het voorstel verstreken", script: "scripts/checkProposalTimelock.ts" };
const INVARIANT: Step = { name: "recovery-/wachtrij-invariant", script: "scripts/checkRecoveryQueueInvariant.ts" };

function fail(message: string): never {
  console.error(`preUpgradeChecks: ${message}`);
  process.exit(2);
}

function main(): number {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "--pre" && mode !== "--post")) {
    fail("gebruik: preUpgradeChecks.ts --pre | --post (precies één van beide)");
  }
  let steps: Step[];
  if (mode === "--pre") {
    if (!process.env.TRANSACTION_INDEX) {
      fail("--pre vereist TRANSACTION_INDEX (het nummer van het voorstel dat uitgevoerd gaat worden)");
    }
    steps = [TIMELOCK, INVARIANT];
  } else {
    steps = [INVARIANT];
  }

  for (const [i, step] of steps.entries()) {
    console.log(`\n=== ${mode} stap ${i + 1}/${steps.length}: ${step.name} (${step.script}) ===`);
    const run = spawnSync(TS_NODE, ["--transpile-only", step.script], { cwd: ROOT, stdio: "inherit", env: process.env });
    if (run.error) fail(`${step.script} kon niet gestart worden: ${run.error.message}`);
    const code = run.status ?? 1;
    if (code !== 0) {
      const advice =
        mode === "--pre"
          ? "NIET UITVOEREN."
          : "De upgrade is al uitgevoerd: dit is detectie, geen herstel. Zie het commentaar in scripts/checkRecoveryQueueInvariant.ts.";
      console.error(`\nSTOP: ${step.script} faalde (exit ${code}${run.signal ? `, signaal ${run.signal}` : ""}). ${advice}`);
      return code;
    }
  }
  console.log(`\nAlle ${steps.length} stap(pen) van ${mode} groen.`);
  return 0;
}

process.exit(main());
