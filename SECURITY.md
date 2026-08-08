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
opgeloste beveiligingsoverwegingen (met name secties 21-22 over de grondige
security-doorloop en secties 25-26 over de `execute`-herziening).
