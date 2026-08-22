# devnet-program-id.sh - de ENE plek waar het echte, live devnet-adres van
# spankwallet vastligt, onafhankelijk van git-state (zie STATUS.md - de
# derde voetangel bij het herstel-mechanisme: `git show HEAD:` bleek geen
# vanzelfsprekend betrouwbare bron, sectie 81's gedeelde-werkboom-incident
# liet zien dat een working tree's HEAD kan verschuiven zonder dat iemand
# het op dat moment merkt). Gebruikt door zowel build-and-deploy.sh (om
# terug te herstellen na een lokale test-run) als build-devnet-buffer.sh (om
# een buffer-build tegen te verifiëren) - EEN bestand om bij te werken als
# dit adres ooit legitiem verandert, niet twee losse, uit elkaar te lopen
# kopieën.
#
# Source dit bestand (`source scripts/lib/devnet-program-id.sh`), niet
# los uitvoeren.

readonly SPANKWALLET_DEVNET_PROGRAM_ID="9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9"
