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

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
};

const server = https.createServer(options, (req, res) => {
  // req.url kan een query-string bevatten (bijv. Solflare's deep-link-
  // antwoord: "/?nonce=...&data=..."). Eerder werd req.url === "/" pas
  // gecontroleerd VOORDAT de query-string eraf ging, dus "/?nonce=..."
  // faalde die vergelijking en viel door naar het lezen van ROOT zelf (een
  // map, geen bestand) - EISDIR, dus 404. Eerst het pathname isoleren, dan
  // pas vergelijken.
  const pathname = req.url.split("?")[0];
  let filePath = path.join(ROOT, pathname === "/" ? "/wallet-signer.html" : pathname);
  const ext = path.extname(filePath);

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
      "Content-Type": MIME[ext] || "application/octet-stream",
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
