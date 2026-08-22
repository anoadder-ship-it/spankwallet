// verifyValidatorType.ts — structurele validator-detectie, zelfde patroon
// als EIS 1's binary-versheidscontrole (verifyBinaryFresh.ts): faalt hard,
// VOORDAT er ook maar één test draait, onafhankelijk van hoe mocha wordt
// aangeroepen (`anchor test`, `yarn test`, `ts-mocha` rechtstreeks).
//
// AANLEIDING (STATUS.md, hunt-rentsplitsing-sectie): deze anchor-cli-fork
// heeft `#[clap(value_enum, long, default_value = "surfpool")]` op de
// `--validator`-vlag (letterlijk zo in de fork's eigen broncode,
// `cli/src/lib.rs`) - een KALE `anchor test`, zonder enige vlag, kiest
// daardoor in DEZE workspace altijd surfpool, nooit een echte
// `solana-test-validator`. Ontdekt doordat surfpool's gerapporteerde
// `meta.fee` niet overeenkwam met wat daadwerkelijk werd ingehouden (5000
// lamport verschil in de hunt-rentsplitsingstest, zie STATUS.md) - surfpool
// is dus niet zomaar "een andere validator", de fee-boekhouding die deze
// testsuite op lamport-niveau controleert is er aantoonbaar onbetrouwbaar.
// `package.json`'s `test`-script dekt dit af (`--validator legacy`), maar
// een kale `anchor test` (of `ts-mocha` rechtstreeks) blijft op surfpool
// staan - een grens van de tooling zelf, niet script-side op te lossen.
// Deze module is de vangnet-laag.
//
// FAIL-CLOSED, GEEN BLOKKEERLIJST: dit eist POSITIEF bewijs dat de RPC-
// endpoint een echte solana-core-validator is (een geldige `solana-core`-
// versiestring in `getVersion()`, ÉN geen van surfpool's eigen signalen).
// Alles wat niet aan dat positieve bewijs voldoet - onbereikbare RPC,
// timeout, een onverwachte/lege/misvormde respons, een `getVersion()`
// zonder `solana-core`-veld - weigert net zo hard als herkend surfpool. Een
// eerdere versie blokkeerde uitsluitend bij HERKENDE surfpool-signalen (een
// blokkeerlijst) - exact het patroon waarmee surfpool hier ongemerkt kon
// binnenkomen: een derde, niet-herkende validator-implementatie zou zo'n
// blokkeerlijst evengoed ongemerkt gepasseerd zijn. Herkenning van surfpool
// specifiek blijft alleen behouden om de foutmelding preciezer te maken,
// nooit als voorwaarde om te blokkeren.
//
// SURFPOOL-SIGNALEN, EMPIRISCH GEVERIFIEERD (niet aangenomen) tegen zowel
// een echte `solana-test-validator` als `surfpool` (STATUS.md): surfpool's
// `getVersion`-antwoord bevat een `surfnet-version`-sleutel die een echte
// agave-validator nooit teruggeeft, EN surfpool's `getIdentity` retourneert
// altijd de vaste vanity-string
// "SUrFPooLSUrFPooLSUrFPooLSUrFPooLSUrFPooLSUr" (geen per-run-willekeurige
// validator-identiteit zoals een echte validator).

import * as http from "http";
import * as https from "https";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const SURFPOOL_IDENTITY = "SUrFPooLSUrFPooLSUrFPooLSUrFPooLSUrFPooLSUr";

const ACTIONABLE_ADVICE =
  "In deze workspace kiest een KALE `anchor test` (of `ts-mocha` rechtstreeks,\n" +
  "zonder --validator) altijd surfpool - de anchor-cli-fork die hier\n" +
  "geïnstalleerd is, heeft `default_value = \"surfpool\"` hardcoded op die vlag.\n" +
  "Surfpool's `meta.fee` bleek in de praktijk niet overeen te komen met wat\n" +
  "daadwerkelijk werd ingehouden (STATUS.md, hunt-rentsplitsing-sectie) - een\n" +
  "testresultaat hiertegen bewijst niets over gedrag tegen een echte validator,\n" +
  "deze suite controleert lamportbedragen op de byte.\n" +
  "\n" +
  "Draai in plaats daarvan:\n" +
  "  yarn test   (of: npm test)      - bakt --validator legacy al in\n" +
  "of handmatig:\n" +
  "  solana-test-validator --reset --gossip-port 8001   (aparte, open terminal)\n" +
  "  ./scripts/build-and-deploy.sh\n" +
  "  anchor test --skip-local-validator --skip-build --skip-deploy\n" +
  "(STATUS.md sectie 5 voor de volledige workflow).";

function rpcCall(method: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(RPC_URL);
    const transport = url.protocol === "https:" ? https : http;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method });
    const req = transport.request(
      RPC_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Kon RPC-antwoord op ${method} niet parsen als JSON: ${data}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`RPC-aanroep ${method} naar ${RPC_URL} liep vast (timeout)`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function mochaGlobalSetup(): Promise<void> {
  let versionResult: any = null;
  let identityResult: any = null;
  let rpcError: string | null = null;

  try {
    const [versionResponse, identityResponse] = await Promise.all([
      rpcCall("getVersion"),
      rpcCall("getIdentity"),
    ]);
    versionResult = versionResponse?.result ?? null;
    identityResult = identityResponse?.result?.identity ?? null;
  } catch (err: any) {
    rpcError = err?.message ?? String(err);
  }

  // Positief bewijs vereist, geen afwezigheid-van-signalen: een geldige
  // solana-core-versiestring MOET aanwezig zijn. Alles anders (RPC
  // onbereikbaar, timeout, ontbrekend/misvormd getVersion-antwoord) faalt
  // hier al, los van of surfpool specifiek herkend wordt.
  const hasValidSolanaCoreVersion =
    versionResult !== null &&
    typeof versionResult === "object" &&
    typeof versionResult["solana-core"] === "string" &&
    versionResult["solana-core"].length > 0;

  const hasSurfnetVersionKey =
    versionResult !== null &&
    typeof versionResult === "object" &&
    Object.prototype.hasOwnProperty.call(versionResult, "surfnet-version");

  const hasSurfpoolIdentity = identityResult === SURFPOOL_IDENTITY;

  const isConfirmedRealValidator =
    rpcError === null && hasValidSolanaCoreVersion && !hasSurfnetVersionKey && !hasSurfpoolIdentity;

  if (!isConfirmedRealValidator) {
    const reasons: string[] = [];
    if (rpcError !== null) {
      reasons.push(`kon geen RPC-verbinding maken met ${RPC_URL} (${rpcError})`);
    } else {
      if (!hasValidSolanaCoreVersion) {
        reasons.push(
          `getVersion() bevat geen geldig "solana-core"-versieveld: ${JSON.stringify(versionResult)}`
        );
      }
      if (hasSurfnetVersionKey) {
        reasons.push('getVersion() bevat de "surfnet-version"-sleutel (uniek voor surfpool)');
      }
      if (hasSurfpoolIdentity) {
        reasons.push("getIdentity() is surfpool's vaste vanity-adres (SUrFPooL...)");
      }
    }

    throw new Error(
      "\n\nVALIDATOR-DETECTIE FAALDE: geen positief bewijs dat dit een echte\n" +
        `solana-test-validator is op ${RPC_URL}.\n` +
        reasons.map((r) => `  - ${r}`).join("\n") +
        "\n\n" +
        ACTIONABLE_ADVICE
    );
  }

  // eslint-disable-next-line no-console
  console.error(
    `[verifyValidatorType] echte validator bevestigd (${RPC_URL}): ` +
      `solana-core=${versionResult["solana-core"]}`
  );
}
