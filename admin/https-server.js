// Minimale HTTPS-static-server voor wallet-signer.html - alleen nodig omdat
// wallet-signer.html op window.isSecureContext leunt (WebAuthn/Wallet
// Standard vereisen dat), en een self-signed certificaat is voldoende voor
// intern LAN-gebruik door de multisig-signers zelf. Zie README.md in deze
// map voor wanneer en hoe dit te gebruiken.
const https = require("https");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = __dirname;

// STATUS.md sectie 181 (review 84025ce, M1/L1): standaard alleen loopback.
// ADMIN_HTTPS_HOST (een IP-adres, bijv. 0.0.0.0 voor de telefoonroute) en
// ADMIN_HTTPS_PORT (1-65535) worden strikt gecontroleerd; anders stopt de
// server met een duidelijke fout, vóór hij iets leest of opent.
function parseListenConfig(env) {
  const host = env.ADMIN_HTTPS_HOST ?? "127.0.0.1";
  if (net.isIP(host) === 0) throw new Error(`ADMIN_HTTPS_HOST ${JSON.stringify(host)} is geen IP-adres (bijv. 127.0.0.1 of 0.0.0.0)`);
  const portText = env.ADMIN_HTTPS_PORT ?? "8766";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`ADMIN_HTTPS_PORT ${JSON.stringify(portText)} is geen poort (alleen cijfers, 1 tot en met 65535)`);
  return { host, port };
}

const isLoopback = (host) => (net.isIPv4(host) && host.startsWith("127.")) || host === "::1";

// STATUS.md sectie 180: de Helius-sleutel staat niet meer in git, maar in een
// lokaal bestand (rechten 600, eigen eigenaar, alleen een UUID). Eén keer
// gelezen bij het starten; het pad komt nooit uit een verzoek. Elke afwijking
// geeft één waarschuwing zonder inhoud, en /config.js valt terug op de
// gecommitte admin/config.js, die alleen een fout gooit.
const DEFAULT_KEY_FILE =
  process.env.SPANKWALLET_HELIUS_KEY_FILE ?? path.join(os.homedir(), ".config", "spankwallet", "helius-devnet.key");
const KEY_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n?$/i;

function loadLocalConfig(keyFile, { uid = process.getuid(), warn = console.warn } = {}) {
  const fallback = (reason) => {
    warn(`WAARSCHUWING: geen lokale Helius-sleutel (${keyFile}: ${reason}); /config.js valt terug op admin/config.js, de pagina meldt een fout.`);
    return null;
  };
  let fd;
  try {
    // O_NOFOLLOW: een symlink wordt geweigerd, niet gevolgd. O_NONBLOCK: een
    // FIFO op dit pad laat het starten niet hangen (§181, L2); fstat weigert hem.
    fd = fs.openSync(keyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    return fallback(err.code === "ENOENT" ? "bestand ontbreekt" : `niet te openen (${err.code})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return fallback("geen gewoon bestand");
    if ((st.mode & 0o777) !== 0o600) return fallback(`rechten ${(st.mode & 0o777).toString(8)}, verwacht 600`);
    if (st.uid !== uid) return fallback("eigenaar is niet deze gebruiker");
    const match = fs.readFileSync(fd, "utf8").match(KEY_PATTERN);
    if (!match) return fallback("inhoud is geen UUID");
    return Buffer.from(`export const HELIUS_API_KEY = "${match[1]}";\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

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
  // STATUS.md sectie 107/109/180: de Helius-sleutel staat niet in
  // wallet-signer.html. Sinds sectie 180 komt de inhoud van /config.js uit
  // het lokale sleutelbestand (loadLocalConfig hierboven); alleen als dat
  // ontbreekt of afwijkt, wordt dit gecommitte bestand geserveerd.
  "config.js": { file: "config.js", contentType: "text/javascript" },
  // STATUS.md sectie 168: voorstelselectie, gedeeld met scripts/checkProposalTimelock.ts.
  "upgradeProposalCheck.mjs": { file: "upgradeProposalCheck.mjs", contentType: "text/javascript" },
  // STATUS.md sectie 146: los gevendorde buffer@6.0.3-polyfill (window.Buffer),
  // vereist door @sqds/multisig/@solana/web3.js maar sinds de esm.sh->esbuild-
  // vendoring van sectie 107/109 niet meer automatisch aanwezig in de browser.
  "vendor/buffer.mjs": { file: "vendor/buffer.mjs", contentType: "text/javascript" },
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
  // Object.hasOwn: "/constructor", "/__proto__" enz. gaven anders een geërfde
  // waarde, en path.join(ROOT, undefined) liet de server stoppen (§181, M2).
  if (!Object.hasOwn(ALLOWED_FILES, requestedName)) return null;
  return ALLOWED_FILES[requestedName];
}

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0",
};

// localConfig: de Buffer van loadLocalConfig, of null voor de terugval.
const createRequestHandler = (localConfig) => (req, res) => {
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
  if (entry.file === "config.js" && localConfig) {
    res.writeHead(200, { "Content-Type": entry.contentType, ...NO_CACHE_HEADERS });
    res.end(localConfig);
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
    res.writeHead(200, { "Content-Type": entry.contentType, ...NO_CACHE_HEADERS });
    res.end(data);
  });
};

// tlsOptions alleen voor de tests (zonder certificaat); anders key.pem/cert.pem.
function main(env = process.env, { tlsOptions, log = console.log, warn = console.warn } = {}) {
  const { host, port } = parseListenConfig(env);
  const keyFile = env.SPANKWALLET_HELIUS_KEY_FILE ?? DEFAULT_KEY_FILE;
  const localConfig = loadLocalConfig(keyFile, { warn });
  if (localConfig) log(`Lokale Helius-sleutel geladen uit ${keyFile}.`);
  if (!isLoopback(host)) {
    warn(`WAARSCHUWING: luistert op ${host}, niet alleen loopback: /config.js geeft de Helius-sleutel aan het hele netwerk. Alleen op het eigen thuisnetwerk, nooit op een vreemd wifi.`);
  }
  const options = tlsOptions ?? {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
  };
  const server = https.createServer(options, createRequestHandler(localConfig));
  server.listen(port, host, () => {
    log(`HTTPS-server draait op https://${host}:${port}`);
  });
  return server;
}

module.exports = { loadLocalConfig, createRequestHandler, parseListenConfig, main, DEFAULT_KEY_FILE };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`FOUT: ${err.message}`);
    process.exit(2);
  }
}
