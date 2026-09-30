# Upgradevoorstel-sjabloon (spankwallet-programma)

Sjabloon voor elke upgrade van `9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9` via de
Squads-multisig (2-van-3, 72u-timelock). Per upgrade een ingevulde kopie als eigen sectie
in STATUS.md. Elke stap is verplicht; een stap die niet groen is, stopt het proces tot
de oorzaak begrepen en vastgelegd is. Ontstaan in STATUS.md sectie 162 (review §161,
L-1), op basis van de pre-flight uit sectie 94 en de verificaties uit sectie 95.

## 0. Gegevens

- Upgrade: (naam, STATUS-secties)
- Commit: (SHA op `main`)
- Binary: `target/deploy/spankwallet.so`, sha256:
- Buffer-adres:
- Voorstel (`transactionIndex`):
- Uitvoertransactie (handtekening, slot):
- Controles op toestand van vóór de upgrade die het nieuwe programma zelf niet afdwingt
  (upgrade 1: de recovery-/wachtrij-invariant, secties 160-162):

## 1. Vóór het voorstel

1. Onafhankelijke review en RC-verificatie afgerond (secties):
2. Volledige regressie groen: `cargo test`, `yarn test`, `yarn test:pending-action`,
   `yarn test:spend-window-rollover`.
3. Binary: `scripts/verify-no-test-features-in-binary.ts` en
   `scripts/verify-program-id-in-binary.ts` groen op exact de binary die in de buffer gaat.
4. Buffer schrijven en de buffer-authority overdragen aan de vault (README, "Deployen naar
   devnet", stap 1).
5. Het buffer-adres vastleggen op beide plekken die het voorstel toetsen:
   `EXPECTED_BUFFER` in `scripts/checkProposalTimelock.ts` (sectie 167) en `BUFFER` in
   `admin/wallet-signer.html` (admin/README stap 1); `tests/unit/adminPageSelection.ts`
   faalt als ze verschillen. Leg ook de lengte en sha256 van de binary vast als
   `EXPECTED_BUFFER_PROGRAM_LENGTH` en `EXPECTED_BUFFER_PROGRAM_SHA256` (sectie 168), en
   vervang `tests/unit/fixtures/rc163-spankwallet.so.gz` door de nieuwe binary. Commit vóór
   het voorstel.
6. Voorstel aanmaken en goedkeuren via `admin/wallet-signer.html` (twee van de drie leden).
   Knop 3 keurt alleen het laatste voorstel goed, en alleen als het het enige open voorstel
   voor deze buffer is, geen enkel ander voorstel Approved of Executing is (welke inhoud
   ook), en het precies de upgrade is (sectie 168/169).

## 2. Pre-flight, direct vóór het uitvoeren (volgorde verplicht)

1. `TRANSACTION_INDEX=<n> npx ts-node --transpile-only scripts/preUpgradeChecks.ts --pre`
   moet eindigen met exit 0. Dit draait na elkaar, en stopt bij de eerste fout:
   - `scripts/checkProposalTimelock.ts` (secties 94, 167, 168):
     - devnet volgens de genesis-hash. Die hash geeft de RPC zelf op: de controle weert een
       verkeerde URL of een lokale test-validator, maar is geen absolute garantie tegen een
       simulator die devnet forkt;
     - `<n>` is het laatste voorstel en niet stale, en **geen enkel ander voorstel staat op
       Approved of Executing**, welke inhoud ook: VaultTransaction, Batch of Config (alle
       voorstellen 1..`<n>` gelezen, ook stale; sectie 169). De regel komt uit
       `admin/upgradeProposalCheck.mjs`, dezelfde module als knop 4;
     - de multisig is autonoom (config_authority de standaardwaarde), time_lock is exact
       259200 s en threshold minstens 2 (sectie 170). Daarop rust dat een later
       goedgekeurd voorstel pas 72u daarna uitgevoerd kan worden. Wat deze controle
       **niet** zegt (sectie 170 punt 7):
       - *spending limits* zijn een uitvoerpad **zonder** voorstel en zonder timelock: een
         lid van een SpendingLimit maakt SOL of tokens uit de vault over. Ze kunnen geen
         Upgrade tekenen (`spendingLimitUse` neemt alleen bedrag, decimalen en memo, geen
         instructies), dus ze omzeilen deze poort niet; wel kunnen ze de vault leeghalen.
         Een nieuwe spending limit vergt in een autonome multisig een config-voorstel, dat
         als Approved deze poort blokkeert;
       - threshold ≥ 2 betekent twee **sleutels**, niet twee **personen**. Houdt één persoon
         twee lidsleutels (of staan ze op hetzelfde apparaat), dan is er één persoon nodig.
         Dat kan geen on-chain controle zien; noteer bij het voorstel wie welke sleutel houdt;
       - de 72u zijn **Clock-seconden** (`unix_timestamp`), geen wandkloktijd. Onder
         Alpenglow zet de leider van elk blok die tijdstempel, binnen een protocolmarge
         (sectie 156); hoe ver een leider de 72u kan verschuiven, is nog niet gemeten;
     - de VaultTransaction is precies de upgrade van dit programma vanaf `EXPECTED_BUFFER`,
       met de vault als authority en spill;
     - de buffer zelf: van de loader, authority de vault, en de sha256 van de eerste
       `EXPECTED_BUFFER_PROGRAM_LENGTH` bytes na de kop is de RC-build; de rest is nul;
     - de 72u-timelock is verstreken, gemeten tegen de Clock-sysvar (Clock-seconden, zie
       hierboven);
   - `scripts/checkRecoveryQueueInvariant.ts --pre`: devnet; geen wachtende actie bij een
     wallet met een lopende recovery, geen afwijkende epoch, en een volledig RPC-antwoord
     (secties 161-162, 167). Versheid is hier alleen begrensd tot ná de vorige deploy: een
     node die daarna achterloopt, herkent `--pre` niet. De echte versheidsgarantie is `--post`
     (§4).

   Niet 0: niet uitvoeren.
2. Sessie-bruikbaarheid (sectie 94/95).
3. Voorstel- en bufferstatus on-chain herbevestigd.
4. Adminpagina: "TRANSACTION_INDEX voor de pre-flight" toont `<n>` (sectie 168).

Houd de tijd tussen stap 1 en het uitvoeren zo kort mogelijk: tot het uitvoeren draait de
oude binary. Bij twijfel stap 1 opnieuw.

## 3. Uitvoeren

Knop 4 op `admin/wallet-signer.html`. De knop past dezelfde regel toe als stap 1 en weigert
als het voorstel dat hij zou uitvoeren niet `<n>` is (sectie 168). Uitvoertransactie
noteren.

## 4. Direct ná het uitvoeren

1. `EXECUTE_SIGNATURE=<handtekening uit §3> npx ts-node --transpile-only
   scripts/preUpgradeChecks.ts --post` moet eindigen met exit 0. De handtekening bewijst
   dat de gelezen staat van ná de deploy is: de slot moet gelijk zijn aan de
   `last_deploy_slot`, en de scan moet daarna gelezen zijn (sectie 167). Rood is hier
   detectie, geen herstel: de upgrade staat al. Zie het commentaar in
   `scripts/checkRecoveryQueueInvariant.ts` voor wat een treffer betekent en wie hem kan
   wegnemen; leg elke treffer vast in STATUS.md.
2. De vijf verificaties van sectie 95: uitvoertransactie (`err: null`), programma-hash
   gelijk aan de buffer (rest nul-padding, `lastDeploySlot` = uitvoerslot), buffer
   gesloten, upgrade authority ongewijzigd, voorstel op `Executed`.

## 5. Vastleggen

Uitvoer van elke stap (exit-codes, slots, hashes) in de STATUS.md-sectie van deze upgrade.
`MIN_WALLET_ACCOUNTS` in `scripts/checkRecoveryQueueInvariant.ts` is een ondergrens; als
het gemeten aantal WalletAccounts gegroeid is, kan hij na een eigen meting omhoog.
