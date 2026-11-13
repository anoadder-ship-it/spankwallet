import { assert } from "chai";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * STATUS.md sectie 194: de Helius-sleutel is een geheim en staat nooit in de
 * broncode (de vaste terugvalwaarde in client/ en desktop/ is weg, §180/§188/
 * §192). Deze test faalt zodra een bestand onder client/src, desktop/src-tauri/src
 * of scripts een sleutel als letterlijke UUID bevat: na `api-key=`, of kort na
 * `helius-rpc.com` op dezelfde regel.
 *
 * Bronlijst: `git ls-files --cached --others --exclude-standard`, dus de gevolgde
 * bestanden én nieuwe bestanden die nog niet zijn toegevoegd (genegeerde bestanden
 * zoals client/.env.local niet: daar hoort de sleutel juist).
 *
 * Dit bestand bevat zelf geen UUID: het patroon wordt uit losse delen opgebouwd en
 * de controle op de detector gebruikt een willekeurige UUID uit randomUUID().
 * Een treffer wordt gemeld met bestand en regelnummer, nooit met de waarde.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["client/src", "desktop/src-tauri/src", "scripts"];

const HEX = "[0-9a-f]";
const UUID_SOURCE = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;
const KEY_PATTERNS: [RegExp, string][] = [
  [new RegExp(`api-key=["'\`]?${UUID_SOURCE}`, "i"), "api-key= gevolgd door een UUID"],
  [new RegExp(`helius-rpc\\.com[^\\n]{0,80}?${UUID_SOURCE}`, "i"), "UUID kort na helius-rpc.com"],
];

function findKeyLiterals(source: string): { line: number; what: string }[] {
  const hits: { line: number; what: string }[] = [];
  source.split("\n").forEach((text, i) => {
    for (const [pattern, what] of KEY_PATTERNS) {
      if (pattern.test(text)) hits.push({ line: i + 1, what });
    }
  });
  return hits;
}

function listFiles(): string[] {
  const res = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_DIRS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0, `git ls-files faalde: ${res.stderr}`);
  return res.stdout.split("\0").filter((f) => f !== "" && fs.existsSync(path.join(ROOT, f)));
}

describe("geen Helius-sleutel als letterlijke UUID in client, desktop of scripts (STATUS.md sectie 194)", () => {
  it("de detector herkent een sleutel na api-key= en na helius-rpc.com, en niet een sjabloon", () => {
    const fake = randomUUID();
    assert.lengthOf(findKeyLiterals(`const u = "https://devnet.helius-rpc.com/?api-key=${fake}";`), 2);
    assert.lengthOf(findKeyLiterals(`fetch("https://mainnet.helius-rpc.com/" + "${fake.toUpperCase()}")`), 1);
    assert.lengthOf(findKeyLiterals(`format!("https://x.example/?api-key=${fake}")`), 1);
    assert.lengthOf(findKeyLiterals("new URL(`https://devnet.helius-rpc.com/?api-key=${key}`)"), 0);
    assert.lengthOf(findKeyLiterals('format!("https://devnet.helius-rpc.com/?api-key={key}")'), 0);
  });

  it("de bronlijst bevat de bestanden met de Helius-URL", () => {
    const files = listFiles();
    assert.include(files, "client/src/main.ts");
    assert.include(files, "desktop/src-tauri/src/rpc.rs");
  });

  it("geen bestand bevat een sleutel als letterlijke UUID", () => {
    const offenders: string[] = [];
    for (const file of listFiles()) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const hit of findKeyLiterals(source)) offenders.push(`${file}:${hit.line} (${hit.what})`);
    }
    assert.deepEqual(offenders, [], `letterlijke sleutel gevonden (waarde niet getoond): ${offenders.join(", ")}`);
  });
});
