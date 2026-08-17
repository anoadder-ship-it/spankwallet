# Vergrendelde wallet-gebruiker (optioneel, gevorderd)

Dit is een optionele hardening-stap voor gevorderde gebruikers, geen vereiste voor
SpankWallet en geen codewijziging aan het project zelf. Achtergrond: STATUS.md §72
("WebAuthn API Hijacking"). Doel: het risico verkleinen dat een kwaadaardige of te
permissieve browserextensie de WebAuthn-ceremonie (`navigator.credentials.get()`) kan
onderscheppen of de challenge/payload kan herschrijven vlak voor ondertekening.

## Wat dit wel en niet oplost

**Lost op:** het risico dat een extensie die je (per ongeluk of later) in je gewone,
dagelijkse browserprofiel installeert, ooit toegang krijgt tot de WebAuthn-ceremonie van
je wallet - want die ceremonie vindt dan plaats in een OS-gebruikersaccount waar die
extensie nooit draait.

**Lost NIET op:**
- Een gecompromitteerd besturingssysteem/kernel - dit blijft een browser-niveau-maatregel,
  geen sandbox tegen root-niveau malware.
- Een kwaadaardige site/dApp binnen de wallet-sessie zelf - dat is het domein van de
  bevestigingskaarten uit UI-fase 1 (STATUS.md §59-73), niet van deze maatregel.
- Een 0-day in de browser of in de wallet-extensie zelf.
- Wie root/sudo heeft op deze machine kan de hieronder beschreven policy alsnog wijzigen
  of verwijderen - dit is dus zelf geen bescherming tegen een reeds-gecompromitteerde
  machine, alleen tegen een toekomstige, ongewenste extensie-installatie op een verder
  schone machine.

## Belangrijke correctie vooraf: dit is GEEN "los profiel", het is machine-breed

De voor de hand liggende aanname - "zet dit in een apart Chrome-profiel, mijn gewone
profiel blijft ongemoeid" - klopt NIET. Geverifieerd tegen Google's eigen documentatie
("Understand Chrome policy management"): lokale, bestandsgebaseerde policies (het
mechanisme hieronder) gelden machine-breed, voor ALLE OS-gebruikers en ALLE
browserprofielen op dat apparaat. Echte per-profiel-scoping ("Cloud-user policy") bestaat
alleen wanneer een profiel is ingelogd met een door Google Workspace/Cloud Identity
beheerd account - niet praktisch voor een individuele gebruiker die dit voor zichzelf wil
instellen.

**Consequentie, expliciet, geen understatement:** zodra je de policy hieronder instelt,
geldt "alleen deze ene extensie mag draaien" voor ELKE Chrome/Brave op deze machine, voor
ELKE OS-gebruiker erop - ook je eigen, dagelijkse account, als die op dezelfde machine
staat. Een aparte OS-gebruikersaccount lost dat NIET vanzelf op; het geeft je wel een
schone, dedicated omgeving om de wallet-extensie in te gebruiken (eigen `$HOME`, eigen
browserprofiel-opslag, nooit toevallig dezelfde sessie als je gewone browsen), maar de
policy zelf blijft voor de hele machine gelden.

Twee realistische toepassingen, kies wat bij je past:
- **Een machine/VM die je uitsluitend voor de wallet gebruikt** (klein extra apparaat, of
  een virtuele machine): de machine-brede scope is dan geen nadeel, want er is toch nog
  maar één relevante gebruiker.
- **Je dagelijkse machine, met de bewuste keuze dat de policy ook je hoofdaccount
  raakt:** je hoofdaccount kan dan alleen nog dezelfde toegestane extensie(s) installeren
  - alle andere extensies (ook in je gewone profiel) worden geblokkeerd/uitgeschakeld
  zodra je dit instelt. Alleen zinvol als je toch al weinig andere extensies gebruikt of
  bereid bent die op te geven.

Er bestaat geen lokale, gratis manier om dit tot slechts één Chrome-profiel te beperken
terwijl een ander profiel op dezelfde machine ongemoeid blijft - dat is de kern van de
hierboven genoemde correctie.

## Stap voor stap (Linux)

1. **Nieuwe OS-gebruiker aanmaken**, uitsluitend voor wallet-gebruik:
   ```
   sudo adduser spankwallet-vault
   ```
2. **Bepaal de extension-ID van je gekozen Wallet Standard-extensie, en verifieer 'm
   zelf** tegen de officiële Chrome Web Store-listing vlak vóór gebruik (nagemaakte
   wallet-extensie-listings zijn een bekend, actief scam-vector - vertrouw geen ID die je
   ergens anders dan `chromewebstore.google.com` vandaan hebt). Twee voorbeelden,
   geverifieerd op 2026-08-17 tegen hun officiële Chrome Web Store-listing:
   - Phantom: `bfnaelmomeimhlpmgjnjophhpkkoljpa`
     (<https://chromewebstore.google.com/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa>)
   - Solflare: `bhhhlbepdkbapadjdnnojkbgioiodbic`
     (<https://chromewebstore.google.com/detail/solflare-wallet/bhhhlbepdkbapadjdnnojkbgioiodbic>)

   Extension-ID's zijn stabiel zolang de listing bestaat, maar controleer ze zelf opnieuw
   als je dit later toepast - vertrouw niet blind op de waarden in dit document.
3. **Policy-bestand aanmaken** (vereist root - dit is zelf al machine-breed, zie
   waarschuwing hierboven):
   - Chrome: `/etc/opt/chrome/policies/managed/spankwallet-extension-lockdown.json`
   - Brave (sinds ~april 2024): `/etc/brave/policies/managed/spankwallet-extension-lockdown.json`
     (oudere Brave-installaties lezen soms nog `/etc/chromium/policies/managed/` - werkt
     de bovenstaande locatie niet, probeer dat als fallback en controleer met stap 4).

   Inhoud (vervang de ID door je eigen, geverifieerde keuze - meerdere toegestane
   extensies mogen als losse array-elementen):
   ```json
   {
     "ExtensionInstallBlocklist": ["*"],
     "ExtensionInstallAllowlist": ["bfnaelmomeimhlpmgjnjophhpkkoljpa"]
   }
   ```
   `ExtensionInstallBlocklist: ["*"]` blokkeert standaard alle extensies; reeds
   geïnstalleerde, niet-toegestane extensies worden automatisch uitgeschakeld.
   `ExtensionInstallAllowlist` maakt hierop een uitzondering voor exact de opgesomde
   ID's.
4. **Herstart de browser en verifieer** via `chrome://policy` (Chrome) of
   `brave://policy/` (Brave) - beide policies moeten zonder foutstatus getoond worden.
   Controleer daarna `chrome://extensions` (of `brave://extensions/`): alleen de
   toegestane extensie(s) mogen daar installeerbaar/actief zijn.
5. Installeer je wallet-extensie in deze gebruikersaccount zoals gewoonlijk, en gebruik
   deze account voortaan uitsluitend voor SpankWallet-gerelateerd browsen.

## Hardware-sleutel-ondersteuning (los van bovenstaande, al vandaag beschikbaar)

Onafhankelijk van deze profielmaatregel: SpankWallet ondersteunt vandaag al gewone
FIDO2/WebAuthn-hardware-sleutels (bv. YubiKey) als passkey-authenticator, zonder enige
codewijziging - `passkey.ts` stelt geen `authenticatorAttachment`-restrictie, dus
registratie accepteert zowel platform- als cross-platform-authenticators. Zie STATUS.md
§72 voor de volledige nuance (zo'n sleutel heeft doorgaans geen eigen scherm en tekent dus
nog steeds "blind" wat de browser 'm aanbiedt - dit is fysieke sleutel-air-gapping, geen
volledige WYSIWYS-garantie).

## Bronnen

- [ExtensionInstallAllowlist - Chrome Enterprise](https://chromeenterprise.google/intl/en_au/policies/extension-install-allowlist/)
- [ExtensionInstallBlocklist - Chrome Enterprise](https://chromeenterprise.google/intl/en_ca/policies/extension-install-blocklist/)
- [Set Chrome app and extension policies (Linux) - Google Support](https://support.google.com/chrome/a/answer/7517525?hl=en)
- [Understand Chrome policy management - Google Support](https://support.google.com/chrome/a/answer/9037717?hl=en)
- [Group Policy - Brave Help Center](https://support.brave.app/hc/en-us/articles/360039248271-Group-Policy)
- [Brave Linux policy path resolution - Brave Community](https://community.brave.app/t/solved-brave-for-linux-policy-issue/66481)
