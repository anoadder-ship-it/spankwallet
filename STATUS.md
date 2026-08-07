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
