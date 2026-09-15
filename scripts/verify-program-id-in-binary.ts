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
//   2. NEGATIEF: GEEN van de bekende test-/wegwerpadressen mag voorkomen -
//      zowel lokale-validator-testadressen als devnet-wegwerpdeploys
//      (STATUS.md sectie 87: 2NHovxaquuaf1RsPsKAPk9rVAcN4ntfoFCiHWYhpCAp8,
//      de B1-B7-throwaway-deploy). Dit is de controle die de daadwerkelijke
//      voetangel tegenhoudt: een test-artefact dat voor een deploybare
//      devnet-.so wordt aangezien (zie STATUS.md - "de .so is een
//      valstrik"-sectie). Twee, elkaar aanvullende bronnen, want niet elk
//      bekend wegwerpadres heeft een bewaarde private key:
//        a. ${XDG_CONFIG_HOME:-~/.config}/spankwallet/program-keypairs/ -
//           volledige keypairs (secret key nodig geweest/nog nodig voor
//           iets anders). Bestaat de map niet, dan is dat geen fout - dit
//           deel wordt dan expliciet (niet stilzwijgend) overgeslagen.
//        b. scripts/historical-throwaway-program-ids.json (WEL gecommit,
//           bevat UITSLUITEND publieke adressen, nooit secrets) - voor
//           wegwerpadressen waarvan de private key bewust nooit bewaard is
//           (STATUS.md sectie 140/143: EwBHjzFCt9inNb9WBWeZjV4fcQ925GHWNp-
//           jNaaZgXkj3, deel 2's eenmalige devnet-rooktest-adres). Ontbreekt
//           dit bestand, dan is dat ook geen fout - alleen (a) draait dan.
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

  type KnownIdentity = { label: string; pubkey: string; bytes: Buffer };
  const knownIdentities: KnownIdentity[] = [];

  // Bron (a): volledige keypairs (secret key ooit nodig geweest/nog nodig).
  if (fs.existsSync(keypairStore)) {
    const keypairFiles = fs.readdirSync(keypairStore).filter((f) => f.endsWith("-keypair.json"));
    for (const file of keypairFiles) {
      const fullPath = path.join(keypairStore, file);
      let keypair: Keypair;
      try {
        const secret = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
      } catch {
        fail(`FOUT (ongeldig keypair-bestand): ${fullPath} kon niet gelezen worden als een geldig Solana-keypair.`);
        return;
      }
      knownIdentities.push({
        label: `${keypair.publicKey.toBase58()} (uit ${file})`,
        pubkey: keypair.publicKey.toBase58(),
        bytes: Buffer.from(keypair.publicKey.toBytes()),
      });
    }
    if (keypairFiles.length === 0) {
      console.log(`MELDING: ${keypairStore} bestaat, maar bevat geen *-keypair.json-bestanden.`);
    }
  } else {
    console.log(`MELDING: ${keypairStore} bestaat niet - dit deel van de negatieve controle wordt overgeslagen.`);
  }

  // Bron (b): publieke-adressen-manifest (geen secrets) - voor wegwerpadressen
  // waarvan de private key bewust nooit bewaard is.
  const manifestPath = path.join(__dirname, "historical-throwaway-program-ids.json");
  if (fs.existsSync(manifestPath)) {
    let manifest: Array<{ address: string; description?: string }>;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      fail(`FOUT (ongeldig manifest): ${manifestPath} kon niet gelezen worden als geldige JSON.`);
      return;
    }
    for (const entry of manifest) {
      let pk: PublicKey;
      try {
        pk = new PublicKey(entry.address);
      } catch {
        fail(`FOUT (ongeldig adres in manifest): "${entry.address}" in ${manifestPath} is geen geldig base58-adres.`);
        return;
      }
      knownIdentities.push({
        label: `${entry.address} (uit ${path.basename(manifestPath)}${entry.description ? ": " + entry.description : ""})`,
        pubkey: entry.address,
        bytes: Buffer.from(pk.toBytes()),
      });
    }
  } else {
    console.log(`MELDING: ${manifestPath} bestaat niet - dit deel van de negatieve controle wordt overgeslagen.`);
  }

  if (knownIdentities.length === 0) {
    console.log(
      "MELDING (negatieve controle OVERGESLAGEN): geen enkele bron van bekende " +
        "test-/wegwerpadressen beschikbaar. Dit is geen fout, maar de negatieve " +
        "controle heeft in dit geval NIET gedraaid."
    );
    console.log("ALLE UITGEVOERDE CONTROLES GESLAAGD.");
    return;
  }

  let foundAny = false;
  for (const { label, bytes } of knownIdentities) {
    const offsets = findAllOccurrences(soBytes, bytes);
    if (offsets.length > 0) {
      foundAny = true;
      console.error(
        `FOUT (BEKEND TEST-/WEGWERPADRES AANGETROFFEN): ${label} komt ` +
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
      `${knownIdentities.length} bekende identiteit(en) (keypair-store + manifest).`
  );
  console.log("ALLE CONTROLES GESLAAGD.");
}

main();
