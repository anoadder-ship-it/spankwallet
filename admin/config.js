// STATUS.md sectie 107/109: was hardcoded in wallet-signer.html zelf, nu
// hier apart - uitsluitend zodat rotatie ooit één bestand is i.p.v. drie
// (samen met client/src/main.ts en desktop/src-tauri/src/rpc.rs). GEEN
// echte secret-hantering: dit is een gratis, devnet-only Helius-sleutel
// (bevestigd in sectie 107 punt 5) - vandaar dat dit bestand BEWUST WEL
// gecommit is (niet .gitignored), zodat een verse kloon zonder enige
// configuratiestap werkt. Wordt dit ooit een echte, geheime sleutel: dan
// hoort dit bestand alsnog naar .gitignore verplaatst te worden, met een
// los, ongecommit exemplaar per signer-apparaat - vandaag is dat niet
// nodig.
//
// Geen build-stap voor wallet-signer.html zelf (de esm.sh-vendoring in
// vendor/*.mjs is een eenmalige, losstaande esbuild-stap om die
// bundels te PRODUCEREN - dit bestand hier is gewoon platte, direct
// bruikbare JS, net als wallet-signer.html zelf).
export const HELIUS_API_KEY = "f39fc413-6730-4848-a60f-a6685a6f04d3";
