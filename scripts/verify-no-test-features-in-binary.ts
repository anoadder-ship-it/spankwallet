// verify-no-test-features-in-binary.ts — STATUS.md sectie 124 (stap
// 6-opzet): actieve, byte-niveau-controle dat de test-only Cargo-feature
// `test-fast-pending-timelock` (programs/spankwallet/Cargo.toml) NOOIT in
// een echt te deployen .so terechtkomt. Zelfde discipline/stijl als
// verify-program-id-in-binary.ts: niet vertrouwen op "de feature staat
// standaard uit", maar de daadwerkelijk gecompileerde bytes controleren -
// de enige bron die niet kan liegen over wat er straks echt gedeployed
// wordt.
//
// `test-fast-pending-timelock` verkort PENDING_ACTION_TIMELOCK_SECONDS
// (instructions.rs) van 24 uur naar 3 seconden - functioneel een
// beveiligingsverzwakking als hij ooit in een echte build meekomt.
// instructions.rs zet daarom, ALLEEN als de feature actief is, een
// `#[used]` 34-byte marker-static in het binary
// (PENDING_ACTION_TEST_TIMELOCK_MARKER = "SPANKWALLET_TEST_FAST_TIMELOCK_V1")
// - deze controle zoekt naar EXACT die bytes. Geen aanname over hoe de
// verkorte i64-constante zelf door de compiler gecodeerd/geïnlined wordt
// (onbetrouwbaar om op te scannen) - wel over de expliciete marker, die
// alleen bestaat als de feature bij het bouwen actief was.
//
// Gebruik:
//   node_modules/.bin/ts-node --transpile-only \
//     scripts/verify-no-test-features-in-binary.ts <pad-naar-.so>
//
// Exitcode 0 = marker niet aangetroffen (veilig om te deployen).
// Exitcode 1 = marker aangetroffen - HARDE STOP, dit .so bevat de
// verkorte testtimelock en mag nooit naar devnet/mainnet.

import * as fs from "fs";

const TEST_TIMELOCK_MARKER = Buffer.from(
  "SPANKWALLET_TEST_FAST_TIMELOCK_V1",
  "utf-8"
);

function findAllOccurrences(haystack: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack.compare(needle, 0, needle.length, i, i + needle.length) === 0) {
      offsets.push(i);
    }
  }
  return offsets;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const [, , soPath] = process.argv;
  if (!soPath) {
    fail(
      "Gebruik: verify-no-test-features-in-binary.ts <pad-naar-.so>"
    );
  }
  if (!fs.existsSync(soPath)) {
    fail(`FOUT (bestand ontbreekt): ${soPath} bestaat niet.`);
  }

  const soBytes = fs.readFileSync(soPath);
  const offsets = findAllOccurrences(soBytes, TEST_TIMELOCK_MARKER);

  if (offsets.length > 0) {
    fail(
      `FOUT (TEST-FEATURE AANGETROFFEN IN BINARY): de marker voor de\n` +
        `\`test-fast-pending-timelock\`-Cargo-feature komt ${offsets.length} keer voor in\n` +
        `${soPath}, op offsets ${offsets.join(", ")}.\n` +
        "Dit .so is gebouwd met PENDING_ACTION_TIMELOCK_SECONDS verkort naar 3\n" +
        "seconden (test-only, zie instructions.rs) i.p.v. de echte 24 uur. Dit MAG\n" +
        "NOOIT naar devnet/mainnet - bouw opnieuw ZONDER --features\n" +
        "test-fast-pending-timelock en verifieer deze controle opnieuw."
    );
  }

  console.log(
    `OK (geen test-feature-marker aangetroffen): ${soPath} bevat geen spoor van ` +
      "de test-fast-pending-timelock-feature - veilig op dit punt."
  );
}

main();
