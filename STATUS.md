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
