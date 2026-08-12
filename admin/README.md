# admin/ — Squads-ondertekenpagina voor SpankWallet's upgrade-authority

**Dit heeft niets te maken met SpankWallet's eigen wallet-functionaliteit** (die staat in
`client/`). Deze map bevat het interne beheertool waarmee de 3 multisig-signers een
upgrade van het SpankWallet-*programma zelf* voorstellen, goedkeuren en uitvoeren, via de
2-of-3 Squads V4-multisig met 72u-timelock die sinds STATUS.md sectie 41-46 de
upgrade-authority beheert. Zie de "Kritieke gotchas"-sectie bovenaan STATUS.md voor de
naamsverwarring dit veroorzaakte ("execute" betekent hier iets anders dan in `client/`) -
vandaar de knop-/functienamen hieronder met een `squads-`/`Squads`-voorvoegsel.

## Wanneer dit gebruiken

Uitsluitend bij een toekomstige upgrade van het gedeployde SpankWallet-programma op
devnet (of later, mainnet). Niet nodig voor gewoon gebruik van de wallet zelf - daarvoor
is `client/` de juiste plek.

## Hoe te gebruiken

1. **Bouw en bufferzet de nieuwe programmaversie** zoals beschreven in README.md's
   "Deployen naar devnet"-sectie: `anchor build` (IDL/types) gevolgd door
   `cargo-build-sbf --arch v3` (het daadwerkelijke binary), dan `solana program write-buffer`
   en de buffer-authority overdragen aan de vault-PDA. Werk de `BUFFER`-constante in
   `wallet-signer.html` bij naar het nieuwe buffer-adres.
2. **Genereer een self-signed certificaat** (eenmalig, of opnieuw als het verlopen is -
   standaard 7 dagen geldig):
   ```
   openssl req -x509 -newkey rsa:2048 -keyout admin/key.pem -cert admin/cert.pem \
     -days 7 -nodes -subj "/CN=<jouw-LAN-IP>" \
     -addext "subjectAltName=IP:<jouw-LAN-IP>,IP:127.0.0.1,DNS:localhost"
   ```
   `key.pem`/`cert.pem` zijn bewust gitignored (`admin/*.pem`) - nooit committen, altijd
   lokaal opnieuw genereren.
3. **Start de server:** `node admin/https-server.js` (poort 8766, bindt op `0.0.0.0` zodat
   andere apparaten op hetzelfde LAN erbij kunnen).
4. **Elke signer bezoekt** `https://<jouw-LAN-IP>:8766/wallet-signer.html` op zijn eigen
   apparaat (self-signed-certificaatwaarschuwing accepteren), verbindt zijn wallet (knop 1,
   of knop 1b voor Solflare-mobiel via het deep-link-protocol), en doorloopt
   voorstellen/goedkeuren/uitvoeren (knoppen 2-4) zoals de pagina zelf aangeeft.
5. **Geen enkele private key verlaat ooit een apparaat** - alle drie de ondertekenpaden
   (Wallet Standard, Mobile Wallet Adapter, Solflare-deep-link) laten de wallet-extensie of
   -app zelf ondertekenen. Dit was een expliciete eis bij de echte migratie (in
   tegenstelling tot de devnet-generale-repetitie op een wegwerpprogramma, waar
   wegwerpsleutels wél tijdelijk geëxporteerd zijn - zie STATUS.md sectie 41).

## Bekende beperkingen

- Eén HTML-bestand met inline `<script>`/`<style>`, dus de CSP staat noodgedwongen
  `'unsafe-inline'` toe - minder streng dan `client/`'s CSP. Zie de toelichting in
  `wallet-signer.html`'s eigen `<head>`.
- Certora/CVLR-achtige formele garanties zijn hier niet van toepassing - dit is een
  operationeel hulpmiddel, geen on-chain programma.
- Werkt alleen zolang de CDN-imports (esm.sh) en de Helius-RPC-URL bereikbaar zijn -
  beide hardcoded bovenin `wallet-signer.html`.
