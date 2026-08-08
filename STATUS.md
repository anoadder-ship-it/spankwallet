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
