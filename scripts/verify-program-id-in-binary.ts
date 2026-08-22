// verify-program-id-in-binary.ts — formaliseert de handmatige
// "programma-ID-byte-offset-check (exact 1 treffer)" die STATUS.md sinds
// sectie 39 vóór elke devnet-deploy/buffer beschrijft, maar tot nu toe
// nergens als code stond - alleen als herhaalde, met de hand getypte stap.
//
// Twee controles, ELK met een eigen faalreden, want ze dekken verschillende
// fouten:
//   1. POSITIEF: het verwachte adres moet EXACT 1 keer voorkomen in de
//      rauwe .so-bytes (niet in de broncode - de bytes die daadwerkelijk
//      geüpload zouden worden). Nul treffers = verkeerd/geen programma;
//      meer dan 1 treffer = dubbelzinnig, niet automatisch te vertrouwen.
//   2. NEGATIEF: GEEN van de bekende test-/wegwerpadressen (uit
//      ${XDG_CONFIG_HOME:-~/.config}/spankwallet/program-keypairs/) mag
//      voorkomen - zowel lokale-validator-testadressen als devnet-
//      wegwerpdeploys (STATUS.md sectie 87: 2NHovxaquuaf1RsPsKAPk9rVAcN4nt-
//      foFCiHWYhpCAp8, de B1-B7-throwaway-deploy, staat hier ook expliciet
//      in - een devnet-adres kan net zo goed per ongeluk voor "de echte,
//      deploybare build" worden aangezien als een lokaal testadres). Dit is
//      de controle die de daadwerkelijke voetangel tegenhoudt: een test-
//      artefact dat voor een deploybare devnet-.so wordt aangezien (zie
//      STATUS.md - "de .so is een valstrik"-sectie). Bestaat de keypair-
//      store niet, dan is dat geen fout - de controle wordt dan expliciet
//      (niet stilzwijgend) overgeslagen.
//
// Gebruik:
//   node_modules/.bin/ts-node --transpile-only \
//     scripts/verify-program-id-in-binary.ts <pad-naar-.so> <verwacht-base58-adres>
//
// Exitcode 0 = beide controles geslaagd (of de negatieve controle was niet
// van toepassing, expliciet gemeld). Exitcode 1 = een van beide gefaald,
// met een op zichzelf staande, herkenbare foutmelding per faalreden.

import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  const [, , soPath, expectedId] = process.argv;
  if (!soPath || !expectedId) {
    fail(
      "Gebruik: verify-program-id-in-binary.ts <pad-naar-.so> <verwacht-base58-adres>"
    );
  }
  if (!fs.existsSync(soPath)) {
    fail(`FOUT (bestand ontbreekt): ${soPath} bestaat niet.`);
  }

  let expectedPubkey: PublicKey;
  try {
    expectedPubkey = new PublicKey(expectedId);
  } catch {
    fail(`FOUT (ongeldig adres): "${expectedId}" is geen geldig base58 Solana-adres.`);
    return;
  }

  const soBytes = fs.readFileSync(soPath);
  const expectedBytes = Buffer.from(expectedPubkey.toBytes());

  // --- Controle 1: POSITIEF - het verwachte adres exact 1 keer ---
  const expectedOffsets = findAllOccurrences(soBytes, expectedBytes);
  if (expectedOffsets.length === 0) {
    fail(
      `FOUT (ADRES NIET GEVONDEN): ${expectedId} komt geen enkele keer voor in\n` +
        `${soPath}.\n` +
        "Dit .so-bestand declareert dit programma-ID niet - waarschijnlijk een\n" +
        "verkeerde build, een verouderde binary, of een compleet ander programma."
    );
  }
  if (expectedOffsets.length > 1) {
    fail(
      `FOUT (ADRES MEERDERE KEREN GEVONDEN): ${expectedId} komt ` +
        `${expectedOffsets.length} keer voor in\n` +
        `${soPath}, op offsets ${expectedOffsets.join(", ")}.\n` +
        "Een eenduidige byte-offset-check vereist precies 1 treffer - dit is\n" +
        "dubbelzinnig en wordt daarom niet automatisch vertrouwd."
    );
  }
  console.log(
    `OK (adres bevestigd): ${expectedId} komt exact 1 keer voor in ${soPath}, ` +
      `op offset ${expectedOffsets[0]}.`
  );

  // --- Controle 2: NEGATIEF - geen enkel bekend test-/wegwerpadres ---
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const keypairStore = path.join(xdgConfigHome, "spankwallet", "program-keypairs");

  if (!fs.existsSync(keypairStore)) {
    console.log(
      `MELDING (negatieve controle OVERGESLAGEN): ${keypairStore} bestaat niet - ` +
        "geen bekende test-/wegwerpadressen om tegen te controleren. Dit is geen " +
        "fout, maar de negatieve controle heeft in dit geval NIET gedraaid."
    );
    console.log("ALLE UITGEVOERDE CONTROLES GESLAAGD.");
    return;
  }

  const keypairFiles = fs
    .readdirSync(keypairStore)
    .filter((f) => f.endsWith("-keypair.json"));

  if (keypairFiles.length === 0) {
    console.log(
      `MELDING (negatieve controle OVERGESLAGEN): ${keypairStore} bestaat, maar ` +
        "bevat geen *-keypair.json-bestanden."
    );
    console.log("ALLE UITGEVOERDE CONTROLES GESLAAGD.");
    return;
  }

  const localIdentities = keypairFiles.map((file) => {
    const fullPath = path.join(keypairStore, file);
    let keypair: Keypair;
    try {
      const secret = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch {
      fail(`FOUT (ongeldig keypair-bestand): ${fullPath} kon niet gelezen worden als een geldig Solana-keypair.`);
    }
    return { file, pubkey: keypair.publicKey.toBase58(), bytes: Buffer.from(keypair.publicKey.toBytes()) };
  });

  let foundAny = false;
  for (const { file, pubkey, bytes } of localIdentities) {
    const offsets = findAllOccurrences(soBytes, bytes);
    if (offsets.length > 0) {
      foundAny = true;
      console.error(
        `FOUT (BEKEND TEST-/WEGWERPADRES AANGETROFFEN): ${pubkey} (uit ${file}) komt ` +
          `${offsets.length} keer voor in\n` +
          `${soPath}, op offsets ${offsets.join(", ")}.\n` +
          "Dit is precies het artefact dat deze controle moet tegenhouden: een " +
          "lokale-test- of devnet-wegwerp-build die voor een deploybare devnet-.so " +
          "wordt aangezien."
      );
    }
  }
  if (foundAny) {
    process.exit(1);
  }

  console.log(
    `OK (geen bekende test-/wegwerpadressen aangetroffen): gecontroleerd tegen ` +
      `${localIdentities.length} bekende identiteit(en) uit ${keypairStore}.`
  );
  console.log("ALLE CONTROLES GESLAAGD.");
}

main();
