// verify-no-test-features-in-binary.ts — STATUS.md sectie 124 (stap
// 6-opzet) + sectie 132/133 (stap B): actieve, byte-niveau-controle dat
// GEEN van de bekende test-only Cargo-features (`test-fast-pending-
// timelock`, `test-fast-spend-window` - beide in
// programs/spankwallet/Cargo.toml) ooit in een echt te deployen .so
// terechtkomt. Zelfde discipline/stijl als verify-program-id-in-binary.ts:
// niet vertrouwen op "de feature staat standaard uit", maar de
// daadwerkelijk gecompileerde bytes controleren - de enige bron die niet
// kan liegen over wat er straks echt gedeployed wordt.
//
// Elke feature verkort een vaste, beveiligingsrelevante tijdsconstante
// (PENDING_ACTION_TIMELOCK_SECONDS resp. WINDOW_DURATION_SECONDS,
// instructions.rs) voor lokale testbinaries - functioneel een
// beveiligingsverzwakking als een van beide ooit in een echte build
// meekomt. instructions.rs zet daarom, ALLEEN als de betreffende feature
// actief is, een `msg!()`-marker-aanroep in het codepad dat de constante
// gebruikt - GEEN `#[used]`-static (sectie 124's root-cause-analyse: dat
// vertaalt naar de ELF-sectievlag SHF_GNU_RETAIN, wat EI_OSABI op
// ELFOSABI_GNU zet, wat de Solana SBF-loader weigert). Deze controle
// zoekt naar EXACT de bytes van elke marker hieronder. Geen aanname over
// hoe de verkorte constante zelf door de compiler gecodeerd/geïnlined
// wordt (onbetrouwbaar om op te scannen) - wel over de expliciete marker,
// die alleen bestaat als de bijbehorende feature bij het bouwen actief
// was.
//
// Gebruik:
//   node_modules/.bin/ts-node --transpile-only \
//     scripts/verify-no-test-features-in-binary.ts <pad-naar-.so>
//
// Exitcode 0 = marker niet aangetroffen (veilig om te deployen).
// Exitcode 1 = marker aangetroffen - HARDE STOP, dit .so bevat de
// verkorte testtimelock en mag nooit naar devnet/mainnet.

import * as fs from "fs";

// STATUS.md sectie 132/133 (stap B): tweede marker naast de
// oorspronkelijke timelock-marker - zelfde reden, zelfde controlepatroon
// (Cargo-feature `test-fast-spend-window`, verkort WINDOW_DURATION_SECONDS
// i.p.v. PENDING_ACTION_TIMELOCK_SECONDS). Beide markers worden hieronder
// in dezelfde lijst gecontroleerd, niet als los script - één enkele
// vangnetplek voor elke huidige/toekomstige test-only Cargo-feature die
// een beveiligingswaarde verkort.
const TEST_FEATURE_MARKERS: { feature: string; marker: Buffer }[] = [
  {
    feature: "test-fast-pending-timelock",
    marker: Buffer.from("SPANKWALLET_TEST_FAST_TIMELOCK_V1", "utf-8"),
  },
  {
    feature: "test-fast-spend-window",
    marker: Buffer.from("SPANKWALLET_TEST_FAST_SPEND_WINDOW_V1", "utf-8"),
  },
];

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
  const found = TEST_FEATURE_MARKERS.map(({ feature, marker }) => ({
    feature,
    offsets: findAllOccurrences(soBytes, marker),
  })).filter((r) => r.offsets.length > 0);

  if (found.length > 0) {
    const details = found
      .map(
        (r) =>
          `  - \`${r.feature}\`: ${r.offsets.length} keer, op offsets ${r.offsets.join(", ")}`
      )
      .join("\n");
    fail(
      `FOUT (TEST-FEATURE AANGETROFFEN IN BINARY): ${soPath} bevat de marker\n` +
        "voor de volgende test-only Cargo-feature(s):\n" +
        `${details}\n` +
        "Dit .so is gebouwd met een verkorte, test-only beveiligingswaarde\n" +
        "(zie instructions.rs/Cargo.toml) i.p.v. de echte productiewaarde. Dit MAG\n" +
        "NOOIT naar devnet/mainnet - bouw opnieuw ZONDER de bovenstaande\n" +
        "--features en verifieer deze controle opnieuw."
    );
  }

  console.log(
    `OK (geen test-feature-marker aangetroffen): ${soPath} bevat geen spoor van ` +
      `een van de ${TEST_FEATURE_MARKERS.length} bekende test-only Cargo-features - veilig op dit punt.`
  );
}

main();
