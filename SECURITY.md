# Security Policy

SpankWallet is een actief-in-ontwikkeling, non-custodial Solana-wallet met passkey-
authenticatie (WebAuthn / secp256r1). Er is geen versienummering zoals bij een
releasepakket - het project draait momenteel uitsluitend op **devnet**, is niet naar
mainnet gedeployed, en is nog niet geschikt voor productiegebruik met echte waarde.

## Ondersteunde omgeving

| Omgeving | Status |
|----------|--------|
| Devnet   | Actief, primaire testomgeving |
| Mainnet  | Nog niet gedeployed |

De `main`-branch is de enige actief onderhouden branch. Zie `STATUS.md` voor de volledige,
actuele stand van zaken en bekende openstaande punten.

## Een kwetsbaarheid melden

Meld een kwetsbaarheid via [GitHub Security
Advisories](https://github.com/anoadder-ship-it/spankwallet/security/advisories/new) -
dit houdt de melding privé totdat er een fix is, in plaats van een publiek issue te openen.

Neem in de melding op:
- Een duidelijke beschrijving van de kwetsbaarheid en de mogelijke impact
- Stappen om het te reproduceren (indien van toepassing)
- Of het gaat om het on-chain programma (`programs/spankwallet/`), de browser-client
  (`client/`), of iets anders

**Geef alsjeblieft geen details over de kwetsbaarheid in een publiek issue of pull
request.**

## Wat te verwachten

Dit is een klein, actief project - er is geen formeel SLA, maar meldingen worden serieus
en zo snel mogelijk bekeken. Zie `STATUS.md` voor context over reeds bekende en
opgeloste beveiligingsoverwegingen, met name secties 21-22 (de grondige security-doorloop),
25-26 (de `execute`-herziening naar gesloten, getypeerde acties), 36-37 (WebAuthn-hardening:
User Verification-afdwinging en clientDataJSON-type-validatie), 38-39 (het multi-passkey-
model en zijn lockout-bescherming), 40 (session keys: hun scope-/expiry-beperkingen en
een gevonden-en-gefixte autorisatie-ordeningsbug in `execute_advanced_via_session`), en
41-42 (de programma-upgrade-authority: van een enkele sleutel naar een 2-of-3 Squads-
multisig met 72u-timelock, inclusief een devnet-generale-repetitie op een volledig los
wegwerpprogramma voordat de echte migratie werd uitgevoerd).
