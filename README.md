# SpankWallet

Non-custodial Solana wallet met **passkey-authenticatie** (WebAuthn / secp256r1) in plaats van seed phrases.

- Passkey i.p.v. seed phrase, met optioneel meerdere gelijkwaardige passkeys per wallet
- Tijdelijke, gescopede **session keys** (LazorKit-geïnspireerd, slot-gebonden expiry) voor dApp/game-gebruik zonder herhaalde WebAuthn-prompts (zie de kanttekening onder de ontwerpprincipes)
- Programma-allowlist: gecontroleerde CPI naar externe programma's, uitsluitend naar zelf goedgekeurde programma-ID's
- Anti-spam: `hunt` burnt/sluit ongevraagde spam-tokens, teruggewonnen rent 50/50 gesplitst tussen de hunter en Solana's incinerator-adres (permanent uit omloop)
- Recovery via offline Ed25519 backup-authority met 72u-timelock + owner-veto
- **Gesloten, getypeerde acties** - geen open CPI-doorgeefluik

> **STATUS.md** is de primaire bron van waarheid voor voortgang, gotchas en beslissingen.
> Lees die eerst als je het project hervat - dit README geeft alleen het overzicht.

## Huidige staat (augustus 2026)

| Onderdeel                          | Status                                                          |
|-------------------------------------|-------------------------------------------------------------------|
| init_wallet                        | Bewezen end-to-end (echte hardware-passkey + Phantom, devnet)  |
| execute (= transfer_sol)           | Bewezen end-to-end op devnet                                    |
| transfer_token                     | Bewezen end-to-end op devnet (echte devnet-USDC)                |
| hunt                                | Bewezen, incl. 50/50-rentsplitsing, ook tegen extern devnet-USDC |
| Recovery-flow                       | Volledig bewezen (initiate / cancel / finalize)                |
| Programma-allowlist + execute_advanced | Bewezen end-to-end op devnet (add/remove_allowed_program)   |
| WebAuthn-hardening                  | UV-vlag afgedwongen + expliciete type-validatie, bevestigd op devnet |
| Multi-passkey                       | Bewezen end-to-end op devnet (meerdere gelijkwaardige sleutels, lockout-bescherming) |
| Session keys                        | Bewezen end-to-end op devnet (slot-gebonden expiry, scope-beperking, permissionless cleanup) |
| Browser-testpagina                  | Werkend (Vite + Wallet Standard), 20 teststappen                |
| Open CPI / arbitrary instructions   | Bewust verwijderd (zie STATUS.md sectie 25-26)                  |
| Tauri-desktop-migratie (fase 0)      | In ontwikkeling: skeleton, fee-payer (Stronghold), execute_action en passkey-backend (ctap-hid-fido2) gebouwd; echte hardware-ceremonie met de nieuwe backend nog niet bewezen (zie STATUS.md sectie 72/74/75) |

**Program ID (devnet):** 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9

### execute naar transfer_sol (belangrijke ontwerpwijziging)

De oorspronkelijke execute accepteerde willekeurige cpi_instruction_data en was daarmee
een open CPI-doorgeefluik: wie een geldige passkey-handtekening kon produceren, kon de vault
laten interacteren met elk programma, elke instructie ("Arbitrary CPI" - een erkende
kwetsbaarheidsklasse). Dat is verwijderd.

execute is nu een gesloten, getypeerde actie:

```rust
pub fn execute(
    ctx: Context<Execute>,
    amount: u64,               // + recipient via accounts
    client_data_json: Vec<u8>,
) -> Result<()>
```

- Challenge-payload bindt expliciet recipient + amount
- Alleen SOL-transfer vanuit de vault mogelijk
- Directe lamport-manipulatie (geen externe CPI nodig)
- Rent-exempt-drempelbewaking (de vault kan nooit onder zijn eigen minimum zakken)
- Arbitrary CPI bestaat structureel niet meer voor deze instructie

transfer_token volgt exact hetzelfde principe: een gesloten, getypeerde actie met een eigen
challenge-domain, zonder generieke CPI, werkend voor elke SPL-token (zBTC, BTCSOL, USDC, etc.)
zonder per-munt-configuratie. Wie wel bredere, programmatische controle nodig heeft, gebruikt
`execute_advanced` - dat mag WEL een CPI doen naar een extern programma, maar uitsluitend naar
een programma-ID dat de wallet-eigenaar zelf, met zijn eigen passkey, vooraf op zijn eigen
allowlist heeft gezet (`add_allowed_program`). Zie STATUS.md sectie 25-27 voor de volledige
motivatie en ontwerpafwegingen.

## Instructies

Alle instructies hieronder staan in `programs/spankwallet/src/lib.rs`. "Handtekening" is wie
de actie mag autoriseren: een echte WebAuthn-passkey (via de secp256r1-precompile), de
offline Ed25519 backup-authority, een tijdelijke session key (gewone Ed25519-transactiesigner,
geen WebAuthn), of permissionless (door wie dan ook aanroepbaar, on-chain-gate doet het werk).

| Instructie                    | Handtekening                        | Beschrijving                                                        |
|--------------------------------|--------------------------------------|-----------------------------------------------------------------------|
| init_wallet                    | Passkey                              | Wallet + Vault-PDA aanmaken                                          |
| execute                        | Passkey                              | SOL-transfer (getypeerd)                                             |
| transfer_token                 | Passkey                              | SPL-token-transfer (getypeerd, munt-onafhankelijk)                  |
| add_allowed_program             | Passkey                              | Programma-ID toevoegen aan de wallet-eigen allowlist                |
| remove_allowed_program          | Passkey                              | Programma-ID verwijderen van de allowlist                           |
| execute_advanced                | Passkey                              | Permanent geblokkeerd voor directe aanroep - CPI loopt via initiate_/finalize_advanced_action |
| hunt                            | Passkey                              | Spam-token burnen + account sluiten (50/50 rent)                    |
| initiate_withdrawal              | Passkey                              | SOL-opname aankondigen (queued, timelock) - opent PendingAction (kind=SolWithdrawal) |
| finalize_withdrawal              | Passkey                              | Aangekondigde SOL-opname afronden, ná de timelock                    |
| cancel_action                    | Passkey                              | Een openstaande PendingAction annuleren, ongeacht kind/staat/timelock |
| initiate_token_transfer          | Passkey                              | SPL-token-overdracht aankondigen (queued, timelock) - opent PendingAction (kind=TokenTransfer) |
| finalize_token_transfer          | Passkey                              | Aangekondigde SPL-token-overdracht afronden, ná de timelock          |
| initiate_advanced_action         | Passkey                              | CPI naar een toegestaan programma aankondigen (queued, timelock) - opent PendingAction (kind=AdvancedAction) |
| finalize_advanced_action         | Passkey                              | Aangekondigde CPI afronden, ná de timelock                            |
| initiate_threshold_change        | Passkey                              | Wijziging van spend_threshold_lamports/window_total_cap_lamports aankondigen (queued, timelock) - opent PendingAction (kind=ThresholdChange) |
| finalize_threshold_change        | Passkey                              | Aangekondigde drempelwijziging afronden, ná de timelock               |
| add_passkey                     | Een van de al geldige passkeys        | Extra, gelijkwaardige passkey registreren (multi-passkey)           |
| remove_passkey                  | Een van de al geldige passkeys        | Passkey intrekken (lockout-beschermd: nooit de laatste verwijderen) |
| initiate_recovery                | Backup authority                     | Recovery starten                                                    |
| cancel_recovery                 | Passkey (owner-veto)                  | Recovery annuleren; de handtekening is gebonden aan precies deze recovery-poging (momentopname van de nonce bij de start, niet de live nonce) |
| finalize_recovery                | Permissionless (na timelock)          | Recovery afronden: wist alle extra passkeys, maakt bestaande sessiesleutels ongeldig (epoch-verhoging, sluit ze niet), verhoogt de action_nonce |
| add_session_key                  | Een van de al geldige passkeys        | Tijdelijke session key registreren (scope + slot-gebonden expiry)   |
| remove_session_key               | Een van de al geldige passkeys        | Session key vroegtijdig intrekken                                    |
| close_session                    | De session key zelf                   | Eigen sessie zelf sluiten, rent terug (enige zelfstandige actie)     |
| close_expired_session             | Permissionless (na expiry_slot)       | Verlopen sessie opruimen, rent naar de aanroeper                    |
| execute_via_session               | De session key zelf                   | SOL-transfer via een tijdelijke, gescopede sessiesleutel             |
| transfer_token_via_session         | De session key zelf                   | SPL-token-transfer via een tijdelijke, gescopede sessiesleutel       |
| execute_advanced_via_session       | De session key zelf                   | Permanent geblokkeerd - een sessie kan een CPI alleen initiëren in de wachtrij |
| initiate_advanced_action_via_session | De session key zelf                 | CPI aankondigen in de PendingAction-wachtrij (kind=AdvancedAction); geen CPI, geen nonce |
| confirm_pending_action            | Passkey                               | Een door een sessie geïnitieerde actie bevestigen; de timelock start hier. Weigert als de initiërende sessie ingetrokken of verlopen is |
| freeze_via_passkey                | Passkey                               | Wallet bevriezen (noodstop); weigert als de wallet al bevroren is  |
| freeze_via_backup_authority       | Backup authority                      | Wallet bevriezen (noodstop), idempotent; werkt ook tijdens een lopende recovery |
| unfreeze_via_backup_authority     | Backup authority                      | Direct ontdooien; kan in dezelfde instructie passkeys verwijderen (zie Veiligheidsprincipes); weigert tijdens een lopende recovery |
| initiate_unfreeze                 | Passkey                               | Ontdooien aankondigen (queued, timelock) - opent PendingAction (kind=Unfreeze) |
| finalize_unfreeze                 | Passkey                               | Aangekondigd ontdooien afronden, ná de timelock (2-van-2 bij ≥2 passkeys) |

## Structuur

```
spankwallet/
programs/spankwallet/       - Anchor-programma (Rust)
  src/lib.rs                 - #[program]-entrypoints (35 instructies)
  src/state.rs                - WalletAccount, VaultAccount, RecoveryState, PolicyAccount,
                                 PasskeysAccount, SessionKeyAccount, PendingAction, SpendWindow
  src/instructions.rs          - alle instructielogica + gedeelde verificatiehelpers
  src/errors.rs
client/                      - Vite/TS-testpagina (passkey + Phantom), 20 teststappen
  src/main.ts                  - de testpagina zelf (stap 1-20)
  src/passkey.ts, cbor.ts       - passkey aanmaken + rauwe publieke sleutel decoderen
  src/webauthnSign.ts, secp256r1.ts - WebAuthn-assertie + secp256r1-precompile-instructie
  src/wallet.ts                 - Wallet Standard-verbinding (Phantom e.d.)
  src/challenge.ts               - gedeelde challenge-/Borsh-encodeerhelpers
  src/programId.ts                - SPANKWALLET_PROGRAM_ID-constante
  src/polyfill.ts                  - Buffer-polyfill, moet als allereerste module laden
  src/initWallet.ts, execute.ts, transferToken.ts, hunt.ts, recovery.ts - kerninstructies
  src/policy.ts                  - programma-allowlist (add/remove_allowed_program)
  src/executeAdvanced.ts          - execute_advanced (CPI naar toegestane programma's)
  src/passkeys.ts                 - multi-passkey (add/remove_passkey)
  src/sessionKeys.ts               - session keys, alle 7 instructies
tests/                        - Anchor-tests (121 passing, 112 pending, 0 failing - `npm test`, 2026-09-25)
  spankwallet.ts                 - init_wallet
  policy.ts                       - programma-allowlist + execute_advanced
  passkeys.ts                      - multi-passkey + finalize_recovery-wipe
  recovery.ts                       - recovery-flow
  transferToken.ts                   - transfer_token + B6 challenge-binding aan vault_token_account
  hunt.ts                             - hunt (spam-token burnen + account sluiten)
  actionNonce.ts                       - action_nonce-mechanica (C-1-fix, sectie 69)
  replay_execute.ts                     - permanente regressietest tegen replay (C-1-fix)
  pendingAction.ts                       - queued/timelock PendingAction-flow (withdrawal/token-transfer/advanced-action)
  spendThreshold.ts                       - spend_threshold_lamports (drempel-mechanisme, sectie 127/128)
  spendWindow.ts                           - window_total_cap_lamports (glijdende-window spend-cap, sectie 132/133)
  thresholdChangePanel.ts                   - initiate/finalize_threshold_change + UI-panel pure-logica (sectie 135)
  thresholdBanner.ts                         - drempel-statusbanner, pure-logica + DOM-effectkant (sectie 127-129)
  migrateWalletAccountValidator.ts             - eigen test-validator met vooraf geplaatste accounts (gebruikt door cancelActionLegacyLayout.ts)
  cancelActionLegacyLayout.ts                   - cancel_action op een PendingAction in de oude 124-byte-layout
  sessionKeys.ts                     - session keys, alle 7 instructies
  addSessionKeyBlock.ts               - tijdelijke client-blokkade op execute_advanced-sessies
  uint8ArrayByteFidelity.ts           - bytegetrouwheid WebAuthn/Web-Crypto-tekenpad (sectie 78)
  writability_check.ts                 - audit: session-PDA isWritable in execute_via_session
  verifyBinaryFresh.ts                  - build-versbewijs (geen stale binary, sectie 76/77)
  verifyValidatorType.ts                 - structurele validator-type-detectie
  m2_fix_verify.ts                        - M-2-fix-verificatie tegen de echte productieclient
  webauthnTestHelper.ts               - gedeelde testhelpers (o.a. slot-/tijd-advancers)
desktop/                      - Tauri-desktop-migratie (fase 0, native, extensie-vrije runtime,
                                 zie desktop/README.md + STATUS.md sectie 72/74/75)
  src-tauri/src/passkey_ctap.rs  - passkey-ceremonie (ctap-hid-fido2, rechtstreeks CTAP2/HID)
  src-tauri/src/execute.rs       - execute_action (onafhankelijke challenge-herberekening + tx-opbouw)
  src-tauri/src/fee_payer.rs     - lokaal, Stronghold-versleuteld fee-payer-keypair
  src-tauri/src/challenge.rs      - Rust-poort van challenge-/action-nonce-logica
  src-tauri/src/secp256r1.rs      - DER->raw-low-S + secp256r1-precompile-instructie
  src/main.ts, passkey.ts, webauthn.ts, executeAction.ts - frontend-orchestratie
scripts/
STATUS.md                     - lees dit eerst
SECURITY.md
```

## Lokaal bouwen en testen

```bash
# 1. Toolchain (ARM64: Agave + Anchor from source - zie STATUS.md voor de volledige uitleg)
export PATH="$HOME/projects/agave/bin:$PATH"

# 2. Lokale validator, in een EIGEN terminal-tab die je verder met rust laat
solana-test-validator --reset --gossip-port 8001

# 3. Bouwen + deployen (gebruik altijd het script, nooit los cargo-build-sbf zonder --arch v3)
./scripts/build-and-deploy.sh --clean

# 4. Tests
anchor test --skip-local-validator --skip-deploy
```

### Deployen naar devnet (voor browser-tests met een echte wallet-extensie)

Belangrijk: wallet-extensies zoals Phantom kunnen niet bij een lokale validator
(127.0.0.1) - hun eigen achtergrondinfrastructuur simuleert/verstuurt transacties via een
publiek bereikbaar RPC-endpoint, nooit via loopback. Voor elke test die een echte
wallet-extensie gebruikt, moet het programma dus op devnet staan (zie STATUS.md sectie 13
voor de volledige diagnose van dit probleem).

**De upgrade-authority is sinds STATUS.md sectie 42 een Squads V4-multisig (2-of-3, 72u-
timelock), niet meer een enkele lokale sleutel.** Een directe
`solana program deploy --keypair ~/.config/solana/id.json` op `9ma6...` FAALT nu terecht -
die sleutel is geen authority meer. Een upgrade van het echte devnet-programma verloopt nu
in twee delen:

1. **Buffer voorbereiden (lokaal, geen multisig nodig):**
   ```bash
   solana program write-buffer target/deploy/spankwallet.so \
     --keypair ~/.config/solana/id.json \
     --url https://api.devnet.solana.com
   # noteer het geretourneerde buffer-adres, dan:
   solana program set-buffer-authority <buffer-adres> \
     --new-buffer-authority 89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw \
     --keypair ~/.config/solana/id.json \
     --url https://api.devnet.solana.com
   ```
2. **Upgrade voorstellen/goedkeuren/uitvoeren via `admin/wallet-signer.html`** - NIET via
   `app.squads.so`: die webinterface bleek onbetrouwbaar (toonde herhaaldelijk alleen
   demodata, kon de echte multisig niet vinden - zie STATUS.md sectie 43). `admin/`
   bevat een zelfgebouwde, sleutelloze ondertekenpagina die dezelfde Squads-transacties
   opbouwt en door de wallet-extensie/-app zelf laat ondertekenen - zie `admin/README.md`
   voor de volledige, actuele instructies. Twee van de drie leden (telefoon, hoofdpc,
   Windows-pc) moeten goedkeuren, en de 72u-timelock moet verstrijken voordat uitvoering
   mogelijk is. Zie STATUS.md sectie 41-46 voor de volledige achtergrond, inclusief een
   aantal reëel tegengekomen valkuilen (SDK-foutvertaalbugs, ProgramData-headroom-tekort,
   RPC-timing-races, browsercaching, transactionIndex-verwarring) die de moeite waard
   zijn om te kennen voordat je dit voor het eerst zelf doet.

Controleer de huidige authority altijd met:
```bash
solana program show 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9 --url https://api.devnet.solana.com
```

Voor een upgrade ALTIJD het vaste programma-ID direct als `--program-id`/doel gebruiken,
NOOIT het pad naar `target/deploy/spankwallet-keypair.json` - dat keypair-bestand is een
lokaal, wegwerpbaar build-artefact (gitignored) dat op elk moment kan afwijken van het
daadwerkelijk gedeployde adres. Zie STATUS.md voor de volledige lijst bekende
deploy-valkuilen (verkeerde signer uit een gedeelde solana-config, `anchor keys sync` dat
per ongeluk een nieuw programma-ID genereert, `anchor build` dat de `--arch v3`-binary
overschrijft) en het altijd-eerst-`anchor build`-dan-`cargo-build-sbf --arch v3`-proces.

Rate-limiting: api.devnet.solana.com heeft een officieel, strikt rate-limit (100
verzoeken/10s per IP). Bij intensief testen op een dag raak je dat onvermijdelijk. Een
werkend, gratis alternatief zonder aanmelding: `https://solana-devnet.api.onfinality.io/public`
(gebruik hetzelfde endpoint voor zowel de `--url`-vlaggen hierboven als client/src/main.ts's
Connection). Bij structureel intensiever testen: overweeg een gratis account bij een
dedicated RPC-provider (Helius, Alchemy, QuickNode) in plaats van de gedeelde publieke
endpoints.

### Desktop-app (Tauri, fase 0)

```bash
cd desktop
npm install
npm run tauri dev      # development
npm run tauri build    # production-bundle (.deb/.rpm/.AppImage op Linux)
```

Zie `desktop/README.md` voor de volledige uitleg (architectuur, passkey-backend, status).

## Veiligheidsprincipes

- Geen open CPI - alleen expliciet getypeerde acties, of CPI naar een programma dat de
  eigenaar zelf vooraf op zijn eigen allowlist heeft gezet (`execute_advanced`).
- Passkey-verificatie via Solana's secp256r1-precompile (SIMD-0075) + WebAuthn-
  clientDataJSON-binding, inclusief afgedwongen User Verification (UV-vlag) en expliciete
  `"type":"webauthn.get"`-validatie.
- PDA-seeds gebruiken wallet_seed_hash (SHA-256 van de 33-byte passkey) vanwege Solana's
  32-byte-per-seed-limiet.
- seed_key is onveranderlijk; owner_passkey muteert alleen bij een succesvolle recovery.
- Multi-passkey is optioneel en zero-migratie: een wallet die nooit add_passkey aanroept
  gedraagt zich exact als voorheen. Lockout-bescherming verbiedt het verwijderen van de
  allerlaatste geldige sleutel.
- Session keys zijn een tijdelijke autorisatielaag naast passkeys: gewone Ed25519-Solana-
  signers (geen WebAuthn-ceremonie per actie), gescoped op instructiesoort (en voor
  execute_advanced op een sub-allowlist), altijd slot-gebonden begrensd, en kunnen zichzelf
  nooit verlengen of nieuwe bevoegdheid creëren - alleen aanmaken/intrekken via een echte
  passkey. De per-sessie-maxima (lamports/tokens) gelden voor `execute_via_session` en
  `transfer_token_via_session`. Een sessie met execute_advanced-bevoegdheid kan een CPI
  alleen aankondigen in de PendingAction-wachtrij; bevestigen, uitvoeren en annuleren
  vereist een passkey (STATUS.md sectie 153/154). De meegeleverde client maakt zulke
  sessies nog niet aan (zie STATUS.md sectie 155 voor de voorwaarden).
- Noodstop: elke geldige passkey of de backup authority kan de wallet direct bevriezen.
  Tijdens een bevriezing zijn alle waardepaden en alle bevoegdheidsuitbreidingen
  geblokkeerd; versmallende acties (annuleren, sessies en allowlist-entries intrekken,
  recovery) blijven werken. Ontdooien kan via de wachtrij (24u timelock, 2-van-2 bij twee
  of meer passkeys) of direct door de backup authority.
- De backup authority heeft daarmee meer dan alleen de recovery-rol. Zij kan een bevroren
  wallet **direct** ontdooien, zonder timelock en zonder passkey, en daarbij in dezelfde
  instructie passkeys verwijderen (nooit de laatste geldige passkey). Verwijdert zij er
  minstens één, dan worden ook alle sessiesleutels ongeldig. Dit is bewust: bij een
  gecompromitteerde passkey is zij de enige partij die de wallet kan ontdooien zonder dat
  die passkey het kan tegenhouden. Het betekent ook dat wie deze sleutel bezit, een
  bevriezing kan opheffen. Bewaar de backup-authority-sleutel daarom offline en veilig
  (niet op hetzelfde apparaat als een passkey), maar wel bereikbaar: bij een noodgeval
  moet de eigenaar hem binnen afzienbare tijd kunnen gebruiken.
- **Wijzigingen aan de passkey-set zijn via de backup-route in feite 2-van-3.** Omdat de
  backup authority bij het ontdooien passkeys kan verwijderen zonder passkey-handtekening,
  geldt: de backup-authority-sleutel samen met één willekeurige geldige passkey geeft
  volledige controle over welke passkeys geldig blijven, en daarmee over de wallet. De
  2-van-2 bij grote uitgaven beschermt tegen het verlies van één passkey, niet tegen de
  combinatie van de backup-sleutel en één passkey. Behandel de backup-sleutel daarom als een
  volwaardige derde sleutel: bewaar hem gescheiden van elke passkey, nooit op hetzelfde
  apparaat en nooit in dezelfde cloud-synchronisatie als een passkey.
- Recovery heeft een 72u-timelock + owner-veto (cancel_recovery), en wist bij succes de
  volledige extra-passkey-set - geen stale, mogelijk-gecompromitteerde passkeys overleven
  een recovery. Bestaande sessiesleutels worden bij diezelfde finalize_recovery NIET
  gewist of gesloten, maar wel meteen ongeldig: een wallet-brede session_epoch-teller
  verhoogt, en elke `_via_session`-instructie tegen een sessie met een oudere epoch faalt
  vanaf dat moment met `SessionRevokedByRecovery` - de accounts zelf blijven bestaan tot
  ze via `remove_session_key`, `close_session` of `close_expired_session` daadwerkelijk
  opgeruimd worden. De handtekening van het veto is gebonden aan precies de lopende
  recovery-poging: een momentopname van de action_nonce bij `initiate_recovery`, plus het
  startmoment en de nieuwe sleutel - niet aan de live action_nonce. Omdat `cancel_recovery`
  en `finalize_recovery` de nonce allebei verhogen, geldt een handtekening nooit voor een
  latere poging, ook niet als die in dezelfde seconde met dezelfde sleutel start.
- Tijdens een lopende recovery kan de backup authority de wallet bevriezen, maar niet direct
  ontdooien. Bevriezen is nodig omdat elke geldige passkey de recovery kan annuleren en de
  waardepaden daarmee weer opengaan; een eigenaar die alleen nog de backup-sleutel heeft,
  moet dat kunnen voorkomen. Direct ontdooien kan passkeys verwijderen en blijft daarom
  geblokkeerd: zo ligt vast welke passkeys de recovery mogen tegenhouden. Dat houdt de
  combinatie backup-sleutel + één passkey niet tegen (zie hierboven, 2-van-3); die kan de
  passkey-set vóór een recovery al aanpassen. Wie vermoedt dat een passkey in verkeerde
  handen is, bevriest vóór of samen met `initiate_recovery`, en verwijdert eventuele
  passkeys vóór de recovery.
- Elke gevoelige actie bindt zijn volledige, relevante parameters in de ondertekende
  challenge (nooit alleen een deel) - voorkomt dat een geldige handtekening voor iets anders
  hergebruikt kan worden dan waarvoor hij bedoeld was.

## Roadmap (korte samenvatting)

- Fase 1: kerninstructies + echte passkey-flow - afgerond
  - execute (transfer_sol) en transfer_token beide bewezen als gesloten, getypeerde acties
  - Programma-allowlist + execute_advanced - afgerond, bewezen op devnet
  - Multi-passkey (meerdere gelijkwaardige sleutels per wallet) - afgerond, bewezen op devnet
  - Session keys (tijdelijke, gescopede sleutels) - afgerond, bewezen op devnet
- Fase 2: fee-gated PDA-inbox
- Fase 3: USB 2-of-2 / post-quantum (later)
- Parallel: Tauri-desktop-migratie (native, extensie-vrije runtime - sluit de
  `chrome.webAuthenticationProxy`-dreigingsklasse structureel, zie STATUS.md sectie 72) -
  fase 0 in ontwikkeling, zie `desktop/README.md`

## Gerelateerde projecten

- **[OBP - OfflineBearer Protocol](https://github.com/anoadder-ship-it/offline-bearer-protocol)**:
  een experimenteel protocol (alleen devnet) voor bearer-munten die je offline kunt ophalen,
  offline kunt overdragen en later weer on-chain kunt inleveren. SpankWallet wordt de
  host-wallet voor OBP. Die integratie is gepland maar **nog niet gebouwd**: SpankWallet bevat
  vandaag geen OBP-code en communiceert niet met het OBP-programma.

## Licentie en Security

**Licentie:** Apache-2.0 — zie `LICENSE`.

**Disclaimer:** deze software wordt geleverd "as is", zonder garantie (zie ook
de Apache-2.0-licentie zelf). SpankWallet beheert echte waarde op Solana —
gebruik op eigen risico. Dit is geen financieel advies, en er is geen garantie
tegen bugs, verlies van toegang of andere risico's die inherent zijn aan
zelfbeheer van crypto-assets.

Zie SECURITY.md voor het verantwoord melden van kwetsbaarheden.
