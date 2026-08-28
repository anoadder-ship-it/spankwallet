// Minimale HTTPS-static-server voor wallet-signer.html - alleen nodig omdat
// wallet-signer.html op window.isSecureContext leunt (WebAuthn/Wallet
// Standard vereisen dat), en een self-signed certificaat is voldoende voor
// intern LAN-gebruik door de multisig-signers zelf. Zie README.md in deze
// map voor wanneer en hoe dit te gebruiken.
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 8766;
const ROOT = __dirname;

const options = {
  key: fs.readFileSync(path.join(__dirname, "key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
};

// Allowlist i.p.v. "elk bestand in ROOT, tenzij een blacklist het
// tegenhoudt" - deze server serveert bewust maar EEN bestand
// (wallet-signer.html is doelbewust een enkel, zelfstandig HTML-bestand
// zonder losse <script src=.../<link href=..>-verwijzingen, geverifieerd
// via grep - geen enkele legitieme reden om iets anders te serveren).
// Dit dicht in een keer twee reele, empirisch bevestigde problemen:
//
// 1. CodeQL "Uncontrolled data used in path expression" (high) - de
//    oorspronkelijke code deed fs.readFile(path.join(ROOT, req.url)) zonder
//    enige sanitatie. path.join() normaliseert "../" niet weg tot buiten
//    het samengevoegde pad - met genoeg "../"-segmenten kwam het resultaat
//    buiten ROOT terecht. Empirisch bevestigd exploiteerbaar (niet
//    aangenomen): `curl --path-as-is "https://host:8766/../../../../etc/
//    hostname"` gaf de inhoud van /etc/hostname terug, HTTP 200. Deze
//    server bindt bewust op 0.0.0.0 (LAN-signers moeten erbij kunnen), dus
//    dit was door IEDEREEN op hetzelfde LAN te misbruiken om elk bestand
//    te lezen dat de proces-gebruiker kan lezen.
// 2. Onafhankelijk, apart ontdekt tijdens het onderzoeken van (1), NIET in
//    de CodeQL-scan: zonder ENIGE traversal was `key.pem` (de TLS-
//    PRIVESLEUTEL van dit zelfondertekende certificaat, 0600) al gewoon
//    rechtstreeks op te vragen als `https://host:8766/key.pem` - het stond
//    immers gewoon in ROOT naast wallet-signer.html, en de oude code had
//    geen enkele beperking op WELKE bestandsnamen ze diende. Empirisch
//    bevestigd: `curl -sk https://127.0.0.1:8766/key.pem` gaf de volledige
//    PEM-inhoud terug, HTTP 200.
//
// Een blacklist (bv. "geen .pem-bestanden") had probleem 2 opgelost maar
// blijft kwetsbaar voor toekomstige nieuwe bestanden in deze map; een
// resolved-path-prefixcheck had probleem 1 opgelost maar NIET probleem 2
// (key.pem staat binnen ROOT, geen traversal nodig). Een allowlist van
// precies de benodigde bestandsnamen sluit beide structureel af, ongeacht
// wat er ooit nog aan bestanden in deze map bijkomt.
// STATUS.md sectie 107/109: de zes esm.sh-CDN-imports zijn lokaal
// gevendored (`vendor/*.mjs`, eenmalig gebouwd met esbuild) - dezelfde
// allowlist-discipline als hierboven beargumenteerd geldt onverkort voor
// deze nieuwe bestanden: elk exact bij naam toegevoegd, geen
// directory-wildcard (die zou de hele allowlist-redenering ondermijnen).
const ALLOWED_FILES = {
  "wallet-signer.html": { file: "wallet-signer.html", contentType: "text/html" },
  "vendor/web3.mjs": { file: "vendor/web3.mjs", contentType: "text/javascript" },
  "vendor/multisig.mjs": { file: "vendor/multisig.mjs", contentType: "text/javascript" },
  "vendor/wallet-standard-app.mjs": { file: "vendor/wallet-standard-app.mjs", contentType: "text/javascript" },
  "vendor/bs58.mjs": { file: "vendor/bs58.mjs", contentType: "text/javascript" },
  "vendor/tweetnacl.mjs": { file: "vendor/tweetnacl.mjs", contentType: "text/javascript" },
  "vendor/wallet-standard-mobile.mjs": { file: "vendor/wallet-standard-mobile.mjs", contentType: "text/javascript" },
  // De drie chunk-<hash>-bestanden zijn esbuild's automatisch gesplitste,
  // GEDEELDE modules (bijv. @solana/web3.js zelf, dat zowel web3.mjs als
  // multisig.mjs rechtstreeks nodig hebben - dezelfde module-instantie,
  // dus dezelfde PublicKey-klasse, i.p.v. twee losse kopieen die elkaars
  // `instanceof`-checks zouden breken). De hash verandert bij elke
  // rebuild - bij een toekomstige `npx esbuild ...`-hertaal van vendor/
  // (bijv. een libraryversie-bump) MOETEN deze drie regels mee-updaten
  // naar de nieuwe bestandsnamen, anders serveert deze allowlist een
  // niet-meer-bestaand chunk-bestand.
  "vendor/chunk-IYJ5Z2CH.mjs": { file: "vendor/chunk-IYJ5Z2CH.mjs", contentType: "text/javascript" },
  "vendor/chunk-HDN7WHJK.mjs": { file: "vendor/chunk-HDN7WHJK.mjs", contentType: "text/javascript" },
  "vendor/chunk-KLMJEOXW.mjs": { file: "vendor/chunk-KLMJEOXW.mjs", contentType: "text/javascript" },
};

function resolveAllowedFile(pathname) {
  const requestedName = pathname === "/" ? "wallet-signer.html" : pathname.replace(/^\//, "");
  const entry = ALLOWED_FILES[requestedName];
  if (!entry) return null;
  return entry;
}

const server = https.createServer(options, (req, res) => {
  // req.url kan een query-string bevatten (bijv. Solflare's deep-link-
  // antwoord: "/?nonce=...&data=..."). Eerder werd req.url === "/" pas
  // gecontroleerd VOORDAT de query-string eraf ging, dus "/?nonce=..."
  // faalde die vergelijking en viel door naar het lezen van ROOT zelf (een
  // map, geen bestand) - EISDIR, dus 404. Eerst het pathname isoleren, dan
  // pas vergelijken.
  const pathname = req.url.split("?")[0];
  const entry = resolveAllowedFile(pathname);
  if (!entry) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const filePath = path.join(ROOT, entry.file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    // Expliciet no-cache: elke deep-link-terugkeer is een GET naar exact
    // dezelfde URL, en zonder deze headers kan een browser (met name MIUI/
    // HyperOS, al eerder in dit project bevestigd als non-standaard
    // agressief) een verouderde gecachte versie van deze pagina serveren
    // i.p.v. hem vers op te halen - waardoor knopklikken een oudere,
    // mogelijk gefixte bug opnieuw zouden kunnen vertonen zonder dat dat
    // duidelijk is.
    res.writeHead(200, {
      "Content-Type": entry.contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTPS-server draait op https://0.0.0.0:${PORT}`);
});
