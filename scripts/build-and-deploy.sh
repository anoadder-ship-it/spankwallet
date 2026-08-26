#!/usr/bin/env bash
# build-and-deploy.sh — de enige juiste manier om spankwallet te bouwen en
# te deployen op de lokale validator, na de sbpf_version-ontdekkingen.
#
# WAAROM DIT SCRIPT BESTAAT (zie STATUS.md voor de volledige speurtocht):
#   1. cargo-build-sbf MOET met --arch v3 draaien. Zonder deze vlag compileert
#      hij naar een SBPF-doelarchitectuur die deze lokale validator-genesis
#      niet accepteert ("Detected sbpf_version required by the executable
#      which are not enabled"). SIMD-0432 faseert oudere SBPF-versies uit,
#      dus v3 is momenteel de juiste keuze, geen default en geen v1.
#   2. `anchor deploy` / `anchor test` (zonder --skip-deploy) bouwen ZELF
#      opnieuw, zonder de --arch v3-vlag, en overschrijven daarmee stilletjes
#      een werkende v3-build met een kapotte default-build. Daarom deployen
#      we hier met het rauwe `solana program deploy`-commando.
#   3. Cargo's build-cache detecteert een --arch-wijziging niet altijd als
#      reden voor een rebuild. Bij twijfel: `rm -rf target` eerst.
#
# VOETANGEL 1 (twee keer aangetroffen, zie STATUS.md - precisiefout-sectie):
# `rm -rf target` bij --clean wist ook target/deploy/<programma>-keypair.json.
# Dat bestand is het ENIGE exemplaar van het lokale programma-keypair (nooit
# gecommit, .gitignore'd) - eenmaal weg, voorgoed weg. `anchor keys sync`
# genereert daarna stilzwijgend een NIEUWE identiteit en herschrijft
# declare_id! in lib.rs EN Anchor.toml - en dat raakt niet alleen
# spankwallet: `anchor keys sync` (zonder -p) synchroniseert het HELE
# Cargo-workspace, dus ook programs/active-defense, ook als je alleen
# spankwallet probeert te bouwen. Fix: het enige-exemplaar-keypair leeft
# BUITEN de repo-checkout (niet alleen buiten target/ - ook `git clean -fdx`
# wist genegeerde bestanden net zo hard), onder
# ${XDG_CONFIG_HOME:-~/.config}/spankwallet/program-keypairs/,
# target/deploy/*-keypair.json is een symlink daarnaartoe.
#
# VOETANGEL 2 (ontdekt bij het bouwen van de fix voor voetangel 1):
# declare_id! in de GECOMMITTE broncode is het ECHTE devnet-adres
# (multisig-bestuurd, zie STATUS.md sectie 42) - niet het lokale testadres.
# Om lokaal te kunnen bouwen/deployen moet declare_id! TIJDELIJK naar het
# lokale keypair wijzen (Anchor's eigen `declare_id!`/zelf-CPI-checks hebben
# het juiste adres nodig om te kunnen draaien). Dit script zette die
# tijdelijke waarde voorheen blijvend weg: na een run stond de werkboom vuil
# met het lokale adres in lib.rs/Anchor.toml, in plaats van het devnet-adres
# dat er in git staat. Dat maakt "schone werkboom" onbruikbaar als signaal.
# Fix: een `trap` herstelt declare_id!/Anchor.toml naar de git-HEAD-waarde
# ZODRA het script stopt - geslaagd, gefaald, of onderbroken (Ctrl+C/kill)
# maakt niet uit, de trap vuurt in alle drie de gevallen. Het lokale adres
# bestaat dus alleen tijdens de run zelf; ná afloop is de werkboom altijd
# schoon en staat er in git altijd nog het devnet-adres, ongeacht hoe het
# script eindigde. De mtime van elk hersteld bestand wordt ook teruggezet
# (niet alleen de inhoud) - anders zou tests/verifyBinaryFresh.ts de zojuist
# gebouwde (en inhoudelijk verse) binary ten onrechte als "verouderd"
# aanmerken, puur omdat het herstel de bronbestand-mtime na de build
# aanraakte.
#
# VOETANGEL 3 (bij het bouwen van voetangel 2's fix): `git show HEAD:...` is
# NIET vanzelfsprekend "de juiste bron" voor het te herstellen devnet-adres -
# STATUS.md sectie 81 documenteert een incident waarbij een GEDEELDE werkboom
# (twee sessies, één map) `main`'s HEAD liet verschuiven zonder dat iemand
# dat op dat moment merkte. Sindsdien heeft active-defense-phase1 een eigen,
# aparte worktree (sectie 81, structurele maatregel), maar deze hoofd-werkboom
# blijft in principe vatbaar voor "een andere branch/commit staat hier
# uitgecheckt op het moment dat dit script draait". Voor active-defense (nog
# nergens op devnet gedeployed, geen vaste identiteit om te beschermen) is
# git HEAD een acceptabele bron. Voor spankwallet (WEL live op devnet, WEL
# multisig-bestuurd, WEL de reden dat dit hele script bestaat) is dat te
# weinig zekerheid voor de inzet - vandaar de losstaande, git-onafhankelijke
# constante (scripts/lib/devnet-program-id.sh, ook gebruikt door
# build-devnet-buffer.sh - EEN bron, niet twee losse kopieën), die ALTIJD
# leidend is voor het herstel, met git HEAD alleen nog als controle (luide
# waarschuwing bij afwijking, geen blind vertrouwen in wat er toevallig net
# is uitgecheckt).

# UITSLUITEND VOOR DE LOKALE VALIDATOR (127.0.0.1). Sinds STATUS.md sectie 42
# is de upgrade-authority van het echte devnet-programma een Squads V4-
# multisig (2-of-3, 72u-timelock), geen lokale sleutel meer - dit script's
# rechtstreekse `solana program deploy` zou daar sowieso op falen, en moet
# NOOIT tegen devnet/mainnet aangeroepen worden. Zie README.md's
# "Deployen naar devnet"-sectie voor het huidige, multisig-gebaseerde proces.
#
# Gebruik:
#   ./scripts/build-and-deploy.sh          # normale build + deploy
#   ./scripts/build-and-deploy.sh --clean  # met rm -rf target eerst (bij twijfel)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/devnet-program-id.sh
source "$SCRIPT_DIR/lib/devnet-program-id.sh"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
# Buiten de repo-checkout (niet alleen buiten target/): dit moet ook een
# `git clean -fdx`, een verkeerde `rm -rf` op de repo-map, of een verse clone
# op een andere machine overleven. XDG_CONFIG_HOME gerespecteerd voor wie dat
# zet; anders de standaard ~/.config-conventie.
KEYPAIR_STORE="${XDG_CONFIG_HOME:-$HOME/.config}/spankwallet/program-keypairs"
WORKSPACE_PROGRAMS=(spankwallet)
declare -A CRATE_NAME=([spankwallet]=spankwallet)

cd "$PROJECT_ROOT"

declare_id_line() {
    # $1 = pad naar een lib.rs-bestand (op schijf of via git show)
    grep -oP 'declare_id!\("\K[^"]+' "$1" 2>/dev/null || true
}

# --- VOETANGEL 2: onthoud VOOR we ook maar iets aanraken wat er nu al op
# schijf staat (mtime + het adres), zodat de trap hieronder exact terug kan
# naar deze staat - ongeacht wat er verderop misgaat.
declare -A ORIG_LIB_MTIME
for prog in "${WORKSPACE_PROGRAMS[@]}"; do
    ORIG_LIB_MTIME[$prog]="$(stat -c %Y "programs/$prog/src/lib.rs" 2>/dev/null || stat -f %m "programs/$prog/src/lib.rs")"
done
ORIG_ANCHOR_MTIME="$(stat -c %Y Anchor.toml 2>/dev/null || stat -f %m Anchor.toml)"

restore_committed_declare_ids() {
    local exit_code=$?
    # Voorkom een dubbele/re-entrante aanroep: een signaal-getriggerde
    # aanroep van deze handler roept zelf `exit` aan, wat de EXIT-trap
    # nogmaals zou afvuren als die niet eerst wordt uitgezet.
    trap - EXIT INT TERM
    echo "==> Herstel declare_id!/Anchor.toml naar de gecommitte (devnet-)waarden"
    for prog in "${WORKSPACE_PROGRAMS[@]}"; do
        lib_rs="programs/$prog/src/lib.rs"
        head_value="$(git show "HEAD:$lib_rs" 2>/dev/null | grep -oP 'declare_id!\("\K[^"]+' || true)"
        if [[ "$prog" == "spankwallet" ]]; then
            # VOETANGEL 3: de git-onafhankelijke constante is leidend, niet
            # wat HEAD toevallig nu zegt.
            restore_value="$SPANKWALLET_DEVNET_PROGRAM_ID"
            if [[ -n "$head_value" && "$head_value" != "$restore_value" ]]; then
                echo "WAARSCHUWING: git HEAD's declare_id! voor spankwallet ($head_value)" >&2
                echo "wijkt af van de vaste devnet-constante in dit script ($restore_value)." >&2
                echo "Hersteld naar de vaste constante - controleer welke van de twee klopt" >&2
                echo "(is er een andere branch/commit uitgecheckt? zie STATUS.md sectie 81)." >&2
            fi
        else
            restore_value="$head_value"
        fi
        if [[ -n "$restore_value" ]]; then
            sed -i "s/declare_id!(\"[^\"]*\")/declare_id!(\"$restore_value\")/" "$lib_rs"
        fi
        touch -d "@${ORIG_LIB_MTIME[$prog]}" "$lib_rs"
    done
    # Generiek over alle workspace-programma's i.p.v. hardcoded op
    # spankwallet: als Anchor.toml ooit ook een [programs.localnet]-regel
    # voor active-defense krijgt, herstelt dit die net zo goed.
    for prog in "${WORKSPACE_PROGRAMS[@]}"; do
        committed_anchor="$(git show HEAD:Anchor.toml 2>/dev/null | grep -oP "^${prog} = \"\K[^\"]+" || true)"
        if [[ -n "$committed_anchor" ]]; then
            sed -i "s/^${prog} = \"[^\"]*\"/${prog} = \"$committed_anchor\"/" Anchor.toml
        elif grep -q "^${prog} = \"" Anchor.toml 2>/dev/null; then
            # Regel bestaat lokaal maar niet in git HEAD (bv. door deze run
            # net toegevoegd) - verwijderen, niet met een fout adres laten staan.
            sed -i "/^${prog} = \"/d" Anchor.toml
        fi
    done
    touch -d "@${ORIG_ANCHOR_MTIME}" Anchor.toml
    exit "$exit_code"
}
# EXIT vangt geslaagd/gefaald (set -e) af; INT/TERM expliciet erbij zodat
# Ctrl+C of een kill ook niet met een half-lokaal adres kan achterblijven.
trap restore_committed_declare_ids EXIT INT TERM

if [[ "${1:-}" == "--clean" ]]; then
    echo "==> Schone build: rm -rf target"
    rm -rf target
fi

echo "==> Zorg dat de programma-keypairs buiten target/ leven (overleven --clean)"
mkdir -p "$KEYPAIR_STORE" target/deploy
for prog in "${WORKSPACE_PROGRAMS[@]}"; do
    crate="${CRATE_NAME[$prog]}"
    stable="$KEYPAIR_STORE/${prog}-keypair.json"
    linked="target/deploy/${crate}-keypair.json"
    if [[ ! -f "$stable" ]]; then
        echo "    (eerste keer: genereer $stable - dit wordt vanaf nu de blijvende lokale test-identiteit)"
        solana-keygen new --no-bip39-passphrase --silent --outfile "$stable"
    fi
    ln -sf "$stable" "$linked"
done

echo "==> Zet declare_id!/Anchor.toml TIJDELIJK op het lokale testadres (alleen voor deze run)"
anchor keys sync

echo "==> Verifieer dat het lokale declare_id! overeenkomt met het bewaarde keypair (harde stop bij drift)"
for prog in "${WORKSPACE_PROGRAMS[@]}"; do
    stable="$KEYPAIR_STORE/${prog}-keypair.json"
    lib_rs="programs/$prog/src/lib.rs"
    expected="$(solana-keygen pubkey "$stable")"
    actual="$(declare_id_line "$lib_rs")"
    if [[ "$actual" != "$expected" ]]; then
        echo "FOUT: declare_id! in $lib_rs ($actual) komt niet overeen met het" >&2
        echo "bewaarde keypair $stable ($expected). Dit hoort na 'anchor keys" >&2
        echo "sync' niet te kunnen - onderzoek dit voordat je verder bouwt of deployt." >&2
        exit 1
    fi
    echo "    $prog: lokaal testadres $actual (wordt na deze run automatisch teruggezet naar het gecommitte adres)"
done

# IDL/types MOETEN gegenereerd worden terwijl declare_id! nog het lokale
# testadres is (de TS-testsuite leest het programma-ID uit target/idl/, niet
# uit lib.rs) - dus VOOR de trap dat adres terugzet, en VOOR de laatste
# cargo-build-sbf hieronder, want `anchor build` compileert zelf ook een
# .so, zonder --arch v3 (zie WAAROM-punt 2 hierboven) - die zou anders de
# net gebouwde v3-.so overschrijven. `-p spankwallet` slaat active-defense
# expres over (die heeft een eigen, hier niet relevante idl-build-vereiste).
echo "==> anchor build -p spankwallet (genereert target/idl + target/types met het lokale adres)"
anchor build -p spankwallet --skip-lint

echo "==> cargo-build-sbf --arch v3 (de daadwerkelijk te deployen .so, laatste stap - overschrijft de .so van de vorige stap)"
(cd programs/spankwallet && cargo-build-sbf --arch v3)

if [[ ! -f target/deploy/spankwallet.so ]]; then
    echo "FOUT: target/deploy/spankwallet.so bestaat niet na build." >&2
    exit 1
fi

SO_SIZE=$(stat -c%s target/deploy/spankwallet.so 2>/dev/null || stat -f%z target/deploy/spankwallet.so)
echo "==> Build klaar: target/deploy/spankwallet.so (${SO_SIZE} bytes)"

echo "==> Deploy naar ${RPC_URL} (rechtstreeks via solana, NIET via anchor deploy)"
solana program deploy target/deploy/spankwallet.so \
    --program-id target/deploy/spankwallet-keypair.json \
    --url "$RPC_URL"

echo "==> Klaar. Draai tests met:"
echo "    anchor test --skip-local-validator --skip-build --skip-deploy"
