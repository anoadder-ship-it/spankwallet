
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
