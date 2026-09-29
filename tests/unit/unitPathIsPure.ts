import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * STATUS.md sectie 167: `yarn test:unit` draait zonder de bewakers uit
 * .mocharc.yml (binary-versheid, validatortype). Dat is alleen verantwoord
 * zolang niets in tests/unit/ een validator, het programma of een echte
 * cluster aanspreekt. Deze test weigert elk bestand in tests/unit/ dat daar
 * een ingang voor heeft; zo'n test hoort in tests/, onder de bewakers.
 */

const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']@coral-xyz\/anchor/, "Anchor-client (praat met een validator)"],
  [/from\s+["'][^"']*(webauthnTestHelper|verifyBinaryFresh|verifyValidatorType)/, "validator-testhelpers"],
  [/:8899\b|localhost:\d|api\.(devnet|mainnet-beta|testnet)\.solana\.com/, "vast RPC-adres"],
  [/\bnew Connection\(/, "eigen RPC-verbinding"],
];

describe("tests/unit bevat alleen tests zonder validator of echte cluster (STATUS.md sectie 167)", () => {
  // process.cwd(), niet __dirname: zie tests/verifyBinaryFresh.ts (ES-modulescope).
  const dir = path.join(process.cwd(), "tests", "unit");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "unitPathIsPure.ts");

  it("er staan testbestanden in tests/unit", () => {
    assert.isAbove(files.length, 0);
  });

  for (const file of files) {
    it(`${file} heeft geen ingang naar een validator of cluster`, () => {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const [pattern, what] of FORBIDDEN) {
        assert.notMatch(source, pattern, `${file}: ${what}`);
      }
    });
  }
});
