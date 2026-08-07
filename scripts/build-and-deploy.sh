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
# Gebruik:
#   ./scripts/build-and-deploy.sh          # normale build + deploy
#   ./scripts/build-and-deploy.sh --clean  # met rm -rf target eerst (bij twijfel)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"

cd "$PROJECT_ROOT"

if [[ "${1:-}" == "--clean" ]]; then
    echo "==> Schone build: rm -rf target"
    rm -rf target
fi

echo "==> Controleer/synchroniseer program-ID (moet VOOR de build, declare_id! wordt meegecompileerd)"
anchor keys sync

echo "==> cargo-build-sbf --arch v3"
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
echo "    anchor test --skip-local-validator --skip-deploy"
