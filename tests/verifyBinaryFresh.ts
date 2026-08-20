// EIS 1 (STATUS.md sectie 76/77): "72 passing" is een aanname zolang
// niemand kan aantonen tegen welke binary er gedraaid is. cargo-build-sbf's
// toolchain-switching bleek de bron-mtime niet altijd correct te detecteren
// (al gedocumenteerd in scripts/build-and-deploy.sh's eigen waarschuwing,
// empirisch tegengekomen tijdens FASE B) - een testrun kon zo stilzwijgend
// tegen een VERALTE binary draaien zonder dat iets dat meldde.
//
// Deze module wordt op module-niveau (dus synchroon, bij import, VOORDAT
// er ook maar één test draait) uitgevoerd, en geïmporteerd door
// webauthnTestHelper.ts - elk testbestand in deze suite importeert
// daaruit, dus deze check loopt onvermijdelijk mee bij elke testrun via
// `tests/**/*.ts`, ongeacht via welk commando (ts-mocha rechtstreeks,
// `yarn test`, `anchor test`) mocha wordt aangeroepen. Dat maakt dit de
// minst omzeilbare plek - een losse pre-test-script zou overgeslagen
// kunnen worden door mocha rechtstreeks aan te roepen; dit niet.
//
// Faalt hard (gooit, wat mocha's bestand-laadfase blokkeert en de HELE
// testrun met een duidelijke foutmelding stopt) als target/deploy/
// spankwallet.so ontbreekt of ouder is dan de nieuwste wijziging in
// programs/spankwallet/src/. Print bij een geslaagde check ook de sha256
// van de binary - dat is de hash die in STATUS.md-testresultaten hoort
// (zie sectie 76/77: "een testresultaat zonder die hash is niet compleet").

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

// process.cwd() i.p.v. __dirname: mocha/ts-node laadt dit bestand soms als
// CommonJS, soms als ES-module (afhankelijk van welke andere testbestanden
// in dezelfde run meeladen - Node's eigen per-bestand-heuristiek), en
// __dirname bestaat niet in ES-modulescope. process.cwd() werkt in beide
// gevallen identiek, en dit project wordt altijd vanuit de repo-root
// aangeroepen (zelfde aanname als elk relatief pad elders in deze suite).
const REPO_ROOT = process.cwd();
const SRC_DIR = path.join(REPO_ROOT, "programs", "spankwallet", "src");
const BINARY_PATH = path.join(REPO_ROOT, "target", "deploy", "spankwallet.so");

function newestMtimeMs(dir: string): { newestPath: string; mtimeMs: number } {
  let newestPath = "";
  let newestMtimeMs = -1;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(fullPath);
      if (sub.mtimeMs > newestMtimeMs) {
        newestMtimeMs = sub.mtimeMs;
        newestPath = sub.newestPath;
      }
    } else if (entry.isFile()) {
      const mtimeMs = fs.statSync(fullPath).mtimeMs;
      if (mtimeMs > newestMtimeMs) {
        newestMtimeMs = mtimeMs;
        newestPath = fullPath;
      }
    }
  }

  return { newestPath, mtimeMs: newestMtimeMs };
}

function verifyBinaryFresh(): void {
  if (!fs.existsSync(BINARY_PATH)) {
    throw new Error(
      "\n\nBINARY-VERSHEIDSCONTROLE FAALDE (EIS 1, STATUS.md sectie 76/77):\n" +
        `${BINARY_PATH} bestaat niet.\n` +
        "Bouw eerst: (cd programs/spankwallet && cargo-build-sbf --arch v3)\n" +
        "en deploy naar de lokale validator voordat je de testsuite draait.\n"
    );
  }

  const { newestPath, mtimeMs: srcMtimeMs } = newestMtimeMs(SRC_DIR);
  const binaryMtimeMs = fs.statSync(BINARY_PATH).mtimeMs;

  if (binaryMtimeMs < srcMtimeMs) {
    throw new Error(
      "\n\nBINARY-VERSHEIDSCONTROLE FAALDE (EIS 1, STATUS.md sectie 76/77):\n" +
        `${BINARY_PATH} (mtime ${new Date(binaryMtimeMs).toISOString()}) is OUDER dan\n` +
        `${newestPath} (mtime ${new Date(srcMtimeMs).toISOString()}).\n` +
        "De testsuite zou tegen een VERALTE binary draaien - de resultaten zouden\n" +
        "niets bewijzen over de huidige broncode. cargo-build-sbf's toolchain-\n" +
        "switching detecteert bronwijzigingen niet altijd betrouwbaar (zie\n" +
        "scripts/build-and-deploy.sh) - forceer een echte rebuild:\n" +
        "  touch programs/spankwallet/src/*.rs\n" +
        "  (cd programs/spankwallet && cargo-build-sbf --arch v3)\n" +
        "  solana program deploy target/deploy/spankwallet.so --program-id target/deploy/spankwallet-keypair.json --url <RPC_URL>\n"
    );
  }

  const sha256 = createHash("sha256").update(fs.readFileSync(BINARY_PATH)).digest("hex");
  // Bewust console.error (niet console.log): mocha's eigen testoutput
  // gebruikt stdout voor de spec-reporter, dit moet er altijd los van
  // zichtbaar zijn, ook bij een andere reporter-configuratie.
  // eslint-disable-next-line no-console
  console.error(
    `[verifyBinaryFresh] target/deploy/spankwallet.so is verser dan de broncode. ` +
      `sha256=${sha256} mtime=${new Date(binaryMtimeMs).toISOString()}`
  );
}

verifyBinaryFresh();
