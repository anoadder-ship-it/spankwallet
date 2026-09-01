# SpankWallet

Non-custodial Solana wallet met **passkey-authenticatie** (WebAuthn / secp256r1) in plaats van seed phrases.

- Passkey i.p.v. seed phrase, met optioneel meerdere gelijkwaardige passkeys per wallet
- Tijdelijke, smal-gescopede **session keys** (LazorKit-geïnspireerd, slot-gebonden expiry) voor dApp/game-gebruik zonder herhaalde WebAuthn-prompts
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
| execute_advanced                | Passkey                              | CPI naar een programma dat op de eigen allowlist staat               |
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
| cancel_recovery                 | Passkey (owner-veto)                  | Recovery annuleren                                                   |
| finalize_recovery                | Permissionless (na timelock)          | Recovery afronden: wist alle extra passkeys, maakt bestaande sessiesleutels ongeldig (epoch-verhoging, sluit ze niet) |
| add_session_key                  | Een van de al geldige passkeys        | Tijdelijke session key registreren (scope + slot-gebonden expiry)   |
| remove_session_key               | Een van de al geldige passkeys        | Session key vroegtijdig intrekken                                    |
| close_session                    | De session key zelf                   | Eigen sessie zelf sluiten, rent terug (enige zelfstandige actie)     |
| close_expired_session             | Permissionless (na expiry_slot)       | Verlopen sessie opruimen, rent naar de aanroeper                    |
| execute_via_session               | De session key zelf                   | SOL-transfer via een tijdelijke, gescopede sessiesleutel             |
| transfer_token_via_session         | De session key zelf                   | SPL-token-transfer via een tijdelijke, gescopede sessiesleutel       |
| execute_advanced_via_session       | De session key zelf                   | CPI via sessiesleutel, dubbel gescoped (sessie-sub-scope + live allowlist) |

## Structuur

```
spankwallet/
programs/spankwallet/       - Anchor-programma (Rust)
  src/lib.rs                 - #[program]-entrypoints (28 instructies)
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
tests/                        - Anchor-tests (80 passing, 2 pending, 0 failing - zie STATUS.md sectie 78)
  spankwallet.ts                 - init_wallet
  policy.ts                       - programma-allowlist + execute_advanced
  passkeys.ts                      - multi-passkey + finalize_recovery-wipe
  recovery.ts                       - recovery-flow
  sessionKeys.ts                     - session keys, alle 7 instructies
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
- Session keys zijn een lager-vertrouwde, tijdelijke autorisatielaag naast passkeys: gewone
  Ed25519-Solana-signers (geen WebAuthn-ceremonie nodig per spend), altijd smal gescoped
  (welke instructiesoorten, welke sub-allowlist), altijd slot-gebonden begrensd, en kunnen
  zichzelf nooit verlengen of nieuwe bevoegdheid creëren - alleen aanmaken/intrekken via een
  echte passkey.
- Recovery heeft een 72u-timelock + owner-veto (cancel_recovery), en wist bij succes de
  volledige extra-passkey-set - geen stale, mogelijk-gecompromitteerde passkeys overleven
  een recovery. Bestaande sessiesleutels worden bij diezelfde finalize_recovery NIET
  gewist of gesloten, maar wel meteen ongeldig: een wallet-brede session_epoch-teller
  verhoogt, en elke `_via_session`-instructie tegen een sessie met een oudere epoch faalt
  vanaf dat moment met `SessionRevokedByRecovery` - de accounts zelf blijven bestaan tot
  ze via `remove_session_key`, `close_session` of `close_expired_session` daadwerkelijk
  opgeruimd worden.
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

## Licentie en Security

Zie SECURITY.md voor het verantwoord melden van kwetsbaarheden.
