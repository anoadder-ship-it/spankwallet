# SpankWallet Desktop (Tauri) — fase 0

Native, extensie-vrije desktop-tegenhanger van de browser-client (`client/`). Zie
`STATUS.md` sectie 72 voor de volledige dreigingsanalyse die tot deze migratie leidde:
`chrome.webAuthenticationProxy` is een structureel, browser-brede WebAuthn-hijacking-
mechanisme dat geen enkele DOM-gebaseerde mitigatie kan sluiten, omdat het op
browserextensie-niveau werkt - vóór/onafhankelijk van elke pagina-/frame-constructie. Een
Tauri-webview heeft geen extensie-ecosysteem, dus dat aanvalsoppervlak bestaat hier
structureel niet (bevestigd, niet aangenomen - zie STATUS.md sectie 72, punt 3).

**Status: fase 0, actief in ontwikkeling, niet productierijp.** Zie `STATUS.md` secties
74-75 voor de volledige, gedetailleerde geschiedenis (elke blokkade, elke fix, elk
onderzoek). Dit README geeft alleen het overzicht.

## Architectuur, kort

- **Frontend** (`src/`): vanilla TS + Vite, dezelfde bevestigingskaart-stijl als `client/`.
  Orchestreert de WebAuthn-ceremonie en roept Rust-commands aan via `invoke()`.
- **Backend** (`src-tauri/src/`):
  - `passkey_ctap.rs` - de passkey-ceremonie zelf (`register_passkey`/`sign_with_passkey`),
    rechtstreeks tegen `ctap-hid-fido2` (CTAP2/HID). WebKitGTK op Linux heeft geen eigen
    `navigator.credentials` (structurele engine-limitatie, `tauri-apps/tauri#4073`), dus dit
    kan niet via een browser-native aanroep lopen. **Gebruikt niet meer
    `tauri-plugin-webauthn`/`authenticator-rs`** - die bleek structureel te hangen op
    minstens één testmachine; zie STATUS.md sectie 75 voor de volledige onderzoekstrail
    (drie onafhankelijke bewijskanalen) en de provenance-check van de vervanging.
  - `challenge.rs`/`execute.rs`/`secp256r1.rs` - Rust-poort van `client/`'s challenge-
    berekening, transactie-opbouw en secp256r1-precompile-instructie. Herberekent het
    verwachte challenge ONAFHANKELIJK van wat de webview beweert, vóór er een transactie
    gebouwd/verstuurd wordt - defense-in-depth tegen een gecompromitteerde frontend.
  - `fee_payer.rs` - lokaal, Stronghold-versleuteld fee-payer-keypair. Betaalt uitsluitend
    netwerkkosten; kan nooit wallet-fondsen verplaatsen (geverifieerd tegen
    `instructions.rs` - geen enkele instructie autoriseert op fee-payer-identiteit).

Het on-chain programma (`programs/spankwallet/`) is volledig ongewijzigd - dit is
uitsluitend een client-architectuurwijziging.

## Draaien (development)

```bash
npm install
npm run tauri dev
```

`WEBKIT_DISABLE_DMABUF_RENDERER=1` staat al in het `tauri`-npm-script (permanente fix voor
een zwart-venster-probleem op sommige sandboxed/aarch64-omgevingen - zie STATUS.md sectie 74,
Blokkade 2).

Registratie/ondertekening vraagt momenteel de PIN van je externe FIDO2-hardware-sleutel op
via een simpele `window.prompt()` - functioneel, maar nog niet op het UI-niveau van de rest
van dit project's bevestigingskaarten (genoteerd als vervolgpunt in STATUS.md sectie 75).

## Bouwen (production)

```bash
npm run build          # tsc + vite build (frontend)
npm run tauri build    # volledige Tauri-bundle: binary + .deb/.rpm/.AppImage (Linux)
```

## Verder lezen

`STATUS.md` is de primaire bron van waarheid voor deze migratie - lees secties 72
(dreigingsanalyse/ontwerp), 74 (fase-0-skeleton, Stronghold, execute_action, drie opgeloste
blokkades) en 75 (passkey-backend-vervanging: root-cause-onderzoek, provenance, de
implementatie) voor de volledige, gedetailleerde geschiedenis.
