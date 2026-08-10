# SpankWallet

Non-custodial Solana wallet met **passkey-authenticatie** (WebAuthn / secp256r1) in plaats van seed phrases.

- Passkey i.p.v. seed phrase, met optioneel meerdere gelijkwaardige passkeys per wallet
- Tijdelijke, smal-gescopede **session keys** (LazorKit-geinspireerd, slot-gebonden expiry) voor dApp/game-gebruik zonder herhaalde WebAuthn-prompts
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
| add_passkey                     | Een van de al geldige passkeys        | Extra, gelijkwaardige passkey registreren (multi-passkey)           |
| remove_passkey                  | Een van de al geldige passkeys        | Passkey intrekken (lockout-beschermd: nooit de laatste verwijderen) |
| initiate_recovery                | Backup authority                     | Recovery starten                                                    |
| cancel_recovery                 | Passkey (owner-veto)                  | Recovery annuleren                                                   |
| finalize_recovery                | Permissionless (na timelock)          | Recovery afronden, wist ook alle extra passkeys/sessies              |
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
  src/lib.rs                 - #[program]-entrypoints (19 instructies)
  src/state.rs                - WalletAccount, VaultAccount, RecoveryState, PolicyAccount,
                                 PasskeysAccount, SessionKeyAccount
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
tests/                        - Anchor-tests (49/49 groen)
  spankwallet.ts                 - init_wallet
  policy.ts                       - programma-allowlist + execute_advanced
  passkeys.ts                      - multi-passkey + finalize_recovery-wipe
  recovery.ts                       - recovery-flow
  sessionKeys.ts                     - session keys, alle 7 instructies
  webauthnTestHelper.ts               - gedeelde testhelpers (o.a. slot-/tijd-advancers)
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

```bash
solana program deploy target/deploy/spankwallet.so \
  --program-id 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9 \
  --keypair ~/.config/solana/id.json \
  --url https://api.devnet.solana.com
```

Gebruik voor een upgrade ALTIJD het vaste, hierboven genoemde programma-ID direct als
`--program-id`, NOOIT het pad naar `target/deploy/spankwallet-keypair.json` - dat
keypair-bestand is een lokaal, wegwerpbaar build-artefact (gitignored) dat op elk moment kan
afwijken van het daadwerkelijk gedeployde adres (bijv. na een `anchor keys sync`-misser of een
schone `target/`-rebuild). Zie STATUS.md voor de volledige lijst bekende deploy-valkuilen
(verkeerde signer uit een gedeelde solana-config, `anchor keys sync` dat per ongeluk een
nieuw programma-ID genereert, `anchor build` dat de `--arch v3`-binary overschrijft) en het
altijd-eerst-`anchor build`-dan-`cargo-build-sbf --arch v3`-proces.

Rate-limiting: api.devnet.solana.com heeft een officieel, strikt rate-limit (100
verzoeken/10s per IP). Bij intensief testen op een dag raak je dat onvermijdelijk. Een
werkend, gratis alternatief zonder aanmelding:

```bash
solana program deploy target/deploy/spankwallet.so \
  --program-id 9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9 \
  --keypair ~/.config/solana/id.json \
  --url https://solana-devnet.api.onfinality.io/public
```

client/src/main.ts's Connection moet naar hetzelfde endpoint wijzen als waar je op
deployt. Bij structureel intensiever testen: overweeg een gratis account bij een dedicated
RPC-provider (Helius, Alchemy, QuickNode) in plaats van de gedeelde publieke endpoints.

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
  zichzelf nooit verlengen of nieuwe bevoegdheid creeren - alleen aanmaken/intrekken via een
  echte passkey.
- Recovery heeft een 72u-timelock + owner-veto (cancel_recovery), en wist bij succes de
  volledige extra-passkey-set - geen stale, mogelijk-gecompromitteerde sleutels overleven
  een recovery.
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

## Licentie en Security

Zie SECURITY.md voor het verantwoord melden van kwetsbaarheden.
