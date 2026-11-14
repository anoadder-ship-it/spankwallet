import { assert } from "chai";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * STATUS.md sectie 194: de Helius-sleutel is een geheim en staat nooit in de
 * broncode (de vaste terugvalwaarde in client/ en desktop/ is weg, §180/§188/
 * §192). Een Helius-sleutel heeft de vorm van een UUID, en in de gescande
 * bestanden staat verder geen enkele UUID. Daarom is de regel streng: geen
 * enkele UUID-literal (hoofdletterongevoelig), waar ook op de regel.
 *
 * De eerste versie van deze test zocht alleen een UUID direct na `api-key=` of
 * kort na `helius-rpc.com`. Die bleef groen op de oorspronkelijke code van
 * cd21a90, want daar stond de sleutel als losse terugvalconstante
 * (`?? "<uuid>"` in main.ts, `None => "<uuid>"` in rpc.rs). Deze regel vangt
 * die vorm wel (§194).
 *
 * Gescand: de mappen in SCAN_DIRS en de html-, json- en configbestanden van
 * client en desktop in SCAN_FILES. Bronlijst: `git ls-files --cached --others
 * --exclude-standard`, dus gevolgde bestanden én nieuwe bestanden die nog niet
 * zijn toegevoegd; genegeerde bestanden zoals client/.env.local en
 * desktop/src-tauri/.cargo/config.toml niet, want daar hoort de sleutel juist.
 *
 * Dit bestand bevat zelf geen UUID: het patroon wordt uit losse delen
 * opgebouwd en de controle op de detector gebruikt randomUUID(). Een treffer
 * wordt gemeld met bestand en regelnummer, nooit met de waarde.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["client/src", "desktop/src", "desktop/src-tauri/src", "desktop/src-tauri/capabilities", "scripts"];
const SCAN_FILES = [
  "client/index.html",
  "client/vite.config.ts",
  "client/tsconfig.json",
  "client/.npmrc",
  "desktop/index.html",
  "desktop/vite.config.ts",
  "desktop/tsconfig.json",
  "desktop/.npmrc",
  "desktop/src-tauri/tauri.conf.json",
  "desktop/src-tauri/build.rs",
];

const HEX = "[0-9a-f]";
const UUID_PATTERN = new RegExp(`${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`, "i");

function findUuidLines(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((text, i) => {
    if (UUID_PATTERN.test(text)) lines.push(i + 1);
  });
  return lines;
}

function listFiles(): string[] {
  const res = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_DIRS, ...SCAN_FILES],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.strictEqual(res.status, 0, `git ls-files faalde: ${res.stderr}`);
  return res.stdout.split("\0").filter((f) => f !== "" && fs.existsSync(path.join(ROOT, f)));
}

describe("geen UUID-literal (Helius-sleutelvorm) in client, desktop of scripts (STATUS.md sectie 194)", () => {
  it("de detector herkent een UUID in elke vorm en positie, en niet een sjabloon of een kortere waarde", () => {
    const fake = randomUUID();
    // De vormen van de oorspronkelijke terugvalwaarde (cd21a90).
    assert.deepEqual(findUuidLines(`const K = import.meta.env.VITE_HELIUS_API_KEY ?? "${fake}";`), [1]);
    assert.deepEqual(findUuidLines(`        None => "${fake}",`), [1]);
    // Hoofdletters, in een URL, en het regelnummer klopt.
    assert.deepEqual(findUuidLines(`// regel 1\nconst u = "https://devnet.helius-rpc.com/?api-key=${fake.toUpperCase()}";`), [2]);
    assert.deepEqual(findUuidLines(`format!("https://x.example/?api_key=${fake}")`), [1]);
    // Geen treffer: sjablonen en een te korte waarde.
    assert.deepEqual(findUuidLines("new URL(`https://devnet.helius-rpc.com/?api-key=${key}`)"), []);
    assert.deepEqual(findUuidLines('format!("https://devnet.helius-rpc.com/?api-key={key}")'), []);
    assert.deepEqual(findUuidLines(`"${fake.slice(0, 35)}"`), []);
  });

  it("de bronlijst bevat de bestanden met de Helius-URL, de desktopfrontend en de html- en configbestanden", () => {
    const files = listFiles();
    for (const f of [
      "client/src/main.ts",
      "desktop/src-tauri/src/rpc.rs",
      "desktop/src/main.ts",
      "client/index.html",
      "client/vite.config.ts",
      "desktop/index.html",
      "desktop/vite.config.ts",
      "desktop/src-tauri/tauri.conf.json",
    ]) {
      assert.include(files, f);
    }
  });

  it("geen bestand bevat een UUID-literal", () => {
    const offenders: string[] = [];
    for (const file of listFiles()) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const line of findUuidLines(source)) offenders.push(`${file}:${line}`);
    }
    assert.deepEqual(offenders, [], `UUID-literal gevonden (waarde niet getoond): ${offenders.join(", ")}`);
  });
});
