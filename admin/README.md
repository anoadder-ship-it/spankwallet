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
   `wallet-signer.html` bij naar het nieuwe buffer-adres, en `EXPECTED_BUFFER` (plus lengte
   en sha256 van de binary) in `scripts/checkProposalTimelock.ts`
   (docs/upgradevoorstel-sjabloon.md §1 stap 5).
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
   andere apparaten op hetzelfde LAN erbij kunnen). De allowlist wordt bij het starten
   gelezen: na een wijziging aan de bestandenlijst (sectie 168: `upgradeProposalCheck.mjs`)
   de server opnieuw starten.
4. **Elke signer bezoekt** `https://<jouw-LAN-IP>:8766/wallet-signer.html` op zijn eigen
   apparaat (self-signed-certificaatwaarschuwing accepteren), verbindt zijn wallet (knop 1,
   of knop 1b voor Solflare-mobiel via het deep-link-protocol), en doorloopt
   voorstellen/goedkeuren/uitvoeren (knoppen 2-4) zoals de pagina zelf aangeeft. Welk
   voorstel knoppen 3/4 raken, en welk nummer bij `TRANSACTION_INDEX` van de pre-flight
   hoort, komt uit `upgradeProposalCheck.mjs`, dezelfde module als
   `scripts/checkProposalTimelock.ts` (sectie 168/169): alleen het laatste voorstel, als het
   open (knop 3) of goedgekeurd (knop 4) is en precies de upgrade, en **geen enkel ander
   voorstel op Approved of Executing staat, welke inhoud ook** (sectie 169). Knop 3 eist
   daarnaast dat er geen ander Active-voorstel voor deze buffer is. Knoppen 2, 3 en 4 eisen
   ook een autonome multisig (geen config_authority), time_lock exact 259200 s en threshold
   minstens 2 (sectie 170). Anders weigert de knop
   met de reden. Een overbodig voorstel dat nog Active is, wijs je af met knop 5; een
   overbodig goedgekeurd voorstel annuleer je buiten deze pagina (Squads `proposalCancel`)
   en voer je nooit uit om het weg te krijgen (open punt, STATUS.md sectie 168/169).

   Wat de pagina niet afdwingt (STATUS.md sectie 171):
   - de volgorde "eerst `scripts/preUpgradeChecks.ts --pre`, dan knop 4" rust op de
     bediener, niet op de keten: na de 72u-timelock kan elk lid met Execute-recht het
     voorstel buiten deze pagina om uitvoeren. Knop 4 controleert bovendien de
     buffer-inhoud, de genesis-hash en de recovery-invariant niet; dat doet alleen het script;
   - "SUCCES" op de pagina betekent alleen dat de RPC de exacte signature zonder fout zag
     (knop 2-5 beslissen dat op één plek, `awaitConfirmation`). Het is geen bewijs dat de
     upgrade klopt: alleen `scripts/preUpgradeChecks.ts --post` en de vijf verificaties van
     STATUS.md sectie 95 tellen.

   Sinds STATUS.md sectie 172:
   - alle actieknoppen staan uit van het versturen tot het einde van de controle, ook na
     terugkeer van een Solflare-deep-link (dan vanaf het laden van de pagina);
   - "Kon niet vaststellen of transactie … geland is": de transactie kan nog landen tot haar
     blockhash verloopt (ongeveer 2 minuten na het versturen). Wacht tot het tijdstip dat de
     pagina noemt, controleer de signature opnieuw, en klik pas daarna eventueel opnieuw;
   - knop 4 via de deep-link bewaart het voorstelnummer over de omleiding heen en noemt het
     in de uitkomst ("SUCCES - voorstel #… uitgevoerd"). De regel "Uitvoeren van voorstel
     #…" vóór de omleiding is op mobiel nauwelijks te lezen; controleer het nummer in de
     uitkomst;
   - de verbindingsmelding begint niet meer met "SUCCES"; dat woord is voorbehouden aan een
     transactie die aantoonbaar zonder fout landde.

   Sinds STATUS.md sectie 173 (daarna is de pagina bevroren: alleen een bevinding die een
   verkeerde transactie of een onterecht succes kan veroorzaken, leidt nog tot een wijziging):
   - na een terugkeer uit Solflare bewaart de pagina de te controleren transactie (actie,
     signature, voorstelnummer, tijdstip) vóór de controle. Herlaadt de pagina of sluit het
     toestel het tabblad midden in de controle, dan controleert het volgende laden opnieuw
     (tot 30 minuten na de terugkeer). Een nieuwe verbinding of de wisknop ruimt zo'n stand
     op en zet de niet-beoordeelde signature in de log;
   - tijdens een controle staan ook de verbindknoppen 1 en 1b uit; de wisknop niet;
   - staan de knoppen na 3 minuten nog uit (wallet of RPC antwoordt niet), dan zegt de
     pagina dat herladen kan, dat de transactie mogelijk toch verstuurd is, en dat je daarna
     eerst de keten laat lezen;
   - knop 4 meldt "SUCCES - voorstel #n uitgevoerd" alleen als #n op de keten `Executed` is;
   - na "niet vastgesteld of … geland" blijft de betrokken knop uit tot het genoemde tijdstip
     (alleen zolang de pagina niet herladen wordt);
   - bedieningsregels (niets klikken of herladen tijdens een controle, na elke deep-link-stap
     de uitkomst op de keten laten lezen, knop 4 bij voorkeur via de desktop-extensie):
     `docs/upgradevoorstel-sjabloon.md` §3.
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
