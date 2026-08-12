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

## 14. DOORBRAAK 2: execute met echte WebAuthn-passkey-handtekening bevestigd

Voortbouwend op sectie 13 (init_wallet werkend via Phantom op devnet), is nu ook execute
end-to-end getest met een ECHTE passkey-HANDTEKENING (niet alleen de publieke sleutel).
Dit bewijst de WebAuthn-fix uit sectie 10 daadwerkelijk werkt tegen echte hardware.

Nieuwe client-bestanden:
- client/src/secp256r1.ts: DER-naar-raw signature-conversie + low-S-normalisatie (ECDSA-
  handtekeningen zijn malleabel - (r,s) en (r,n-s) zijn beide geldig; Solana's precompile
  weigert high-S, WebAuthn-authenticators garanderen geen low-S, dus normalisatie is
  verplicht) + secp256r1-precompile-instructie-opbouw (offsets-struct exact matchend met
  instructions.rs parse_offsets).
- client/src/webauthnSign.ts: navigator.credentials.get() aanroepen, authenticatorData +
  clientDataJSON + DER-handtekening extraheren, signedMessage opbouwen (authenticatorData
  || SHA-256(clientDataJSON)).
- client/src/execute.ts: bouwt de volledige transactie (secp256r1-precompile-instructie
  direct gevolgd door execute-instructie, verplichte volgorde - het programma leest altijd
  "instructie direct hiervoor"). Gebruikt Keccak-256 via @noble/hashes (bewust een kleine,
  vertrouwde library i.p.v. zelf een Keccak-permutatie herimplementeren - in tegenstelling
  tot de CBOR-decoder was dit een bewuste keuze omdat het een gestandaardiseerd
  cryptografisch primitief is, geen eigen novel logica).

execute discriminator (sha256("global:execute") eerste 8 bytes): 82ddf29a0dc1bd1d.

**Resultaat: volledig bevestigd op devnet.** navigator.credentials.get() succesvol
aangeroepen (tweede biometrie-/PIN-prompt op dezelfde hardware-key als stap 1), secp256r1-
precompile + verify_passkey_signature accepteerden de echte handtekening, programma-logs
tonen "Instruction: Execute" -> "success". Signature:
6YnPpkX1rDUpVhk3rWaem1MrNLSjKq7YPVH8qpLqoEPKW3pvw7ipriZzoJtAZDBeXLncK421rSrKwe9PWGp7seQ.

**Dit sluit het WebAuthn-hoofdstuk van dit project af:** de volledige keten - passkey-
aanmaak, publieke-sleutel-extractie (CBOR), init_wallet, en execute met echte handtekening
(DER-decodering, low-S-normalisatie, precompile-opbouw, on-chain verificatie) - is nu
allemaal bewezen correct tegen echte hardware, niet alleen in Rust-unittests met
gesimuleerde data.

## 15. Volgende stappen (bijgewerkt overzicht)

- hunt: nog niet getest tegen echte passkey (zelfde patroon als execute, zou nu snel moeten
  kunnen met de bestaande secp256r1/webauthnSign-bouwstenen)
- cancel_recovery: idem, nog niet getest tegen echte passkey
- execute's CPI-uitvoering is nog steeds een no-op placeholder in het Rust-programma - de
  eerste concrete use-case (bv. kale SOL-transfer) moet nog uitgewerkt worden
- Fase 2 (fee-gated PDA-inbox) en fase 3 (USB 2-of-2, post-quantum): nog niet begonnen
- npm audit-kwetsbaarheden (8, 2 high) nog niet opgeruimd - browser-dev-dependencies,
  niet in productiecode, maar wel netjes om op te ruimen voor een echte release

## 16. DOORBRAAK 3: volledige recovery-flow bewezen met echte handtekeningen

initiate_recovery en cancel_recovery zijn nu ook end-to-end getest op devnet, allebei met
echte ondertekening (niet gesimuleerd, niet met test-Keypairs uit de Rust-tests).

Belangrijke technische fix vooraf nodig, ontdekt door vooruit te denken i.p.v. te gokken:
initiate_recovery vereist TWEE handtekeningen in dezelfde transactie (fee-payer via
wallet-extensie EN backup_authority als los Ed25519-keypair). client/src/wallet.ts's
signAndSendTransaction bouwde intern een verse VersionedTransaction op
(new VersionedTransaction(transaction.compileMessage())) die eerder gezette
partialSign()-handtekeningen STILZWIJGEND verloor - een subtiele bug die nooit zichtbaar
werd zolang er maar één signer was (alle eerdere stappen). Gefixed: signAndSendTransaction
zet nu expliciet elke reeds aanwezige signature uit transaction.signatures over naar de
juiste index in de VersionedTransaction, gematcht op publicKey. Ook: chain-hint gecorrigeerd
van het nooit-bijgewerkte "solana:localnet" naar "solana:devnet" (geen blokkerend probleem
gebleken - Phantom gebruikt zijn eigen ingestelde netwerk - maar wel onjuist en nu gefixed).

Nieuw bestand client/src/recovery.ts:
- Handmatige WalletAccount-byte-parser (readWalletAccount), OFFSETS handmatig afgeleid uit
  state.rs, gevalideerd doordat de berekende totale grootte (231 bytes) exact overeenkwam
  met de al eerder waargenomen on-chain account-grootte - onafhankelijke bevestiging zonder
  IDL.
- buildInitiateRecoveryTransaction: bouwt instructie + ondertekent alvast met
  backup_authority via partialSign(), voordat de wallet-extensie zijn eigen handtekening
  toevoegt.
- buildCancelRecoveryTransaction: zelfde patroon als execute.ts (secp256r1-precompile +
  echte navigator.credentials.get()), maar de challenge is hier gebonden aan de specifieke
  lopende recovery (initiated_at + new_owner_passkey), exact zoals cancel_recovery in
  instructions.rs dat vereist.

initiate_recovery discriminator: 84943c4a31b2ebbb
cancel_recovery discriminator: b017cb2579fbe353

**Resultaat: volledig bevestigd op devnet, in één keer foutloos.** Beide instructies
succesvol: "Instruction: InitiateRecovery" -> success, recovery_state correct uitgelezen
(initiated_at + new_owner_passkey kloppen), "Instruction: CancelRecovery" -> success
(tweede, onafhankelijke echte passkey-handtekening in dezelfde sessie), en tot slot
bevestigd dat recovery_state weer None is na cancel - niet alleen "transactie ging door"
maar de daadwerkelijke state-verandering geverifieerd.

**Dit sluit de volledige, kritieke WebAuthn/recovery-testdekking van dit project af.**
Nog niet getest tegen echte hardware: hunt (vereist een echte SPL-token-mint + token-
account-opzet, aparte, grotere taak) en finalize_recovery (permissionless, geen
handtekening nodig, dus eigenlijk al impliciet gedekt door de Rust-tests in
tests/recovery.ts).

## 17. Hunt voltooid: burn+close met echte handtekening, 50/50 rent-splitsing naar incinerator

Op verzoek is hunt uitgebreid: in plaats van 100% van de teruggewonnen SPL-token-account-
rent naar de hunter, gaat nu de helft permanent naar Solana's algemeen erkende "dead
address" (1nc1nerator11111111111111111111111111111111, off-curve, geen bekende private
key) - deflatoir voor alle SOL-houders, maakt spammen kostbaar zonder een gecentraliseerde
begunstigde te kiezen.

Belangrijke technische ontdekking tijdens het ontwerp: de vault-PDA is eigendom van ONS
programma (niet System Program), dus een System-Program-CPI-transfer om lamports te
splitsen is niet mogelijk (System Program mag alleen debiteren van accounts die het zelf
bezit). Oplossing: directe lamport-manipulatie
(**account.try_borrow_mut_lamports()? = nieuw_saldo), wat elk programma mag doen op
accounts die het zelf bezit (debiteren) of op willekeurige accounts (crediteren - altijd
toegestaan, ongeacht eigenaarschap). token_account wordt eerst gesloten NAAR DE VAULT ZELF
(niet rechtstreeks naar rent_destination) zodat het programma het exacte teruggewonnen
bedrag kan meten (vault_lamports_after - vault_lamports_before) voordat het splitst -
zonder aannames over de rent-exempt-drempel.

Nieuwe Rust-constanten/errors: INCINERATOR (instructions.rs), InvalidIncineratorAccount +
RentAccountingOverflow (errors.rs). Hunt-struct: vault nu mut, nieuw incinerator-account
met address-constraint. hunt discriminator: 941e1c3931f91d41.

Nieuwe client-bestanden: client/src/hunt.ts (setupSpamTokenAccount met @solana/spl-token -
bewust een officiele library, zelfde afweging als eerdere gestandaardiseerde onderdelen -
plus buildHuntTransaction).

**Belangrijke ontdekte les: ES-module-import-volgorde en Buffer-polyfill.** De bestaande
Buffer-polyfill bovenaan main.ts bleek NIET betrouwbaar zodra @solana/spl-token werd
geimporteerd - in ES-modules worden ALLE import-statements eerst volledig geevalueerd, in
volgorde, voordat er ook maar een gewone regel in het aanroepende bestand draait. Een
polyfill-toewijzing simpelweg bovenaan main.ts plaatsen draait daardoor pas NA alle (ook
diep geneste) imports. Opgelost met client/src/polyfill.ts, een apart bestand met als
enige afhankelijkheid het buffer-package zelf, als allereerste import in main.ts.

**Verificatie-episode, uiteindelijk vals alarm - waardevolle les over RPC-consistentie:**
de eigen client-side na-hunt-verificatie (getBalance() direct na confirmTransaction()) las
aanvankelijk 0 lamports voor de incinerator, wat leek op een falende rent-splitsing. Bleek
GEEN programma-bug: solana confirm -v op de exacte transactie-signature toonde de
daadwerkelijke pre/post-lamport-balansen uit de blockchain zelf, en die klopten EXACT tot
op de lamport (incinerator: 0 -> 1.019.640 lamports, precies de helft van de 2.039.280-
lamport rent-exempt-drempel voor een SPL-token-account, geen rest). Zelfs een direct
daaropvolgend `solana balance`-commando toonde nog steeds 0 - een bevestigd, bekend
propagatie-vertragingsfenomeen bij publieke, load-balanced RPC-endpoints (devnet in dit
geval), niet uniek voor onze eigen JS-code. Les: voor definitieve verificatie na een
transactie, gebruik de transactie-signature zelf (solana confirm -v of vergelijkbaar) i.p.v.
een losse, onmiddellijk daaropvolgende account-balans-query op mogelijk een andere RPC-node.

**Resultaat: volledig bevestigd, functioneel EN qua rent-boekhouding tot op de lamport
correct.** Dit is de laatste van de vier kern-instructies (init_wallet, execute, recovery,
hunt) die nu allemaal end-to-end bewezen zijn met echte hardware-passkey-handtekeningen op
devnet.

## 18. Status na Fase A (functionele dekking)

Alle bestaande instructies zijn nu getest tegen echte hardware:
- init_wallet: bewezen (sectie 11-12)
- execute: bewezen, al is de CPI-uitvoering zelf nog een no-op placeholder (sectie 14)
- initiate_recovery + cancel_recovery: bewezen (sectie 16)
- hunt: bewezen, inclusief de nieuwe 50/50-rentsplitsing (sectie 17)
- finalize_recovery: permissionless, geen handtekening nodig, al gedekt door
  tests/recovery.ts

Volgende, afgesproken fase (Fase B: veiligheid verharden) en Fase C (compacter/zuiverder)
staan nog open - zie eerdere chatgeschiedenis voor de volledige afspraak. Concreet:
npm audit-kwetsbaarheden opruimen, een grondige security-doorloop van elke require!/PDA-
seed/ondertekeningscontrole met de kennis van hoe het systeem nu daadwerkelijk werkt, en
daarna pas code-opschoning + UI-vereenvoudiging.

## 19. Fase B (npm audit) afgerond

Twee losse package.json-bestanden (root voor Anchor/Rust-testtooling, client/ voor de
browser-testpagina) apart doorlopen, per kwetsbaarheid onderzocht i.p.v. blind
`npm audit fix --force` (dat zou in beide gevallen kernpakketten - @solana/web3.js,
@solana/spl-token, mocha - naar onbruikbaar oude versies hebben teruggezet).

**client/package.json:** bigint-buffer (high, CVE-2025-3194, buffer-overflow in
toBigIntLE(), pakket zelf onderhoudsloos, "no solution available yet" volgens de officiele
advisory) - opgelost via npm overrides naar de onderhouden, API-compatibele fork
@trufflesuite/bigint-buffer@^1.1.10, een in de praktijk al gebruikt patroon (o.a. bij
BitGoJS). Resultaat: van 10 (4 high) naar 9 kwetsbaarheden (1 high). Die resterende "1 high"
bleek bij nader onderzoek Vite's path-traversal-advisory, EXPLICIET beperkt tot "Windows
alternate paths" - niet van toepassing op onze Linux/ARM64-omgeving. Overige moderate
meldingen (esbuild, overige vite) zijn allemaal beperkt tot Vite's development-server,
nooit aanwezig in een productie-build, en onze dev-server is sinds het weghalen van de
Cloudflare-tunnel niet meer publiek blootgesteld.

**Root package.json:** serialize-javascript (high, CVE-2020-7660/GHSA-5c6j-r48x-rmvq, RCE
via RegExp.flags/Date.toISOString(), via mocha) - opgelost via npm overrides naar de
gepatchte serialize-javascript@^7.0.3 (mocha zelf heeft deze dependency nog niet gebumped,
maar deze exacte override is een breed gedocumenteerd, community-erkend patroon). Resultaat:
van 7 (1 high) naar 5 (0 high). Bevestigd dat anchor test nog steeds foutloos 8/8 passing
blijft na deze wijziging (overrides kunnen in theorie iets breken - expliciet getest, niet
aangenomen).

Resterende uuid-kwetsbaarheid (moderate, beide package.json's) - "No fix available", diep
verweven in @solana/web3.js's eigen RPC-transportlaag (jayson). Zelf forceren zou
@solana/web3.js zelf moeten breken, wat npm's eigen advies ook bevestigt. Bewust
geaccepteerd risico, laag praktisch risico (uuid's kwetsbaarheid betreft een edge-case in
hoe een optionele buffer-parameter gebruikt wordt, niet iets wat onze eigen code-paden
raakt).

**Opmerking over GitHub's Dependabot-telling:** blijft "2 high" tonen na deze fixes, ook al
laat onze eigen npm audit 0 daadwerkelijk exploiteerbare high-severity kwetsbaarheden meer
zien. Verklaring: Dependabot classificeert puur op pakketversie-bereiken zonder platform-
context - de resterende "high"-classificatie (vite path-traversal) is Windows-specifiek en
dus niet van toepassing op onze Linux/ARM64-omgeving, maar GitHub weet dat niet automatisch.
Geen gemiste kwestie, puur een classificatie-discrepantie.

Volgende stap in Fase B: grondige security-doorloop van elke require!/PDA-seed/
ondertekeningscontrole in het Rust-programma, met de kennis van hoe het systeem nu
daadwerkelijk werkt (na alle end-to-end-bevestigingen in sectie 11-17).

## 20. Vervolg Fase B: Vite path-traversal (GHSA-4w7w-66w2-5vf9) grondig onderzocht en structureel gefixt

Na sectie 19 kwam op expliciet verzoek een tweede, dieper onderzoek naar de resterende
"1 high" (Vite path-traversal in .map-afhandeling van optimized deps, CWE-22/CWE-200).

**Eerdere te snelle conclusie, gecorrigeerd:** in eerste instantie leek dit niet van
toepassing (GitHub's eigen advisory-pagina zegt expliciet "affected: >=6.0.0", en wij
draaien vite@5.4.21). Bij nader onderzoek bleek npm's eigen audit-database een ANDER,
breder bereik te hanteren ("<=6.4.1", geen ondergrens) - en een concreet extern
GitHub-issue (medusajs/medusa#15659) bevestigde expliciet: "There is no 5.x backport - the
fix exists only in vite@>=6.4.2". We staan al op de nieuwste 5.4.x-patch (5.4.21, geen
5.4.22 beschikbaar) - dus een niet-brekende patch-upgrade binnen de huidige major was geen
optie. Les: bij tegenstrijdige bronnen (advisory-pagina vs. audit-database-bereik), het
bredere/voorzichtigere bereik aanhouden, niet de gunstigste lezing kiezen.

**Bewuste keuze: GEEN overhaaste major-upgrade naar Vite 6+.** Dat zou (a) een grote,
ongeteste breaking change zijn na uren zorgvuldig debuggen om de huidige Vite 5-opzet
werkend te krijgen (Buffer-polyfill-volgorde, allowedHosts, etc.), en (b) npm's eigen
voorstel sprong zelfs door naar Vite 8, een nog grotere sprong. Een major-upgrade is een
aparte, bewust geplande taak, geen tussendoortje.

**In plaats daarvan: de daadwerkelijke aanvalsvoorwaarde structureel gesloten.** De
advisory zelf specificeert exact: misbruik vereist dat de dev-server publiek bereikbaar
wordt gemaakt via --host/server.host. client/vite.config.ts kreeg
`server.host: false` toegevoegd - dwingt af dat de dev-server ALTIJD uitsluitend aan
127.0.0.1 bindt, ongeacht toekomstige per-ongeluk-CLI-vlaggen of config-wijzigingen. Dit is
geen operationele gewoonte meer ("we typen toevallig nooit --host") maar een verifieerbare,
code-level garantie. Bijkomend: de overbodige `allowedHosts: true` (overgebleven van de
eerdere, inmiddels niet meer gebruikte Cloudflare Tunnel-test, zie sectie 13) is
verwijderd - was zelf ook een onnodige verruiming van dezelfde toegangscontrole.

Bevestigd getest: `npm run dev` toont na de wijziging geen "Network:"-regel meer (die
verschijnt normaliter alleen bij --host-gebruik) - dat kan nu structureel niet meer
gebeuren.

**Waarom GitHub's Dependabot-telling na deze fix nog steeds "1 high" toont:** Dependabot
categoriseert uitsluitend op geinstalleerde pakketversie versus bekend-kwetsbaar bereik. Het
kan niet zien dat we de daadwerkelijke aanvalsvoorwaarde (publieke blootstelling) zelf al
structureel onmogelijk gemaakt hebben zonder de versie te wijzigen. Dit is een verwachte,
onschuldige discrepantie tussen geautomatiseerde classificatie en daadwerkelijke,
in-code-geverifieerde risicomitigatie - vergelijkbaar met de eerdere Windows-only-observatie
in sectie 19.

**Openstaand, bewust uitgesteld:** een volledig geteste major-upgrade naar Vite 6/7/8, als
aparte, apart geplande taak wanneer daar tijd voor is - niet blokkerend voor nu, want het
daadwerkelijke aanvalspad is al gesloten.

## 21. Fase B afgerond: grondige security-doorloop van de Rust-programmalogica

Op expliciet verzoek een systematische doorloop van instructions.rs en state.rs, getoetst
tegen bekende Solana-kwetsbaarheidsklassen (ontbrekende signer/owner-checks, PDA-seed-
botsingen, type-cosplay, close-account-revival, integer-overflow, CPI-manipulatie). Vier
concrete bevindingen, drie direct gefixt:

**Bevinding A (gefixt) - ontbrekende validatie van passkey-prefix-bytes.** Nergens werd
gecontroleerd of seed_key (init_wallet) of new_owner_passkey (initiate_recovery)
daadwerkelijk met 0x02 of 0x03 begint (het verplichte SEC1-gecomprimeerd-punt-prefix). Bij
initiate_recovery was dit ernstig: een misvormde waarde zou de wallet na
finalize_recovery PERMANENT en ONHERSTELBAAR vastzetten - geen enkele handtekening kan ooit
tegen ongeldige sleutelbytes valideren. Fix: nieuwe validate_passkey_prefix()-helper,
aangeroepen in beide instructies, nieuwe SpankWalletError::InvalidPasskeyPrefix.

**Bevinding B (gefixt) - ontbrekende expliciete eigendom-/mint-check in hunt.** hunt
vertrouwde volledig op SPL Token's eigen interne validatie voor de relatie tussen
target_token_account, vault, en token_mint - niet direct misbruikbaar (SPL Token weigert
zelf al een mismatch), maar fragiele engineering. Fix: expliciete Anchor-constraints
(target_token_account.owner == vault.key(), target_token_account.mint == token_mint.key()),
nieuwe SpankWalletError::InvalidTargetTokenAccount.

**Bevinding C (bewust NIET gefixt, gedocumenteerd als open ontwerprisico) - theoretisch
front-running-risico bij init_wallet.** init_wallet vereist geen bewijs van eigendom van de
meegegeven seed_key op het moment van aanmaak - wie dan ook kan een wallet claimen voor een
willekeurige 33-byte-waarde. Als een aanvaller een passkey-publieke-sleutel zou kunnen
onderscheppen VOORDAT de rechtmatige eigenaar zelf init_wallet aanroept (kort tijdvenster
tussen passkey-aanmaak en transactiebevestiging), zou de aanvaller een wallet kunnen
claimen met een eigen backup_authority en na de recovery-flow de wallet overnemen. Praktisch
smal venster, geen raadbare sleutel nodig door de aanvaller - maar een reeel, tot nu toe niet
gedocumenteerd ontwerprisico. Vereist een bewuste ontwerpbeslissing (bv. commit-reveal-
patroon, of accepteren als afgewogen risico) - geen quick fix, bewust uitgesteld tot een
apart gesprek hierover.

**Bevinding D (gefixt) - inconsistente arithmetic-stijl.** finalize_recovery's
tijdsberekening (elapsed = clock.unix_timestamp - recovery.initiated_at) gebruikte gewone
aftrekking i.p.v. checked_sub, inconsistent met de checked-arithmetic-stijl elders (hunt).
Praktisch onschadelijk (zou pas na miljarden jaren overflowen) maar voor consistentie
gefixt met een eigen SpankWalletError::TimestampOverflow (bewust APART van
RentAccountingOverflow - een tussentijdse sed-fout tijdens het doorvoeren verwarde deze twee
foutcodes eerst, ontdekt en direct hersteld voordat verder werd gegaan, zie ook onderstaande
les).

**Zijeffect, ontdekt tijdens het testen van de fixes:** de bestaande TS-testfixtures
(tests/recovery.ts, tests/spankwallet.ts) gebruikten volledig willekeurige 33-byte-waarden
via randomBytes(33) voor seed_key/new_owner_passkey, zonder ooit het prefix-byte te forceren
- de nieuwe validate_passkey_prefix-check liet daardoor terecht alle 8 tests initieel falen.
Dit was geen regressie maar een onthulling dat de testfixtures nooit realistisch waren op
dit punt. Gefixt: bytes[0] = 0x02 geforceerd in beide testbestanden, overige 32 bytes
blijven willekeurig (behoudt de botsingsbescherming tussen testruns tegen het permanente
devnet-account-hergebruik-probleem uit eerdere secties).

**Les over voorzichtig sed-gebruik bij foutcode-hernoeming:** een aanvankelijk te brede
sed-vervanging (regex zonder regelnummer-specificiteit) veranderde per ongeluk 5 legitieme
RentAccountingOverflow-verwijzingen in hunt mee naar TimestampOverflow. Direct ontdekt door
het gewijzigde bestand meteen te herlezen na de vervanging (in plaats van te vertrouwen op
"het zal wel goed gegaan zijn"), en gericht per regelnummer hersteld. Bevestigt de waarde
van de in deze sessie gehanteerde werkwijze: elke wijziging direct verifiëren door het
gewijzigde bestand terug te lezen, nooit aannemen.

Bevestigd: 8/8 Rust-tests groen na alle wijzigingen. Gedeployed op devnet:
Bt7jcHC5RE93E6J5HGRtWBBmnXYbC3e21pjXLP6tqtBm.

**Fase B is hiermee inhoudelijk afgerond** (npm audit + Rust-security-doorloop). Open
punten: Bevinding C (ontwerpgesprek nodig), Vite major-upgrade (sectie 20, bewust
uitgesteld). Volgende fase per eerdere afspraak: Fase C (compacter/zuiverder/eenvoudiger -
code-opschoning + UI-vereenvoudiging), pas te beginnen nadat Bevinding C is besproken en
opgelost of bewust geaccepteerd.

## 22. Bevinding C volledig gedicht: init_wallet vereist nu een echte passkey-handtekening

Op expliciet verzoek ("accepteren geen enkel risico of zwakheid") is het front-running-
ontwerprisico uit Bevinding C (sectie 21) niet geaccepteerd maar volledig opgelost: init_wallet
vereist nu, net als execute/hunt/cancel_recovery, een ECHTE secp256r1-precompile-
handtekening als bewijs van bezit van de meegegeven seed_key, vóórdat de wallet daadwerkelijk
wordt aangemaakt.

**Cruciaal ontwerpdetail:** de challenge bindt niet alleen de wallet-PDA en het domain
("init_wallet"), maar ook backup_authority + recovery_timelock_seconds als payload. Zonder
die binding zou een onderschepte, geldige handtekening op seed_key alsnog herbruikbaar zijn
met een ANDERE backup_authority - dezelfde overname-aanval in een net iets andere vorm.
Nieuwe helper encode_optional_i64() (instructions.rs) codeert Option<i64> als vaste 9 bytes
voor deze payload-binding (apart van de Borsh-instructie-argument-codering, die variabele
lengte heeft - twee verschillende coderingen voor twee verschillende doelen, bewust niet
hergebruikt om verwarring te voorkomen).

InitWallet-struct kreeg een instructions_sysvar-account (address=IX_SYSVAR_ID). init_wallet
kreeg een nieuw client_data_json: Vec<u8>-parameter. Signature-verificatie gebeurt VOOR de
account-mutatie, consistent met het patroon in execute/hunt/cancel_recovery.

**Belangrijke technische onzekerheid, empirisch opgelost i.p.v. aangenomen:** voor de
Rust/TS-testsuite was een synthetische-maar-cryptografisch-echte WebAuthn-handtekening nodig
(geen browser/hardware beschikbaar in Node-test-context). Kernvraag: hasht Solana's
secp256r1-precompile het "message" zelf intern, of verwacht het een reeds gehasht bericht?
Geen sluitend antwoord gevonden in de documentatie/SIMD-0075-tekst. Besloten volgens
standaard-ECDSA-conventie te implementeren (SHA-256 van het bericht vóór p256.sign()) EN dit
DIRECT empirisch te toetsen tegen de echte precompile op de validator, i.p.v. op vertrouwen
te bouwen. Bevestigd correct in de eerste testrun: 8/8 passing.

Nieuw bestand tests/webauthnTestHelper.ts (gedeeld tussen spankwallet.ts en recovery.ts):
generateTestPasskey() (echt P-256-keypair via @noble/curves, geen willekeurige bytes met
geforceerd prefix-byte zoals eerder), buildExpectedChallenge(), signTestChallenge()
(synthetische WebAuthn-structuur + echte ECDSA-handtekening), buildSecp256r1Instruction()
(TS-tegenhanger van client/src/secp256r1.ts, bewust gedupliceerd i.p.v. gedeeld tussen
tests/ en client/ - twee losse npm-projecten, herstructureren is een Fase C-taak).
encodeOptionalI64() als TS-tegenhanger van de Rust-helper.

Nieuwe root-devDependencies: @noble/curves, @noble/hashes (tests-only, niet in het
on-chain-programma of de client-productiecode).

client/src/initWallet.ts volledig herbouwd: secp256r1-precompile-instructie + echte
navigator.credentials.get()-aanroep via signWithPasskey(), analoog aan execute.ts/hunt.ts.
client/src/main.ts's runStep2 vraagt nu ook om een biometrie-/PIN-prompt (naast de
wallet-goedkeuring).

**Zijeffect, ontdekt tijdens het browser-testen:** main.ts's runStep4 (recovery-flow-test)
gebruikte nog een volledig willekeurige dummyNewOwnerPasskey zonder het prefix-byte te
forceren - dezelfde klasse fout als eerder al gefixed in de Rust-testfixtures (sectie 21),
maar hier over het hoofd gezien omdat main.ts niet was aangeraakt tijdens die eerdere fix.
Direct gevonden en gefixed (bytes[0] = 0x02) zodra de browser-test dit blootlegde.

**Resultaat: volledig, in twee onafhankelijke omgevingen bevestigd.**
- Rust/TS-testsuite: 8/8 passing, met een echt cryptografisch secp256r1-keypair (niet langer
  "zonder passkey" zoals de oude testbeschrijving nog zei - init_wallet-tests testen nu ECHT
  de secp256r1-precompile-verificatie, niet alleen de account-/PDA-aanmaaklogica).
- Volledige browserflow (echte hardware-passkey + Phantom, devnet): alle 5 teststappen
  doorlopen zonder enige onverwachte fout. Signature van de succesvolle init_wallet-aanroep:
  2S5s6dGURsmGUcSSsCW1CKSTgrkmXh4eVL2MboYWdJCM89Bab1TXh4eBxLxzUmnKnWFtsmfwBTLWNLfVss9fzhja.

Gedeployed op devnet: Gcj9TL8Pt2KfknLVXRrSJ83qkgZzqgghCAFG7UaM31QP.

**Dit sluit Fase B volledig af, zonder enig geaccepteerd risico.** Alle vier bevindingen
(A, B, C, D) uit de security-doorloop zijn nu opgelost, niet slechts gedeeltelijk of
gedocumenteerd-als-risico. Volgende, per eerdere afspraak: Fase C (compacter/zuiverder/
eenvoudiger - code-opschoning + UI-vereenvoudiging).

## 23. Fase C gestart: gedeelde client-helpers samengevoegd

Eerste concrete Fase C-stap (compacter/zuiverder): de drie helperfuncties concatBytes(),
encodeBorshVecU8(), en buildExpectedChallenge() stonden bijna-identiek viervoudig
gedupliceerd in execute.ts, hunt.ts, recovery.ts en initWallet.ts. Samengevoegd tot een
nieuw, gedeeld client/src/challenge.ts.

Onderweg ontdekt en voorkomen: challenge.ts heeft SPANKWALLET_PROGRAM_ID nodig, maar
initWallet.ts (waar die constante voorheen stond) zou omgekeerd challenge.ts's helpers
nodig hebben - een circulaire import. Opgelost door de constante naar een eigen, minimaal
bestand client/src/programId.ts te verplaatsen, dat beide zonder cirkel kunnen importeren.
initWallet.ts blijft SPANKWALLET_PROGRAM_ID wel exporteren (re-export) zodat andere
bestanden die er al vanuit initWallet.ts importeerden niet hoefden te wijzigen.

Alle vier bestanden herschreven om de gedeelde helpers te importeren i.p.v. lokaal te
herdefiniëren. Bevestigd in de browser: stap 1, 2, en het begin van stap 4 slaagden
volledig identiek aan voor de opschoning (initiate_recovery met echte on-chain bevestiging).
Latere stappen liepen tegen devnet's RPC-rate-limiting aan (429, na de vele testruns van
vandaag) - een externe, tijdelijke beperking, geen regressie door de refactor.

Nog openstaand in Fase C: dezelfde soort duplicatie bestaat ook tussen client/src/
secp256r1.ts en tests/webauthnTestHelper.ts (bewust nog niet samengevoegd, twee losse
npm-projecten - zie sectie 22), CLI-testscript opruimen/archiveren, en de UI-vereenvoudiging
(momenteel vijf losse debug-knoppen, niet hoe een eindgebruiker SpankWallet zou ervaren).

## 24. Fase C afgerond: opruiming en leesbaarheid

Drie concrete opschoningsstappen na de eerdere helper-samenvoeging (sectie 23):

**CLI-testscript verwijderd:** client/scripts/cli-init-wallet-check.mjs was waardevol vroeg
in het project (toen Phantom nog niet met localnet kon praten, zie sectie 12/13), maar
overbodig sinds de volledige browserflow bewezen werkt. Verwijderd; de geschiedenis in Git
en STATUS.md behoudt de context mocht dat ooit nog relevant worden.

**Per-ongeluk-gecommit duplicaat-bestand ontdekt en verwijderd:** client/STATUS.md bleek te
bestaan naast het root-STATUS.md - ontstaan doordat een `cat >> STATUS.md`-commando ooit
per ongeluk vanuit de client/-map werd uitgevoerd i.p.v. de project-root (verklaart ook de
eerder opgemerkte, ogenschijnlijk inhoudsloze dubbele commit met identiek bericht). Bevatte
een geïsoleerde kopie van sectie 22. Correct verwijderd via git rm, geen inhoud verloren
(stond al compleet in het root-bestand).

**Verouderde teksten gecorrigeerd:** tests/recovery.ts's describe-beschrijving zei nog
"zonder passkey", wat niet meer klopt sinds createWallet() daarin een echte
passkey-handtekening gebruikt voor init_wallet (initiate/finalize zelf vereisen nog steeds
geen passkey - beschrijving verduidelijkt om dat onderscheid expliciet te maken).
client/index.html's titel en introductietekst spraken nog van "Stap 1+2", zonder stap 3-5 te
noemen - uitgebreid met een volledige, accurate beschrijving van alle vijf stappen.

**UI-leesbaarheid, bewust minimaal-risico aanpak:** op de vraag "wat is het veiligste"
gekozen voor de kleinst mogelijke, puur cosmetische wijziging i.p.v. de teststructuur zelf
te herzien - de vijf-losse-knoppen-met-volledige-logging-opzet blijft ongewijzigd, omdat
die opzet vandaag herhaaldelijk cruciaal was om problemen op te sporen (blockhash-volgorde,
RPC-propagatievertraging, de vergeten prefix-fix in runStep4). log() in main.ts gebruikt nu
DOM-elementen (createElement/textContent, GEEN innerHTML - voorkomt elk injectie-risico,
ook al is de inhoud altijd onze eigen programma-gegenereerde tekst) i.p.v. simpele
textContent-optelling, zodat regels die met "SUCCES" beginnen groen en regels die met
"FOUT" beginnen rood weergegeven worden. Nul functionele wijziging, puur visuele
leesbaarheidsverbetering. Bevestigd in de browser: styling werkt, rest van de flow
ongewijzigd (op devnet's bekende rate-limiting na, niet gerelateerd aan deze wijziging).

**Nog openstaand in Fase C (bewust laag-prioriteit, niet blokkerend):** de duplicatie tussen
client/src/secp256r1.ts en tests/webauthnTestHelper.ts (twee losse npm-projecten, een
gedeeld package zou een monorepo-herstructurering vereisen - groter dan de huidige
Fase C-scope rechtvaardigt). Een eventuele grotere UI-herziening (bijv. richting een
daadwerkelijke productie-achtige wallet-interface i.p.v. testpagina) is een aparte,
toekomstige fase, geen onderdeel van deze opschoning.

## 25. execute herbouwd: van generieke CPI-doorgeefluik naar gesloten, getypeerde actie

Op de vraag hoe het fundamentele veiligheidsrisico van een volledig open CPI-doorgeefluik
("wie een geldige handtekening kan produceren kan de vault laten interacteren met elk
programma, elke instructie") daadwerkelijk op te lossen, is grondig onderzoek gedaan naar
hoe productie-smart-wallets dit aanpakken, aangevuld met een eigen, doordacht overzicht van
de gebruiker (Crossmint Smart Wallet policies, Maestro agent policy engine).

**Kernbevinding uit onderzoek:** "Arbitrary CPI" is een erkende, benoemde kwetsbaarheidsklasse
in Solana-security-literatuur (SlowMist's solana-smart-contract-security-best-practices,
Helius' "Hitchhiker's Guide to Solana Program Security", Zealynx' security-checklist). De
Zealynx-checklist noemt letterlijk: "Unsafe CPI patterns - Forwarding user signers to
untrusted programs enables wallet theft" en "Don't forward user wallets - Use protocol PDAs
as authorities instead" - exact onze situatie (de vault-PDA als CPI-autoriteit doorgeven aan
een willekeurig doelprogramma). Productie-smart-wallets (genoemd op solana.com/wallets)
bieden "configurable spending caps, and destination allowlists", geen ongelimiteerde CPI.

**Besluit, samen met de gebruiker vastgesteld: vijf-lagen-aanpak, waarvan nu laag 2
geïmplementeerd:**
1. On-chain policy/allowlist (program-allowlist, spend limits, recipient-allowlist) - NOG
   NIET gebouwd, zie roadmap hieronder.
2. **Intent-based/getypeerde acties i.p.v. rauwe CPI - VANDAAG GEBOUWD.** execute is nu
   transfer_sol(recipient: Pubkey, amount: u64) - geen vrije-vorm-instructiebytes meer die
   het programma blind ondertekent/uitvoert. Arbitrary CPI bestaat hierdoor STRUCTUREEL
   niet meer voor execute, niet "beperkt door een allowlist" maar volledig afwezig: de
   enige mogelijke actie is precies wat de handtekening expliciet toestaat.
3. Gelaagde privileges/risk tiers (laag-risico=alleen passkey, hoog-risico=passkey+timelock
   of backup_authority-cosign) - NOG NIET gebouwd, zie roadmap.
4. Client-side human-readable preview + on-chain als harde grens - DEELS AL AANWEZIG: de
   wallet-extensie (Phantom) simuleert en toont balansveranderingen vóór ondertekening, een
   waardevol tweede controlepunt naast de (voor mensen niet leesbare) WebAuthn-prompt zelf.
5. Extra cryptografische/UX-lagen (domain separation, hardware-bound passkeys) - AL AANWEZIG
   sinds het begin van dit project, maar op zichzelf onvoldoende (vermindert alleen de kans
   op een gestolen handtekening, lost niet op wat een geldige handtekening mag doen).

**Technische implementatie:** nieuwe accounts in Execute: vault nu mut, nieuw recipient-
account (UncheckedAccount, willekeurige ontvanger - crediteren mag altijd, ongeacht
eigenaarschap). Challenge-payload bindt recipient + amount (16 bytes: 32+8) - een
onderschepte handtekening is dus specifiek en uitsluitend geldig voor precies dat bedrag
naar precies die ontvanger, niets anders. Directe lamport-manipulatie (geen System-Program-
CPI mogelijk, vault is eigendom van ons eigen programma - zelfde situatie als hunt, sectie
17), MET een nieuwe rent-exempt-drempelbewaking (Rent::get().minimum_balance) zodat een
overdracht de vault nooit onder zijn eigen rent-exempte minimum kan laten zakken. Nieuwe
foutcodes: ExecuteTransferOverflow, VaultWouldFallBelowRentExempt.

Nieuw, structureel: geen enkele externe CPI-aanroep meer nodig voor deze actie - volledig
zelfstandig binnen ons eigen programma, kleinst mogelijke aanvalsoppervlak voor de meest
fundamentele wallet-actie (SOL versturen).

client/src/execute.ts volledig herbouwd (recipient/amountLamports i.p.v. cpi_instruction_data).

**Bevestigd: 8/8 Rust-tests groen na de wijziging.** Devnet-deploy bevestigd
(ERAEjxMgxserGuj8hc6v7LVy6ZaXaVxwDtXFLbsxj8wY). Live browsertest (echte hardware-passkey +
Phantom) NOG NIET afgerond vandaag - zowel api.devnet.solana.com als het OnFinality-
alternatief (solana-devnet.api.onfinality.io/public, zie hieronder) raakten na de vele
testruns van vandaag verzadigd (429 Too Many Requests, ook Phantom's eigen simulatie
faalde hierdoor). Client wijst nu naar het OnFinality-endpoint. Bewust uitgesteld tot de
RPC-belasting afneemt, i.p.v. door te blijven proberen tegen een structureel overbelast
endpoint.

**Bijkomende ontdekking vandaag: gratis devnet-RPC-alternatief.** api.devnet.solana.com
heeft een officieel, gedocumenteerd rate-limit (100 verzoeken/10s per IP, 40/10s per
losse RPC-methode - solana.com/docs/references/clusters). Na intensief testen op één dag
onvermijdelijk geraakt. https://solana-devnet.api.onfinality.io/public is een legitiem,
veelgebruikt, gratis endpoint zonder aanmelding - werkte aanvankelijk goed voor een deploy
toen het officiële endpoint al geblokkeerd was, raakte later op dezelfde dag echter ook
verzadigd. Voor toekomstige sessies: overweeg een gratis account bij een dedicated
RPC-provider (Helius, Alchemy, QuickNode - allemaal genoemd in het onderzoek met reële
gratis tiers) als de teststand structureel intensiever gebruikt gaat worden.

## 26. Roadmap: verdere policy-lagen voor execute (NIET vandaag gebouwd, bewust uitgesteld)

Vastgelegd als expliciete, doordachte vervolgstappen - niet vergeten, wel bewust niet
vandaag opgepakt (groter werk dan één sessie rechtvaardigt):

- **Program-/instruction-allowlist voor wie ooit wel bredere CPI wil:** een aparte,
  standaard-uitgeschakelde instructie/modus (bijv. execute_advanced), met een vaste,
  on-chain gecontroleerde lijst van toegestane programma-ID's (System, Token, Token-2022,
  eventueel specifieke DEX's/Jupiter) EN instruction-discriminator-allowlist/blocklist
  binnen die programma's. Nooit als vervanging van de getypeerde acties, als aanvulling
  voor power-users.
- **Spend limits:** per token, per dag/week, absoluut maximum - vereist een nieuw
  SpendLimit- of Policy-account gekoppeld aan WalletAccount, met tijdvenster-tracking.
- **Recipient-allowlist:** optioneel, alleen transfers toestaan naar vooraf goedgekeurde
  adressen - sterke bescherming tegen phishing-geïnduceerde blind-signing, kost UX-
  flexibiliteit.
- **Gelaagde privileges/risk tiers:** kleine/bekende transfers = alleen passkey (huidige
  situatie); grote/eerste-keer-naar-dit-adres/advanced-CPI = passkey + timelock, of
  passkey + backup_authority-cosign, analoog aan de al bestaande recovery-timelock-
  architectuur.
- **transfer_token als volgende getypeerde actie** (zelfde patroon als transfer_sol, maar
  voor SPL-tokens) - logische eerstvolgende uitbreiding, hergebruikt grotendeels de
  hunt-achtige SPL-Token-CPI-kennis die al aanwezig is in dit project.

Deze roadmap is bewust NIET geïmplementeerd vandaag - v1 (transfer_sol, gesloten getypeerd,
geen allowlist-complexiteit) is de veiligste, kleinste, meest verdedigbare basis. Uitbreiding
volgt hetzelfde principe dat vandaag is vastgesteld: elke nieuwe mogelijkheid als eigen,
apart getypeerde instructie met eigen challenge-domain, nooit als generieke CPI-doorgeefluik.

## 27. Concrete uitwerking programma-allowlist (besproken, nog niet gebouwd - startpunt voor volgende sessie)

Vervolg op de roadmap uit sectie 26, na een gesprek over de praktische balans tussen
veiligheid en bruikbaarheid (SOL/SPL-tokens vrij laten stromen, DeFi-platforms
toegankelijk maken zonder de kernveiligheid los te laten).

**transfer_token (eerstvolgende stap, vóór de allowlist):** zelfde patroon als
transfer_sol (sectie 25) maar voor SPL-tokens - dekt daarmee automatisch zBTC, BTCSOL, en
elke andere SPL-token zonder per-munt-configuratie. De specifieke munt is geen
beveiligingsgrens; het SPL Token-programma zelf handelt de overdracht al veilig af zodra
`transfer_token` bestaat. Munt-namen/iconen zijn puur een UI-aangelegenheid.

**Programma-allowlist-architectuur (voor bredere DeFi-interactie zoals Jupiter):**

- Nieuw, klein on-chain policy-account gekoppeld aan WalletAccount, met een lijst
  toegestane programma-ID's.
- Twee nieuwe instructies: add_allowed_program, remove_allowed_program - BEIDE vereisen
  een echte passkey-handtekening, dus uitsluitend de walleteigenaar zelf kan zijn eigen
  lijst wijzigen. Geen enkele bevoorrechte partij (inclusief de ontwikkelaars) kan hier iets
  aan toevoegen namens de gebruiker.
- Een uitgebreide execute-variant die WEL een CPI naar een extern programma mag doen, maar
  eerst controleert of dat programma-ID op de eigen, gebruiker-goedgekeurde lijst staat -
  behoudt de kernbeveiliging (geen blinde/willekeurige CPI, zie sectie 25) terwijl er
  ruimte komt voor wat de gebruiker zelf vertrouwt.

**Twee-niveaus-UX voor het toevoegen van programma's, BEIDE via exact dezelfde on-chain
instructie (bewust geen on-chain onderscheid - zie motivatie hieronder):**

1. Aanbevolen lijst (client-side, door ons meegeleverd): een klein, zorgvuldig gecureerd
   lijstje bekende, veelgebruikte programma's (bijv. Jupiter). Puur een UI-gemaksfunctie -
   bij toevoegen alvast ingevuld met een geruststellende badge ("bekend, veelgebruikt
   programma"). De gebruiker moet nog steeds zelf, met zijn eigen passkey, expliciet
   bevestigen.
2. Handmatig een eigen adres toevoegen: dezelfde on-chain instructie, zonder badge, met een
   stevige, expliciete waarschuwing in de UI ("je staat op het punt deze wallet te laten
   interacteren met een niet-geverifieerd programma - voeg alleen toe wat je vertrouwt").

**Bewust ontwerpprincipe:** de on-chain logica maakt GEEN onderscheid tussen "aanbevolen"
en "handmatig" - beide lopen via identieke add_allowed_program-instructie met identieke
passkey-vereiste. Het verschil zit uitsluitend in de client-UI (badge/waarschuwingstekst
afhankelijk van of het adres in de meegeleverde lijst voorkomt). Bewust zo gekozen: een
on-chain onderscheid zou "aanbevolen" een soort door-de-ontwikkelaars-gecontroleerde
bevoorrechte status geven - een nieuw centralisatierisico. Dit houdt de wallet volledig
non-custodial: de ontwikkelaars adviseren alleen (via de client), de gebruiker beslist en
ondertekent altijd zelf, on-chain, zonder uitzondering.

Nog te bepalen bij implementatie: exacte account-layout van het policy-account, maximum
aantal toegestane programma's (vast array vs. dynamisch), en of remove_allowed_program een
timelock nodig heeft (voorkomt dat een gestolen sessie een programma stilletjes toevoegt
en er direct misbruik van maakt - te overwegen samen met de gelaagde-privileges-roadmap
uit sectie 26).

## 28. UI-veiligheidsroadmap (besproken, nog niet volledig geïmplementeerd)

Naast de programma-allowlist (sectie 27) is ook de veiligheid van de client-UI zelf
besproken - een wallet-UI is precies de plek waar een kleine kwetsbaarheid (XSS, een
gecompromitteerde dependency, clickjacking) direct tot verlies van fondsen kan leiden.

**Reeds aanwezig, zonder dat het expliciet als beveiligingsmaatregel was benoemd:**
- client/src/main.ts's log()-functie gebruikt createElement()/textContent, nooit
  innerHTML - maakt XSS via geinjecteerde HTML structureel onmogelijk, zelfs bij
  onverwachte tekens in gelogde data (zie sectie 24, oorspronkelijk toegevoegd voor
  leesbaarheid, blijkt ook een beveiligingsvoordeel).
- WebAuthn's rpId-binding zorgt al voor domeinbinding op protocolniveau - een phishing-site
  op een ander domein kan structureel nooit een geldige handtekening van dezelfde passkey
  verkrijgen.
- Geen externe CDN's voor scripts - alles via npm/Vite gebundeld, geen derde partij die
  ongemerkt andere code kan gaan serveren.

**Nog toe te voegen, vastgelegd als concreet startpunt:**

1. **Strict Content-Security-Policy (CSP).** Belangrijkste, meest concrete stap. Verbiedt
   externe scripts, inline-scripts, en eval() - zelfs bij een geslaagde HTML-injectie kan
   dan alsnog geen code worden uitgevoerd. Voor een wallet zo strikt mogelijk:
   script-src 'self', geen unsafe-inline, geen unsafe-eval. Te implementeren via een
   meta-tag in index.html of (beter, bij eventuele eigen hosting) een HTTP-response-header.

2. **Supply-chain-verharding.** npm ci gebruiken i.p.v. npm install in elke build (respecteert
   de lockfile exact, geen onverwachte versie-drift). Bewust overwegen om dependency-versies
   vast te pinnen i.p.v. ^-ranges, met name voor cryptografie-gerelateerde packages
   (@noble/curves, @noble/hashes, @solana/web3.js). Elke nieuwe dependency bewust
   beoordelen op onderhoud/vertrouwen voordat toegevoegd, niet alleen op functionaliteit.

3. **Clickjacking-bescherming.** X-Frame-Options: DENY of frame-ancestors 'none' - voorkomt
   dat de wallet-UI onzichtbaar in een iframe op een kwaadaardige site geladen kan worden
   om klikken te kapen.

4. **Bij een eventuele eigen browserextensie (i.p.v. leunen op Phantom zoals nu):** de
   bevestigingsprompt (waar de gebruiker ziet wat hij ondertekent) moet in een
   geisoleerde context draaien, gescheiden van de rest van de UI-code - zoals Phantom het
   zelf doet. Sluit aan bij de observatie uit sectie 25 dat Phantom's eigen
   simulatie-preview al een waardevol tweede controlepunt is naast de WebAuthn-prompt
   zelf (die geen leesbare transactie-inhoud toont).

Prioriteitsvolgorde voor implementatie: CSP eerst (grootste beveiligingswinst, kleinste
implementatie-inspanning), dan npm ci in de build-workflow, dan de overige punten
naarmate het project richting een bredere/publiekere release beweegt.


## 29. Beoordelingscriteria voor de aanbevolen-lijst (uitbreiding op sectie 27)

Op de vraag hoe de "aanbevolen lijst" (sectie 27) daadwerkelijk gebruikers moet
beschermen - niet alleen technisch (is het programma veilig aan te roepen) maar ook
financieel (wat gebeurt er met je geld als het misgaat) - onderstaande criteria
vastgelegd, in volgorde van belang:

1. **Audit-geschiedenis.** Meerdere onafhankelijke, gerenommeerde audits, met publiek
   toegankelijke rapporten. Een enkele audit is een startpunt, geen garantie.

2. **Trackrecord, met name gedrag NA een incident.** Hoe langer een protocol zonder
   incidenten draait is een signaal, maar minstens even belangrijk: als er ooit een hack
   was, zijn gebruikers dan volledig terugbetaald? Dit zegt vaak meer over
   betrouwbaarheid dan "nooit gehackt" - elk protocol kan getroffen worden, hoe ermee
   omgegaan wordt is het onderscheidende signaal.

3. **Verzekering/reserves specifiek voor gebruikerscompensatie.** Heeft het protocol een
   eigen verzekeringsfonds, externe dekking (bijv. protocol-verzekering zoals Nexus
   Mutual-achtige constructies), of een treasury expliciet gereserveerd voor terugbetaling
   bij een exploit?

4. **Upgrade-authority-decentralisatie.** Cruciaal, vaak over het hoofd gezien: staat het
   programma onder een timelocked multisig, of kan een enkele sleutel het programma
   ogenblikkelijk wijzigen? Dat laatste is een reëel "rug pull"-risico, los van hoe goed de
   huidige code is - relevant voor SpankWallet zelf ook (zie de eigen upgrade-authority-
   observatie in sectie 12).

5. **Actief bug-bounty-programma** (bijv. via Immunefi). Teken van doorlopende, serieuze
   investering in veiligheid, niet alleen een eenmalige audit bij lancering.

6. **TVL + tijd in productie.** Ruwe, aanvullende marktvertrouwens-indicator, nooit op
   zichzelf voldoende - een aanvulling op de bovenstaande criteria, geen vervanging.

**Belangrijk onderscheid: on-chain DeFi-programma's versus gecentraliseerde beurzen.**
Bovenstaande criteria gelden voor on-chain programma's waarmee de wallet daadwerkelijk via
CPI interacteert (Jupiter, DEX's - de allowlist uit sectie 27). Een gecentraliseerde beurs
is technisch fundamenteel anders: geld ernaartoe sturen is een gewone transfer, geen
programma-aanroep, dus geen allowlist-kwestie in dezelfde zin. Verdient een EIGEN,
apart waarschuwingstype in de UI: "je stuurt geld naar een custodial platform - je
vertrouwt hun solvabiliteit en beveiliging, niet die van deze wallet." Een fundamenteel
ander risicotype dan een smart-contract-bug, moet ook anders gecommuniceerd worden -
niet met dezelfde "geverifieerd programma"-badge als een DeFi-protocol.

**Eerlijke, verplichte grens - altijd te communiceren in de UI:** de financiele
soliditeit van een beurs of protocol kan niet in realtime programmatisch geverifieerd
worden. Dit blijft mensenwerk, vereist periodieke herziening van de aanbevolen lijst, en
de UI mag NOOIT de indruk wekken dat "aanbevolen" hetzelfde is als "gegarandeerd veilig" -
altijd expliciet vermelden dat het gaat om een zorgvuldige, maar geen onfeilbare
beoordeling. Consistent met het principe uit sectie 27: de gebruiker beslist en tekent
altijd zelf, de aanbevolen lijst is advies, geen garantie of vrijwaring.

## 30. execute/transfer_sol live-browsertest voltooid + drie reele bugs gevonden en opgelost

Vervolgsessie, begon met "stap 1" (bevestigen dat gisteren se werk nog standhoudt) - leverde
drie onafhankelijke, echte problemen op, geen van alle mysterieus of onoplosbaar, elk
gevonden door grondig door te vragen i.p.v. genoegen te nemen met een vage foutmelding.

**Probleem 1: RPC-instabiliteit hield aan.** Zowel api.devnet.solana.com als het OnFinality-
fallback-endpoint (sectie 25) bleken vandaag opnieuw structureel overbelast (429's, ook
Phantom's eigen achtergrondverkeer liep vast met een generieke 400-fout). Opgelost door een
dedicated, gratis Helius-devnet-RPC-account aan te maken (1M credits/maand gratis tier) -
structurele oplossing i.p.v. weer een ander gedeeld publiek endpoint proberen. Client
(client/src/main.ts) wijst nu naar https://devnet.helius-rpc.com/?api-key=<eigen-sleutel>.
Phantom zelf bleek geen instelbaar custom-RPC-veld voor devnet te hebben - blijft op zijn
eigen infrastructuur draaien, wat na de Helius-omschakeling geen probleem meer bleek.

**Probleem 2: verouderd programma-ID in client/src/programId.ts.** Na de execute-herbouw
naar transfer_sol (sectie 25, nieuw devnet-ID ERAEjxMgxserGuj8hc6v7LVy6ZaXaVxwDtXFLbsxj8wY)
was programId.ts nooit bijgewerkt - bleef wijzen naar het OUDE, pre-herziening programma-ID
(Gcj9TL8Pt...). Dit veroorzaakte een InstructionDidNotDeserialize-fout (0x66) bij execute:
de client verstuurde de NIEUWE instructie-encodering (amount: u64 als 8 rauwe bytes) naar
het OUDE programma, dat nog de oude signatuur (cpi_instruction_data: Vec<u8>) verwachtte.
Ontstaan tijdens Fase C's helper-samenvoeging (sectie 23) toen SPANKWALLET_PROGRAM_ID naar
een eigen bestand verplaatst werd - de verplaatsing zelf was correct, maar de waarde was op
dat moment al verouderd en is nooit apart geverifieerd tegen de laatste deploy. Direct
gevonden door de testoutput exact te vergelijken met de in sectie 25 gedocumenteerde nieuwe
program-ID, en gefixed met een gerichte sed-vervanging.

**Probleem 3 (geen bug, correct gedrag): VaultWouldFallBelowRentExempt bij de eerste
transfer_sol-poging.** Na het fixen van probleem 2 trad een NIEUWE foutmelding op:
VaultWouldFallBelowRentExempt (6017). Onderzoek wees uit dat dit geen programmabug was maar
verwacht, correct gedrag: de vault-PDA wordt door init_wallet aangemaakt met PRECIES de
rent-exempte minimum-lamports, zonder enig vrij saldo - elke transfer_sol-poging, hoe klein
ook, zou de vault daardoor onder zijn eigen minimum duwen. Dit bevestigt dat de
rent-exempt-drempelbewaking uit sectie 25 exact werkt zoals ontworpen. Opgelost door
main.ts's runStep3 een funding-stap te geven: eerst 100000 lamports van de payer naar de
vault-PDA sturen (gewone SystemProgram.transfer, aparte Phantom-goedkeuring), pas daarna
transfer_sol van 1000 lamports proberen - slaagt nu.

**Resultaat: execute/transfer_sol volledig bevestigd end-to-end**, met echte hardware-
passkey-handtekening en Phantom, op devnet. Signature van de succesvolle execute-aanroep:
4rnr3UdRzbJuma1UxK2cjHbuUHhiaPC9rkTmf9Xe7Smkzsx3vtJ8VHt1eykriZQEPaZRuXyEYzqSZzhca2cq5VkK.

**Les voor toekomstige refactors:** wanneer een constante (zoals een programma-ID) naar een
nieuw bestand verplaatst wordt tijdens een opschoning, expliciet verifieren dat de
VERPLAATSTE WAARDE zelf nog actueel is, niet alleen dat de verplaatsing zelf syntactisch
correct is - een refactor kan een reeds-verouderde waarde onbedoeld "bevriezen" zonder dat
er een functionele testfout in dezelfde sessie optreedt (Fase C's eigen browsertest
gebruikte toen alleen init_wallet/hunt/recovery, niet execute, dus de fout bleef onopgemerkt
tot vandaag).

## 31. hunt bewezen tegen een echt, extern devnet-token (Circle devnet-USDC)

Laatste openstaande item uit het begin van deze sessie ("stap 1", zie sectie 30) - hunt
werd tot nu toe altijd getest tegen een spam-token dat de eigen testflow zelf aanmaakte
(setupSpamTokenAccount in hunt.ts). Functioneel maakt dit voor het programma geen verschil
(SPL Token-instructies werken identiek ongeacht wie de mint aanmaakte), maar als sterker,
overtuigender bewijs is nu ook getest tegen een ECHT, extern, bekend devnet-token: Circle's
officiele devnet-USDC (mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU), verkregen via
de gratis Circle-faucet (faucet.circle.com, tot 20 USDC/2u zonder account).

Nieuwe teststap (client/index.html knop 6, client/src/main.ts's runStep6): stuurt 1 USDC
vanuit de gewone gebruikerswallet naar de vault-PDA (simuleert een echte, ongevraagde
ontvangst van buitenaf - het scenario waar hunt voor ontworpen is), roept dan hunt aan op
dat echte token. Hergebruikt de bestaande, bewezen buildHuntTransaction() uit hunt.ts
ongewijzigd - alleen de testopzet (welk token, van waar) is nieuw, niet de programmalogica.

Bevestigd end-to-end op devnet met echte hardware-passkey: het USDC-token-account is
aantoonbaar gesloten na de hunt-aanroep (rechtstreekse getAccountInfo-check op het account
zelf, niet afhankelijk van eventuele RPC-propagatievertraging). Signature:
2dzSpG9aS8BJAGLTpNtZw8sWJUQtXzpu6SnN3E1Mgkpx3B9w3WwGguC1Z8PqNd1sdkVb8oz7uvZ6fad2unU5ann1.

De bekende "Incinerator-toename: 0 lamports"-melding trad ook hier weer op (zelfde
RPC-propagatievertragingsartefact als eerder empirisch vastgesteld in sectie 17, niet een
nieuwe bug) - de account-sluiting zelf is het sluitende, betrouwbare bewijs van correcte
uitvoering, niet de directe balansquery.

**Hiermee is de volledige testdekking uit "stap 1" van deze sessie afgerond:**
init_wallet, execute/transfer_sol, en hunt (zowel tegen eigen als tegen extern-aangemaakte
tokens) zijn nu allemaal end-to-end bewezen met echte hardware-passkeys op devnet.

## 32. transfer_token geimplementeerd: tweede getypeerde actie

Eerste concrete bouwstap na de volledige testdekking uit sectie 30-31, precies volgens de
roadmap uit sectie 26/27 - transfer_token als tweede getypeerde actie na transfer_sol,
zelfde ontwerpprincipe: gesloten, expliciet, geen generieke CPI.

**Nieuwe on-chain instructie transfer_token(amount: u64, client_data_json: Vec<u8>):**
- Accounts: wallet, vault (beide read-only, geen mut nodig - de vault zelf muteert niet,
  alleen de token-accounts), vault_token_account (mut, met owner+mint-constraints, zelfde
  patroon als target_token_account in hunt), recipient_token_account (mut, met alleen een
  mint-constraint - willekeurige ontvanger toegestaan, zelfde principe als execute's
  recipient), token_mint (UncheckedAccount, alleen doorgegeven aan de CPI), instructions_sysvar,
  token_program.
- Challenge-payload bindt recipient_token_account + token_mint + amount (32+32+8 bytes) -
  een onderschepte handtekening is dus specifiek geldig voor precies dat bedrag, die
  ontvanger, EN die mint, niets anders.
- Implementatie: ECHTE SPL-Token-CPI (token::transfer), ondertekend door de vault-PDA via
  invoke_signed met dezelfde seeds als hunt gebruikt - in tegenstelling tot transfer_sol
  (directe lamport-manipulatie, geen CPI nodig) MOET transfer_token wel een CPI doen, omdat
  SPL-token-overdrachten altijd een owner-autoriteit-handtekening vereisen die de runtime
  zelf controleert, niet iets wat met directe accountmanipulatie te omzeilen is.
- Nieuwe foutcodes: InvalidVaultTokenAccount, InvalidRecipientTokenAccount.

Client: nieuw bestand client/src/transferToken.ts (buildTransferTokenTransaction, zelfde
structuur als execute.ts), nieuwe teststap 7 (runStep7) in main.ts - gebruikt opnieuw
Circle's devnet-USDC (zelfde aanpak als sectie 31: een echt, extern token i.p.v. een
zelf-aangemaakt testtoken).

**Belangrijke les herhaald en dit keer meteen goed toegepast:** na de programma-ID-fout uit
sectie 30 (verouderd ID in programId.ts na een eerdere refactor) is programId.ts deze keer
METEEN bijgewerkt na de nieuwe deploy, voordat er client-code tegen getest werd - geen
herhaling van die specifieke fout.

**Kleine, herkenbare sed-valkuil tijdens het invoegen:** bij het invoegen van zowel
runStep7 (na runStep6) als het transfer_token-Rust-blok (in lib.rs, na hunt) ontstonden
kortstondig dubbele/ontbrekende sluit-accolades door een verkeerd ingeschat invoegpunt -
in beide gevallen direct herkend (via de daaropvolgende sed -n-controle die een dubbele of
ontbrekende `}` liet zien) en gericht hersteld voordat er gebouwd werd. Consistent met de
in deze hele sessie gehanteerde werkwijze: elke wijziging direct verifieren, nooit
aannemen dat een sed-invoeging is gelukt zoals bedoeld.

**Resultaat: 8/8 Rust-tests groen, en volledig end-to-end bevestigd op devnet** met echte
hardware-passkey: 0.5 USDC (500000 units) succesvol verplaatst van de vault-token-account
terug naar de payer. Signature:
4f8R67UdRJuUNqodQLJs5sVP83HWzcsgkwKd1aezYqqnydVQnMvyZr4CbajG337gybRJhxCf6bKrQiPzx3BnBDS7.
Gedeployed op devnet: 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9.

Met transfer_sol en transfer_token nu beide bewezen, dekt SpankWallet de twee meest
fundamentele wallet-acties (native SOL en willekeurige SPL-tokens, inclusief zBTC/BTCSOL)
volledig, zonder ooit een generieke CPI-doorgeefluik te hebben geintroduceerd.

## 33. UI-veiligheidsroadmap stap 1 afgerond: strikte Content-Security-Policy

Eerste, hoogste-prioriteit stap uit sectie 28 uitgevoerd: client/index.html heeft nu een
CSP via een `<meta http-equiv="Content-Security-Policy">`-tag, zo strikt mogelijk voor een
wallet-UI:

- `script-src 'self'` - geen `unsafe-inline`, geen `unsafe-eval`. Was al haalbaar zonder
  compromis: de enige script-inhoud is de module-import van /src/main.ts, geen inline
  `<script>`-blokken aanwezig.
- `style-src 'self'` - ook zonder `unsafe-inline`. index.html had wel een inline
  `<style>`-blok (alle CSS voor de testpagina); dat is verplaatst naar een nieuw bestand
  client/src/style.css en via `<link rel="stylesheet">` ingeladen, zodat er geen enkele
  inline-uitzondering nodig was. Bewuste keuze: liever de styling-bron verplaatsen dan de
  CSP verzwakken voor iets dat net zo goed extern kan.
- `connect-src 'self' https://devnet.helius-rpc.com` - de enige externe host die de
  pagina zelf aanspreekt (client/src/main.ts's Connection, devnet). Wallet-extensies
  (Phantom) doen hun eigen RPC-verkeer vanuit hun eigen extensiecontext, niet vanuit de
  pagina zelf, dus die vallen buiten de CSP van de pagina.
- Overige directives zo strikt mogelijk: `default-src 'self'`, `img-src 'self'`,
  `font-src 'self'` (geen externe afbeeldingen/fonts aanwezig), `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `frame-src 'none'`.

**Bekende beperking, bewust zo gelaten:** `frame-ancestors` (en `report-uri`/`sandbox`)
worden door de CSP-spec NIET gehandhaafd wanneer ze via een `<meta>`-tag afgeleverd worden
- alleen via een echte HTTP-response-header. Chromium bevestigt dit letterlijk in de
console: "The Content Security Policy directive 'frame-ancestors' is ignored when
delivered via a `<meta>` element." De directive blijft staan als documentatie van de
intentie (en werkt automatisch zodra dit ooit achter een eigen server met headers draait),
maar de daadwerkelijke clickjacking-bescherming (roadmap-punt 3 uit sectie 28) is dus nog
NIET gerealiseerd - vereist X-Frame-Options of een CSP-header vanaf een echte server, niet
mogelijk vanuit een statische meta-tag alleen. Voor nu draait dit project via Vite's
dev-server zonder eigen response-header-laag, dus dit blijft openstaand tot een eventuele
eigen hosting-opzet.

**Getest:** `npm run dev` gestart, pagina opgehaald en gecontroleerd met headless Chromium
(`chromium --headless=new --dump-dom` + `--enable-logging=stderr` om de browserconsole te
vangen, aangezien er geen interactieve browser beschikbaar was in deze sessie). Resultaat:
pagina laadt normaal (200 OK, alle content aanwezig), /src/style.css en /src/main.ts beide
200, Vite's HMR-websocket verbindt gewoon ("[vite] connected."), en de ENIGE
CSP-gerelateerde consoleregel is de hierboven genoemde, verwachte `frame-ancestors`-melding
- geen "Refused to..."-violaties, geen geblokkeerde resources. Gebruiker heeft nog niet
zelf in een normale browser gekeken; als daar alsnog iets afwijkt (bijvoorbeeld door een
wallet-extensie die zelf inline content in de pagina probeert te injecteren) is dat de
volgende plek om te kijken.

Gecommit en gepusht naar main (1d980ce). npm-audit-supply-chain-verharding (roadmap-punt 2:
npm ci in build, versies pinnen) en de overige punten uit sectie 28 blijven bewust
openstaand voor een volgende sessie, zoals daar al aangegeven.

**Zijdelings, tijdens dezelfde sessie bekeken maar NIET gemerged:** de openstaande
Dependabot-PR #1 (npm_and_yarn-groep, /client) bumpt vite 5.4.21 -> 6.4.3 en esbuild 0.21.5
-> 0.25.12. Dit is exact de major-upgrade die in sectie 20 bewust werd uitgesteld ("een
aparte, bewust geplande taak, geen tussendoortje") - blijft op verzoek van de gebruiker
onaangeraakt tot een expliciete, apart geplande test van die upgrade.

## 34. Programma-allowlist gebouwd: add_allowed_program, remove_allowed_program, execute_advanced

Eerste concrete bouwstap uit de architectuur die in sectie 26/27 was uitgewerkt maar
bewust nog niet gebouwd - de programma-allowlist die bredere DeFi-interactie (Jupiter en
vergelijkbaar) mogelijk maakt zonder de kernbeveiliging (geen blinde/willekeurige CPI, zie
sectie 25) los te laten.

**Nieuw account: PolicyAccount, PDA `[b"policy", wallet.key()]`.** Vast array van 32
programma-ID's (`allowed_programs: [Pubkey; 32]` + `count: u8`) i.p.v. een dynamische Vec.
Bewuste keuze, samen met de gebruiker doorgesproken: een dynamische lijst zou bij elke
`add_allowed_program` een Anchor `realloc` vereisen (extra rent-topup, en bij `remove` geeft
een Vec geen rent terug zonder aparte, foutgevoelige boekhouding). Voor een persoonlijke
wallet-allowlist (een handvol gecureerde + handmatig toegevoegde programma's, geen
honderden) is een vast aantal slots simpelweg goedkoper EN eenvoudiger - 1066 bytes,
~0,008 SOL eenmalige rent, zonder enige realloc-complexiteit. `remove_allowed_program`
gebruikt swap-remove (laatste actieve entry naar het gat) om de actieve slots altijd
aaneengesloten vanaf index 0 te houden, O(1).

Het policy-account wordt LUI aangemaakt op de eerste `add_allowed_program`-aanroep via
Anchor's `init_if_needed` (nieuwe Cargo-feature op anchor-lang), i.p.v. een aparte
`init_policy`-instructie. Dit is hier veilig zonder de bekende init_if_needed-valkuil
(re-init-aanvallen bij accounts die ook een ANDER type/eigenaar zouden kunnen hebben): het
policy-adres is een PDA die uitsluitend deterministisch van `wallet.key()` afhangt, dus er
kan nooit een ander accounttype op dat adres bestaan om per ongeluk te "hergebruiken" - het
is ofwel nog nooit aangemaakt, ofwel altijd al precies deze structuur. Eerste-gebruik wordt
herkend via `policy.wallet == Pubkey::default()` (een echte WalletAccount-PDA is nooit gelijk
aan de default/nul-pubkey).

**add_allowed_program / remove_allowed_program vereisen BEIDE een echte, domain-gebonden
secp256r1-passkey-handtekening** - zelfde patroon als execute/transfer_token/hunt (challenge
bindt het programma-ID aan de wallet + de instructienaam als domain). Geen enkele partij,
ook niet de ontwikkelaars, kan de allowlist namens de gebruiker wijzigen. `add_allowed_program`
weigert bovendien het eigen SpankWallet-programma-ID (`SelfCpiNotAllowed` - er is geen
legitiem gebruik voor zelf-CPI, en dit sluit elke twijfel over reentrancy-gedrag structureel
af in plaats van te leunen op runtime-garanties die tussen Solana-versies kunnen verschillen).

**Bewust GEEN on-chain onderscheid tussen "aanbevolen" en "handmatig toegevoegd" programma** -
exact zoals in sectie 27 vastgelegd. Beide lopen via identiek `add_allowed_program`, on-chain
volledig gelijk behandeld; het verschil (badge/waarschuwing) is puur clientside UI, een latere,
aparte stap.

**Timelock-vraag uit sectie 27 voorgelegd en samen met de gebruiker besloten: GEEN timelock,
noch op add, noch op remove.** Motivatie (voorgelegd via expliciete opties, gebruiker koos de
aanbevolen optie): in dit ontwerp bestaat er geen "gestolen sessie" zoals bij OAuth-sessies of
browserextensie-permissies - elke aanroep vereist sowieso een eigen, verse, live
passkey-handtekening. Het specifieke risico dat sectie 27 noemde ("toevoegen + direct
misbruiken") gebeurt hoe dan ook atomair BINNEN dezelfde transactie als de add (via
blind-signing/een misleidende client, zie sectie 25) - een timelock op remove verandert daar
niets aan, de schade is al gebeurd voordat remove ooit relevant wordt. De precies gerichte
mitigatie (een activatievertraging voordat een NIEUW toegevoegd programma door
execute_advanced gebruikt mag worden) hoort thuis in de al geplande "gelaagde
privileges"-roadmap van sectie 26, bewust niet vandaag gebouwd als blanket-timelock.

**execute_advanced: de eerste instructie die wél een CPI naar een extern programma mag doen.**
Accounts: wallet (read-only), vault (mut - mag als CPI-autoriteit optreden), policy (read-only,
membership-check), `cpi_program` (UncheckedAccount, moet op `policy.allowed_programs` staan EN
`executable` zijn), instructions_sysvar. De daadwerkelijke CPI-accounts komen via
`ctx.remaining_accounts` - elke account wiens sleutel gelijk is aan de vault wordt via
`invoke_signed` met de vault-PDA-seeds als signer doorgegeven (zelfde mechanisme als
hunt/transfer_token), de rest ongewijzigd doorgegeven zoals de aanroeper aanlevert (de
Solana-runtime staat sowieso geen signer-escalatie toe voor accounts die het programma niet
zelf via invoke_signed kan verantwoorden).

**Challenge bindt het VOLLEDIGE CPI-target**, niet alleen het programma-ID: programma-ID + elke
meegegeven account (sleutel + schrijf-vlag + signer-vlag, deze laatste al geforceerd voor de
vault) + de instructiedata zelf. Een onderschepte handtekening is dus uitsluitend geldig voor
precies deze ene, volledig gespecificeerde CPI-aanroep tegen precies dat toegestane programma -
zelfde principe als transfer_sol/transfer_token (sectie 25/32).

**Twee compilerfouten tijdens het bouwen, beide meteen opgelost en geverifieerd door
herbouwen:**
1. Borrow-checker-conflict (`policy.allowed_programs[policy.count as usize] = ...` - `count`
   lezen terwijl `allowed_programs` al mutabel geleend is) - opgelost door `count` eerst in
   een lokale variabele te zetten.
2. Lifetime-fout bij het combineren van `ctx.remaining_accounts` (leeft zo lang als Context's
   eigen `'info`) met `ctx.accounts.cpi_program.to_account_info()` (kreeg een losstaande,
   niet-geünificeerde lifetime door elisie) - opgelost door `execute_advanced` een expliciete,
   gedeelde `'info`-lifetime te geven op zowel de vrije functie in instructions.rs als de
   `#[program]`-wrapper in lib.rs (`Context<'info, ExecuteAdvanced<'info>>`).

**Testen: 8 nieuwe lokale Rust-tests in het nieuwe tests/policy.ts**, zelfde stijl/patroon als
tests/spankwallet.ts en tests/recovery.ts (echte p256-handtekeningen via webauthnTestHelper.ts,
geen gemockte crypto):
- happy-path add_allowed_program (incl. init_if_needed-creatie van het policy-account)
- SelfCpiNotAllowed bij toevoegen van het eigen programma-ID
- ProgramAlreadyAllowed bij een duplicaat
- happy-path remove_allowed_program (bevestigt swap-remove houdt de lijst aaneengesloten)
- ProgramNotAllowed bij remove van een niet-toegevoegd programma
- ProgramNotAllowed bij execute_advanced tegen een niet-toegestaan programma
- **execute_advanced met een echte CPI naar System Program (`Assign`)** - bewijst de
  basis-CPI-dispatch + policy-gate + volledige challenge-binding met een gewoon signende
  account
- **execute_advanced met een echte SPL Token::transfer-CPI, vault als GEFORCEERDE
  PDA-signer-autoriteit** - bewijst het kernmechanisme van execute_advanced (de vault mag
  namens zichzelf tekenen bij een willekeurig toegestaan extern programma), zonder een nieuwe
  npm-dependency: de Token-instructielay-outs (InitializeMint/InitializeAccount/MintTo/
  Transfer) zijn handmatig opgebouwd, zelfde aanpak als de bestaande
  secp256r1-precompile-helper in webauthnTestHelper.ts. Lokaal bevestigd dat SPL Token
  standaard aanwezig is op de solana-test-validator-genesis, geen aparte deploy/clone nodig.

**Subtiele testbug onderweg gevonden en opgelost:** de eerste versie van de
SPL-Token-CPI-test gaf de vault `isWritable: false` mee in `remainingAccounts`, en kreeg
`WebAuthnChallengeMismatch`. Oorzaak: vault staat in DEZELFDE instructie ook als het
mut-gedeclareerde, met-naam-genoemde `vault`-account - Solana's transactie-compilatie merget
de schrijf-vlag van eenzelfde sleutel over alle voorkomens binnen een instructie, dus het
Rust-programma zag `is_writable = true` ongeacht wat de TS-test in `remainingAccounts` opgaf.
De TS-challenge-berekening moet daarom exact weerspiegelen wat on-chain daadwerkelijk
waargenomen wordt, niet alleen wat de aanroeper "bedoelt" mee te geven - les die aansluit bij
het steeds terugkerende principe in dit project (zie de sed-valkuilen in sectie 21/22/32): elke
aanname verifiëren tegen wat er werkelijk gebeurt, niet tegen wat logisch zou moeten gebeuren.

**Resultaat: 15/16 relevante lokale tests groen** (8 nieuw + 7 bestaand). De ene falende test
(`finalize_recovery slaagt ná het tijdslot`, recovery.ts) is een vooraf al bestaande,
omgevingsgebonden flaky timing-test (raakt de on-chain klok van de lokale validator, niet iets
in dit project se code) - expliciet bevestigd door `git stash` en dezelfde test op ongewijzigde
`main` te draaien: faalt daar identiek, dus aantoonbaar niet veroorzaakt door deze wijziging.

Gecommit en gepusht naar main (9adc77a). Devnet-deploy en live-browsertest bewust nog NIET
gedaan vandaag - volgt als aparte, losse stap na bevestiging dat de Rust-laag klopt (in lijn
met de afspraak voor deze sessie).

## 35. Programma-allowlist bewezen end-to-end op devnet, inclusief een CSP-regressie gevonden en gefixed

Vervolg op sectie 34 (on-chain laag + lokale tests) - vandaag devnet-deploy, browser-
uitbreiding (stappen 8-10), en een volledige live-test met echte hardware-passkey.

**Devnet-deploy - een landmine ontdekt in het bestaande build-script:** `./scripts/
build-and-deploy.sh --clean` bleek TWEE problemen te hebben zodra die letterlijk tegen
devnet gedraaid zou worden op deze machine:

1. **Verkeerde signer.** Het script se `solana program deploy` heeft geen `--keypair`-vlag,
   dus leunt het op de globale `solana config`-default. Die stond op deze machine op
   `/home/michel/solana_darkpool/heartbeat.json` - een keypair van een compleet ANDER,
   ongerelateerd project dat toevallig dezelfde machine deelt, niet de upgrade-authority
   van SpankWallet (`~/.config/solana/id.json`, G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp,
   bevestigd via `solana program show`). Blindweg draaien had een mislukte transactie
   vanuit een volledig verkeerde, ongerelateerde wallet oncost. Opgelost door de globale
   config NIET aan te raken (voorkomt zij-effecten op het andere project) en in plaats
   daarvan expliciet `--keypair ~/.config/solana/id.json` te gebruiken bij de deploy-stap
   zelf, zoals README.md se eigen devnet-sectie al voorschreef.
2. **`--clean` + `anchor keys sync` is destructief voor een bestaand devnet-programma.**
   `rm -rf target` verwijdert `target/deploy/spankwallet-keypair.json` - de LOKALE kopie van
   de keypair die het adres `9ma6...` ooit geclaimd heeft. Zonder dat bestand genereerde
   `anchor keys sync` een GEHEEL NIEUWE, willekeurige keypair en herschreef `declare_id!`
   in lib.rs EN Anchor.toml naar dat nieuwe adres (`BAbTe7HWMfGXvd7ifP1cXLETs1h2hTHi6cY1EGg9r3Sj`)
   - zonder ooit te deployen zou dit het al-werkende, live devnet-programma stilletjes
   verweesd hebben achtergelaten. Direct herkend via `git diff` (beide bestanden zijn
   getrackt) VOORDAT er gebouwd of gedeployed werd, en teruggedraaid met `git checkout`.
   Voor een UPGRADE van een bestaand programma is die keypair sowieso niet nodig - alleen de
   upgrade-authority en het publieke adres, dus `anchor keys sync` is simpelweg overgeslagen.
   Vermoedelijk exact het mechanisme achter eerdere programma-ID-wijzigingen in dit project
   (ERAEjx... -> 9ma6..., zie sectie 32) - nu voor het eerst expliciet doorzien en bewust
   vermeden voor een upgrade.
3. **`anchor build` overschrijft stilletjes een --arch v3-build.** Precies het gedrag dat het
   script se eigen commentaar al waarschuwt (gotcha #2) - moest `anchor build` (voor IDL/types)
   VOOR `cargo-build-sbf --arch v3` (voor het daadwerkelijk te deployen .so-bestand) draaien,
   in die volgorde, anders wordt de v3-build stilletjes vervangen door een default-arch-build.
   Elke keer geverifieerd door de rauwe 32 bytes van het verwachte programma-ID (`9ma6...`,
   handmatig base58-gedecodeerd) daadwerkelijk in het gecompileerde `.so`-bestand terug te
   zoeken - `strings` alleen is hiervoor nutteloos (Pubkey wordt als ruwe bytes ingebed, niet
   als leesbare base58-tekst).

Na deze drie correcties: gedeployed als upgrade naar het BESTAANDE adres
`9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9` (zelfde programma-ID, ongewijzigd). Bevestigd
via `solana program show`: data length 282272 -> 299056 bytes (matcht exact de nieuwe
lokale build), authority ongewijzigd, nieuwe deploy-slot. README.md se "Program ID (devnet)"-
regel bleek daarnaast al stale te staan (nog de oude sectie-30-waarde, nooit bijgewerkt na de
sectie-32-redeploy) - in dezelfde beurt gecorrigeerd.

**Client uitgebreid met stappen 8-10**, zelfde patroon als de bestaande 7 (handmatig
Borsh-geencodeerd, discriminators uit `target/idl/spankwallet.json`, geen gegenereerde
Anchor-TS-client). Nieuwe bestanden `client/src/policy.ts` (add/remove_allowed_program +
`readPolicyAccount`, een ruwe-bytes-parser zoals `readWalletAccount` in recovery.ts) en
`client/src/executeAdvanced.ts` (de challenge-payload-opbouw exact zoals
`instructions.rs::execute_advanced` verwacht, inclusief de geforceerde-vault-signer-regel).
Stap 8: System Program toevoegen. Stap 9: EERST het negatieve pad (TOKEN_PROGRAM_ID, nooit
toegevoegd, alleen gesimuleerd om een onnodige fee te vermijden), DAARNA het positieve pad
(een echte, ongevaarlijke CPI - System::Assign op een vers gefund testaccount, verandert
alleen de eigenaar naar ons eigen programma-ID, geen echte waarde in het spel). Stap 10:
System Program weer verwijderen, en herbevestigen via simulatie dat de CPI daarna weer
geweigerd wordt - sluit de volledige add/gebruik/remove-cyclus.

**CSP-regressie gevonden tijdens de eerste live-testpoging, direct gefixed.** De gebruiker se
eerste testrun liep vast bij stap 2 (init_wallet): transactie verstuurd, maar
`confirmTransaction()` liep na 30s vast op een timeout. Browserconsole wees het exact aan:
"Connecting to 'wss://devnet.helius-rpc.com/...' violates the Content-Security-Policy
directive: connect-src 'self' https://devnet.helius-rpc.com." De CSP uit sectie 33 stond
alleen het https-scheme toe naar het Helius-devnet-endpoint; `@solana/web3.js`'s Connection
gebruikt daarnaast standaard een wss-websocket (voor confirmTransaction/subscriptions) op
HETZELFDE endpoint met alleen het scheme gewisseld - bevestigd door de daadwerkelijke
`makeWebsocketUrl()`-broncode in `node_modules/@solana/web3.js` te lezen (https-> wss, geen
poort-verschuiving zonder expliciete poort in de originele URL, dus geen ander
subdomein/pad om nog te missen). Fix: `wss://devnet.helius-rpc.com` toegevoegd aan
`connect-src` in `client/index.html`.

**Belangrijk, en gerustellend:** de mislukte eerste poging bleek GEEN inconsistente
on-chain state te hebben achtergelaten. De wallet-PDA van die poging
(`4iz9tFLxiBNuetFDrvHmBc4srXFv8JCWUHD2bDP2dR9c`) bleek bij controle (`solana account`) een
volledig geldig, succesvol geinitialiseerd WalletAccount - 231 bytes, exact
`WalletAccount::LEN`, eigendom van ons programma. De transactie was daadwerkelijk al
bevestigd op devnet voordat de websocket-timeout de CLIENT liet denken dat het mislukt was
- een pure false-negative in de bevestigingswaarneming, geen echte mislukking. Geen opruiming
nodig; de tweede testpoging begon toch weer bij stap 1 (maakt sowieso altijd een nieuwe
passkey/wallet aan, dit test-UI heeft nooit staat over reloads heen bewaard).

**Twee andere console-meldingen uit dezelfde sessie, apart beoordeeld:**
- `favicon.ico 404` - onschuldig, geen favicon-bestand aanwezig, genegeerd (puur cosmetisch,
  niet de moeite voor een testpagina).
- `pubKeyCredParams mist RS256` (Chrome-advieswaarschuwing) - BEWUST zo, geen gat. Het
  on-chain programma kan uitsluitend secp256r1 (ES256) verifieren via Solana's
  secp256r1-precompile; er bestaat geen RSA-verificatie-precompile op Solana, en
  owner_passkey/seed_key zijn altijd exact een 33-byte gecomprimeerde secp256r1-sleutel.
  RS256 toevoegen zou een authenticator die RSA prefereert een credential kunnen laten
  aanmaken die dit programma NOOIT kan verifieren. Toelichtende code-comment toegevoegd in
  `client/src/passkey.ts` zodat dit niet per ongeluk als "gefixed" wordt beschouwd in een
  latere sessie.

**Resultaat: volledig end-to-end bevestigd op devnet met echte hardware-passkey**, na de
CSP-fix, in een tweede testpoging zonder verdere problemen:

- Passkey: `037391fa3b6d55b999edcf24bb6fc6ee8a4c36113bcfff75c01b0a87ee5577e95e`
- wallet PDA: `Dsc1UNY1t8saH5rTfLBP6ZeMCrDDJxMeoox5mUKjqY1x`, vault PDA:
  `BV599j59gpPYcCYjF5GxEuP7eochr9oFsxr3DSq5LtEa`
- init_wallet: `55aFvnUafZ4oQVCbLxTnNgdqA31P8VSQTyp8umeXA7BFSiFcfmsCSN5Hsay6Cm8HhLy5McHddSJv8Ep6JE99tuGY`
- policy PDA: `5A3mpkAwsxsm9MSV6hqSYTSQCuY5KiztHFqw9RXdkSHo`
- add_allowed_program (stap 8): `5ZBs2KFz8moTRu5ziC5sQunSWPQ3r9Ki5PeRwqw2kzXYN6UKHBEJUGeoe5FHrs4jCKbQvRSV7uBu4fcDPysNzAnM`
  - policy-account teruggelezen: `count: 1`, `allowed_programs: [11111111111111111111111111111111]`
- execute_advanced negatief (stap 9a): simulatie tegen TOKEN_PROGRAM_ID geweigerd met
  `ProgramNotAllowed` (Error Number 6022, `custom program error: 0x1786`) - zoals verwacht.
- execute_advanced positief (stap 9b): echte System::Assign-CPI,
  `Wp9hEAyrPTzjy1ePei2RfBiav6oBWZ9cGb7tugkAeN139aWQQkjPoD7DHSsCn9ppk4g3hpXCR1RLjQr1DrhJZk1`
  - testaccount `5VT3xfFMyfv9MJGdAT876VFGSbEQqeao9DKcGpkChaDE`, eigenaar na de CPI bevestigd
    gewijzigd naar `9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9` (ons eigen programma-ID).
- remove_allowed_program (stap 10): `Zxd2uJXJC3oGVqFEMLhLgk5m4Kk9kts9w8S6zyFibHuKwgn6wUk6pda1sF1tScYWCu8k2Dvid6ff1LVxRCP5ZF4`
  - policy-account teruggelezen: `count: 0`, lege allowlist.
  - herbevestiging: simulatie tegen (het zojuist verwijderde) System Program opnieuw
    geweigerd met `ProgramNotAllowed` - de volledige add/gebruik/remove-cyclus is aantoonbaar
    effectief, in beide richtingen, met echte handtekeningen, op devnet.

Met dit bewezen dekt SpankWallet nu zeven van de acht on-chain instructies end-to-end met
een echte hardware-passkey op devnet (init_wallet, execute, transfer_token, hunt,
add_allowed_program, remove_allowed_program, execute_advanced) - alleen de recovery-flow
(initiate/cancel/finalize) staat nog met een losse, oudere live-bevestiging uit sectie 16/30.
De programma-allowlist-architectuur uit sectie 26/27 is hiermee volledig van ontwerp tot
bewezen werking op devnet doorlopen.

## 36. WebAuthn-hardeningscheck op de al-live signature-verificatie: UV-vlag gefixt, laag-S al gedekt

Op verzoek een gerichte hardeningscheck op `verify_passkey_signature` in instructions.rs -
de EEN gedeelde functie die execute, transfer_token, add_allowed_program,
remove_allowed_program EN execute_advanced allemaal gebruiken om een echte
passkey-handtekening te verifieren. Dit raakt code die al met echte devnet-fondsen werkt,
dus eerst grondig onderzocht en gerapporteerd per punt, pas na expliciete goedkeuring
gewijzigd.

**Punt 1 - UV-vlag (User Verified): ONTBRAK, nu gefixt.** De functie controleerde nooit de
authenticatorData-flags-byte. De client vraagt wel `userVerification: "required"` aan
(`client/src/webauthnSign.ts`), maar dat is een client-side hint - exact het soort ding dat
dit hele architectuurprincipe (niet de client vertrouwen) juist wil vermijden. Een
authenticator die geen echte biometrie-/PIN-bevestiging afdwingt zou zonder deze check
alsnog een geldige handtekening kunnen leveren voor elke spend- of policy-actie.

Fix: twee nieuwe constanten (`AUTHENTICATOR_DATA_MIN_LEN=37`,
`AUTHENTICATOR_DATA_FLAGS_OFFSET=32`, `AUTHENTICATOR_DATA_UV_FLAG=0x04`) en een expliciete
`flags & 0x04 != 0`-check, direct na de bestaande message-hash-check. Bijkomende,
noodzakelijke correctheidsfix om dit veilig te kunnen doen: de oude berichtlengte-eis
(`>= 32`) liet in theorie een LEGE authenticatorData toe zolang er nog 32 bytes voor de hash
overbleven - te zwak om straks veilig byte 32 (de flags-byte) uit te lezen. Nu `>= 69`
(37 voor een geldige .get()-authenticatorData + 32 voor de hash).

**Testgevolg, direct meegenomen (anders had dit de testsuite flaky gemaakt):**
`tests/webauthnTestHelper.ts` genereerde authenticatorData voorheen als 37 volledig
willekeurige bytes - ~50% kans dat de UV-bit toevallig niet gezet was, wat zonder aanpassing
willekeurig test-falen had veroorzaakt na de Rust-fix. `signTestChallenge` bouwt de
flags-byte nu expliciet op (default `0x05` = UP|UV, met een optionele override-parameter;
rpIdHash/signCount blijven willekeurig, worden door dit programma toch niet gecontroleerd).
Nieuwe negatieve test in `tests/spankwallet.ts` ("faalt als de authenticatorData-flags UV
niet zetten") bevestigt expliciet dat een verder cryptografisch volledig geldige
handtekening (echt keypair, correcte challenge, correcte clientDataHash) zonder de UV-bit
daadwerkelijk geweigerd wordt met de nieuwe `UserVerificationRequired`-foutcode - hetzelfde
principe dat dit hele project consequent toepast: elke beveiligingscontrole moet ook
aantoonbaar iets tegenhouden, niet alleen aantoonbaar iets doorlaten.

**Punt 2 - P-256-malleability (laag-S-eis): AL VOLLEDIG AFGEDWONGEN, niet door onze code.**
Onderzocht in de daadwerkelijke Solana-precompile-broncode (lokale checkout onder
`~/projects/agave/precompiles/src/secp256r1.rs`, regel 107):
`s_bignum >= one && s_bignum <= half_order` als onvoorwaardelijke eis, met een dedicated
test (`test_secp256r1_high_s`) die expliciet bevestigt dat een hoge-S-handtekening met
`InvalidSignature` faalt. Dit betekent dat de Solana-runtime zelf ELKE transactie met een
hoge-S-secp256r1-handtekening al weigert tijdens precompile-verificatie, vóórdat ons
programma ooit draait - niets wat ons programma zou kunnen omzeilen zelfs als het wilde, en
onafhankelijk van clientgedrag. `client/src/secp256r1.ts`'s `normalizeS()` is dus GEEN
beveiligingsmaatregel maar een functionele noodzaak (WebAuthn-assertions zijn niet
gegarandeerd laag-S; zonder normalisatie zou ~50% van overigens geldige handtekeningen
simpelweg door de precompile geweigerd worden). Geen codewijziging nodig - uitgebreide
toelichtende comment toegevoegd bij `SECP256R1_PROGRAM_ID` en bij de signature-lengte-check
onderaan `verify_passkey_signature`, zodat een latere sessie dit niet als ontbrekend
aanmerkt (zelfde patroon als de ES256-comment uit sectie 35).

**Punt 3 - challengeIndex/typeIndex-validatie in clientDataJSON: beoordeeld, NIET
aangepast op verzoek van de gebruiker.** `extract_webauthn_challenge` doet een rauwe
substring-zoektocht naar `"challenge":"` i.p.v. clientDataJSON structureel te parsen.
Grondig getraceerd of dit daadwerkelijk exploiteerbaar is: `client_data_json` is een
client-aangeleverd instructieargument, maar cryptografisch gebonden - de laatste 32 bytes
van het ondertekende precompile-bericht moeten exact `SHA-256(client_data_json)` zijn.
Gegeven SHA-256-preimage-weerstand moet elke on-chain geaccepteerde `client_data_json`
byte-identiek zijn aan wat een echte authenticator daadwerkelijk hashte en ondertekende.
Browsers bouwen clientDataJSON via hun eigen interne serializer (nooit developer-
string-concatenatie), `type`/`origin` zijn nooit developer-controleerbaar, en de
`challenge`-waarde zelf (base64url-alfabet) kan nooit een aanhalingsteken bevatten - er is
dus geen manier om een vervalste `"challenge":"..."`-substring te smokkelen via een andere
veldwaarde in een legitiem geproduceerde clientDataJSON. Wel geconstateerd: `"type":
"webauthn.get"` wordt nergens expliciet gecontroleerd (een WebAuthn-spec-verplichte
verificatiestap, bedoeld om cross-ceremony-typeverwarring te voorkomen) - in deze codebase
niet praktisch exploiteerbaar (attestation wordt met `"none"` aangevraagd in `passkey.ts`,
wat sowieso geen bruikbare handtekening van de credential-sleutel zelf oplevert), maar wel
een echte, spec-verplichte check die ontbreekt. Voorgelegd aan de gebruiker als expliciete
optie; NIET gekozen deze sessie - blijft openstaand als bewust uitgestelde, goedkoop toe te
voegen defense-in-depth-maatregel voor een latere sessie.

**Zijdelings geconstateerd, niet een van de drie gevraagde punten, apart gerapporteerd maar
niet aangepast:** `rpIdHash` (de eerste 32 bytes van authenticatorData) wordt nergens
vergeleken met `SHA-256(rpId)`. In de praktijk laag risico (WebAuthn-credentials zijn
OS/browser-gescoped aan één rpId, een browser biedt een credential nooit aan voor een
andere site se ceremonie), maar net als punt 3 een spec-verplichte check die ontbreekt.
Beschikbaar voor dezelfde soort rapporteer-en-beslis-behandeling in een latere sessie,
indien gewenst.

**Resultaat: 16/17 lokale tests groen** (alle bestaande tests, inclusief alle 8
allowlist-tests uit sectie 34/35, blijven groen na de fix - geen regressie. De ene falende
test, `finalize_recovery slaagt ná het tijdslot`, is dezelfde vooraf al bekende,
omgevingsgebonden flaky timing-test uit sectie 34/35 - recovery.ts en de recovery-
instructies zijn deze sessie niet aangeraakt).

**Belangrijk, expliciet: dit is gecommit maar NOG NIET GEDEPLOYD naar devnet.** Het live
programma op `9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9` draait nog de OUDE
verificatiecode (zonder de UV-check). Voor bestaande, eerlijke gebruikers zou een deploy
geen breaking change moeten zijn (elke authenticator die `userVerification: "required"`
daadwerkelijk respecteert - wat voor de meeste platform-authenticators en hardware-sleutels
geldt - zet de UV-bit toch al), maar dit is nog niet tegen een echte hardware-passkey op
devnet bevestigd sinds de wijziging. Devnet-deploy en een nieuwe live-bevestiging (zelfde
niveau van bewijs als sectie 35) blijven een bewust aparte, losse vervolgstap.

## 37. WebAuthn-hardeningstraject afgerond: punt 3 alsnog gebouwd, gedeployed en herbevestigd op devnet

Sluitstuk van het traject uit sectie 36. Twee dingen tegelijk opgepakt: alsnog punt 3
(type-validatie) bouwen, en de complete set fixes (UV uit sectie 36 + de nieuwe
type-validatie) daadwerkelijk naar het live devnet-programma deployen en herbevestigen met
een echte hardware-passkey.

**Punt 3 alsnog gebouwd: expliciete `"type":"webauthn.get"`-validatie.** Nieuwe
`verify_webauthn_type()`-helper in instructions.rs, bewust dezelfde substring-techniek als
het bestaande `extract_webauthn_challenge()` - geen volledige JSON-parser nodig, om exact
dezelfde reden als destijds beargumenteerd voor de challenge-extractie: `client_data_json`
is al cryptografisch gebonden aan wat de secp256r1-precompile daadwerkelijk ondertekende
(SHA-256-preimage-weerstand), en `type`/`origin` zijn nooit developer-controleerbaar (door
de browser zelf gezet). Aangeroepen vanuit `verify_passkey_signature`, dus automatisch
geldig voor alle acht instructies die een passkey-handtekening verifieren. Nieuwe foutcode
`InvalidWebAuthnType`.

Testhelper-uitbreiding: `signTestChallenge` accepteert nu ook een optioneel
`webauthnType`-argument (default `"webauthn.get"`, volledig backwards-compatibel met alle
bestaande aanroepen - alleen een nieuw, laatste positioneel argument). Nieuwe negatieve test
in tests/spankwallet.ts bevestigt dat een verder cryptografisch volledig geldige
handtekening (echt keypair, correcte challenge, correcte clientDataHash) met
`clientDataJSON.type = "webauthn.create"` daadwerkelijk geweigerd wordt met
`InvalidWebAuthnType` - zelfde bewijsprincipe als de UV-test uit sectie 36: elke
beveiligingscontrole moet aantoonbaar iets tegenhouden, niet alleen aantoonbaar iets
doorlaten. **17/18 lokale tests groen** (dezelfde vooraf al bekende, omgevingsgebonden
flaky timing-test in recovery.ts als in sectie 34-36, ongewijzigd).

**Devnet-deploy uitgevoerd, met de drie sectie-35-valkuilen bewust vermeden:**
1. Expliciete `--keypair ~/.config/solana/id.json` bij de deploy zelf (niet geleund op de
   globale `solana config`-default, die op deze machine nog steeds naar het ongerelateerde
   `solana_darkpool`-project wijst).
2. `anchor keys sync` volledig overgeslagen - niet nodig voor een upgrade van een bestaand
   programma (alleen de upgrade-authority en het publieke adres zijn nodig), en het is
   precies deze stap die eerder een nieuw, ongewenst programma-ID genereerde.
3. Bouwvolgorde bewust: `anchor build` (voor IDL/types) EERST, `cargo-build-sbf --arch v3`
   (voor de daadwerkelijk te deployen `.so`) LAATST - en na afloop bevestigd door de rauwe
   32 bytes van het verwachte programma-ID (`9ma6...`, handmatig base58-gedecodeerd)
   daadwerkelijk en precies één keer terug te vinden in het gecompileerde binary-bestand.

Resultaat, bevestigd via `solana program show` vóór en ná:
- Voor: slot 482681670, data length 299056 bytes.
- Na: slot 482693421, data length 309296 bytes (groter - logisch, twee nieuwe checks +
  bijbehorende constanten/foutcodes toegevoegd).
- Programma-ID (`9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9`) en authority
  (`G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp`) ongewijzigd - een upgrade, geen nieuw
  programma.
- Deploy-transactiehandtekening:
  `45kcuNidxjXKtfkr6uinuaD1bkhgEAqZLhdhhSndzsQwaGHsZS36Fa4QfQatb92Axhoznyk9L5x2WoNLoAYbqgUg`.

**Herbevestiging op devnet met echte hardware-passkey - stap 1-3, bevestigd voldoende
omdat `verify_passkey_signature` de EEN gedeelde functie is die alle acht
passkey-geverifieerde instructies gebruiken** (init_wallet, execute, transfer_token,
add_allowed_program, remove_allowed_program, execute_advanced, hunt, cancel_recovery -
letterlijk nagelopen via de call sites in instructions.rs) - stap 2 (init_wallet) en stap 3
(execute) raken dus allebei onafhankelijk zowel de UV-check als de nieuwe type-check op het
zojuist geupgradede, live programma:

- Passkey: `02f1890f8caf08762dda7fee8d2637537ab5cbe8135ac7730db078c7095052fcf1`
- wallet PDA: `61EHnUwRb7J3oU71Z4YuUmDbJwSYeYbDY4Ezxxkb17u9`, vault PDA:
  `AALh78VjtJkMqNR8yAtLoqnE9xvo69QPBoEJ5XsvVqrt`
- init_wallet: `4BX8Gf9qs2jhz8bXeYG1k4yLqLfvFSmjJfmw6F67Mmna6qtQy6WF4ofHD7HpSBye8njqgGzJ2LSupeVzQsitPfLX`
  - simulatielogs: `Instruction: InitWallet`, 23085/400000 compute units, `success` - geen
    `UserVerificationRequired`/`InvalidWebAuthnType`-fout, dus de echte
    biometrie-/PIN-bevestigde, correct getypeerde handtekening van de hardware-passkey
    voldeed meteen aan beide nieuwe eisen.
- execute (transfer_sol, 1000 lamports terug naar de payer):
  `PQ2zjRHM6DgsgVTBV4pvaMWkQSZPNzJeFgCs88DiVKexpCA4p3hRhDeybu6yLLPVEeoFtPbdfUMSqSqqLG1vyfY`
  - simulatielogs: `Instruction: Execute`, 10651/400000 compute units, `success`.
- Geen console-fouten gerapporteerd tijdens de volledige run.

**Resultaat: het volledige WebAuthn-hardeningstraject (sectie 36-37) is nu afgesloten.** Alle
drie de oorspronkelijk gevraagde punten zijn doorlopen: UV-vlag (ontbrak, gefixt, herbevestigd
op devnet), laag-S-malleability (bleek al volledig afgedwongen door Solana's eigen
secp256r1-precompile, uitsluitend gedocumenteerd), en type-validatie (aanvankelijk bewust
uitgesteld, deze sessie alsnog gebouwd, getest en herbevestigd op devnet). Het live
devnet-programma draait nu de volledig geharde `verify_passkey_signature`, bevestigd
werkend met een echte hardware-passkey, zonder enige regressie in de bestaande
functionaliteit (init_wallet en execute beide nog steeds probleemloos, zelfde niveau van
bewijs als alle eerdere devnet-bevestigingen in dit project).

## 38. Multi-passkey authority-model gebouwd: add_passkey/remove_passkey (Rust-laag, nog niet gedeployed)

Op verzoek een LazorKit-geinspireerd multi-passkey-model gebouwd: waar een wallet tot nu
toe precies één `owner_passkey` kon hebben, kunnen nu meerdere, gelijkwaardige, volledig
bevoegde passkeys geregistreerd staan (telefoon, laptop, losse hardware-sleutel, back-up).
Ontwerp vooraf voorgelegd en expliciet goedgekeurd op alle 5 punten (account-layout,
rollen, recovery-interactie, migratiepad, challenge-binding) voordat er iets gebouwd werd -
dit raakt de kern-identiteitsstructuur van de wallet.

**Account-layout: satellite-account, bewust NIET LazorKits per-sleutel-PDA.** Nieuwe
`PasskeysAccount` (PDA `[b"passkeys", wallet]`): `wallet`, `bump`,
`owner_passkey_revoked: bool`, `count: u8`, `additional_passkeys: [[u8;33]; 8]`. Zelfde
rent-/eenvoud-afweging als destijds bij `PolicyAccount` (sectie 34): LazorKits eigen PDA
per sleutel geeft O(1)-lookup en onbeperkt aantal sleutels, maar kost een aparte
rent-betaling PER sleutel en - belangrijker - zou elke van de acht bestaande
passkey-geverifieerde instructies een VARIABEL aantal extra accounts hebben gegeven i.p.v.
precies één. Passkeys zijn fysieke apparaten, geen honderden-schaal probleem: 8 extra (9
totaal met owner_passkey) is ruim voldoende, één account, één eenmalige rent-betaling.

**Bewust GEEN rollen.** Elke geregistreerde passkey heeft gelijke, volledige zeggenschap -
directe generalisatie van "één owner_passkey" naar "een van N geregistreerde passkeys",
zonder een permissiematrix (welke rol mag `remove_passkey`? `hunt`? `add_allowed_program`?)
als bijvangst te hoeven ontwerpen. Rollen/gelaagde privileges blijven bewust bij de
sectie-26-roadmap, een aparte, grotere ontwerpvraag.

**Recovery-interactie, exact zoals voorgesteld:** `add_passkey`/`remove_passkey` is de
EERSTE verdedigingslinie (één apparaat kwijt, andere werken nog); de bestaande
`backup_authority`-recovery-flow blijft het LAATSTE redmiddel (alle passkeys tegelijk
kwijt). `finalize_recovery` wist nu bij een geslaagde recovery de VOLLEDIGE passkey-set
(alle extra sleutels weg, `owner_passkey_revoked` terug naar `false`) - geen stale,
mogelijk-gecompromitteerde extra sleutels overleven een recovery. Lockout-bescherming:
`remove_passkey` blokkeert het verwijderen van de allerlaatste geldige sleutel
(`owner_passkey` actief + `count` samen moeten na de verwijdering nog >= 1 blijven).
`remove_passkey` kan `owner_passkey` zelf intrekken zodra er minstens één extra sleutel
bestaat - hetzelfde apparaat-kwijt-scenario geldt namelijk ook voor het OORSPRONKELIJKE
apparaat, vaak het meest gedragen/verliesbare. Beide nieuwe instructies checken
`wallet.recovery_state.is_none()`, net als alle andere passkey-gated instructies -
voorkomt dat de passkey-lijst wordt gewijzigd tijdens een lopend herstelverzoek.

**Migratiepad: geen migratie-instructie nodig.** `wallet.owner_passkey` blijft ongewijzigd
de primaire sleutel - `WalletAccount`'s layout wordt nooit aangeraakt. `PasskeysAccount` is
puur additief en lui aangemaakt (`init_if_needed`, zelfde patroon als `PolicyAccount`).
Bestaande devnet-wallets werken volledig ongewijzigd door totdat hun eigenaar zelf voor het
eerst `add_passkey` aanroept.

**Challenge-binding: zelfde patroon als add_allowed_program.** `add_passkey(new_passkey,
client_data_json)` en `remove_passkey(target_passkey, client_data_json)` binden beide
uitsluitend de 33-byte passkey-payload aan de challenge (domain `"add_passkey"` /
`"remove_passkey"`), geverifieerd tegen EEN VAN de al geldige sleutels - nooit een
ongeautoriseerde toevoeging. `add_passkey` valideert bovendien het prefix-byte van de
nieuwe sleutel (`validate_passkey_prefix`, zelfde reden als bij `seed_key`/
`new_owner_passkey` elders) en weigert duplicaten (`PasskeyAlreadyRegistered`).

**Rust-kernrefactor: `verify_passkey_signature` gesplitst in drie lagen.**
`verify_passkey_signature_core` doet alle precompile-/UV-/type-/challenge-verificatie
ONAFHANKELIJK van welke sleutel toegestaan is, en retourneert de daadwerkelijk
ondertekenende publieke sleutel. De bestaande `verify_passkey_signature` (nu een dunne
wrapper om de core) blijft uitsluitend voor `init_wallet` - daar bestaat nog geen
`WalletAccount`/`PasskeysAccount` om tegen te verifieren, de enige mogelijke sleutel is
`seed_key` zelf. De nieuwe `verify_passkey_signature_multi` wordt door alle ANDERE
acht instructies gebruikt (de zeven bestaande plus de twee nieuwe) en accepteert een
handtekening van `owner_passkey` (tenzij ingetrokken) OF een van de sleutels in
`PasskeysAccount.additional_passkeys`. `read_passkeys_account` leest het account
tolerant (`None` als het nog nooit is aangemaakt = alleen `owner_passkey` geldig, geen
foutcase) - cruciaal voor het zero-migratiepad.

**Elke van de zeven bestaande passkey-geverifieerde instructies kreeg een `passkeys`-veld**
(`UncheckedAccount` met een `seeds = [b"passkeys", wallet.key()], bump`-constraint - dit
garandeert dat het gegeven account ALTIJD exact het `PasskeysAccount` van DEZE wallet is,
nooit een ander account gesubstitueerd door een kwaadwillende/foutieve client, ook al hoeft
het account zelf niet te bestaan). Volledige, met `grep`-bewijs gecontroleerde checklist
van alle 8 call-sites (Rust `Accounts`-struct + client-TS-bestand) is met de gebruiker
doorgenomen voordat er gecommit werd:

| Instructie | Rust `passkeys`-veld | `verify_passkey_signature_multi` | Client-bestand |
|---|---|---|---|
| init_wallet | n.v.t. (bewust, single-key) | n.v.t. (bewust) | n.v.t. |
| execute | ✓ | ✓ | execute.ts |
| transfer_token | ✓ | ✓ | transferToken.ts |
| add_allowed_program | ✓ | ✓ | policy.ts |
| remove_allowed_program | ✓ | ✓ | policy.ts |
| execute_advanced | ✓ | ✓ | executeAdvanced.ts |
| hunt | ✓ | ✓ | hunt.ts |
| cancel_recovery | ✓ | ✓ | recovery.ts |

`finalize_recovery` viel BUITEN deze checklist (roept `verify_passkey_signature` nooit aan
- permissionless, uitsluitend tijdslot-gated) maar kreeg wel een nieuw, optioneel
`PasskeysAccount`-veld (Anchors ingebouwde `Option<Account<'info, T>>`-patroon, met het
programma-ID zelf als client-side sentinel voor "bestaat niet") voor de wipe-bij-succes-
logica. Was nooit in de client-testpagina verweven (bevestigd: 0 treffers), dus geen
client-bestand om bij te werken.

**Client:** nieuw `client/src/passkeys.ts` (`derivePasskeysPda`, `readPasskeysAccount`,
`buildAddPasskeyTransaction`, `buildRemovePasskeyTransaction`) plus de zeven bestaande
bestanden bijgewerkt om het nieuwe account door te geven aan hun instructie-opbouw - stuk
voor stuk geverifieerd met `grep` (niet aangenomen).

**12 nieuwe lokale tests** in `tests/passkeys.ts`: add/remove happy-path (incl.
`init_if_needed`-creatie), een net toegevoegde/verwijderde sleutel heeft daadwerkelijk
wel/geen zeggenschap (getest door met die sleutel zelf een ANDERE instructie -
`add_allowed_program` - te ondertekenen, niet enkel dat `add_passkey`/`remove_passkey`
zelf slaagt), duplicaat-/niet-geregistreerd-detectie, lockout-bescherming,
`owner_passkey` zelf intrekken zodra een extra sleutel bestaat, `RecoveryAlreadyInProgress`
op beide nieuwe instructies, en de volledige `finalize_recovery`-wipe (inclusief
bevestiging dat een sleutel van vóór de recovery erna geen zeggenschap meer heeft).

**Zijdelings ontdekt en structureel opgelost: de al langer bekende flaky
recovery-timing-tests (sectie 34-37) bleken NIET aan een trage on-chain klok te liggen,**
maar aan een lokale validator die nauwelijks nieuwe slots produceert tijdens pure
inactiviteit - empirisch vastgesteld door de daadwerkelijke `initiatedAt`/`getBlockTime`-
waarden te loggen: 11 seconden `sleep()` leverde slechts ~1 seconde on-chain
klokvooruitgang op, ongeacht hoe ruim de marge werd gemaakt (ook +8s bleef falen). Een
standalone probe-validator zonder de rest van de testsuite liet WEL een normale 1:1-
verhouding zien, wat erop wijst dat slot-productie hier samenhangt met transactie-
activiteit, niet puur met verstreken tijd. Nieuwe `advanceOnChainClockPast()`-helper in
`webauthnTestHelper.ts` verstuurt actief kleine, echte transacties totdat de on-chain klok
(via `getBlockTime`) de gewenste tijd daadwerkelijk gepasseerd is, i.p.v. blind te
wachten - toegepast op zowel de bestaande `tests/recovery.ts`-tests als de nieuwe
`finalize_recovery`-wipe-test. Resultaat: de volledige testsuite draait nu in 3-4 seconden
(was 12-24s) en is voor het eerst deze sessie **structureel stabiel groen**, niet
incidenteel geluk - bevestigd via meerdere herhaalde volledige runs.

**Resultaat: 30/30 lokale tests groen** (18 bestaand + 12 nieuw), inclusief de tot nu toe
altijd-flaky recovery-timing-tests. Gecommit lokaal, NOG NIET gepusht of gedeployed -
devnet-deploy en een live-hardware-passkey-herbevestiging (zelfde niveau van bewijs als
sectie 35/37) blijven een bewust aparte, losse vervolgstap.

## 39. Multi-passkey-model gedeployed en end-to-end bewezen op devnet met echte hardware-passkeys

Vervolgstap op sectie 38: de twee lokale commits gepusht, het devnet-programma opnieuw
gedeployed, de browser-testpagina uitgebreid met vijf nieuwe stappen die het
multi-passkey-model daadwerkelijk bewijzen (niet enkel dat bestaande stappen nog werken),
en dat alles live herbevestigd met echte hardware-passkeys.

**Devnet-deploy, zelfde beproefde proces als sectie 35/37, alle drie bekende valkuilen
opnieuw expliciet vermeden** (geen `anchor keys sync` voor een upgrade, `anchor build`
altijd eerst voor de IDL, `cargo-build-sbf --arch v3` altijd als laatste voor het
daadwerkelijk te deployen binary). Programma-ID-byte-offset vooraf geverifieerd (exact één
treffer, offset 4880 in het gecompileerde `.so`-bestand) voordat er gedeployed werd.
Deploy-signature
`XU11LJH2w9o1htx1HTVUGs2fPiiPzhMvgCPqq1escukeEKg6qH52rtfNQeTDLBAdBZdgGYR8QfaJiE2dHV6DAET`.
Slot vóór deploy 482693421 (databytes 309296) -> slot na deploy 482705049 (databytes
351416, exact gelijk aan de lokale build). Zelfde programma-ID en upgrade-authority
(`G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp`) als voorheen - een upgrade, geen nieuwe
deploy.

**Onderweg een tot nu toe onopgemerkt lek in de eigen sessie gevonden en gerepareerd,
losstaand van de deploy zelf.** Bij het verplicht controleren dat lokale tests nog groen
waren na de client-wijzigingen (steeds vereiste stap voor commit), faalde `anchor test`
plotseling op 28 van de 30 tests met `This program may not be used for executing
instructions`. Root cause: `target/deploy/spankwallet-keypair.json` - het bestand dat
bepaalt op welk adres `anchor test` het programma LOKAAL deployt - was een restant van de
eerdere `anchor keys sync`-misser (sectie 37/38-traject): destijds waren `declare_id!` en
Anchor.toml met `git checkout` teruggedraaid naar `9ma6...`, maar het keypair-bestand zelf
nooit vervangen, dus wees het nog naar een oud, fout adres
(`5KDuUu6TcmxcAWq6hDSSfbvXxSEr2hCK8a25ZgdF24o7`). Bevestigd via
`solana program show 9ma6... --url http://127.0.0.1:8899` -> "Unable to find the account":
er stond lokaal helemaal niets op het adres waar de tests naar zochten. Omdat lokale
testvalidator-state altijd wegwerpbaar is en losstaat van devnet, en omdat alle testbestanden
`program.programId` dynamisch uit de IDL lezen (nooit hardcoded), was de veilige fix:
`target/` volledig wissen, `anchor keys sync` LATEN draaien om een vers, lokaal-only
keypair te genereren (dit keer bewust, in een schone map, puur voor lokaal testen), de
volledige suite draaien (30/30 groen, opnieuw ~3s dankzij de sectie-38-klokfix), en
DAARNA `declare_id!`/Anchor.toml weer terugzetten naar `9ma6...` met `git checkout` voordat
er iets anders gebeurde. Geverifieerd dat dit geen enkele invloed had op de al bevestigde,
correcte devnet-deploy (die stond al vast voordat dit lek ontdekt werd).

**Vijf nieuwe browserstappen (11-15) in `client/index.html` +
`client/src/main.ts`**, ontworpen om het model zelf te bewijzen, niet enkel dat de
onderliggende instructies bestaan:

- **Stap 11** - maakt PASSKEY 2 aan: een tweede, cryptografisch onafhankelijke passkey
  (`createSpankWalletPasskey`, apart `user.id`). Nog nergens geregistreerd.
- **Stap 12** - `add_passkey`, ondertekend door PASSKEY 1: registreert PASSKEY 2 op de
  wallet. Leest het `PasskeysAccount` terug en controleert `count === 1` en dat
  `additional_passkeys[0]` daadwerkelijk PASSKEY 2's publieke sleutel is.
- **Stap 13 - het eigenlijke bewijs.** PASSKEY 2 ondertekent ZELFSTANDIG een volledig
  andere instructie (`add_allowed_program`, met `TOKEN_PROGRAM_ID`), zonder PASSKEY 1 er
  op enige manier bij te betrekken. Dit toont daadwerkelijke, onafhankelijke zeggenschap
  aan - niet enkel een geslaagde registratie.
- **Stap 14** - `remove_passkey`, ondertekend door PASSKEY 2: trekt PASSKEY 1 in
  (`owner_passkey_revoked -> true`). Bewijst zowel dat een nieuwe sleutel de originele kan
  opvolgen, als dat de wallet daarna nog bereikbaar blijft via PASSKEY 2.
- **Stap 15 - lockout-bescherming.** Probeert PASSKEY 2 (nu de enige geldige sleutel) te
  verwijderen. Alleen gesimuleerd, nooit verstuurd - het doel is de weigering aantonen,
  geen fee betalen voor een transactie die sowieso zou falen.

Elke stap-log labelt expliciet `[PASSKEY 1]` of `[PASSKEY 2]` vlak vóór de bijbehorende
`navigator.credentials.get()/create()`-aanroep, om verwarring te voorkomen nu er meerdere
prompts na elkaar voorkomen voor verschillende sleutels.

**Live herbevestigd op devnet met echte hardware-passkeys, volledig succesvol.** Stap 12:
`count: 1`, `owner_passkey_revoked: false`, `additional_passkeys[0]` matcht PASSKEY 2 exact
(signature `2FjJWvvy7TV9s6WQCGQYWsb4dfGiMQeVRTn7N98CUjNmJpsvEPyEnYAPAETzttTKhh3FMztmTYt6mAHPynKKxttT`).
Stap 13: PASSKEY 2 alleen ondertekende `add_allowed_program`, `TOKEN_PROGRAM_ID`
daadwerkelijk toegevoegd aan de allowlist
(signature `63puyVLhyynaDYumUPPnBYhmbYuzv1cfNsApSBGkVVRZfoFYZMkqra1TPtdZdKRcVTneMM62dzBuLeEPZvdVqkNx`).
Stap 14: `owner_passkey_revoked: true` na intrekking door PASSKEY 2
(signature `4kRWoSDorCYYVsiDFxcmWWeMZfHr72WJVJrRZ2Fejo81D1gG6L3ujPy4r7XP1tZNpfzgsn3mYx1xFL51EyrxnMex`).
Stap 15: simulatie faalde zoals bedoeld met `Custom(6031)` / `CannotRemoveLastPasskey`
("Kan de laatste geldige passkey van deze wallet niet verwijderen - zou de wallet
onbereikbaar maken") - de lockout-bescherming werkt daadwerkelijk on-chain, niet enkel in
de lokale testsuite. Geen console- of CSP-fouten. Het volledige model is nu bewezen met
echte hardware-cryptografie, niet enkel met testvalidator-keypairs: een tweede sleutel
toevoegen, zelfstandige, volledige zeggenschap van die sleutel over een willekeurige
andere instructie, de oorspronkelijke sleutel intrekken zodra een vervanger bestaat, en de
onmogelijkheid om de wallet per ongeluk permanent op slot te zetten.

## 40. Session keys gedeployed en end-to-end bewezen op devnet, inclusief een gevonden en gefixte autorisatie-ordeningsbug

Vervolgstap op sectie 38-achtige aanpak, nu voor session keys: devnet-deploy, client-
integratie (`client/src/sessionKeys.ts`, functies voor alle 7 instructies), vijf nieuwe
browserstappen (16-20), een tijdens het live testen gevonden en gerepareerde bug in de
autorisatie-volgorde van `execute_advanced_via_session`, een herdeploy, en een volledige
herbevestiging.

**Client + browserstappen 16-20, zelfde structuur als sectie 39's multi-passkey-stappen.**
Stap 16 maakt een sessiesleutel aan (gewone Ed25519-`Keypair`, GEEN passkey - puur lokaal
gegenereerd) met scope `can_execute=true` (verder alles `false`) en een slot-gebonden
expiry, registreert hem via `add_session_key` (`[PASSKEY]`-prompt - het wijzigen van WIE
toegang heeft blijft altijd passkey-gated, ook al is de sessiesleutel zelf dat niet), en
fundt zowel de vault als de sessiesleutel (wallet-extensie-prompt, geen passkey). Stap 17
is het kernbewijs: `execute_via_session`, volledig zelfstandig ondertekend door de
sessiesleutel, verstuurd via `sendRawTransaction` - GEEN passkey-prompt, GEEN
wallet-extensie-prompt, precies het punt van het hele ontwerp (ontwerppunt 5: een
sessiesleutel is een gewone Solana-signer, Solana's eigen transactie-ondertekening bindt
hem al aan de instructie). Stap 18 bewijst het negatieve scope-pad
(`execute_advanced_via_session` met een sessie die daar niet voor gescoped is). Stap 19
wacht daadwerkelijk (pollt `getSlot()`, echte devnet-tijd, geen dummy-transacties zoals in
de lokale testsuite) tot de sessie verlopen is en bewijst `SessionExpired`. Stap 20 bewijst
dat `close_expired_session` permissionless is: een verse, willekeurige derde partij ruimt
de verlopen sessie op en claimt de rent.

**Eerste live-testronde ontdekte een echte bug, geen testfout.** Stap 18 verwachtte
`SessionInstructionNotAllowed` maar kreeg `AccountNotInitialized` (Anchor-foutcode 3012) op
het `policy`-account - de testwallet had nooit `add_allowed_program` aangeroepen, dus
`PolicyAccount` bestond niet. Root cause: `policy` was `Account<'info, PolicyAccount>`
(typed) in `ExecuteAdvancedViaSession` - Anchors macro deserialiseert elk typed
`Account<T>`-veld altijd in `try_accounts()`, VOORDAT de instructie-body ooit draait. Geen
enkele `require!()`-volgorde binnen de body-tekst kan dat corrigeren, ongeacht waar de
autorisatie-check staat geschreven - de account-existence-check gebeurt structureel eerst,
door Anchors eigen constructie, niet door leesvolgorde. Dit werd voor het eerst zichtbaar
via een live devnet-aanroep, niet via de lokale testsuite (geen enkele bestaande test riep
`execute_advanced_via_session` aan zonder eerst een PolicyAccount aan te maken).

**Fix, zelfde patroon als eerder toegepast op `passkeys`/`session` in dit bestand:**
`policy` is nu `UncheckedAccount<'info>`, tolerant gelezen via de al-bestaande
`read_policy_account`-helper ("bestaat niet" = lege allowlist, geen foutcase) NA de
autorisatie-checks (`SessionExpired`, `SessionInstructionNotAllowed`,
`SessionProgramNotAllowed`). Een sessie zonder `execute_advanced`-scope krijgt nu altijd
`SessionInstructionNotAllowed`, ongeacht of er ooit een `PolicyAccount` bestaat - autorisatie
gaat nu daadwerkelijk voor op de vraag of iets anders uberhaupt bestaat. Nieuwe
regressietest in `tests/sessionKeys.ts` controleert expliciet de foutcode zelf
(`SessionInstructionNotAllowed` aanwezig, `AccountNotInitialized` afwezig), niet enkel "er
was een fout" - anders zou een toekomstige regressie van precies dit probleem stilzwijgend
door de test heen glippen. Bewust NIET toegepast op het langer-bestaande `execute_advanced`
(passkey-pad), dat dezelfde onderliggende eigenschap heeft maar apart, al-bewezen, live
code is - een aparte, latere afweging als dat ooit relevant wordt.

**Tweede, kleinere bug tijdens dezelfde live-testronde: de eerste expiry-marge (40 slots,
~15-20s) was te krap.** Realistische klik-/bevestigingstijd tussen stap 16 en 17
(passkey-prompt-interactie + twee sequentiele transactiebevestigingen) overschreed die
marge ruimschoots - de sessie was al verlopen voordat stap 17 ooit kon draaien. Verhoogd
naar 300 slots (~2 minuten), ruim voldoende voor stap 17-18 zonder stap 19's wachttijd
onredelijk te maken.

**Twee devnet-deploys in dit traject**, beide volgens het beproefde proces (`anchor build`
eerst voor de IDL, `cargo-build-sbf --arch v3` laatst voor de deployable binary,
byte-offset vooraf geverifieerd, `--program-id`/`--keypair` expliciet, nooit `anchor keys
sync` voor een upgrade):
1. Client-integratie-deploy: slot 482740156, data length 444608 bytes, signature
   `5hyRdinpvBeTbbbW9uzdzvg6mHjQyC2afhZTfup2i4V62kTCBYKsVgce4iHdL53hs9wakZce7Niqw9YrcTAjbPnr`.
2. Bugfix-deploy: slot 482750163, signature
   `x3XVcc9kpb2ehKD4aCATy2mzjK9m9EJ1JSyRqYoe6w913JADmMZ8C4pjv6fESrqptyf7mXQM18Fa6KduQFkzFzD`.
   Op-chain "Data Length" (454848 bytes) kwam NIET overeen met de lokale build (445272
   bytes) - onderzocht via `solana program dump` + `cmp`: de eerste 445272 bytes zijn
   byte-voor-byte identiek aan de lokale build, de rest is pure zero-padding. Verklaring:
   Solana-programma-accounts kunnen groeien maar nooit krimpen; de extra ruimte is
   restcapaciteit van een eerdere, grotere allocatie, geen deploy-fout. Genoteerd als les:
   "Data Length" uit `solana program show` alleen is onvoldoende voor byte-verificatie bij
   incrementeel kleine wijzigingen na een eerdere grotere deploy - een directe
   dump-en-vergelijk is de sluitende check.

**Live herbevestigd op devnet met een echte hardware-passkey, volledig succesvol na de
fix.** `add_session_key`
(signature `3tAvbygU9C2XJG2eri8P3ekkeLP4BMRF572tHasianb9nRpSEUAAHRTy1khe6zmuL8VQBLR1vB6EduKKAJXDJpM4`,
teruggelezen `canExecute=true, canTransferToken=false, canExecuteAdvanced=false`). Stap 17,
het kernbewijs, zelfstandig door de sessiesleutel ondertekend zonder enige prompt
(signature `5SYVNsZFDSj6KR7isr1triidwUy8bqaqq7aYqaFxm8m7yuHjbiR2Sx4FyuBaa6i9SgNPt693bcCVFSd2uCaEadtN`).
Stap 18, na de fix: `Custom(6035)` / `SessionInstructionNotAllowed` ("Deze sessiesleutel is
niet gescoped voor deze instructiesoort") - precies de bedoelde, specifieke foutcode, niet
langer een onbedoelde `AccountNotInitialized`. Stap 19: on-chain slot daadwerkelijk voorbij
`expiry_slot` (482751268 -> 482751270 tijdens het pollen), daarna `Custom(6032)` /
`SessionExpired` bevestigd. Stap 20 (permissionless opruiming door een willekeurige derde,
ongewijzigde code sinds de fix) al bewezen in de voorgaande volledige testronde: het
session-account sloot en de closer-balans steeg van 5.000.000 naar 8.259.240 lamports
(signature `x264a2RzxiCFvKjxn3JPrLXCq6xZvGoCqC7qRFNJ47R9t938Ka9sXFq61uY2sRE8wur1sdLZyNnUy4ubh43cV8B`).
Geen console- of CSP-fouten. Het volledige session-key-model is nu bewezen met echte
hardware-cryptografie: een tijdelijke, smal-gescopede sleutel zelfstandig laten ondertekenen
zonder enige prompt, de scope-beperking die andere instructies weigert, daadwerkelijk
verlopen, en permissionless opruiming.

## 41. Externe security-review ontvangen + devnet-generale-repetitie voor upgrade-authority-migratie gestart

Een externe security-review van het project kwam binnen: de kernconclusie is dat de
fundamentele laag (passkeys, recovery, typed actions, allowlist, multi-passkey, session
keys - secties 1-40) solide en goed gedocumenteerd is, "boven gemiddeld voor een
solo/kleine inspanning". Drie concrete, niet-acuut-kritieke gaps genoemd voor een
volgende fase: (1) de programma-upgrade-authority is een single-key restrisico, (2) de
client is nog een testpagina, geen productie-UI (clickjacking-header, supply-chain-
pinning, human-readable tx-previews ontbreken), (3) de gelaagde-privileges/spend-limits-
roadmap (sectie 26, bewust tweemaal uitgesteld tijdens multi-passkey en session keys)
staat nog open. Beoordeeld en gekozen: punt (1) eerst, omdat het de enige van de drie is
die met de tijd erger wordt naarmate er meer waarde achter de huidige single-key-authority
opgestapeld wordt, en omdat een gecompromitteerde upgrade-authority letterlijk elke andere
beveiligingseigenschap in dit project (secties 21-40) in één stap ongedaan kan maken - een
kwaadwillende upgrade kan simpelweg alle checks verwijderen.

**Ontwerp goedgekeurd**: Squads Protocol V4 (formeel geverifieerd, geaudit door OtterSec/
Neodyme/Trail of Bits/Certora, beveiligt >$10 miljard aan waarde, native timelock +
dedicated program-upgrade-tooling) als multisig-implementatie, boven Snowflake Safe
(kleinere schaal, timelock-ondersteuning niet bevestigd) en een zelfgebouwde n-of-m-
implementatie (afgewezen: precies op het meest kritieke punt nieuwe, ongeteste
autorisatiecode toevoegen is het tegenovergestelde van het doel). Bevestigd: dit raakt
geen custody van gebruikersfondsen (STATUS.md sectie 27's non-custodial-principe gaat
over WalletAccount/VaultAccount, niet over wie de programma-bytecode mag vervangen - een
orthogonale as). Signer-configuratie definitief vastgelegd door de gebruiker: 2-of-3, drie
fysiek gescheiden apparaten (telefoon, hoofd-pc, koude/backup-Windows-pc), elke keypair
onafhankelijk gegenereerd, geen seed-hergebruik. Timelock: 72u voor de uiteindelijke
SpankWallet-migratie (consistent met `recovery_timelock_seconds`'s eigen 72u-default),
bewust GEEN noodgeval-bypass (zou de hele bescherming ondermijnen - dezelfde reden als bij
recovery).

**Niet-onderhandelbare eerste stap: een devnet-generale-repetitie op een volledig
onafhankelijk wegwerpprogramma - NIET SpankWallet zelf.** Fase 1 (deze sectie) afgerond:
een triviaal Anchor-"hello world"-tellerprogramma (standaard `anchor init`-template,
`initialize`/`increment`, geen enkele functionele relatie met SpankWallet) opgezet in een
volledig aparte workspace (buiten deze repository, buiten elke Cargo-workspace die met
SpankWallet te maken heeft) en gedeployed naar devnet:
- Programma-ID: `6hzVvPNHxVCW4aMECXW92GWHdRsCzcZkDXmY6k9zUmEU`
- Deploy-signature: `hPrupkNbswYP7jPxuRBfgKzPLnaNcjgSy9E3p6jChcQ7fzuMoxW3mADfNF49aZ9J8PwJRLs1mUbcSGT6R9Tifd4`
- Slot 482758337, data length 129456 bytes
- Initiele authority: dezelfde `G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp` als
  SpankWallet's huidige authority (puur voor het gemak - het enige devnet-gefunde
  sleutelbestand dat beschikbaar is; wordt in een latere fase overgedragen aan de
  Squads-multisig, exact het mechanisme dat we willen bewijzen)

Vooraf onderzocht en bevestigd (niet aangenomen): Squads V4's `time_lock`-parameter is een
plain `u32` in seconden, met een expliciete "Custom (in seconden)"-optie in de UI - er is
geen protocolbeperking die een korte testduur verbiedt. Besluit: de repetitie gebruikt een
verkorte timelock (minuten, niet 72u) - dit test exact hetzelfde codepad/dezelfde
state-transities als een lange timelock (wacht-tot-vervaldatum, dan uitvoerbaar), dus
verzwakt dit de repetitie niet voor haar daadwerkelijke doel (het MECHANISME bewijzen). De
uiteindelijke SpankWallet-migratie gebruikt nog steeds de volle 72u - deze verkorting geldt
uitsluitend voor de wegwerp-repetitie.

**Nog te doen (vervolgfases, wachten op acties van de gebruiker op de drie fysieke
apparaten)**: per-apparaat Squads-lid/keypair aanmaken, de 2-of-3-multisig met verkorte
testtimelock inrichten voor het wegwerpprogramma, de upgrade-authority van het
wegwerpprogramma overdragen aan de Squads-vault, een echte testupgrade door de volledige
voorstel-/goedkeurings-/timelock-/uitvoeringsflow heen halen, en het resultaat verifiëren
met `solana program show`. SpankWallet's eigen upgrade-authority (`9ma6...`) wordt pas
aangeraakt na expliciete bevestiging van de gebruiker dat deze volledige repetitie
succesvol is afgerond.

**Tussentijdse correctie: apparaat-scheiding.** Bij het verzamelen van de drie signer-
adressen bleek een van de drie ("Chromium acc1") een tweede browserprofiel op dezelfde
Linux-machine te zijn als een andere signer, geen apart fysiek apparaat - exact het
scenario dat de bescherming van 2-of-3 zou ondermijnen (een enkele-machine-compromittering
zou dan mogelijk 2 van de 3 handtekeningen kunnen bereiken). Direct gevonden en opgelost
door te vragen naar bevestiging in plaats van aan te nemen dat de opgegeven adressen
correct gescheiden waren. Definitieve, daadwerkelijk fysiek gescheiden signer-set:
telefoon (Solflare Android, `CP2fg9zgyh12FFVhqfP9PcuVhfhNBp4H59GrGDW9ios3`), hoofd-pc
(Brave/Phantom, `3zZcLwTXUn2zw3RPJ3tLNofqPnP6J8KQD3pxfEJixXt3`), Windows-pc (Edge,
`AHy1bU6pMv4NQ2H8zivtW3AFvzaXY836yx2BaTyJfcwG`) - geldt voor zowel deze repetitie als de
latere, echte SpankWallet-migratie. Elk adres gefund met devnet-SOL (0.1/0.3/nog te doen)
vanaf de al-gefunde lokale devnet-sleutel, puur om transactiefees te kunnen betalen -
geen van deze transfers heeft enige relatie met SpankWallet's eigen fondsen.

**Fase 2: multisig-aanmaak - browser-UI verlaten voor een gescript pad.** De Squads-
webinterface gaf herhaaldelijk netwerkverwarring tussen Phantom-instellingen, Squads'
eigen clusterkeuze, en drie verschillende apparaten/wallets. In plaats van door te blijven
klikken: onderzocht en bevestigd (niet aangenomen) dat Squads V4 een officiele TypeScript-
SDK heeft (`@sqds/multisig`, npm) waarmee een multisig volledig gescript aangemaakt kan
worden. Kern-inzicht, geverifieerd tegen de daadwerkelijk geinstalleerde package-
typedefinities (niet tegen mogelijk verouderde blogposts): `multisig.rpc.multisigCreateV2()`
vereist alleen een `creator` (fee payer) en een verse, eenmalige `createKey` als
handtekeningen - de `members` zijn pure data (publieke sleutels + permissies), ZONDER dat
die leden zelf iets hoeven te ondertekenen bij aanmaak. Dit betekent dat de multisig-
aanmaak zelf volledig vanaf de Spark kon, met uitsluitend de drie al-bekende publieke
adressen en het lokale, al-gefunde devnet-testkeypair als payer - geen van de drie
apparaten hoefde erbij betrokken te worden.

Gebouwd: een klein, op zichzelf staand TS-script (`@sqds/multisig` + `@solana/web3.js`,
volledig los van zowel SpankWallet als het wegwerp-Anchor-programma) dat: de actuele
Squads-`ProgramConfig` (treasury-adres) rechtstreeks van devnet opvraagt i.p.v. aan te
nemen, een multisig aanmaakt met de drie leden (allemaal `Permissions.all()` - bewust geen
rollen, zelfde ontwerptaal als multi-passkey), drempel 2-of-3, timelock 300s (verkorte
TEST-waarde voor deze repetitie, niet de 72u van de uiteindelijke migratie), en het
resultaat DIRECT VAN DEVNET TERUGLEEST ter verificatie (niet enkel op een geslaagde
RPC-respons vertrouwd).

**Resultaat, bevestigd via on-chain-terugleeslezing:**
- Multisig PDA: `DELWtaR7m7xsFLKVDggofscvakykvXFt6c5eEAXSA3BJ`
- Vault PDA (index 0, wordt de nieuwe upgrade-authority): `5FtJ2ZVVpbu3ckErDUgtrKwyUtr8NFXburSSTA2P4Crt`
- Aanmaak-signature: `5exhA1iRh4tmXsBnmAbD5YCwJF57CVjYqxTSXoPpkLUZe7prhShprbag6q71TkSh3JsMyAPxh8TgfAVHg3fHaRk7`
- Teruggelezen: `threshold: 2`, `timeLock: 300`, alle drie leden aanwezig met
  `permissions.mask: 7` (Initiate+Vote+Execute, volledig gelijkwaardig)

Nog te doen: upgrade-authority van het wegwerpprogramma overdragen aan deze vault, een
echte testupgrade door de volledige voorstel-/goedkeurings-/timelock-/uitvoeringsflow
heen halen, en het resultaat verifieren met `solana program show`.

**Fase 3: upgrade-authority overgedragen, v2 gebouwd en als buffer klaargezet -
uitsluitend nog CLI-bereikbare stappen.** Tijdens deze fase een tweede reele valkuil
gevonden en direct gefixt: `solana program set-upgrade-authority` deelt, in tegenstelling
tot `solana program deploy`, GEEN enkel `--keypair`-argument voor zowel signer als fee-
payer - zonder expliciete `--keypair` viel de fee-payer terug op de CLI-config-default
(`~/solana_darkpool/heartbeat.json`, 0 devnet-SOL, hetzelfde "verkeerde signer"-gevaar als
al gedocumenteerd voor deploys), wat de eerste poging deed falen met "Attempt to debit an
account but found no record of a prior credit". Opgelost door `--keypair
~/.config/solana/id.json` expliciet mee te geven naast `--upgrade-authority`.

Uitgevoerd en on-chain geverifieerd (telkens met `solana program show`/`--buffers`, niet
enkel op een geslaagde CLI-aanroep vertrouwd):
- Upgrade-authority van het wegwerpprogramma overgedragen aan de vault (met bewust
  `--skip-new-upgrade-authority-signer-check`, omdat een PDA per definitie nooit zelf kan
  ondertekenen - de vault-adres was al onafhankelijk geverifieerd via de vorige fase, dus
  het overslaan van deze CLI-veiligheidscheck was hier verantwoord). `Authority` op het
  wegwerpprogramma toont nu `5FtJ2ZVVpbu3ckErDUgtrKwyUtr8NFXburSSTA2P4Crt`.
- v2 van het wegwerpprogramma gebouwd (`msg!()`-tekst zichtbaar gewijzigd naar "UPGRADED
  via Squads 2-of-3 multisig!" - een concrete, verifieerbare bytecode-wijziging, geen
  no-op-herdeploy), via hetzelfde `anchor build`-dan-`cargo-build-sbf --arch v3`-proces.
- v2 weggeschreven als buffer-account (`4P3anQqbW5q8ChjQXKnTQjD4WwmRo9etejXP36ShPUPP`),
  en de buffer-authority overgedragen aan diezelfde vault - bevestigd via
  `solana program show --buffers --buffer-authority <vault>`.

**Grens van wat vanaf de Spark alleen kan, expliciet vastgesteld** (niet aangenomen):
zowel het indienen van het upgrade-voorstel (`vaultTransactionCreate`, vereist een
signer met Initiate-permissie) als de uiteindelijke uitvoering
(`vaultTransactionExecute`, vereist een `member`-signer-account) zijn geverifieerd tegen
de daadwerkelijke SDK-typedefinities te vereisen dat een van de DRIE geregistreerde leden
zelf ondertekent - geen enkele combinatie van lokaal beschikbare sleutels op de Spark kan
dit vervangen. Deze twee stappen (plus de goedkeuring ertussen) moeten dus daadwerkelijk
via de drie fysieke apparaten/wallets gebeuren. Vooraf onderzocht: de eerdere
browser-netwerkverwarring komt vermoedelijk doordat `app.squads.so` de MAINNET-UI is - de
juiste devnet-URL is een apart domein, `https://devnet.squads.so`.

**Correctie op de vorige alinea - eigen fout, gevonden door de gebruiker en pas daarna
grondig geverifieerd.** De gebruiker zag op `devnet.squads.so/squads` twee squads
(`9TzP2rTLkkGKTDDu7A2iJzp88aUuEWPMRE2jqSMm9dSc`, 3 owners; `BVGkkiAApvzvAPKcHAA4EzopXP5nJMWTooXG22a1oWVY`,
1 owner) die geen van beide overeenkwamen met het gerapporteerde multisig-adres, en een
directe link naar dat adres 404'te. In plaats van aan te nemen dat het eigen eerder
gerapporteerde adres fout was, eerst alle drie de kandidaat-adressen rechtstreeks on-chain
opgevraagd en vergeleken. Uitkomst: `DELWtaR7...` bleek nog steeds volledig correct (owner
program = de echte Squads V4-program-ID, threshold/timeLock/leden allemaal exact zoals
verwacht) - de TWEE zichtbare squads in de UI bleken beide eigendom van
`SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`, bevestigd via onderzoek de **Squads V3
(legacy)**-programma-ID te zijn (onveranderlijk sinds februari 2023, geen enkele relatie
met de V4-SDK die dit hele traject gebruikt) - ze deserialiseerden dan ook merkbaar NIET
als een V4 `Multisig`-account (struct-mismatch-fout).

Root cause: mijn eigen eerdere claim dat `devnet.squads.so` de juiste V4-devnet-URL was
(en `app.squads.so` mainnet) bleek FOUT, gebaseerd op een lage-kwaliteit zoekresultaat-
samenvatting, niet op een primaire bron. Rechtstreeks Squads' eigen v4-launch-blogpost
opgehaald en gecontroleerd: "v4, the new Squads app... available today at app.squads.so" -
`app.squads.so` IS de juiste V4-app (met vermoedelijk een in-app devnet/mainnet-toggle,
geen apart domein); `devnet.squads.so` hoort kennelijk bij het legacy V3-domein. Les:
zoekresultaat-samenvattingen zijn geen vervanging voor een primaire bron bij een claim die
een concrete actie van de gebruiker stuurt - de fout zat in te snel een claim aannemen
zonder hem tegen de brontekst zelf te toetsen, niet in het onderzoek zelf overslaan.

Upgrade-authority van het wegwerpprogramma nogmaals expliciet herverifieerd na deze
verwarring: `solana program show 6hzVvPNHxVCW4aMECXW92GWHdRsCzcZkDXmY6k9zUmEU` toont nog
steeds `Authority: 5FtJ2ZVVpbu3ckErDUgtrKwyUtr8NFXburSSTA2P4Crt` - exact de vault-PDA van
de correcte, geverifieerde `DELWtaR7...`-multisig. Niets is stiekem gewijzigd; de
verwarring zat uitsluitend in welke URL naar welke programma-versie leidt.

**Fase 4: volledig CLI-based voorstel/goedkeuring/uitvoering, browser-UI losgelaten.**
Na de URL-verwarring expliciet gekozen (functionaliteit boven UI-gemak, op verzoek): ook
het indienen van het upgrade-voorstel, de goedkeuring en de uitvoering zelf via een script
laten lopen, in plaats van verder te zoeken naar een werkende Squads-webinterface voor
deze specifieke multisig. Vastgesteld en bevestigd (niet aangenomen) dat dit deel WEL
daadwerkelijk een echte handtekening van een van de drie leden vereist voor alle drie de
stappen - zowel `vaultTransactionCreate` (`creator`-veld) als `vaultTransactionExecute`
(`member`-veld, expliciet `[**signer**]` in de gegenereerde SDK-typedefinities) - dus dit
kan, in tegenstelling tot de multisig-aanmaak zelf, niet zonder de drie echte apparaten.

De instructie-account-volgorde en -data voor de daadwerkelijke `Upgrade`-instructie (het
kernstuk van dit script) is NIET zelf verzonnen, maar geverifieerd tegen twee onafhankelijke
primaire bronnen die elkaar bevestigen: (1) de daadwerkelijke Agave-broncode zelf
(`programs/bpf_loader/src/lib.rs`, lokaal beschikbaar), en (2) Squads' eigen, officiele
`squads-v4-program-upgrade`-GitHub-Action (`src/main.ts`, opgehaald via `gh`/curl, niet via
een samenvattend zoekresultaat). Beide bevestigen exact dezelfde account-volgorde
(ProgramData, Program, Buffer, Spill, Rent-sysvar, Clock-sysvar, upgrade-authority-signer)
en instructiedata (u32 LE waarde 3).

Gebouwd: `manage-proposal.ts`/`.js` (drie modi: `propose`/`approve`/`execute`, elk
aanroepbaar met `node manage-proposal.js <modus> <pad-naar-keypair>`), met tolerante
detectie of het Proposal-account al bestaat (voorkomt een verwarrende
"already exists"-fout, voor het geval een nieuwere SDK-versie `vaultTransactionCreate` en
`proposalCreate` ooit zou samenvoegen - vooraf niet met zekerheid vast te stellen uit de
documentatie alleen). `tsc` ving tijdens het bouwen een echte fout (`approve()` miste een
verplicht `feePayer`-veld) voordat het bij de gebruiker terechtkwam.

**Eerlijk vastgestelde grens: dit script kon niet end-to-end getest worden vanaf de Spark**
(geen van de drie echte member-sleutels is hier beschikbaar, met opzet). Verificatie
beperkt zich dus tot: overeenstemming met twee onafhankelijke primaire bronnen, en een
schone TypeScript-compilatie. De gebruiker is expliciet gevraagd eerst `propose` te
draaien en het resultaat te melden voordat `approve`/`execute` gebruikt worden, om een
eventuele fout met minimale cyclus te vinden.

**Fase 5: propose + eerste approve daadwerkelijk uitgevoerd, een echte bug gevonden en
gefixt.** De gebruiker kon de scripts niet zelf op de drie apparaten draaien (geen
terminal-toegang/geen developer) - in overleg overgestapt op: gebruiker exporteert een
private key uit de wallet-extensie en deelt die in de chat, de sleutel wordt uitsluitend
voor deze devnet-wegwerp-repetitie gebruikt (expliciet bevestigd door de gebruiker), nooit
voor de echte SpankWallet-migratie. Voorafgaand hieraan expliciet gecontroleerd of het om
een speciaal-hiervoor-aangemaakte wallet ging (niet een bestaande/dagelijkse) - bevestigd.
Ontvangen sleutel geconverteerd naar het standaard keypair-array-formaat en de publieke
sleutel er direct uit teruggerekend en vergeleken tegen het bekende adres, voordat hij
gebruikt werd - niet blind vertrouwd dat de conversie klopte.

`propose` uitgevoerd met de hoofd-pc-sleutel: `vaultTransactionCreate` slaagde meteen
(transactionIndex 1, signature `25ARwsoB7h5oYoFbeZnamZsqfvFJoocWuYpQ6znXKtZP58cZWg8nU4sN92gVbUttA2Tt8XFxnbMXxMvg6N2Wxa82`),
maar de daaropvolgende `proposalCreate`-aanroep in hetzelfde scriptverloop faalde met
on-chain foutcode `InvalidTransactionIndex` (6009). Root cause gevonden door Squads' eigen
programmabroncode rechtstreeks op te halen (`proposal_create.rs`, GitHub) i.p.v. te
gokken: de validatie `args.transaction_index <= multisig.transaction_index` faalde
vermoedelijk door een timing-/bevestigingsniveau-gat tussen de twee opeenvolgende
RPC-aanroepen binnen dezelfde scriptrun - het script hergebruikte een lokaal berekende
`transactionIndex`-variabele in plaats van vlak voor `proposalCreate` het account vers
van de chain te herlezen. Bevestigd via een direct on-chain-onderzoek (niet aangenomen):
`multisig.transactionIndex` stond op dat moment daadwerkelijk al op 1, de
`VaultTransaction`-account bestond al, alleen het `Proposal`-account ontbrak nog. Fix:
`propose()` in `manage-proposal.ts` herleest het multisig-account nu expliciet vers vlak
voor `proposalCreate`, in plaats van de eerder lokaal berekende waarde te hergebruiken.
Losstaand met deze fix `proposalCreate` opnieuw gedraaid (signature
`hXfrzmD48uRAAPbjTdw9ksyQtZ7sEswuXxkctirogqzGVnrozytcSkK6xw5RkMVjALdx7eGFaHGVrkyyBBELYd4`) -
geslaagd, `Proposal`-account bevestigd `Active` met 0 goedkeuringen.

Tweede ontdekking (ook niet aangenomen, on-chain geverifieerd): het aanmaken van een
Proposal-account telt NIET automatisch als de eerste goedkeuring van de creator - er zijn
daadwerkelijk twee losse `approve`-aanroepen nodig voor de 2-of-3-drempel. Eerste
`approve` uitgevoerd met dezelfde hoofd-pc-sleutel (creator en approver mogen dezelfde
persoon/sleutel zijn - twee losse acties, geen beperking op wie welke actie mag
combineren) - signature `4297FamyaPonzt5wxMbVYCMVpdExhmbT7p94rCXQMLuYmX61rpmj2R9rCkPHR1ZGWFobjTJiV7tMSdjCoUYognGw`,
bevestigd via directe terugleeslezing: `approved: [3zZcLwTXUn2zw3RPJ3tLNofqPnP6J8KQD3pxfEJixXt3]`,
status nog `Active` (wacht op de tweede van de drie leden voor de drempel).

**Fase 6: het opgegeven Windows-pc-adres bleek nooit echt bestaan te hebben - multisig +
wegwerpprogramma opnieuw opgezet, plus een tweede timing-bug gevonden.** Bij het
exporteren van de private key voor het Windows-pc-lid (`AHy1bU6pMv4NQ2H8zivtW3AFvzaXY836yx2BaTyJfcwG`)
bleek de teruggerekende publieke sleutel niet overeen te komen (niet aangenomen - expliciet
gecontroleerd door de private key te decoderen en de publieke sleutel ervan te vergelijken
vóórdat hij ergens gebruikt werd). Navraag bij de gebruiker: Phantom op de Windows-pc had
altijd maar een enkel, ander account gehad (`2jDzaP3FbW5583hb4FeGZVU9MYseqBeFHwxycjzcvT7Q`) -
het eerder opgegeven adres bestond nooit als een echte, benaderbare wallet.

Omdat de allereerste 2-of-3-multisig (`DELWtaR7...`) dit onbereikbare adres al als lid
had vastgelegd bij aanmaak, en de upgrade-authority van het (eerste) wegwerpprogramma
al naar DIE multisig's vault was overgedragen, koos de gebruiker er expliciet voor
(sneller/betrouwbaarder dan een config-transactie op de bestaande multisig) om opnieuw te
beginnen: een nieuwe multisig aanmaken met het gecorrigeerde adres, i.p.v. het foutieve lid
te vervangen via nog een aparte propose/approve/execute-cyclus.

Gedaan:
- Nieuwe multisig aangemaakt (zelfde script, gecorrigeerde ledenlijst): PDA
  `2twpc8sYxYBUwArQ2D6cbFvkufTdK7iRUfaYycUJ58YA`, vault `5nvYWhBRmN9TNru37mqQAX6dPJ7qyVbGQdEDyreUxdwt`,
  opnieuw 2-of-3/300s, on-chain teruggelezen ter bevestiging.
- Vastgesteld dat de upgrade-authority van het EERSTE wegwerpprogramma niet meer
  rechtstreeks over te dragen was (zat al achter de oude vault, alleen bereikbaar via DIE
  multisig's eigen 2-of-3-flow - een nieuwe propose/approve/execute-cyclus enkel om de
  authority te verplaatsen). In plaats daarvan sneller en zonder afhankelijkheid van de
  oude, verlaten multisig: een TWEEDE, vers wegwerpprogramma gedeployed
  (`BndKWeeteD8pADsssZaDhkhoSEQQzTJT149S2zFncsc4`, zelfde triviale bron, eerst de
  ORIGINELE v1-boodschap opnieuw gedeployed zodat de latere upgrade weer een
  daadwerkelijk waarneembaar verschil laat zien), waarvan de upgrade-authority meteen
  rechtstreeks (met de eigen, nog wel beschikbare lokale sleutel) naar de NIEUWE vault
  gezet is. v2-buffer opnieuw geschreven en overgedragen (`GKLXSZNxUZs92oNirBQao1J4bKuXRcjk3CJnp7QJMGpe`).
  `manage-proposal.ts`'s constanten bijgewerkt naar alle nieuwe adressen.

**Tweede timing-bug, dezelfde soort als eerder maar met een andere foutcode.** Ondanks de
eerdere fix (vers herlezen vlak voor `proposalCreate`) faalde de eerste `propose`-poging op
de nieuwe multisig opnieuw, deze keer met `StaleProposal` (6007) i.p.v.
`InvalidTransactionIndex`. Direct on-chain gecontroleerd (niet aangenomen): op dat moment
gold `transactionIndex=1 > staleTransactionIndex=0` al gewoon correct, en de
`VaultTransaction`, maar niet het `Proposal`-account, bestond al - exact hetzelfde patroon
als de eerste keer, dus vermoedelijk dezelfde onderliggende oorzaak (RPC-
bevestigingsniveau-vertraging tussen twee snel-opeenvolgende aanroepen binnen een en
dezelfde scriptrun), nu net iets trager zichtbaar. Losstaand `proposalCreate` opnieuw
gedraaid (signature `2a4MNw4eBDjpoCd1ypkGudwB1yUnqP8Ny1SZ55Bk6cE2YrkxNcMLQEr9N14JUs3m3KM3u2MaN3ZdLqJJLh1LAnCP`) -
geslaagd. Nog niet structureel in het script opgelost (bijv. met een korte expliciete
wachttijd of een confirmatie-niveau "finalized" tussen de twee aanroepen) - voor deze
eenmalige repetitie was handmatig retrying voldoende, maar dit zou de aandacht verdienen
als dit script ooit vaker/geautomatiseerd gebruikt wordt.

Beide goedkeuringen daarna zonder problemen gezet: hoofd-pc
(signature `5w5f5JtAfbBNuL6WSFJMvyuJo3YgbGRTy34hANsrcae22SKG3UzaftqrGbnWq2KMojoh6fowVFSaY8BmvtXcsKC2`),
Windows-pc, gecorrigeerd adres
(signature `3C7TpLxfJdLLDpdUw3tAZv6tzfUHRWGSuMxM6gyqHF4HT7spYN69zRfvMTkptsw2Sm3KFKbn2SYxWD2VkUMoEAPU`).
On-chain bevestigd: proposal-status `Approved`, beide leden aanwezig in `approved`. De
2-of-3-drempel is hiermee daadwerkelijk bereikt en de 300s-timelock is gestart (18:05:05
UTC -> uitvoerbaar vanaf 18:10:05 UTC).

**Fase 7: uitvoering - de timelock daadwerkelijk laten verlopen, nog twee echte bugs
gevonden en opgelost, en tot slot de upgrade onweerlegbaar bevestigd.** Op de klok
gewacht (een korte `until`-poll-lus, geen dummy-transacties nodig aangezien dit devnet is
- devnet-tijd verstrijkt vanzelf, zelfde principe als bij session keys sectie 40) tot
18:10:05 UTC daadwerkelijk gepasseerd was, dan pas `execute` geprobeerd.

Eerste probleem: `multisig.rpc.vaultTransactionExecute` gooide een client-side
`TypeError: Cannot set property logs of Error which has only a getter` - een bug in de
SDK's eigen foutvertaal-code die de ECHTE onderliggende foutmelding verborg. Opgelost door
de lager-liggende `multisig.transactions.vaultTransactionExecute` te gebruiken (geeft een
ongetekende `VersionedTransaction` terug) en die zelf te ondertekenen/simuleren, wat de
buggy foutvertaling omzeilde en de daadwerkelijke simulatie-logs zichtbaar maakte.

Daaruit bleek de ECHTE, tweede bug: `AccountDataTooSmall` / "ProgramData account not large
enough". Root cause gevonden door de daadwerkelijke ProgramData-account-grootte on-chain op
te vragen (129501 bytes, oftewel exact 129456 bytes ELF-capaciteit na aftrek van de vaste
45-byte metadata-header - EXACT gelijk aan v1's grootte, dus letterlijk geen enkele byte
speling): `solana program deploy`'s standaardallocatie reserveert kennelijk geen enkele
headroom voor toekomstige upgrades, dus zelfs een verschil van 24 bytes (129480 t.o.v.
129456) al genoeg was om de upgrade te laten mislukken. Gefixt met `solana program extend`
- een permissionless, autoriteit-onafhankelijke actie (voegt uitsluitend rent-betaalde
ruimte toe, raakt geen code of autoriteit aan) - het minimum van 10.240 bytes per aanroep
toegepast (ontdekt via de foutmelding van een eerdere, te kleine poging). Nieuwe
ProgramData-grootte: 139741 bytes, ruim voldoende. Les voor toekomstige DEVNET/mainnet-
deploys (ook relevant voor SpankWallet zelf, hoewel niet met terugwerkende kracht
toegepast op de al-lopende devnet-deploy): standaard `solana program deploy` geeft geen
gegarandeerde upgrade-headroom - overweeg vooraf `--max-len` met een bewuste marge, of
gebruik `solana program extend` proactief na een deploy die significant kleiner is dan een
te verwachten toekomstige versie.

Na de fix: simulatie slaagde schoon ("Upgraded program..."), daadwerkelijk verstuurd en
bevestigd (signature `2f6wXvHcAbtxsxKxKaKoKcgfLNGcvhEpg8tPmaNngR4axRHcT2rv4WM47KZaHThzSETn3EAeBKfoaMnZWdkV3S1S`).
`solana program show` toont een nieuw deploy-slot (482976329 -> 482979618), authority nog
steeds correct de vault. **Sluitende, onweerlegbare verificatie**: de daadwerkelijke
on-chain bytecode opgehaald met `solana program dump` en doorzocht - bevat nu letterlijk
`"UPGRADED via Squads 2-of-3 multisig! Counter is now"`, en de oude
`"Hello, world! Counter is now"`-tekst is volledig verdwenen. Geen aanname op basis van een
slot-nummer of foutloze simulatie - de daadwerkelijk gewijzigde bytecode zelf is
gecontroleerd.

**De devnet-generale-repetitie is hiermee volledig, end-to-end geslaagd:** een 2-of-3
Squads V4-multisig met timelock aangemaakt, de upgrade-authority van een volledig los
wegwerpprogramma overgedragen, een echte code-upgrade voorgesteld, door twee van de drie
onafhankelijke leden goedgekeurd, na een daadwerkelijk verstreken timelock uitgevoerd, en
de resulterende bytecode-wijziging onweerlegbaar bevestigd. Onderweg vijf reele, niet
voorziene problemen gevonden en opgelost (twee RPC-timing-races in propose/approve, een
foutief/nooit-bestaand signer-adres, een SDK-foutvertaalbug, en een te-krappe
ProgramData-allocatie) - geen van alle vooraf voorzien, allemaal empirisch gevonden en met
primaire bronnen (Agave-broncode, Squads' eigen programmabroncode, directe on-chain-
verificatie) opgelost in plaats van aangenomen. SpankWallet's eigen upgrade-authority
(`9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9`) is tijdens dit hele traject geen moment
aangeraakt - de daadwerkelijke migratie is een bewuste, aparte vervolgstap na deze
geslaagde repetitie.

## 42. Echte SpankWallet-migratievoorstel goedgekeurd - stap 1+2 uitgevoerd, stap 3 (overdracht) wacht op expliciete bevestiging

Vervolg op de geslaagde devnet-generale-repetitie (sectie 41). Voorstel voor de echte
migratie behandelde drie punten die de repetitie blootlegde: (1) ProgramData-headroom
vooraf controleren en zo nodig vergroten, (2) ondertekenen zonder private-key-export voor
de echte migratie (in tegenstelling tot de repetitie, waar wegwerpwallets voor een
wegwerpprogramma dat wel toelieten), (3) de bewezen aanpak/scripts hergebruiken i.p.v.
opnieuw beginnen. Goedgekeurd, met een expliciete, harde grens: geen enkele actie op
`9ma6...`'s daadwerkelijke upgrade-authority totdat apart bevestigd.

**Stap 1 (geen authority-actie): ProgramData-headroom vergroot.** Gecontroleerd:
`9ma6...`'s ProgramData had al ~9.531 bytes headroom (454.848 bytes toegewezen, 445.272
bytes daadwerkelijke laatste build) - niet nul zoals het wegwerpprogramma bij de repetitie,
maar waarschijnlijk te krap voor iets substantieels zoals de nog openstaande
gelaagde-privileges-roadmap. Vergroot met `solana program extend` (dezelfde permissionless,
autoriteit-onafhankelijke actie als bewezen tijdens de repetitie) met 300.000 bytes extra.
Geverifieerd: 454.848 -> 754.848 bytes (exact +300.000), `Authority` ongewijzigd
(`G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp`) - bevestigt dat deze actie de authority
niet raakt.

**Stap 2 (geen authority-actie): de echte productiemultisig aangemaakt.** Hergebruik van
het bij de repetitie bewezen `create-multisig`-script (nieuw bestand,
`create-spankwallet-multisig.ts`, om de wegwerp-versie niet te overschrijven/verwarren),
met de drie definitieve, echte signer-adressen (telefoon/Solflare, hoofd-pc/Phantom,
Windows-pc/Phantom - dezelfde set als aan het eind van de repetitie gecorrigeerd) en de
volle 72u-timelock (259.200 seconden - bewust dezelfde duur als `recovery_timelock_seconds`'s
eigen default). Multisig-aanmaak heeft, net als bij de repetitie, geen van de drie echte
private keys nodig gehad (leden zijn pure data bij aanmaak) - uitsluitend de lokale,
al-gefunde devnet-sleutel als betaler/aanmaker. On-chain teruggelezen ter verificatie:
`threshold: 2`, `timeLock: 259200`, alle drie leden aanwezig met volledige permissies.

- Multisig PDA: `A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp`
- Vault PDA (toekomstige upgrade-authority, nog NIET actief): `89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw`
- Aanmaak-signature: `5aqw7zJiNaUMzqJURYM7LsQmsFAosSnh4oaFqGrLAmkeTLycoYLHimQL4KAc1rg3Dwan2nzv8g3uRzTXKUc3GgeK`

`9ma6...`'s `Authority` opnieuw expliciet gecontroleerd na beide stappen: nog steeds
`G1qgHzMxNHqewWEKzEoV46GUXjDrsuD4P8LQ97T6gNXp`, ongewijzigd. **Stap 3 (de daadwerkelijke
overdracht van de upgrade-authority naar de vault hierboven) is NIET uitgevoerd en wacht op
aparte, expliciete bevestiging van de gebruiker**, zoals afgesproken.

**Stap 3 uitgevoerd: de echte upgrade-authority is overgedragen.** Na expliciete
bevestiging: `solana program set-upgrade-authority 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9
--new-upgrade-authority 89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw
--skip-new-upgrade-authority-signer-check` (zelfde reden als bij de repetitie: een PDA kan
nooit zelf ondertekenen, het vault-adres was al onafhankelijk geverifieerd). Direct
geverifieerd met `solana program show`: `Authority` toont nu daadwerkelijk
`89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw`, alle andere velden (Program ID,
ProgramData-adres, Data Length, Balance) ongewijzigd. **Het single-key-upgrade-authority-
SPOF - gap 1 uit de externe security-review (sectie 41) - is hiermee gesloten op devnet.**

**Stap 4 uitgevoerd: documentatie en scripts bijgewerkt.** README.md's "Deployen naar
devnet"-sectie beschrijft nu het daadwerkelijke, huidige tweetraps-proces (buffer
voorbereiden met een gewone lokale sleutel, upgrade voorstellen/goedkeuren/uitvoeren via de
multisig op `app.squads.so`) - een directe `solana program deploy` met de oude lokale
sleutel faalt nu terecht. `scripts/build-and-deploy.sh` kreeg een expliciete waarschuwing
dat het uitsluitend voor de lokale validator is. SECURITY.md's sectiepointers uitgebreid.

**Stap 5 (canary-upgrade), voorbereidingsdeel afgerond.** Een triviale, functioneel
volledig onschadelijke wijziging aangebracht (een toelichtende comment bij `declare_id!`,
geen enkele instructie-/verificatielogica gewijzigd) - bewust gekozen zodat de eerste
daadwerkelijke test van de nieuwe multisig-flow geen enkel functioneel risico draagt.
49/49 lokale tests bevestigd groen vóór het committen. Build + `--arch v3`-binary
(445.272 bytes, byte-offset geverifieerd, 1 treffer) als buffer geschreven
(`7jvidUn42xWhJCV7GWbE61N41exK5iEP4sZDnJtwTZYh`), buffer-authority overgedragen aan de
vault, bevestigd via `solana program show --buffers --buffer-authority`. **Het indienen
van het voorstel, de twee goedkeuringen, het verstrijken van de 72u-timelock, en de
uiteindelijke uitvoering moeten via `app.squads.so` door de gebruiker zelf gebeuren** (geen
geëxporteerde sleutels voor de echte migratie, zoals afgesproken) - zie de exacte
klikvolgorde die aan de gebruiker is gegeven direct na deze sectie werd geschreven.

## 43. Squads-webinterface bleek onbruikbaar - eigen wallet-adapter-ondertekenpagina gebouwd; canary-upgrade-voorstel staat op 1-van-2 goedkeuringen

Vervolg op sectie 42. **De Squads-webinterface (`app.squads.so`) bleek in de praktijk
onbruikbaar** - toonde herhaaldelijk alleen demodata, kon de echte productiemultisig niet
vinden, ongeacht devnet/mainnet-instelling. Omdat de gebruiker voor deze ECHTE migratie
expliciet GEEN private-key-export wilde (in tegenstelling tot de repetitie in sectie 41,
waar wegwerpsleutels dat voor een wegwerpprogramma toelieten), is in plaats daarvan een
eigen ondertekenpagina gebouwd: `wallet-signer.html` (scratchpad, `squads-admin/`-map,
dus buiten de git-repo). Deze bouwt de Squads-transacties zelf op en laat ze door de
wallet-extensie ondertekenen via diens eigen goedkeuringspopup (Wallet Standard) - de
sleutel verlaat nooit de extensie.

Onderweg drie root causes gevonden en gefixt, elk met primair bewijs in plaats van
aannames (zoals gebruikelijk voor dit project):

- **RPC-verversingsrace bij propose**: twee losse instructies (`vaultTransactionCreate`
  + `proposalCreate`) na elkaar raakten `InvalidTransactionIndex`/`StaleProposal` door
  een timing-gat. Definitief opgelost (niet omzeild) door ze te combineren tot EEN
  atomaire transactie met twee instructies, dus een enkele handtekening.
- **`window.isSecureContext` was `false`** op het platte `http://<LAN-IP>`-origin,
  waardoor Phantom `connect()` stil liet hangen zonder popup of fout. Opgelost met een
  self-signed HTTPS-server (`https-server.js`, poort 8766).
- **Brave's ingebouwde wallet onderschepte de Wallet Standard-verbinding** die voor
  Phantom bedoeld was, waardoor met het verkeerde (niet-multisig-lid) account werd
  verbonden. Opgelost door Brave Wallet uit te schakelen in de browserinstellingen.

Met beide fixes is via de hoofd-pc (Phantom, adres `3zZcLwTXUn2zw3RPJ3tLNofqPnP6J8KQD3pxfEJixXt3`)
succesvol een upgrade-voorstel ingediend EN goedgekeurd voor de echte canary-upgrade uit
sectie 42. Per ongeluk is de flow twee keer doorlopen op hetzelfde apparaat, wat een dubbel
voorstel opleverde:

- Voorstel `transactionIndex 1`: 1 goedkeuring (hoofd-pc). Overbodig/dood - wijst naar
  dezelfde eenmalige buffer als voorstel 2, wordt dus vanzelf onuitvoerbaar zodra
  voorstel 2 wordt uitgevoerd. Geen actie nodig.
- **Voorstel `transactionIndex 2`: de relevante. Status `Active`, 1 van de 2 vereiste
  goedkeuringen (hoofd-pc).** Dit is ook het voorstel dat de pagina automatisch target
  (de "3. Goedkeuren"/"4. Uitvoeren"-knoppen lezen altijd de huidige
  `multisig.transactionIndex`, dat is nu 2).
- Propose-signature: `5bhHo8gwGGgYQvUgrty854E7UerD9rVJ9968jEe4UjWeMk4HiJ65yzYdKwCJw5Fr2bbnb46LkHvJdFwZ8af68rQ7`
- Approve-signature (hoofd-pc): `5dXT31CxvaVvkqM6pztAy7ehbCd1S88vwuvRyT8bwD3zJn1SN77zP5N7qen9FA12xBH687qZUtgsUHr7G6bXaaFj`
- Een premature uitvoerpoging faalde met een vage `Unexpected error` (`-32603`) uit
  Phantoms eigen extensiecode - on-chain geverifieerd dat dit simpelweg kwam doordat er
  nog maar 1 van de 2 goedkeuringen was (status `Active`, niet `Approved`), geen aparte bug.

**Mobiele ondertekening (telefoon, Solflare) werkte in eerste instantie helemaal niet** -
0 Wallet Standard-providers gedetecteerd, op alle geprobeerde Android-browsers. Root cause
(bevestigd tegen de daadwerkelijke broncode van `solana-mobile/mobile-wallet-adapter` op
GitHub, niet enkel documentatie-samenvattingen - die op een punt zelfs tegenstrijdig
bleken met de broncode): geen enkele mobiele walletapp injecteert zichzelf automatisch in
browsertabbladen zoals een desktopextensie dat doet - de pagina deed nog geen enkele
poging om een mobiele wallet te vinden. **Fix aangebracht, nog NIET getest op de
telefoon:**

- Knop 1 registreert nu bij laden op Android automatisch Mobile Wallet Adapter
  (`@solana-mobile/wallet-standard-mobile`, npm) als Wallet Standard-provider - de
  bestaande verbindingscode vindt 'm daarna vanzelf, geen apart codepad nodig.
- Nieuwe knop "1b. Verbinden via Solflare-mobiel" als onafhankelijke fallback,
  specifiek voor Solflare: gebruikt Solflare's eigen SDK (iframe naar
  `connect.solflare.com` + deep-link + postMessage), werkt in principe ongeacht welke
  mobiele browser.
- CDN-imports geverifieerd (200 OK, juiste exports aanwezig) en de module-JS
  syntactisch gecontroleerd (`node --check`); niet functioneel getest bij gebrek aan een
  Android-toestel in deze sessie.

**Openstaand bij het afsluiten van deze sessie:**
1. Telefoon (of Windows-pc) moet de tweede goedkeuring geven op voorstel `transactionIndex 2`
   via `https://192.168.178.205:8766/wallet-signer.html` (knop 1, of bij falen knop 1b) om
   de 2-van-2-drempel te halen - pas dan begint de echte 72u-timelock.
2. Zodra de timelock verstreken is: uitvoeren via dezelfde pagina (knop 4), daarna
   bevestigen via `solana program show` + `solana program dump` (zelfde bewijspatroon als
   bij de repetitie in sectie 41) dat de canary-bytecode daadwerkelijk is bijgewerkt.
3. De `wallet-signer.html`-HTTPS-server (poort 8766, self-signed certificaat) is bij het
   afsluiten van deze sessie los van de Claude Code-sessie losgekoppeld gestart
   (`setsid`/`nohup`/`disown`) zodat hij blijft draaien; geen actie nodig om 'm morgen
   weer te bereiken.

## 44. Mobiele Solflare-verbinding: root cause van het verkeerde-adres-probleem gevonden, `@solflare-wallet/sdk` vervangen door het echte deep-link-protocol

Vervolg op sectie 43's ongeteste mobiele fix. De gebruiker testte knop "1b" (destijds de
`@solflare-wallet/sdk`-iframe-aanpak) op de telefoon: verbinding lukte, maar gaf een
account terug (`CdReSUq9eX2BKv5kwom12LLJFgyZuYoATfthotUjgE6V`) dat NIET het daadwerkelijke,
enige account in de Solflare-app is (bevestigd: `CP2fg9zgyh12FFVhqfP9PcuVhfhNBp4H59GrGDW9ios3`
is het juiste, correct geregistreerde multisig-lid).

**Root cause, met primair bewijs (broncode, geen documentatie-samenvatting):**
`@solflare-wallet/sdk`'s `connect()` injecteert een iframe naar `connect.solflare.com` en
wacht op een `postMessage`-antwoord (`src/index.ts`, `_injectElement`/`_handleEvent`).
Browsers blokkeren standaard dat een cross-origin iframe de bovenliggende pagina
zelfstandig laat navigeren naar een deep-link/intent ("framebusting intervention" -
vereist een user-gesture direct op de top-level pagina). Zonder die navigatie kan de
iframe de echte, geinstalleerde Solflare-app nooit bereiken, en levert in plaats daarvan
kennelijk zijn eigen, losse sessie/adres. **Dit was dus geen verkeerd account aan de kant
van de gebruiker, maar een structurele beperking van de iframe-SDK-aanpak zelf op mobiel.**

**Oplossing: Solflare's officieel gedocumenteerde deep-link-protocol** (los van de SDK),
geverifieerd tegen de exacte specificatie (`docs.solflare.com/solflare/technical/deeplinks`)
EN Solflare's eigen referentie-implementatie (`github.com/solflare-wallet/deep-link-sample-app`,
`App.tsx`) - dezelfde encrypt/decrypt-aanpak (nacl-box, x25519-sleuteluitwisseling) is
overgenomen, alleen `window.location.href` i.p.v. React Native's `Linking.openURL()`. Dit is
een VOLLEDIGE paginanavigatie (geen iframe): `wallet-signer.html` navigeert zelf naar
`https://solflare.com/ul/v1/<methode>`, Android's eigen App Links-afhandeling opent de
geinstalleerde app, en de app stuurt de gebruiker terug naar `redirect_link` met een
nacl-box-versleuteld antwoord in de query-string.

Belangrijke architecturale consequentie: een volledige paginanavigatie wist de JS-context,
dus een knopklik kan nooit meer synchroon op een resultaat wachten zoals bij Wallet
Standard. De pagina is herstructureerd zodat elke actie (connect/propose/approve/execute)
in een "build"- en een "finish"-functie is opgesplitst; voor het deep-link-pad wordt na
`build` de versleutelde aanvraag weggestuurd en de paginacontext verlaten, en wordt
`finish` pas aangeroepen wanneer de pagina na de redirect opnieuw laadt. Sessie-status
(het x25519-sleutelpaar, het gedeelde geheim, het sessietoken, en welke actie in
behandeling was) overleeft die reload via `sessionStorage`. De oude, bewezen-onbetrouwbare
`@solflare-wallet/sdk`-iframe-knop is volledig verwijderd, niet naast de nieuwe knop
laten staan.

CDN-import (`tweetnacl@1.0.3` via esm.sh) geverifieerd bereikbaar, module-JS syntactisch
gecontroleerd (`node --check`).

**Eerste echte test op de telefoon: de doorverwijzing naar en goedkeuring in de Solflare-app
werkten, maar de terugkeer naar de pagina gaf een blanco "Not Found".** Root cause
gereproduceerd (niet aangenomen) via directe `curl`-tests tegen de draaiende server:
`GET /wallet-signer.html?nonce=X&data=Y` gaf 200, maar `GET /?nonce=X&data=Y` (kale
root-URL + query-string) gaf 404. `https-server.js` vergeleek `req.url === "/"` VOORDAT de
query-string eraf ging, dus `/?nonce=...` faalde die vergelijking en het viel door naar het
lezen van de ROOT-map zelf (EISDIR) i.p.v. `wallet-signer.html` te serveren. Dit trad enkel
op wanneer de pagina via de kale `https://host:8766/` geopend was (`window.location.pathname`
= "/"), waarvandaan `redirect_link` was afgeleid.

Twee fixes, niet een: (1) `https-server.js` isoleert nu eerst het pathname (`req.url.split("?")[0]`)
voordat de "/"-vergelijking gebeurt, en (2) `wallet-signer.html` leidt `redirect_link` niet
langer af van `window.location.pathname` maar gebruikt een vaste `REDIRECT_URL`-constante
(`window.location.origin + "/wallet-signer.html"`), zodat de deep-link-flow niet meer
afhangt van welke URL-vorm de gebruiker toevallig intypte. Ook expliciete logging
toegevoegd van de volledige geconstrueerde deep-link-URL vlak voor het wegnavigeren
(`console.log` + on-page log), voor toekomstige diagnose. Beide fixes geverifieerd door de
exacte eerder-falende `curl`-aanroep (`/?nonce=...&data=...`) opnieuw te draaien na de fix:
nu 200. Server herstart (`setsid`/`nohup`/`disown`, ongewijzigd poort 8766).

Zijdelings gemeld door de gebruiker: knop 1 (MWA) werd per ongeluk eerst aangeklikt en bleef
op de achtergrond hangen (een late timeout-foutmelding kwam pas binnen NA het klikken op
knop 1b). Vermoedelijk onschuldige ruis van de asynchrone MWA-`connect()`-aanroep die nog
liep toen de pagina via knop 1b wegnavigeerde, los van het deep-link-probleem hierboven -
niet verder onderzocht, geen aanwijzing gevonden dat het gerelateerd is.

**Nog steeds niet volledig functioneel bevestigd (verbinden + minstens 1 ondertekenactie
end-to-end) op een echt Android-toestel** - dat is de eerstvolgende stap.

**Aanvullend, op aangeven van de gebruiker: het testtoestel is een Poco F7 (Xiaomi/HyperOS-
MIUI, geen stock Android).** Onderzocht (via websearch, niet aangenomen) of dat relevant is
naast de al-gevonden en -gefixte "Not Found"-bug hierboven. Bevestigd: MIUI/HyperOS staat
gedocumenteerd bekend om (a) agressief browsertabbladen/-processen te killen zodra de
gebruiker wegschakelt naar een andere app (precies wat er gebeurt tijdens het goedkeuren in
Solflare), en (b) inconsistent gedrag van Android App Links-verificatie. De al-gefixte
"Not Found" wordt daar niet door verklaard - dat was een deterministische serverbug,
gereproduceerd los van welk toestel dan ook. Wel een REEEL, ander risico: als MIUI het
tabblad/proces killt terwijl de gebruiker in Solflare zit, overleeft `sessionStorage` dat
niet (gebonden aan de levensduur van die ene browsing-context) - dat zou zich later, anders,
uiten als "Geen actieve Solflare-deep-link-sessie gevonden" bij propose/approve, niet als
"Not Found" bij connect. Preventief gefixt voordat de gebruiker daarop stuitte:
`wallet-signer.html` gebruikt nu `localStorage` (aan het origin gebonden, overleeft een
processkill) in plaats van `sessionStorage` voor de sleutelpaar/sessie-status. Bewuste
afweging, niet stilzwijgend gekozen: de ephemere sessiesleutels blijven hierdoor iets langer
liggen dan strikt nodig (tot de volgende succesvolle afronding, niet tot tabsluiting) -
aanvaardbaar, dit zijn geen langlevende geheimen, enkel voor het encryptiekanaal met
Solflare. Geverifieerd: `node --check` slaagt, de draaiende server serveert de bijgewerkte
pagina (`localStorage.getItem(DEEPLINK_STORAGE_KEY)` aanwezig), en de eerdere "Not
Found"-curl-test blijft 200 geven.

**Vervolgtest: verbinden werkte volledig** (localStorage-fix hield stand, juiste adres
`CP2fg9zgyh12FFVhqfP9PcuVhfhNBp4H59GrGDW9ios3` herkend als lid). **Nieuw probleem bij het
ondertekenen:** na klikken op "3. Voorstel goedkeuren" kwam de foutmelding "Solflare wees
het deep-link-verzoek (execute) af: DeeplinkErrorCode.internalError", terwijl niet op
"4. Uitvoeren" geklikt was.

Eerst gecontroleerd tegen Solflare's eigen documentatie of dit op een verkeerde
methode-naam kan wijzen: nee - propose/approve/execute zijn alle drie in essentie "onderteken
en verstuur deze reeds opgebouwde transactie", en Solflare's deep-link-protocol heeft daar
precies EEN methode voor (`https://solflare.com/ul/v1/signAndSendTransaction`) - geen
aparte "approve"- of "execute"-methode. Bevestigd tegen zowel de exacte spec als Solflare's
eigen referentie-implementatie. Het "(execute)"-label in de foutmelding komt dus niet van
Solflare - dat is uitsluitend eigen lokale boekhouding (`state.pendingAction`, uit
localStorage), teruggegeven in het logbericht.

Werkhypothese (niet met zekerheid vastgesteld, telefoon niet direct instrumenteerbaar):
een eerdere, nooit-afgeronde executeer-poging tijdens het testen (bijv. de terug-knop van
het toestel gebruikt om Solflare te verlaten i.p.v. een expliciete annulering in de app)
leverde geen redirect-antwoord op, dus bleef `pendingAction` op "execute" staan in
localStorage. Normaliter overschrijft een volgende actie (de latere klik op "3.
Goedkeuren") dat gewoon; mogelijk leverde het toestel (MIUI, zie boven, bekend om
vertraagd/gequeued intent-gedrag) echter alsnog een vertraagd antwoord op die OUDERE
poging af, dat werd verward met een reactie op de nieuwe.

Niet aangenomen, wel voorbereid op herhaling: drie aanvullingen aan `wallet-signer.html`
zodat een volgende keer met zekerheid vastgesteld kan worden wat er speelt. (1) Een
expliciete waarschuwing wanneer een NIEUWE actie gestart wordt terwijl er nog een ANDERE,
niet-afgeronde actie openstond (dat had dit scenario meteen zichtbaar gemaakt). (2) Het
volledige uitgaande verzoek (methode, alle payload-velden, tijdstip) wordt nu gelogd - naar
console EN naar localStorage (overleeft de wegnavigatie, in tegenstelling tot console-/
on-page-logs) - zodat het bij terugkomst, ook bij een foutmelding, exact valt te herleiden
welk verzoek bij welk antwoord hoort, inclusief hoe lang geleden dat verzoek verstuurd werd.
(3) Een nieuwe knop "Vastgelopen Solflare-deep-link-status wissen" - een manier voor de
gebruiker om zelf een muurvast/verouderd `pendingAction` te wissen zonder tussenkomst.
Geverifieerd: `node --check` slaagt, server herstart en serveert de bijgewerkte pagina.

**De werkhypothese bleek onjuist: de gebruiker wiste de status met de nieuwe knop,
verbond opnieuw, klikte op "3. Voorstel goedkeuren", en kreeg DEZELFDE fout - nu met een
verse timestamp (6 seconden oud), nog steeds gelabeld "(execute)".** Dat sluit een
verouderde/nooit-afgeronde status als verklaring uit.

De volledige `approve-btn`-handler, `buildApproveTx`, en `startDeeplinkSignAndSend`
regel voor regel herlezen: geen bug gevonden - de code roept ondubbelzinnig
`startDeeplinkSignAndSend("approve", tx)` aan, geen enkel codepad kan daar "execute" van
maken. Dit verlegt de verdenking naar iets dat niet in de broncode zelf zichtbaar is:
of de telefoon daadwerkelijk de nieuwste versie van het bestand draait. `https-
server.js` stuurde nooit cache-headers mee, en elke terugkeer van Solflare is een gewone
GET naar exact dezelfde URL - een reeel scenario waarbij MIUI/HyperOS (al eerder in deze
sectie bevestigd als non-standaard agressief) een VEROUDERDE, gecachte versie van de
pagina serveert in plaats van vers op te halen. Belangrijk: dit zou ook een verse
timestamp verklaren, aangezien die client-side op het moment van klikken gegenereerd
wordt, ongeacht hoe oud de daadwerkelijk draaiende JS is.

Gefixt: `https-server.js` stuurt nu expliciet `Cache-Control: no-store, no-cache,
must-revalidate, max-age=0`, `Pragma: no-cache`, en `Expires: 0` mee bij elke response.
Daarnaast een handmatige, zichtbare build-markering (`PAGE_BUILD`, in het klassieke
script vooraan - zichtbaar zelfs als de module faalt) toegevoegd, zodat een volgende test
DEFINITIEF kan bevestigen welke versie daadwerkelijk draait, in plaats van daarover te
moeten gissen. Geverifieerd: `curl -I` toont de nieuwe cache-headers, de build-markering
staat in de geserveerde pagina, en de eerdere fixes (query-string-routing, localStorage)
blijven intact. Nog te bevestigen: of dit de daadwerkelijke oorzaak was - dat blijkt pas
bij de volgende test op het toestel.

**De caching-hypothese is weerlegd: de gebruiker bevestigde de nieuwe build-markering in
de log, en dezelfde fout kwam alsnog terug.** On-chain opnieuw gecontroleerd (niet
aangenomen): `transactionIndex` bleef ditmaal op 4 staan (geen nieuw duplicaat-voorstel,
in tegenstelling tot de eerdere "execute"-pogingen die wel #3 en #4 creeerden) en voorstel
#2 heeft nog steeds precies 1 van de 2 vereiste goedkeuringen (`3zZcLwTXUn...`, de
poging vanaf de telefoon is niet geregistreerd). **Belangrijkste conclusie voor de veiligheid:
geen premature execute, geen nieuw duplicaat deze keer - de poging faalde voordat er iets
on-chain werd bevestigd.**

`approve-btn`'s handler, `buildApproveTx`, en `startDeeplinkSignAndSend` nogmaals
regel-voor-regel herlezen: nergens een hardcoded "execute"-string te vinden - de
knop-handler geeft ondubbelzinnig de letterlijke string "approve" door. Verdere statische
codereview leverde dus niets nieuws meer op. In plaats daarvan definitieve, empirische
klik-logging toegevoegd: elke knop-handler (propose/approve/execute) logt nu, als EERSTE
regel, vóór alle andere logica, welk DOM-element de browser zelf als geklikt rapporteert
(`element.id` + `element.textContent`) - zowel on-page/console als gepersisteerd in
localStorage (`lastButtonClick`), zodat dit na een deep-link-terugkeer nog te vergelijken
is met de uiteindelijke foutmelding. Dit isoleert definitief tussen twee resterende
mogelijkheden: een echte interne bug (als deze log zelf al "execute-btn" toont bij een
bedoelde klik op knop 3) versus de klik die daadwerkelijk op een ander element viel dan
bedoeld. Build-markering opgehoogd (`2026-08-12T13:20:00Z-click-target-logging`),
geverifieerd via `node --check` en dat de server de bijgewerkte pagina serveert.

**Klik-target-logging bevestigde de juiste knop ("approve-btn"/"3. Voorstel goedkeuren")
- het label-probleem was dus wel degelijk browsercaching, inmiddels opgelost. De
onderliggende `internalError` bleef echter bestaan.** Grondig onderzocht of dit aan de
transactie zelf lag, met harde bewijzen i.p.v. aannames:
- 247 bytes lokaal gereproduceerd, exacte match met de gelogde `transaction_bytes`.
- De approve-transactie (247 bytes, 4 accounts, 1 instructie) rechtstreeks tegen devnet
  gesimuleerd (`connection.simulateTransaction`, `sigVerify: false`): `err: null`,
  programma-logs tonen "Instruction: ProposalApprove" ... "success". **De transactie is
  bewezen 100% geldig.**
- Vergeleken met de propose-transactie (598 bytes, 6 accounts, 2 instructies) die WEL
  slaagde via hetzelfde deep-link-pad - groter en complexer, dus een blanket
  "VersionedTransaction wordt niet ondersteund"-verklaring houdt geen stand.
- `buildApproveTx()` wordt door zowel het synchrone (hoofdpc/Wallet Standard) als het
  deep-link-pad (telefoon) identiek aangeroepen - er is geen apart constructiepad dat kan
  afwijken.

Solflare's eigen foutcode-documentatie (`docs.solflare.com/solflare/technical/deeplinks/
limitations`) opgehaald: `-32603 (Internal Error)` is letterlijk hun eigen, ongedifferen-
tieerde vangnet-foutcode ("Something went wrong within Solflare") - geen verdere diagnose
mogelijk vanaf de client-kant. Een aanverwante, wel specifieke code bestaat apart
(`-32002`, "een ander goedkeuringsvenster staat al open"), niet met zekerheid onze situatie
maar een plausibele onderliggende oorzaak gezien de vele afgebroken/gekilde Solflare-
sessies op dit toestel vanavond.

**Besluit van de gebruiker, na eigen aanvullend onderzoek dat bevestigt dat dit een breed
bekend, langlevend probleem is bij zowel Phantom- als Solflare-deeplinks (meerdere
onafhankelijke ontwikkelaars met exact hetzelfde probleem, geen oplossing beschikbaar) -
dus bij de wallet-provider ligt, niet in `wallet-signer.html`: overstappen naar de
Windows-pc voor de tweede goedkeuring, via hetzelfde bewezen Wallet Standard-pad als de
hoofdpc (knop 1, niet 1b).** Bij het voorbereiden hiervan bleek het door de gebruiker
opgegeven Windows-pc-adres (`AHy1bU6pMv4NQ2H8zivtW3AFvzaXY836yx2BaTyJfcwG`) niet
overeen te komen met de daadwerkelijke, on-chain geregistreerde multisig-leden - opnieuw
gecontroleerd i.p.v. aangenomen. De echte, geregistreerde ledenset (`threshold: 2`):
`2jDzaP3FbW5583hb4FeGZVU9MYseqBeFHwxycjzcvT7Q` (Windows-pc, de juiste),
`3zZcLwTXUn2zw3RPJ3tLNofqPnP6J8KQD3pxfEJixXt3` (hoofdpc, al goedgekeurd),
`CP2fg9zgyh12FFVhqfP9PcuVhfhNBp4H59GrGDW9ios3` (telefoon). Dit komt overeen met de
eerder in dit project al vastgestelde correctie (het oorspronkelijk opgegeven
Windows-pc-adres bleek nooit een echte, controleerbare wallet te zijn).

**Aandachtspunt voor toekomstige, grotere mobiele deep-link-payloads:** de gebruiker vond
via extern onderzoek een melding van een andere ontwikkelaar die tegen dezelfde
`-32603`-fout liep en een vermoeden had van een ongedocumenteerde payload-grootte-limiet
(diens payload was 802 bytes). Onze approve-payload (247 bytes) is kleiner, dus dit
verklaart vermoedelijk niet dit specifieke geval, maar is de moeite waard om te onthouden
mocht er ooit een complexere multisig-actie via het mobiele deep-link-pad moeten (grotere
transacties, meer instructies/accounts).

**Mobiele ondertekening blijft bij het afsluiten van dit spoor onbevestigd/onbetrouwbaar
via Solflare's deep-link-protocol specifiek voor deze actie** (propose werkte, connect
werkte, approve niet) - de telefoon blijft bruikbaar als derde, ongebruikte reserve-signer
zoals oorspronkelijk ontworpen (2-of-3), maar niet als actief gebruikte tweede signer voor
deze migratie. Vervolg: de tweede goedkeuring wordt in plaats daarvan via de Windows-pc
gedaan (Wallet Standard, hetzelfde bewezen pad als de hoofdpc).

## 45. Dependabot-kwetsbaarheden onderzocht: uuid gefixt, esbuild/vite blijven bewust geblokkeerd (zelfde reden als sectie 20), postcss bleek niet (meer) van toepassing

Op verzoek de 6 open Dependabot-alerts (1 high, 5 moderate) grondig onderzocht via `gh api
repos/.../dependabot/alerts` (primaire bron, niet de korte pushmelding). Werkelijke
samenstelling week af van de aangeleverde samenvatting - postcss bleek geen open alert
(al op 8.5.26, ruim boven elke bekende kwetsbare grens); in plaats daarvan bleek `uuid`
tweemaal aanwezig (root + client), niet eerder genoemd.

**Gefixt: `uuid` (medium, GHSA-w5hq-g745-h8pq, `<11.1.1`).** Zowel root als client hadden
`uuid@8.3.2` als transitieve afhankelijkheid van `jayson` (zelf een afhankelijkheid van
`@solana/web3.js`, uitsluitend gebruikt voor `require('uuid').v4()` bij het genereren van
JSON-RPC-request-ID's - geverifieerd door `jayson`'s broncode zelf te lezen). Precies
gericht gefixt via een geneste `overrides`-regel (`"jayson": { "uuid": "^11.1.1" }`) in
beide `package.json`-bestanden, in plaats van een blanket-override die ook de al-veilige
`uuid@14.0.1` van `rpc-websockets` had geraakt. Geverifieerd: `npm ls uuid` toont nu
`uuid@11.1.1` onder `jayson`, `rpc-websockets` ongewijzigd op `14.0.1`. Functioneel getest
(niet alleen aangenomen) met een directe `jayson.utils.request()`-aanroep (geeft een geldige
uuid-v4-string) EN een echte devnet-RPC-round-trip via `Connection.getVersion()` - beide
slagen. `npm audit` in root: 0 kwetsbaarheden.

**Bewust NIET gefixt: `esbuild` (moderate, GHSA-67mh-4wv8-2f99) en `vite`** (drie alerts:
GHSA-4w7w-66w2-5vf9 - de uit sectie 20 al bekende - plus twee nieuwe, GHSA-v6wh-96g9-6wx3 en
GHSA-fx2h-pf6j-xcff, hoog). Gecontroleerd of de aanbevolen fix-versies (`esbuild@0.25.0`,
`vite@6.4.2`/`6.4.3`) binnen de huidige major vallen: nee - `npm audit` in `client/` geeft
zelf expliciet aan dat de fix `vite@8.2.1` vereist (nog verder dan de vite 6 uit sectie 20).
`esbuild` is bovendien geen losse afhankelijkheid maar een transitieve dependency die
`vite@5.4.21` zelf vastzet op `^0.21.3` - een geforceerde override naar 0.25.0 zou tegen
vite's eigen gedeclareerde bereik ingaan en een echt risico op build-/dev-server-breuk
vormen (esbuild's interne API is tussen die versies niet stabiel gebleven), dus dat is
geen "veilige losse patch" zoals bij `uuid`. Dit is dezelfde, al in sectie 20 bewust
uitgestelde situatie - een major-upgrade naar Vite 6+ blijft een aparte, apart geplande
taak, geen tussendoortje.

**De twee nieuwe vite-CVE's onderzocht (primaire advisory-tekst, niet aangenomen) - beide
blijken al net zo effectief gemitigeerd als de oorspronkelijke:** GHSA-v6wh-96g9-6wx3
(`launch-editor`, NTLM-hashlek via UNC-paden) vereist expliciet Windows EN een naar het
netwerk blootgestelde dev-server. GHSA-fx2h-pf6j-xcff (`server.fs.deny`-omzeiling via
NTFS-ADS/8.3-shortnames) vereist expliciet zowel Windows als "explicitly exposes the Vite
dev server to the network (using `--host` of `server.host`)". Beide zijn dus (a)
Windows-specifiek - dit ontwikkelmachine draait Linux - en (b) afhankelijk van precies de
netwerkblootstelling die sectie 20's `server.host: false`-fix al structureel onmogelijk
maakt. Het praktische aanvalsrisico blijft dus net zo gesloten als eerder vastgesteld,
ondanks dat de onderliggende versie niet gepatcht is.

**Zijdelings ontdekt, los van deze taak: `client`'s `npm run build` faalt momenteel** op
een TypeScript-strictheidsfout (`Uint8Array<ArrayBufferLike>` niet toewijsbaar aan
`BufferSource`, in `webauthnSign.ts`/`initWallet.ts`) - bevestigd PRE-BESTAAND en
losstaand van deze wijzigingen (identieke `typescript@5.9.3` in het lockfile voor en na
de uuid-fix). `npm run dev` (de dev-server zelf, geen `tsc`-stap) draait wel gewoon
(HTTP 200, geen `Network:`-blootstelling). Niet opgelost binnen deze taak - apart
gerapporteerd, geen scope-verruiming zonder overleg.

## 46. Doorbraak: de 72u-timelock is al gestart - op voorstel #5, niet #2. De "Solflare-deep-link-internalError" was vermoedelijk nooit een transportbug

Vervolg op sectie 44/45. Na het overstappen naar de Windows-pc (Wallet Standard/Phantom,
zoals besloten) kwam DEZELFDE `-32603`/"Unexpected error" nu OOK terug op zowel de
Windows-pc (Edge) als opnieuw de hoofdpc (Brave) - dus expliciet niet mobiel-/
Solflare-specifiek zoals eerder aangenomen. Beide logs toonden "Goedkeuren van
transactionIndex: 5", niet 2. Grondig on-chain onderzocht, niet aangenomen:

**Alle vijf bestaande voorstellen opgevraagd:**

| # | status | goedgekeurd door | aangemaakt door |
|---|--------|-------------------|-------------------|
| 1 | Active | 3zZcLwTX (1/2) | 3zZcLwTX (hoofdpc) |
| 2 | Active | 3zZcLwTX (1/2) | 3zZcLwTX (hoofdpc) |
| 3 | Active | CP2fg9zg (1/2) | CP2fg9zg (telefoon) |
| 4 | Active | CP2fg9zg (1/2) | CP2fg9zg (telefoon) |
| **5** | **Approved (2/2)** | **3zZcLwTX + CP2fg9zg** | CP2fg9zg (telefoon) |

**Voorstel #5 heeft de volledige 2-van-2-drempel al gehaald, om 2026-08-12T15:46:49Z** -
vermoedelijk tijdens een van de eerdere, als "mislukt" beschouwde telefoonpogingen, waarbij
de stem wél on-chain doorging maar de versleutelde antwoordaflevering apart faalde.
Geverifieerd dat #5 een legitiem, correct opgebouwd voorstel is (dezelfde canary-upgrade-
instructie, dezelfde buffer/programma/vault-accounts als alle andere duplicaten) - geen
kapot/corrupt voorstel.

**Root cause van waarom knop "3. Voorstel goedkeuren"/"4. Uitvoeren" naar #5 wees i.p.v.
#2, bevestigd in de code (geen nieuwe bug, bestaand ontwerp):** `buildApproveTx()` en
`buildExecuteTx()` lazen altijd het HUIDIGE/hoogste `transactionIndex` uit de multisig,
nooit een vastgepind specifiek voorstel. Zolang er maar een canoniek voorstel tegelijk
bestond werkte dat prima; zodra vanavond herhaaldelijk duplicaten ontstonden (secties 43-44)
dreef "huidig" weg van #2, en volgde elke latere klik automatisch het nieuwste voorstel.

**De -32603-fout zelf verklaard en rechtstreeks gereproduceerd via simulatie (niet
aangenomen):** een goedkeuringspoging op transactionIndex 5 (dat al "Approved" staat)
rechtstreeks tegen devnet gesimuleerd:
```
Error Code: InvalidProposalStatus. Error Number: 6008. "Invalid proposal status."
```
Het Squads-programma wijst terecht een stem af op een voorstel dat al niet meer "Active"
is - een volkomen onschuldige, verwachte afwijzing. Zowel Phantom als Solflare vertalen die
specifieke on-chain-fout kennelijk naar dezelfde generieke, onherkenbare "Unexpected
error"/"internalError" i.p.v. de daadwerkelijke reden te tonen - hetzelfde patroon als de
eerder gedocumenteerde premature-execute-poging in sectie 44. **Dit betekent dat de
uitgebreide sectie-44/45-conclusie "Solflare's deep-link-protocol heeft een niet-lokaal-
oplosbaar transportprobleem" vermoedelijk voorbarig was** - de eerdere mislukte
telefoonpogingen probeerden zeer waarschijnlijk dezelfde soort ongeldige herhaalde stem,
niet een kapotte encodering. Niet met 100% zekerheid met terugwerkende kracht vast te
stellen, en niet meer relevant om verder uit te zoeken nu de drempel al gehaald is.

**Praktisch gevolg: er is niets meer te goedkeuren.** De 72u-timelock loopt al en is
verstreken op **2026-08-15T15:46:49Z**. Voorstel #2 blijft onaangeroerd op 1-van-2 en is nu
irrelevant - #5 is functioneel identiek (dezelfde canary-upgrade) en al verder.

**Preventieve fix in `wallet-signer.html`, zodat dit type verwarring niet kan
terugkomen:** een nieuwe `checkProposalReadyForAction()`-controle, aangeroepen vanuit
zowel `buildApproveTx()` als `buildExecuteTx()`, die de status van het doelvoorstel VOORAF
opvraagt en een duidelijke Nederlandse melding geeft in plaats van de transactie te
versturen en op een cryptische walletfout te wachten:
- Goedkeuren op een niet-"Active"-voorstel: legt uit dat het al de vereiste goedkeuringen
  heeft en verwijst naar "4. Uitvoeren" na de timelock.
- Uitvoeren op een niet-"Approved"-voorstel: legt uit hoeveel goedkeuringen er nog
  ontbreken.
- Uitvoeren vóór het verstrijken van de timelock: toont het exacte uitvoerbaar-vanaf-
  tijdstip en de resterende tijd in uren.

Daarnaast toont de pagina nu meteen bij verbinden (`logCurrentProposalStatus()`) op welk
voorstel-nummer de knoppen zich richten en wat de status daarvan is - zodat dit nooit meer
pas via een mislukte poging ontdekt hoeft te worden. Build-markering opgehoogd
(`2026-08-12T16:05:00Z-proposal-status-preflight-check`), geverifieerd via `node --check`
en dat de server de bijgewerkte pagina serveert.

**Openstaand:** wachten tot 2026-08-15T15:46:49Z, daarna via `wallet-signer.html` (knop 4,
op elk apparaat met een geregistreerd lid) voorstel #5 uitvoeren, en daarna bevestigen via
`solana program show` + `solana program dump` (zelfde bewijspatroon als de repetitie in
sectie 41) dat de canary-bytecode daadwerkelijk is bijgewerkt.
