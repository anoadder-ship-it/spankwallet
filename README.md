# SpankWallet

Non-custodial Solana wallet met **passkey-authenticatie** (WebAuthn / secp256r1) in plaats van seed phrases.

- Passkey i.p.v. seed phrase
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
| Browser-testpagina                  | Werkend (Vite + Wallet Standard), 7 teststappen                 |
| Open CPI / arbitrary instructions   | Bewust verwijderd (zie STATUS.md sectie 25-26)                  |

**Program ID (devnet):** ERAEjxMgxserGuj8hc6v7LVy6ZaXaVxwDtXFLbsxj8wY

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
zonder per-munt-configuratie. Zie STATUS.md sectie 25-26 voor de volledige motivatie en de
roadmap (allowlists, spend limits, risk tiers).

## Instructies

| Instructie          | Handtekening              | Beschrijving                                  |
|----------------------|----------------------------|------------------------------------------------|
| init_wallet          | Passkey (WebAuthn)         | Wallet + Vault-PDA aanmaken                   |
| execute              | Passkey                    | SOL-transfer (getypeerd)                      |
| transfer_token       | Passkey                    | SPL-token-transfer (getypeerd, munt-onafhankelijk) |
| hunt                 | Passkey                    | Spam-token burnen + account sluiten (50/50 rent) |
| initiate_recovery    | Backup authority            | Recovery starten                              |
| cancel_recovery      | Passkey (owner-veto)        | Recovery annuleren                            |
| finalize_recovery    | Permissionless               | Recovery afronden na timelock                 |

## Structuur

```
spankwallet/
programs/spankwallet/     - Anchor-programma (Rust)
  src/lib.rs
  src/state.rs             - WalletAccount, VaultAccount, RecoveryState
  src/instructions.rs
  src/errors.rs
client/                    - Vite/TS-testpagina (passkey + Phantom)
tests/                      - Anchor-tests (8/8 groen)
scripts/
STATUS.md                   - lees dit eerst
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
  --program-id target/deploy/spankwallet-keypair.json \
  --keypair ~/.config/solana/id.json \
  --url https://api.devnet.solana.com
```

Rate-limiting: api.devnet.solana.com heeft een officieel, strikt rate-limit (100
verzoeken/10s per IP). Bij intensief testen op een dag raak je dat onvermijdelijk. Een
werkend, gratis alternatief zonder aanmelding:

```bash
solana program deploy target/deploy/spankwallet.so \
  --program-id target/deploy/spankwallet-keypair.json \
  --keypair ~/.config/solana/id.json \
  --url https://solana-devnet.api.onfinality.io/public
```

client/src/main.ts's Connection moet naar hetzelfde endpoint wijzen als waar je op
deployt. Bij structureel intensiever testen: overweeg een gratis account bij een dedicated
RPC-provider (Helius, Alchemy, QuickNode) in plaats van de gedeelde publieke endpoints.

## Veiligheidsprincipes

- Geen open CPI - alleen expliciet getypeerde acties.
- Passkey-verificatie via Solana's secp256r1-precompile (SIMD-0075) + WebAuthn-
  clientDataJSON-binding.
- PDA-seeds gebruiken wallet_seed_hash (SHA-256 van de 33-byte passkey) vanwege Solana's
  32-byte-per-seed-limiet.
- seed_key is onveranderlijk; owner_passkey muteert alleen bij een succesvolle recovery.
- Recovery heeft een 72u-timelock + owner-veto (cancel_recovery).
- Elke gevoelige actie bindt zijn volledige, relevante parameters in de ondertekende
  challenge (nooit alleen een deel) - voorkomt dat een geldige handtekening voor iets anders
  hergebruikt kan worden dan waarvoor hij bedoeld was.

## Roadmap (korte samenvatting)

- Fase 1: kerninstructies + echte passkey-flow - afgerond
  - execute (transfer_sol) en transfer_token beide bewezen als gesloten, getypeerde acties
  - Optionele policy-lagen (spend limits, recipient-allowlist, risk tiers) - zie STATUS.md sectie 26
- Fase 2: fee-gated PDA-inbox
- Fase 3: USB 2-of-2 / post-quantum (later)

## Licentie en Security

Zie SECURITY.md voor het verantwoord melden van kwetsbaarheden.
