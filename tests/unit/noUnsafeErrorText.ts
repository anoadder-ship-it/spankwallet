import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * STATUS.md sectie 198. De desktop maakt foutteksten alleen via
 * desktop/src/errorText.ts (errorText en errorKind gooien nooit). Eerder
 * stond op drie plekken `typeof err?.message === "string" ? err.message :
 * JSON.stringify(err)`; JSON.stringify kan zelf gooien (BigInt,
 * kringverwijzing, toJSON of getter die gooit). De kaarttests in errorText.ts
 * dekken feePayerSetupCard.ts en feePayerUnlockCard.ts, niet de logregel in
 * main.ts; deze bron-controle dekt alle bestanden in desktop/src.
 *
 * Verboden buiten desktop/src/errorText.ts, in elke regel die geen
 * commentaar is:
 * - `JSON.stringify(err)` (ook `e` of `error` als naam);
 * - `typeof X?.message === "string" ? X.message : JSON.stringify(`.
 * Commentaar telt niet mee: regels binnen een blokcommentaar (`/* ... *\/`),
 * regels die met `*` beginnen (vervolgregels van een blokcommentaar) en
 * regels die met `//` beginnen. Code achter een `//` op dezelfde regel
 * wordt ook genegeerd.
 */

const ROOT = process.cwd();
const DESKTOP_SRC = path.join(ROOT, "desktop", "src");
const ALLOWED = "errorText.ts";

const FORBIDDEN: [RegExp, string][] = [
  [/JSON\.stringify\(\s*(err|e|error)\s*\)/, "JSON.stringify(err)"],
  [
    /typeof\s+(\w+)\?\.message\s*===\s*(["'`])string\2\s*\?\s*\1\.message\s*:\s*JSON\.stringify\(/,
    'typeof err?.message === "string" ? err.message : JSON.stringify(...)',
  ],
];

/** Code zonder commentaar, per regel (regelnummers blijven gelijk). */
function codeLines(source: string): string[] {
  let inBlock = false;
  return source.split("\n").map((line) => {
    // Een regel die met `*` begint, is een vervolgregel van een blokcommentaar
    // (ook als de opening buiten het gelezen stuk valt).
    if (!inBlock && /^\s*\*/.test(line)) return "";
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const block = line.indexOf("/*", i);
      const lineComment = line.indexOf("//", i);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        return out + line.slice(i, lineComment);
      }
      if (block === -1) return out + line.slice(i);
      out += line.slice(i, block);
      inBlock = true;
      i = block + 2;
    }
    return out;
  });
}

function findOffenders(source: string): { line: number; what: string }[] {
  const hits: { line: number; what: string }[] = [];
  codeLines(source).forEach((code, i) => {
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(code)) hits.push({ line: i + 1, what });
    }
  });
  return hits;
}

function desktopSources(): string[] {
  return fs
    .readdirSync(DESKTOP_SRC)
    .filter((f) => f.endsWith(".ts") && f !== ALLOWED)
    .sort();
}

describe("desktop/src maakt foutteksten alleen via errorText.ts (STATUS.md sectie 198)", () => {
  it("de detector vindt de oude regels en negeert commentaar", () => {
    // De twee vormen van vóór f7e18de (main.ts en feePayerUnlockCard.ts).
    assert.lengthOf(
      findOffenders('    const message = typeof err?.message === "string" ? err.message : JSON.stringify(err);'),
      2
    );
    assert.deepEqual(
      findOffenders('x\n          : typeof err?.message === "string"\n            ? err.message\n            : JSON.stringify(err);').map(
        (h) => h.line
      ),
      [4]
    );
    assert.lengthOf(findOffenders("log(JSON.stringify( error ));"), 1);
    assert.lengthOf(findOffenders("const t = typeof e?.message === 'string' ? e.message : JSON.stringify(e, null, 2);"), 1);
    // Commentaar telt niet mee.
    assert.deepEqual(findOffenders(" * gaven `JSON.stringify(err)` mee, en dat is"), []);
    assert.deepEqual(findOffenders("/**\n * JSON.stringify(err)\n */\nconst a = 1;"), []);
    assert.deepEqual(findOffenders("// JSON.stringify(err)"), []);
    assert.deepEqual(findOffenders("const a = 1; // JSON.stringify(err)"), []);
    assert.deepEqual(findOffenders("/* JSON.stringify(err) */ const a = 1;"), []);
    // Maar code na een gesloten blokcommentaar wel.
    assert.lengthOf(findOffenders("/* x */ JSON.stringify(err);"), 1);
    // Andere JSON.stringify-aanroepen zijn toegestaan.
    assert.deepEqual(findOffenders("JSON.stringify(expected)"), []);
    assert.deepEqual(findOffenders("JSON.stringify(errors)"), []);
  });

  it("de gescande bestanden bevatten main.ts en de twee fee-payer-kaarten, niet errorText.ts", () => {
    const files = desktopSources();
    for (const f of ["main.ts", "feePayerSetupCard.ts", "feePayerUnlockCard.ts", "confirmationCard.ts"]) {
      assert.include(files, f);
    }
    assert.notInclude(files, ALLOWED);
  });

  it("geen bestand in desktop/src buiten errorText.ts bevat de oude foutregel", () => {
    const offenders: string[] = [];
    for (const file of desktopSources()) {
      const source = fs.readFileSync(path.join(DESKTOP_SRC, file), "utf8");
      for (const hit of findOffenders(source)) offenders.push(`desktop/src/${file}:${hit.line} (${hit.what})`);
    }
    assert.deepEqual(offenders, [], `gebruik errorText uit desktop/src/errorText.ts: ${offenders.join(", ")}`);
  });
});
