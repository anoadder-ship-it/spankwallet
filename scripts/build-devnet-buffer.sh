#!/usr/bin/env bash
# build-devnet-buffer.sh — formaliseert de reproduceerbare-build-route die
# STATUS.md sinds sectie 39 herhaaldelijk met de hand beschrijft (verse
# build vanaf een specifieke commit, byte-offset-controle, DAN pas
# `solana program write-buffer`), en die sectie 79 al bewees via een
# losstaande, geïsoleerde `git worktree` (dezelfde structurele maatregel als
# sectie 81 later koos voor active-defense-phase1).
#
# WAAROM EEN APARTE WORKTREE, NIET DEZE WERKBOOM:
# build-and-deploy.sh (lokaal testen) zet declare_id! TIJDELIJK op een
# lokaal testadres en herstelt dat weer - precies daarom bevat
# target/deploy/spankwallet.so in DEZE werkboom nooit betrouwbaar het
# devnet-adres, en zou hergebruik van deze werkboom voor een buffer-build
# altijd een risico op vermenging blijven, ongeacht hoe zorgvuldig de
# volgorde is. Een verse worktree, uitgecheckt op exact de gevraagde commit,
# raakt build-and-deploy.sh's machinerie nooit aan: geen `anchor keys sync`,
# geen ID-swap, geen enkele van die voetangels is hier zelfs maar mogelijk -
# declare_id! is gewoon wat er op die commit gecommit staat.
#
# WAT DIT SCRIPT NIET DOET (bewuste grens, zelfde als elders in dit
# project): het schrijft NOOIT zelf een buffer en doet NOOIT een on-chain
# aanroep. Het bouwt, verifieert op byte-niveau, en drukt de exacte
# commando's af die JIJ handmatig uitvoert - zowel om te schrijven als om
# achteraf te bevestigen dat wat er on-chain staat overeenkomt.
#
# Gebruik:
#   ./scripts/build-devnet-buffer.sh [commit]   # default: HEAD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/devnet-program-id.sh
source "$SCRIPT_DIR/lib/devnet-program-id.sh"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"

cd "$PROJECT_ROOT"

COMMIT_ARG="${1:-HEAD}"
RESOLVED_COMMIT="$(git rev-parse "$COMMIT_ARG")"
SHORT_COMMIT="${RESOLVED_COMMIT:0:12}"
WORKTREE_DIR="/tmp/spankwallet-buffer-build-${SHORT_COMMIT}-$$"
VERIFIED_OUTPUT="/tmp/spankwallet-devnet-buffer-verified-${SHORT_COMMIT}.so"

# De tijdelijke worktree is wegwerp-bouwsteigers, geen bewaarplek - hij moet
# verdwijnen ongeacht hoe dit script eindigt (geslaagd, gefaald, Ctrl+C),
# anders kan een half-gebouwde map later voor een geldige buildmap worden
# aangezien. Zelfde mechanisme als build-and-deploy.sh's voetangel-2-fix.
# Het geverifieerde .so-bestand wordt VOOR deze cleanup naar een stabiele
# plek gekopieerd (zie verderop) - alleen de worktree zelf is wegwerpbaar.
cleanup_worktree() {
    local exit_code=$?
    trap - EXIT INT TERM
    # De daadwerkelijke opruiming EERST, de melding PAS DAARNA: bij het
    # testen bleek dat wanneer stdout naar een inmiddels gesloten pipe
    # schrijft (bv. een downstream `| tail` dat al gestopt is), een `echo`
    # die pijp een SIGPIPE kan opleveren die dit hele traphandler-proces
    # doodt - als de opruiming NA die echo stond, gebeurde hij dan
    # helemaal niet, en bleef er een wees-worktree achter. Nu kan een
    # SIGPIPE op de melding hooguit de melding zelf missen, nooit de
    # opruiming.
    if [[ -d "$WORKTREE_DIR" ]]; then
        git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
        git worktree prune >/dev/null 2>&1 || true
        echo "==> Tijdelijke worktree opgeruimd: $WORKTREE_DIR" 2>/dev/null || true
    fi
    exit "$exit_code"
}
trap cleanup_worktree EXIT INT TERM
# Zelfde SIGPIPE-redenering voor de rest van het script: een afgebroken
# downstream pipe mag dit script nooit halverwege een stap laten sterven
# zonder dat de EXIT-trap hierboven alsnog netjes opruimt (die vuurt sowieso
# bij elke `exit`, ook een impliciete door een dode `echo`) - maar expliciet
# negeren van SIGPIPE voorkomt dat scenario al bij de bron.
trap '' PIPE

echo "==> Geïsoleerde worktree op $WORKTREE_DIR (commit $RESOLVED_COMMIT)"
git worktree add --detach "$WORKTREE_DIR" "$RESOLVED_COMMIT" >/dev/null

echo "==> Sanity-check: declare_id! op deze commit moet al het devnet-adres zijn (geen sync, geen swap)"
ACTUAL_ID="$(grep -oP 'declare_id!\("\K[^"]+' "$WORKTREE_DIR/programs/spankwallet/src/lib.rs")"
if [[ "$ACTUAL_ID" != "$SPANKWALLET_DEVNET_PROGRAM_ID" ]]; then
    echo "FOUT: declare_id! op commit $RESOLVED_COMMIT is $ACTUAL_ID, niet het" >&2
    echo "verwachte devnet-adres $SPANKWALLET_DEVNET_PROGRAM_ID." >&2
    echo "Verkeerde commit gekozen? Of is het devnet-adres legitiem gewijzigd -" >&2
    echo "werk dan eerst scripts/lib/devnet-program-id.sh bij." >&2
    exit 1
fi

# Eigen, verse CARGO_TARGET_DIR: een fris uitgecheckte worktree heeft normaal
# toch geen bestaande build-cache, maar dit sluit elke twijfel daarover uit -
# en voorkomt een variant van de mtime/cache-valkuil die bij het testen van
# dit script zelf aan het licht kwam (zie STATUS.md): een latere, losse
# cargo-build-sbf-aanroep op een boom waarvan een bronbestand-mtime ooit
# kunstmatig is teruggezet, kan een VEROUDERDE gecachte build teruggeven
# zonder enige foutmelding. Een gegarandeerd lege CARGO_TARGET_DIR maakt dat
# hier onmogelijk.
echo "==> cargo-build-sbf --arch v3 (eigen CARGO_TARGET_DIR, geen enkel cache-hergebruik mogelijk)"
(cd "$WORKTREE_DIR/programs/spankwallet" && CARGO_TARGET_DIR="$WORKTREE_DIR/target" cargo-build-sbf --arch v3)

SO_PATH="$WORKTREE_DIR/target/deploy/spankwallet.so"
if [[ ! -f "$SO_PATH" ]]; then
    echo "FOUT: $SO_PATH bestaat niet na build." >&2
    exit 1
fi

echo "==> Byte-niveau-controle (positief: exact het devnet-adres; negatief: geen enkel lokaal testadres)"
node_modules/.bin/ts-node --transpile-only scripts/verify-program-id-in-binary.ts \
    "$SO_PATH" "$SPANKWALLET_DEVNET_PROGRAM_ID"

echo "==> Byte-niveau-controle (STATUS.md sectie 124): geen test-only Cargo-feature (verkorte PendingAction-timelock) in dit binary"
node_modules/.bin/ts-node --transpile-only scripts/verify-no-test-features-in-binary.ts \
    "$SO_PATH"

# Kopieer het geverifieerde bestand naar een STABIELE plek buiten de
# worktree, VOOR de trap de worktree opruimt - dit is het enige deel van de
# worktree dat het script overleeft.
cp "$SO_PATH" "$VERIFIED_OUTPUT"
SHA256="$(sha256sum "$VERIFIED_OUTPUT" | cut -d' ' -f1)"
SO_SIZE=$(stat -c%s "$VERIFIED_OUTPUT" 2>/dev/null || stat -f%z "$VERIFIED_OUTPUT")

# VOETANGEL 4 (STATUS.md): "exact één keer gevonden, geen besmetting" bewijst
# alleen iets over het BESTAND dat je erlangs haalt - niet over waar dat
# bestand straks daadwerkelijk terechtkomt. Een `solana program write-buffer`
# zonder `--buffer` genereert zelf een WILLEKEURIG buffer-adres, dat je pas
# kent nadat het commando al gedraaid heeft - de mens moet dat adres dan met
# de hand overtypen/plakken in stap 2, en precies dat kopieerpad (aannemen
# i.p.v. controleren) is exact de fout die de wegwerp-devnet-deploy vandaag
# maakte (declare_id! klopte, maar het adres waar `solana program deploy`
# ECHT naartoe schreef kwam van een andere, nooit-geverifieerde keypair).
# Fix: het buffer-adres hier NIET laten afhangen van uit elkaar geplukte
# terminal-output, maar van een keypair-bestand dat WIJ vooraf aanmaken en
# waarvan we het adres zelf, programmatisch, uitlezen - dezelfde bron voor
# zowel "waar we straks naartoe schrijven" (stap 1, via --buffer) als "wat
# we straks terugverifiëren" (stap 2). Bewust nog steeds GEEN on-chain-
# aanroep door dit script zelf (dezelfde grens als altijd) - alleen het
# keypair-bestand wordt hier gegenereerd, het schrijven blijft een bewuste,
# handmatige stap.
BUFFER_KEYPAIR="/tmp/spankwallet-buffer-keypair-${SHORT_COMMIT}.json"
solana-keygen new --no-bip39-passphrase --silent --force --outfile "$BUFFER_KEYPAIR" >/dev/null
BUFFER_ADDRESS="$(solana-keygen pubkey "$BUFFER_KEYPAIR")"

echo ""
echo "==> Build geverifieerd. commit=$RESOLVED_COMMIT bytes=$SO_SIZE"
echo "==> sha256=$SHA256"
echo "==> Geverifieerde .so: $VERIFIED_OUTPUT"
echo "==> Vooraf vastgelegd buffer-adres (keypair: $BUFFER_KEYPAIR): $BUFFER_ADDRESS"
echo ""
echo "STAP 1 - buffer schrijven op het HIERBOVEN al vastgelegde adres (handmatig"
echo "uitvoeren, niet door dit script) - '--buffer' pint het adres, zodat er in stap 2"
echo "niets uit terminal-output overgetypt hoeft te worden:"
echo "    solana program write-buffer $VERIFIED_OUTPUT \\"
echo "        --buffer $BUFFER_KEYPAIR \\"
echo "        --url $RPC_URL --keypair ~/.config/solana/id.json"
echo ""
echo "    VERPLICHTE CONTROLE: het 'Buffer: ...'-adres dat dit commando afdrukt MOET"
echo "    letterlijk $BUFFER_ADDRESS zijn. Is dat niet zo, STOP - er is iets mis met"
echo "    het --buffer-argument zelf, ga dan NIET verder naar stap 2."
echo ""
echo "STAP 2 - PAS NA een geslaagde controle hierboven: lees uit waar ECHT naartoe"
echo "geschreven is ($BUFFER_ADDRESS, niet een aangenomen adres) en bevestig dat de"
echo "INHOUD daarvan zowel byte-voor-byte als qua gedeclareerd programma-adres"
echo "overeenkomt met deze build (dit zijn precies de controles die bij voorstel #10"
echo "doorslaggevend waren):"
echo "    solana program dump $BUFFER_ADDRESS /tmp/spankwallet-buffer-dump.so --url $RPC_URL"
echo "    sha256sum /tmp/spankwallet-buffer-dump.so"
echo "        # moet EXACT overeenkomen met: $SHA256"
echo "    node_modules/.bin/ts-node --transpile-only scripts/verify-program-id-in-binary.ts \\"
echo "        /tmp/spankwallet-buffer-dump.so $SPANKWALLET_DEVNET_PROGRAM_ID"
echo ""
echo "Ga pas NA een geslaagde Stap 2 verder met set-buffer-authority en het"
echo "propose/approve/execute-voorstel - dat blijft, zoals altijd, een bewuste,"
echo "handmatige stap via je eigen wallet."
