#!/usr/bin/env bash
set -euo pipefail

# STATUS.md sectie 119: "anchor build" faalt NIET (exit code blijft altijd
# 0) op een BPF-stackframe-waarschuwing zoals "Stack offset of 4104
# exceeded max offset of 4096 by 8 bytes" - empirisch bevestigd, twee keer
# (eenmaal per ongeluk gevonden, eenmaal doelbewust gereproduceerd door de
# stap-2-regressie tijdelijk terug te zetten en de exacte canonieke
# testgate, `yarn test`, te draaien: die rapporteerde gewoon "80 passing"
# met de waarschuwingsregel begraven in ~200 regels build-output ervoor).
# "cargo check"/"cargo test" zien dit sowieso nooit - die draaien alleen
# tegen het native target, nooit tegen het echte BPF/SBF-doelplatform waar
# deze limiet geldt.
#
# Dit script is de expliciete, losstaande poort die WEL faalt: draai de
# echte "anchor build", en grep de VOLLEDIGE uitvoer (niet de exit code) op
# de bekende waarschuwingstekst. Bedoeld als vast onderdeel van de
# testgate (zie package.json's "test"-script) - draai dit voor ELKE
# WalletAccount/SessionKeyAccount/PolicyAccount-layoutwijziging opnieuw,
# niet alleen deze ene keer, zelfde discipline als
# checkWorstCaseAccountSafety.ts.

echo "[check-stack-safety] anchor build draaien en volledige uitvoer controleren op BPF-stackframe-waarschuwingen..."

OUTPUT=$(anchor build --ignore-keys 2>&1)
STATUS=$?
echo "$OUTPUT"

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "[check-stack-safety] FOUT: anchor build zelf faalde (exit code $STATUS) - zie uitvoer hierboven." >&2
  exit 1
fi

if echo "$OUTPUT" | grep -qiE "stack offset of [0-9]+ bytes exceeded|stack offset of [0-9]+ exceeded max offset"; then
  echo ""
  echo "[check-stack-safety] FOUT: anchor build meldt een BPF-stackframe-waarschuwing (zie uitvoer hierboven)." >&2
  echo "[check-stack-safety] Dit faalt NIET vanzelf via anchor build's eigen exit code (die blijft 0) -" >&2
  echo "[check-stack-safety] vandaar deze expliciete tekstcontrole. Zie STATUS.md sectie 119 voor de" >&2
  echo "[check-stack-safety] achtergrond en het bekende fixpatroon (UncheckedAccount + handmatige" >&2
  echo "[check-stack-safety] (de)serialisatie voor het account dat de limiet overschrijdt)." >&2
  exit 1
fi

echo "[check-stack-safety] Geen stackframe-waarschuwingen gevonden - veilig."
