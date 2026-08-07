# SpankWallet — programma-scaffold (ongetest)

Gegenereerd op basis van ontwerpdocument v0.2 + Appendix A. **Niet gecompileerd, niet getest** —
dit sandbox-environment heeft geen Anchor/Solana-toolchain. Bouw en test lokaal voordat er iets
op devnet wordt gedeployed.

## Derde kritieke testbug: vaste seed-waarden botsen op devnet-persistentie

`anchor test` draait tegen **echt devnet** (`cluster = "devnet"` in `Anchor.toml`), niet een
lokale validator die na elke run resetted. Alle test-seed-keys waren tot nu toe vaste,
deterministische waarden (`dummySeedKey(1)`, `dummySeedKey(20)`, etc.) — dat werkte toevallig de
eerste keer, maar brak op twee manieren tegelijk:

1. **Cross-file botsing:** `recovery.ts` gebruikte per ongeluk dezelfde `fill=1` als de eerste
   test in `spankwallet.ts` — beide leiden dan dezelfde PDA af.
2. **Fundamenteler:** zelfs zonder die overlap zou **elke herhaalde `anchor test`-run** op den
   duur botsen met accounts die een eerdere run al permanent op devnet heeft achtergelaten.

Concrete fout: `Allocate: account ... already in use` bij een tweede/gebotste `init_wallet`-poging.

**Fix, bij de bron:** `dummySeedKey()` genereert nu **echte random bytes** (`crypto.randomBytes(33)`)
in plaats van een deterministische fill-waarde, in beide testfiles. Dit garandeert verse, unieke
PDA's bij elke testrun, ongeacht hoe vaak je het commando draait of hoeveel testfiles er zijn.
Bijkomende aanpassing: `finalize_recovery`'s laatste assertie vergelijkt nu met de `seedKey` die
`createWallet()` daadwerkelijk teruggeeft, niet met een opnieuw aangeroepen `dummySeedKey()` (die
zou met randomness natuurlijk nooit meer matchen).

## Overstap naar localnet: geen rate-limit-ruis meer, gratis, resettable

`Anchor.toml` draaide tot nu toe tegen **echt devnet** (`cluster = "devnet"`), met als gevolg:
veel `429 Too Many Requests`-ruis van het publieke, gratis devnet-RPC-endpoint (harmless —
`anchor test` retryt automatisch met exponential backoff — maar het maakte testruns 3-4x
trager: 35s i.p.v. 10s). Overgeschakeld naar `cluster = "localnet"` (en `[programs.devnet]` →
`[programs.localnet]`, Anchor's sectienaam-conventie per cluster). `anchor test` start nu
automatisch een lokale `solana-test-validator`, deployt en test daartegen, en sluit hem af —
geen externe netwerkcalls meer, dus geen rate-limits, en elke run begint met verse, lege state
(waardoor devnet-persistentie sowieso geen rol meer speelt).

**Bijkomend effect:** de eerder toegevoegde `crypto.randomBytes(33)`-fix in de tests (tegen
devnet-persistentie-botsingen) is nu strikt genomen overbodig — een lokale validator reset
sowieso bij elke run. Bewust laten staan: het is nog steeds goede praktijk (test-isolatie
binnen één run, geen afhankelijkheid van uitvoeringsvolgorde tussen `it()`-blokken), en de
kleine overhead is verwaarloosbaar.

**Consequentie:** `anchor deploy`/`anchor test` deployt niet langer automatisch naar echt
devnet. Voor een daadwerkelijke devnet-deploy (nodig zodra de browser-passkey-pagina er is en
er een publiek toegankelijk endpoint nodig is) moet straks weer expliciet
`anchor deploy --provider.cluster devnet` gebruikt worden, of `Anchor.toml` tijdelijk terug.

## Structuur

```
spankwallet/
├── Anchor.toml
├── Cargo.toml
├── programs/spankwallet/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs           — entrypoint, koppelt instructies
│       ├── state.rs         — WalletAccount, VaultAccount, RecoveryState
│       ├── errors.rs        — custom error codes
│       └── instructions.rs  — init_wallet, execute, hunt, recovery-flow
```

## Eerste lokale stappen

```bash
cd spankwallet
anchor build
anchor keys list        # echte program-ID ophalen
# vervang declare_id!() in lib.rs én Anchor.toml [programs.devnet] met deze ID
anchor build             # opnieuw, met correcte ID
```

## Tweede build-poging: 1 nieuwe fout + cosmetische cfg-warnings opgeschoond

Na de crate-verhuizingen (vorige sectie) compileerde alles behalve één regel:
`solana_keccak_hasher::Hash`'s tuple-veld `.0` bleek **privé** in deze versie (was publiek in
de oude `solana_program::keccak::Hash`). Gefixed door `.as_ref()` te gebruiken in plaats van
`.0` — dat steunt op de `AsRef<[u8]>`-trait die vrijwel universeel op Solana-hash-types
geïmplementeerd is, in plaats van op een aanname over de interne representatie.

**Nog te bevestigen bij de volgende build:** of `AsRef<[u8]>` daadwerkelijk voor dit type
geïmplementeerd is — vrij zekere gok, maar niet 100% geverifieerd zonder compileren.

Daarnaast de drie `unexpected_cfgs`-waarschuwingen (`custom-heap`, `custom-panic`,
`anchor-debug`) onderdrukt via `[lints.rust]` in `programs/spankwallet/Cargo.toml`. Dit is
puur cosmetisch — de onderliggende oorzaak zit in hoe Anchor's macro's interne cfg-vlaggen
genereren die niet als geldige feature bij `solana-program-entrypoint` staan aangemeld, niets
wat wij hebben veroorzaakt of dat de werking beïnvloedt. `cargo update` is bewust *niet*
uitgevoerd: dat zou de zorgvuldig uitgezochte gepinde versies (vorige sectie) weer kunnen laten
schuiven voordat we zeker weten dat de huidige combinatie volledig werkt.

De eerste build met de native ARM64-toolchain (Agave v4.1.2 + Anchor 1.1.2) faalde met 3
fouten, allemaal met dezelfde oorzaak: **`solana-program` is bij deze dependency-resolutie
opgesplitst in losse micro-crates**, en de oude paden onder `anchor_lang::solana_program::...`
bestaan zo niet meer voor deze functies:

1. `load_instruction_at_checked` / `ID` / `load_current_index_checked` zaten niet meer onder
   `anchor_lang::solana_program::sysvar::instructions::*` — verplaatst naar de losse crate
   `solana-instructions-sysvar`. Gefixed door die crate expliciet toe te voegen aan
   `Cargo.toml` en er rechtstreeks uit te importeren.
2. `anchor_lang::solana_program::keccak::hashv` bestond niet meer op dat pad — verplaatst naar
   `solana-keccak-hasher`. Zelfde aanpak: expliciete dependency + directe import.
3. Als bijvangst ook de deprecation-warnings opgelost: `AccountInfo<'info>` voor
   `instructions_sysvar` en `token_mint` vervangen door het door Anchor aanbevolen
   `UncheckedAccount<'info>` (met `.to_account_info()` op de aanroepplekken waar het als
   `&AccountInfo` doorgegeven wordt).

**Nog te bevestigen bij de volgende build:** of `solana_keccak_hasher::Hash` nog steeds een
publiek tuple-veld `.0` heeft zoals de oude `solana_program::keccak::Hash` — dat wordt pas
zeker als de volgende `anchor build` ook echt door de keccak-regel heen compileert.

Anchor is overgenomen door OtterSec en zit sinds kort op een 1.x-lijn, met een Anchor 1.0.0
die bewuste breaking changes bevat t.o.v. de 0.3x-serie waar deze scaffold oorspronkelijk op
gepind was. Twee daarvan raakten deze codebase direct en zijn al gefixed:

1. **`[registry]`-sectie in `Anchor.toml`** wordt niet meer herkend sinds 1.0.0 — verwijderd.
2. **`CpiContext::new`/`new_with_signer` neemt een `Pubkey` (programma-ID) in plaats van een
   `AccountInfo`** — de oude redundante kopie van het programma-account in `CpiContext` is
   verwijderd. Beide aanroepen in `hunt` (burn + close) zijn aangepast naar `Token::id()`.

**Nog niet met zekerheid gevalideerd** (kan pas na een echte `anchor build`): of er nog meer
1.0-breaking-changes zijn die deze scaffold raken buiten de twee hierboven — de release notes
noemen ook wijzigingen aan `#[interface]`/discriminators en IDL-instructies die in dit programma
niet gebruikt worden en dus waarschijnlijk niet relevant zijn, maar "waarschijnlijk niet relevant"
is geen vervanging voor een groene build. Dit is het eerste dat de eerste `anchor build` moet
bevestigen.

`WalletAccount` had oorspronkelijk zijn PDA geseed op `owner_passkey`. Omdat `finalize_recovery`
precies dat veld muteert, zou de PDA na een recovery niet meer terugvindbaar zijn op zijn eigen
seeds — een wallet zou zichzelf onbereikbaar maken zodra recovery ooit gebruikt wordt. Opgelost
door een apart, onveranderlijk `seed_key`-veld te introduceren (zie `state.rs`), losgekoppeld van
het muterende `owner_passkey`. Dit soort fouten is precies waarom er eerst een lokale build +
testsuite moet draaien voordat dit richting devnet gaat, laat staan mainnet.

## Derde build-poging: programma compileert volledig — alleen IDL-generatie miste een feature

`spankwallet v0.1.0` compileerde in 8.84s zonder fouten ("Finished `release` profile
[optimized] target(s)") — de kern van de code is nu correct. De enige resterende melding kwam
van Anchor's eigen IDL-generatiestap, die een `idl-build`-feature-declaratie in `Cargo.toml`
verwacht. Toegevoegd zoals de foutmelding zelf al exact aangaf:
`idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]`. Dit is standaard Anchor-
boilerplate, geen inhoudelijke wijziging aan de programmalogica.

## Twee dingen gefixt bij het uitwerken van de precompile-verificatie

1. **Ontbrekende message-binding.** De eerste versie van `verify_passkey_signature` checkte alleen
   of de verwachte publieke sleutel ergens in de precompile-instructiedata voorkwam — niet of het
   *ondertekende bericht* aan déze specifieke instructie-aanroep gebonden was. Zonder die binding
   zou een geldige oude passkey-handtekening (bv. van een `execute`-aanroep) hergebruikt kunnen
   worden om een andere instructie te autoriseren, zolang de publieke sleutel maar klopte. Opgelost
   met `build_expected_message` (domain-separated keccak-hash over program-ID, wallet, instructie-
   domain en payload) en een expliciete vergelijking van het daadwerkelijk ondertekende bericht.
2. **Ontbrekende lifetime-parameter.** `AccountInfo` vereist een expliciete lifetime in
   functiesignaturen (`AccountInfo<'_>`) — dit compileert niet zonder, in tegenstelling tot velden
   in een `#[derive(Accounts)]`-struct waar Anchor dat impliciet regelt.

## KRITIEKE BUG gevonden bij eerste testrun: PDA-seed overschreed Solana's 32-byte-limiet

**Dit was geen kleinigheid — dit was een ontwerpfout die sinds v0.1 in de code zat en die
`anchor build` niet kon vangen.**

Solana's PDA-seeds hebben een harde limiet van **32 bytes per los seed-component**
(`MAX_SEED_LEN`). `seed_key` — de gecomprimeerde secp256r1-publieke sleutel — is **33 bytes**
(1 byte parity-prefix + 32 bytes X-coördinaat). Overal waar `seeds = [b"wallet",
wallet.seed_key.as_ref()]` stond, werd die limiet met precies 1 byte overschreden.

**Waarom dit niet eerder opviel:** PDA-seeds worden pas *runtime* geëvalueerd, niet
statisch gecontroleerd door de Rust-compiler. `anchor build` compileerde dus prima. Pas toen
de TypeScript-client voor het eerst zelf een PDA probeerde te berekenen (`findProgramAddressSync`),
gooide `@solana/web3.js` de fout `TypeError: Max seed length exceeded`. Als dit script
rechtstreeks naar devnet was gedeployed en pas bij een handmatige `init_wallet`-aanroep was
getest, was dit exact hetzelfde probleem geweest — de testsuite ving het nu vroeg op, precies
waarom er een testsuite moet zijn vóór devnet.

**Fix:** een nieuw veld `wallet_seed_hash: [u8; 32]` op `WalletAccount`, gevuld met de SHA-256-
hash van `seed_key` (altijd exact 32 bytes). `seed_key` blijft bewaard als onveranderlijk
identiteitsveld, maar alle PDA-derivatie (`seeds = [...]`) gebruikt nu `wallet_seed_hash` in
plaats van de ruwe 33-byte sleutel. Zowel `hash_seed_key()` in `instructions.rs` als de
TypeScript-test (`tests/spankwallet.ts`) berekenen deze hash nu identiek via SHA-256, zodat
client en programma exact dezelfde PDA-adressen afleiden.

**Consequentie voor de client-extension (fase 1, nog te bouwen):** dit is een harde vereiste
die nu vastligt — de browser-extension moet bij het opbouwen van elke transactie ook
`SHA-256(seed_key)` berekenen om de juiste `WalletAccount`-PDA te vinden, niet de ruwe
passkey-publieke-sleutel gebruiken.

`tests/spankwallet.ts` bevat drie tests, allemaal alleen tegen `init_wallet` — die instructie
vereist geen passkey-handtekening (de payer tekent als gewone Anchor `Signer`), dus een dummy
33-byte "seed key" is hier legitiem en test uitsluitend de account-/PDA-aanmaaklogica:

1. WalletAccount + VaultAccount worden aangemaakt met correcte default-waarden (seed_key ==
   owner_passkey bij aanmaak, recovery_state leeg, timelock = 259200s, deposit_authority None)
2. een expliciete `recovery_timelock_seconds` overschrijft de default correct
3. een tweede `init_wallet`-aanroep met dezelfde seed_key faalt (PDA bestaat al)

**Nog niet getest, met opzet:** `execute`, `hunt`, `cancel_recovery` — die vereisen een echte
secp256r1-precompile-instructie met een daadwerkelijke WebAuthn-passkey-handtekening, wat een
losstaande testopzet nodig heeft (zie punt 1 hierboven in "Wat nog écht werk is").

**TS-client-versierisico bleek geen probleem:** `@coral-xyz/anchor ^0.31.1` deployt en spreekt
prima met het `anchor-lang 1.1.2`-programma — de eerste twee tests draaiden succesvol
(account-aanmaak + tweede-init-faalt), inclusief correcte account-fetches met de gegenereerde
IDL-typen. Wel een aparte breaking change ontdekt: **`anchor.BN` bestaat niet meer als export**
sinds Anchor 0.31 (bevestigd via solana-foundation/anchor issue #3711 en gerelateerde reports).
Gefixed door `bn.js` als expliciete dependency toe te voegen en `BN` daar rechtstreeks uit te
importeren (`import BN from "bn.js"`) in plaats van via `anchor.BN`.

## Tweede kritieke bug: `idl-build`-compilatiepas kon berekende seeds niet analyseren (E0425)

Na de PDA-seed-lengte-fix (vorige sectie) faalde de build opnieuw, maar nu specifiek in
Anchor's **aparte `idl-build`-compilatiepas** (die draait met een extra feature-flag om de
IDL/TS-typen te genereren, los van de normale programma-build): `error[E0425]: cannot find
value 'seed_key' in this scope`, op de regel `seeds = [b"wallet", hash_seed_key(&seed_key).as_ref()]`.

**Oorzaak:** Anchor's IDL-generatiemacro kan berekende seeds — een functie-aanroep die een
instructie-argument gebruikt — niet statisch analyseren. De normale build accepteerde dit
prima; de IDL-pas verloor daarbij de scope van `seed_key` volledig. Dit is een bekende
beperking van Anchor's IDL-macro, geen fout in onze hash-logica zelf.

**Fix:** de hash-berekening uit de `seeds`-macro gehaald. In plaats van `hash_seed_key(&seed_key)`
inline aan te roepen, wordt `wallet_seed_hash: [u8; 32]` nu een **apart, expliciet
instructie-argument** dat de client zelf berekent en meestuurt — een simpele argument-
verwijzing zonder functie-aanroep, wat Anchor's IDL-macro wél kan analyseren. Om te voorkomen
dat een verkeerd berekende hash van de client zomaar geaccepteerd wordt, verifieert
`init_wallet` nu zelf on-chain via `require!` dat `wallet_seed_hash == hash_seed_key(&seed_key)`
— geen cross-user beveiligingsrisico (iedereen kiest zijn eigen seed_key/hash-paar), maar wel
een harde afvanging van gebruikersfouten.

**Consequentie voor de client-extension:** dit is nu een expliciet, verplicht onderdeel van de
`init_wallet`-aanroep-flow, niet iets wat het programma zelf afleidt.

## Recovery-flow tests toegevoegd (tests/recovery.ts) — alle 3 init_wallet-tests + 5 nieuwe slagen

`initiate_recovery` en `finalize_recovery` vereisen geen passkey-handtekening (`initiate_recovery`
tekent met de gewone Ed25519 `backup_authority`-Signer, `finalize_recovery` is permissionless),
dus konden net als `init_wallet` al getest worden vóórdat er een echte WebAuthn-passkey nodig is.

Belangrijke aanpassing t.o.v. de opzet: `Anchor.toml` heeft `cluster = "devnet"`, dus `anchor
test` draait tegen **echt devnet**, niet een lokale validator — de klok kan dus niet kunstmatig
vooruitgezet worden om de 72u-default-timelock te testen. Opgelost door voor de
timelock-specifieke tests een kort, expliciet aangepaste `recovery_timelock_seconds` (3-10s) mee
te geven aan `init_wallet` en de test daadwerkelijk (kort) te laten wachten — geen clock-mocking,
gewoon echte verstreken tijd, wat op zowel devnet als een lokale validator werkt.

5 tests: recovery_state correct gezet na initiate, faalt bij verkeerde backup_authority, faalt
bij dubbele initiate (RecoveryAlreadyInProgress), finalize faalt vóór afloop tijdslot, finalize
slaagt ná afloop en muteert owner_passkey correct (met expliciete check dat seed_key daarbij
ongewijzigd blijft — een regressietest voor de eerder gevonden PDA-adresseringsbug).

**Nog steeds niet getest:** `cancel_recovery` (het owner-veto) — die vereist wél de
secp256r1-precompile net als `execute`/`hunt`, en wacht dus op de browser-passkey-testpagina.

## KRITIEKE ARCHITECTUURBEVINDING vóór de browser-passkey-testpagina: WebAuthn signeert niet onze rauwe bytes

Voordat de browser-testpagina gebouwd wordt, moet dit eerst worden opgelost — anders bouwen we
een pagina die *nooit* kan slagen, hoe correct de rest ook is.

**Het probleem:** `verify_passkey_signature` vergelijkt momenteel `actual_message` (de bytes die
de secp256r1-precompile daadwerkelijk verifieerde) met `expected_message` — de output van
`build_expected_message()`, een simpele `keccak(program_id || wallet || domain || payload)`.
Maar een **echte WebAuthn-passkey ondertekent nooit rauwe applicatie-bytes**. Bij elke
`navigator.credentials.get()`-aanroep signeert de authenticator altijd exact:

```
authenticatorData (variabele lengte: rpIdHash + flags + counter + evt. extensies)
  || SHA-256(clientDataJSON)
```

waarbij `clientDataJSON` een JSON-blob is met daarin (als base64url) onze `challenge` — dat is
de enige plek waar wij als applicatie iets kunnen inbrengen. Het daadwerkelijk ondertekende
bericht is dus altijd deze samengestelde WebAuthn-blob, nooit onze kale `build_expected_message`-
hash rechtstreeks. Een exacte byte-vergelijking zoals we nu hebben zal dus **per definitie nooit
slagen** met een echte passkey, ongeacht hoe correct de rest van de implementatie is.

**Wat er moet gebeuren (nog niet geïmplementeerd):**
1. De client stuurt niet alleen de signature/pubkey/message via de precompile-instructie, maar
   ook de rauwe `clientDataJSON`-bytes mee in de transactie (extra instructie-argument of
   los meegegeven data).
2. Het programma herberekent zelf `SHA-256(clientDataJSON)`, parst — of matcht op vaste offset —
   het `challenge`-veld eruit, en controleert dat die exact overeenkomt met
   `build_expected_message(...)`.
3. Het programma controleert vervolgens dat `actual_message` (uit de precompile) daadwerkelijk
   gelijk is aan `authenticatorData || SHA-256(clientDataJSON)` — dit is de eigenlijke binding.

Dit is precies het probleem dat LazorKit en Blueshift's referentie-implementaties al hebben
opgelost — voordat de browser-testpagina gebouwd wordt, is het verstandig om hun exacte
`clientDataJSON`-parsing-aanpak als referentie te bekijken in plaats van dit blind zelf opnieuw
te ontwerpen.

## Wat nog écht werk is voordat dit iets voorstelt

1. **`verify_passkey_signature` in `instructions.rs`** — nu een volledige implementatie van de
   SIMD-0075 wire-layout (offsets-struct, pubkey-check, én message-binding via
   `build_expected_message`), **maar nog op geen enkele manier getest tegen een echte
   WebAuthn-passkey-handtekening**. De layout is overgenomen uit de officiële SIMD-0075-spec en
   Blueshift's referentiedocumentatie, maar dat garandeert niet dat de client-side
   handtekening-constructie (welke exacte bytes de passkey daadwerkelijk ondertekent, en hoe die
   in de transactie-instructies terechtkomen) hier één-op-één op aansluit. Eerste concrete
   testdoel: een `init_wallet` + `execute` roundtrip op devnet met een echte browser-passkey.
2. **`execute`** — de daadwerkelijke CPI-uitvoering (`invoke_signed`) is nog een no-op placeholder.
   Eerste concrete use case (kale SOL-transfer) moet uitgewerkt en getest worden.
3. **Tests gedeeltelijk aanwezig** — `init_wallet` heeft nu 3 tests (zie sectie hierboven).
   `execute`, `hunt`, `initiate_recovery`, `cancel_recovery`, `finalize_recovery` hebben nog
   geen enkele test, en `execute`/`cancel_recovery` kunnen pas getest worden zodra er een echte
   secp256r1-passkey-handtekening beschikbaar is (zie punt 1).
4. **`initiate_recovery`-event** — `emit!()` voor het watcher-notificatie-endpoint (§3.1b) is nog
   niet toegevoegd.
5. **Client-side (browser-extension)** — nog niet gestart. Ontwerpdocument §4. De client moet nu
   ook precies weten welk bericht de passkey moet ondertekenen: `keccak(program_id || wallet ||
   domain || payload)` zoals gedefinieerd in `build_expected_message` — dit is de tegenhanger die
   in de extension geïmplementeerd moet worden, exact bytes-voor-bytes gelijk.
6. **Kleinere aanscherping, niet blokkerend:** `Hunt` vertrouwt op de SPL Token-program-eigen
   controle dat `vault` daadwerkelijk de owner van `target_token_account` is (de CPI faalt anders
   vanzelf) — een expliciete Anchor-`constraint` zou een duidelijkere foutmelding geven, maar is
   geen veiligheidsgat.

## Wat hier bewust nog niet in zit

- Fase 2 (fee-gated inbox / `gated_deposit`) — `deposit_authority`-veld staat al in `state.rs`
  klaar, maar de instructie zelf is niet geïmplementeerd. Zie ontwerpdocument §3.3 en §5.
- Fase 3 (USB 2-of-2, post-quantum signing) — geen enkele voorbereiding, met opzet.
