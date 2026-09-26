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
5. Voorstel aanmaken en goedkeuren via `admin/wallet-signer.html` (twee van de drie leden).

## 2. Pre-flight, direct vóór het uitvoeren (volgorde verplicht)

1. `TRANSACTION_INDEX=<n> npx ts-node --transpile-only scripts/preUpgradeChecks.ts --pre`
   moet eindigen met exit 0. Dit draait na elkaar, en stopt bij de eerste fout:
   - `scripts/checkProposalTimelock.ts`: de 72u-timelock is verstreken, gemeten tegen de
     Clock-sysvar (sectie 94);
   - `scripts/checkRecoveryQueueInvariant.ts`: geen wachtende actie bij een wallet met een
     lopende recovery, geen afwijkende epoch, en een volledig RPC-antwoord (secties
     161-162).

   Niet 0: niet uitvoeren.
2. Sessie-bruikbaarheid (sectie 94/95).
3. Voorstel- en bufferstatus on-chain herbevestigd.
4. Adminpagina: `findCanonicalProposal()` geeft precies één open kandidaat, dit voorstel.

Houd de tijd tussen stap 1 en het uitvoeren zo kort mogelijk: tot het uitvoeren draait de
oude binary. Bij twijfel stap 1 opnieuw.

## 3. Uitvoeren

Knop 4 op `admin/wallet-signer.html`. Uitvoertransactie noteren.

## 4. Direct ná het uitvoeren

1. `npx ts-node --transpile-only scripts/preUpgradeChecks.ts --post` moet eindigen met
   exit 0. Rood is hier detectie, geen herstel: de upgrade staat al. Zie het commentaar in
   `scripts/checkRecoveryQueueInvariant.ts` voor wat een treffer betekent en wie hem kan
   wegnemen; leg elke treffer vast in STATUS.md.
2. De vijf verificaties van sectie 95: uitvoertransactie (`err: null`), programma-hash
   gelijk aan de buffer (rest nul-padding, `lastDeploySlot` = uitvoerslot), buffer
   gesloten, upgrade authority ongewijzigd, voorstel op `Executed`.

## 5. Vastleggen

Uitvoer van elke stap (exit-codes, slots, hashes) in de STATUS.md-sectie van deze upgrade.
`MIN_WALLET_ACCOUNTS` in `scripts/checkRecoveryQueueInvariant.ts` is een ondergrens; als
het gemeten aantal WalletAccounts gegroeid is, kan hij na een eigen meting omhoog.
