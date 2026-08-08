# SpankWallet — STATUS.md

**Doel van dit document:** eerste bestand om te lezen bij hervatten van dit project in
een nieuwe chatsessie. Legt vast waar we staan en waarom, zodat niets herhaald hoeft te
worden.

Laatst bijgewerkt: eerste volledig groene lokale testrun (8/8 passing).

## 1. Wat SpankWallet is

Non-custodial Solana wallet + browser-extension:
- Passkey-authenticatie (WebAuthn/secp256r1) i.p.v. seed phrase
- Anti-spam: ongevraagde tokens client-side verborgen, "hunt"-actie om te burnen/sluiten
- Recovery via offline backup-authority (Ed25519), 72u-tijdslot, owner-veto

## 2. Huidige staat: WERKT

8/8 tests slagen lokaal (anchor test --skip-local-validator --skip-deploy, na
./scripts/build-and-deploy.sh): 3 init_wallet-tests, 5 recovery-flow-tests.

Niet getest: execute, hunt, cancel_recovery — vereisen echte secp256r1-precompile met
WebAuthn-passkey-handtekening. Zie sectie 6.

## 3. Omgeving (DGX Spark, Ubuntu, ARM64)

Geen officiele ARM64-Linux-binaries voor Solana/Agave. Alles native vanaf source gebouwd:
Agave v4.1.2 in ~/projects/agave, Anchor 1.1.2 (verhuisd naar otter-sec/anchor, TS-package
blijft @coral-xyz/anchor), cargo-build-sbf apart component v4.1.0.

## 4. Kritieke gotchas - lees dit voor je iets bouwt

### 4.1 PDA-seed-lengte (Solana MAX_SEED_LEN = 32 bytes)
Een gecomprimeerde secp256r1-sleutel is 33 bytes. Kan nooit als PDA-seed dienen (limiet
32 bytes). Oplossing: wallet_seed_hash (SHA-256 van seed_key, 32 bytes) als apart veld,
gebruikt in alle seeds-declaraties.

### 4.2 Anchor idl-build kan geen berekende seeds analyseren
Functie-aanroepen in seeds=[...] breken Anchor's IDL-generatiepas (E0425). Oplossing:
wallet_seed_hash is een los instructie-argument, geverifieerd on-chain via require!.

### 4.3 solana-program is opgesplitst in micro-crates
Nodig als losse dependencies in programs/spankwallet/Cargo.toml:
solana-instructions-sysvar = "3.0.1"
solana-keccak-hasher = "3.1.0"
solana-sha256-hasher = "3.1.0"

### 4.4 Hash-types: .0 is prive
Gebruik .as_ref() in plaats van .0 om aan de bytes te komen.

### 4.5 Anchor 1.0 breaking changes
CpiContext::new(_with_signer) neemt Pubkey ipv AccountInfo (Token::id()).
[registry]-sectie in Anchor.toml bestaat niet meer.
AccountInfo velden zonder validatie: gebruik UncheckedAccount.
anchor.BN bestaat niet meer, importeer BN uit bn.js.

### 4.6 SBPF-versie: moet arch v3 zijn
cargo-build-sbf --arch v3 is verplicht. Default en v1 falen met
"Detected sbpf_version required by the executable which are not enabled".
SIMD-0432 faseert oudere SBPF-versies uit. Gebruik scripts/build-and-deploy.sh.

### 4.7 anchor test bouwt zelf opnieuw zonder arch v3
Eerst build-and-deploy.sh draaien, dan pas anchor test --skip-local-validator
--skip-deploy. Volgorde is belangrijk.

### 4.8 anchor keys sync moet voor de build
declare_id wordt in de .so gecompileerd. Sync eerst, dan bouwen.

### 4.9 Cargo cache detecteert arch-wijziging niet altijd
Bij twijfel: rm -rf target eerst. Check op "Compiling spankwallet" in de output.

### 4.10 Lokale validator: gossip-poort 8000 kan bezet zijn
Start met: solana-test-validator --reset --gossip-port 8001
In een aparte, blijvend open terminal-tab, niet met nohup op de achtergrond.

### 4.11 Devnet werkt ook, trager door rate-limits
Anchor.toml stond eerder op devnet, werkte volledig (8/8 tests), alleen trager.
Fallback-optie als localnet problemen geeft.

## 5. Workflow om vanaf nul te testen

Terminal 1 (laat draaien, niet sluiten):
cd ~/projects/spankwallet
solana-test-validator --reset --gossip-port 8001

Terminal 2:
cd ~/projects/spankwallet
export PATH="$HOME/projects/agave/bin:$PATH"
solana config set --url http://127.0.0.1:8899
solana airdrop 10 --keypair ~/.config/solana/id.json --url http://127.0.0.1:8899
./scripts/build-and-deploy.sh --clean
anchor test --skip-local-validator --skip-deploy

## 6. Eerstvolgende stap: browser-passkey-testpagina

Kritieke architectuurbevinding, nog niet geimplementeerd: een echte WebAuthn-passkey
ondertekent nooit rauwe applicatie-bytes rechtstreeks. De authenticator signeert altijd
authenticatorData plus SHA-256 van clientDataJSON.

Onze huidige verify_passkey_signature vergelijkt actual_message met een kale keccak-hash
van program_id, wallet, domain en payload. Dat zal met een echte passkey nooit matchen.

Wat moet gebeuren voordat de browser-pagina zin heeft:
1. Client stuurt ook de rauwe clientDataJSON-bytes mee in de transactie.
2. Programma herberekent SHA-256 van clientDataJSON, matcht het challenge-veld eruit
   tegen build_expected_message.
3. Programma verifieert dat actual_message gelijk is aan authenticatorData plus die hash.

Aanbevolen: eerst LazorKit (github.com/lazor-kit) of Blueshift referentie-implementatie
bekijken, niet blind zelf herontwerpen.

## 7. Programma-architectuur

programs/spankwallet/src/state.rs - WalletAccount, VaultAccount, RecoveryState
programs/spankwallet/src/instructions.rs - init_wallet, execute (CPI nog placeholder),
hunt, initiate_recovery, cancel_recovery, finalize_recovery, verify_passkey_signature
programs/spankwallet/src/errors.rs - custom error-codes
tests/spankwallet.ts - init_wallet-tests
tests/recovery.ts - recovery-flow-tests
scripts/build-and-deploy.sh - de enige juiste manier om te bouwen en deployen

## 8. Openstaande punten

- execute: CPI-uitvoering is nog een no-op placeholder
- initiate_recovery event (emit!) voor watcher-notificatie nog niet toegevoegd
- Client-side browser-extension: nog niet gestart, wacht op WebAuthn-fix
- Fase 2 (fee-gated PDA-inbox) en fase 3 (USB 2-of-2, post-quantum): nog niet begonnen

## 9. Ontwerpdocument samengevat

PDA-layout: WalletAccount (seeds wallet plus wallet_seed_hash), VaultAccount (seeds
vault plus wallet-pubkey). Recovery: offline backup-authority Ed25519, 72u-default-
timelock, owner-veto via cancel_recovery. Watcher-notificatie: optioneel e-mailadres,
lokaal opgeslagen, geen custodiale macht, nog te implementeren. Fase 2: fee-gated PDA-
inbox, met erkenning dat directe SPL-transfers de gate kunnen omzeilen. Fase 3: USB
2-of-2 hardware-split, optionele post-quantum signing voor high-value transacties.

## 10. WebAuthn-fix geimplementeerd (na sectie 6 hierboven)

verify_passkey_signature is bijgewerkt: verifieert nu echt dat het ondertekende bericht
authenticatorData plus SHA-256(clientDataJSON) is, en dat het challenge-veld in
clientDataJSON overeenkomt met build_expected_challenge. Nieuwe helpers in
instructions.rs: sha256_32, base64url_decode, extract_webauthn_challenge.

execute, hunt en cancel_recovery hebben nu een extra client_data_json: Vec<u8> argument.
De client (browser-extension) moet de WebAuthn-challenge instellen op
build_expected_challenge(wallet, domain, payload), base64url-encoded, voordat
navigator.credentials.get() wordt aangeroepen.

Gecommit en gepusht (commit 8ce4d39). Alle 8 bestaande tests blijven groen (raken deze
instructies niet aan). Nog te doen: een test die deze flow met een echte of gesimuleerde
WebAuthn-handtekening valideert - dat is de browser-testpagina, de eerstvolgende stap.

## 11. Client stap 1 voltooid: passkey-aanmaak geverifieerd tegen echte hardware

client/ bevat nu een werkende Vite/TypeScript-testpagina (client/src/passkey.ts,
client/src/cbor.ts, client/src/main.ts, client/index.html) die een echte WebAuthn-passkey
aanmaakt en de rauwe 33-byte gecomprimeerde secp256r1-publieke sleutel eruit haalt via een
zelfgeschreven CBOR-decoder (geen externe library, bewust klein en auditeerbaar gehouden).

Getest en bevestigd werkend tegen een echte FIDO2-hardware-security-key (PIN-flow, niet
gesimuleerd): resultaat 02df56feb2ffcb354364b05770fa094966e839d337af74869faf1ccf21bae9ab4a
- 33 bytes, prefix 0x02, exact het formaat dat init_wallet als seed_key verwacht.

Belangrijke fix onderweg: authenticatorSelection.residentKey moest van "required" naar
"preferred" (compatibeler met hybride/telefoon-flows), en er moest een expliciete
timeout: 120000 worden toegevoegd (de default browsertimeout was te krap voor de
telefoon-QR-hybride-flow, gaf NotAllowedError).

Volgende stap (nog niet begonnen): init_wallet aanroepen met deze echte publieke sleutel
als seed_key (vereist nog GEEN passkey-handtekening, dus logische tussenstap vóór
navigator.credentials.get() + de secp256r1-precompile-transactie-opbouw).

## 12. Client stap 2 bevestigd via CLI-verificatie (Phantom RPC-routing nog open)

init_wallet is daadwerkelijk on-chain aangeroepen met de echte hardware-passkey-sleutel
uit sectie 11 (03938bf37f37b80762a63244b624278fe38ae8197e3dd63efe49a9572429291ecb).
PDA-afleiding, handmatige Borsh-encoding (client/src/initWallet.ts, geen IDL-
afhankelijkheid), en de volledige transactie-opbouw zijn hiermee bewezen correct.

Belangrijke complicatie onderweg: Phantom's browserextensie faalde herhaaldelijk met
"Blockhash not found" bij simulatie via de Wallet Standard-integratie (client/src/
wallet.ts). Eerste fix (blockhash pas verversen vlak voor verzending i.p.v. bij
transactie-opbouw) loste het niet op. Root cause vermoedelijk: Phantom's interne
"RPC ROUTER" praat mogelijk niet daadwerkelijk met http://127.0.0.1:8899 ondanks de
Localnet-instelling, en dit kon niet definitief geverifieerd worden vanuit onze kant.

Definitief bewijs geleverd door Phantom tijdelijk te omzeilen: client/scripts/
cli-init-wallet-check.mjs tekent rechtstreeks met de lokale CLI-keypair
(~/.config/solana/id.json, nooit in browsercode) en roept dezelfde init_wallet-instructie
aan. Resultaat: SUCCES, WalletAccount aangemaakt, eigenaar en account-grootte (231 bytes)
correct. Dit isoleert het probleem definitief tot Phantom's RPC-routing, niet onze code.

**Openstaand, niet-blokkerend:** Phantom-localnet-RPC-routing-probleem nog niet opgelost.
De Wallet Standard-integratie (wallet.ts) blijft de juiste architectuur voor de
uiteindelijke productie-client — dit vereist later gerichter onderzoek (mogelijk Solflare
als alternatief testen, of Phantom's exacte RPC-configuratie-opties verder uitzoeken).

**Zijdelingse observatie:** de payer-pubkey uit ~/.config/solana/id.json
(G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp) bleek anders dan de eerder geziene deploy-
authority (GaU7itnumyaKbXmVDQtbEurimomGk4K3uFzur1Nbx9X2) — dat keypair-bestand is op enig
moment herschreven. Geen probleem gebleken, maar het is opvallend en de moeite waard om
in de gaten te houden.

Volgende stap (nog niet begonnen): execute aanroepen met een ECHTE passkey-HANDTEKENING
(niet alleen de publieke sleutel zoals in stap 2) - dit vereist navigator.credentials.get()
en de secp256r1-precompile-transactie-opbouw, de kern van de WebAuthn-fix uit sectie 10.

## 13. DOORBRAAK: browserwallet-flow volledig werkend op devnet

Na de CLI-verificatie in sectie 12 volgde uitgebreid, systematisch speurwerk naar waarom
Phantom's browserextensie bleef falen op de lokale validator - ondanks dat onze EIGEN
simulatie (rechtstreeks naar 127.0.0.1:8899) telkens succesvol was, met volledige
programma-logs die "success" toonden.

**Definitieve oorzaak, bevestigd door Phantom's eigen foutmelding:** "Are you sure? Failed
to simulate the results of this request. Proceeding is unsafe, so Phantom blocked this
request." Zelfs na expliciet "unsafe" te bevestigen, bleef het falen. Conclusie: Phantom
simuleert/verstuurt transacties via zijn EIGEN achtergrondinfrastructuur (niet via de RPC
die onze pagina zelf gebruikt), en die infrastructuur kan per definitie nooit bij een
127.0.0.1-adres dat alleen op de lokale machine bestaat - ongeacht welk domein de webpagina
zelf gebruikt (localhost, of zelfs een Cloudflare Tunnel-domein via cloudflared, beide
faalden op dezelfde manier omdat het domein van de PAGINA niet het probleem was).

**Tussenstap die dit isoleerde (niet meer nodig, maar leerzaam):** Cloudflare Tunnel
(cloudflared, quick-tunnel-modus, geen account nodig) gebruikt om de lokale Vite-server via
een echt HTTPS-domein bereikbaar te maken, om te testen of Phantom's aanvankelijke
domeinverificatie-afwijzing van "localhost" de oorzaak was. Vite's eigen allowedHosts-
beveiliging moest daarvoor aangepast (vite.config.ts, server.allowedHosts: true). Loste het
NIET op - bevestigde daarmee dat het probleem dieper zat dan alleen domeinverificatie.

**Oplossing: overgestapt naar echt devnet voor browserwallet-tests.** Programma opnieuw
gedeployed naar devnet met hetzelfde programma-ID (4mE8U2TFRpDDPR3681KdPCwgQMVr2xhaMebvBp9gKW58,
dus GEEN client-ID-update nodig) via:
  solana program deploy target/deploy/spankwallet.so --program-id target/deploy/spankwallet-keypair.json --keypair ~/.config/solana/id.json --url https://api.devnet.solana.com
client/src/main.ts's Connection-adres aangepast van http://127.0.0.1:8899 naar
https://api.devnet.solana.com. Phantom teruggezet naar zijn Devnet-instelling.

**Resultaat: volledig succesvolle end-to-end flow**, voor het eerst zonder enige omweg:
echte hardware-passkey -> Wallet Standard -> Phantom-browserextensie -> daadwerkelijke,
bevestigde on-chain transactie. Signature: mVrwnFMvr9559fRtKqG1vfXYfRP8EJaMLvxgckqLNhkLCbc
TNRat7AoftffGZXKijNLUgY2S3vPauLXkZBzVfEM. WalletAccount aangemaakt, 231 bytes, correcte
eigenaar.

**Praktische les voor toekomstige sessies:** browserwallet-extensies (Phantom in elk geval,
vermoedelijk anderen ook) zijn NIET geschikt om te testen tegen een lokale
solana-test-validator, ongeacht netwerkbereikbaarheid van de testpagina zelf. Gebruik
devnet voor elke test die een echte wallet-extensie in de lus heeft. De lokale validator
blijft prima voor de Rust-programmatests (anchor test) en CLI-scripts, waar geen
wallet-extensie bij betrokken is.

**Kleine opruiming:** cloudflared.deb (16,6MB installatiebestand) per ongeluk in client/
gedownload en tijdelijk gestaged in git - hersteld en *.deb toegevoegd aan .gitignore.
