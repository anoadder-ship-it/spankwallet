// Moet als allereerste module in de hele import-keten geevalueerd worden.
// @solana/spl-token gebruikt Buffer al tijdens het laden van de module zelf
// (niet pas bij een functie-aanroep) - in ES-modules worden ALLE
// import-statements eerst volledig geevalueerd, in volgorde, voordat er ook
// maar een gewone regel in het aanroepende bestand draait. Een polyfill-
// toewijzing simpelweg bovenaan main.ts plaatsen werkt daardoor NIET
// betrouwbaar: die draait pas na alle (ook diep geneste) imports.
// Dit losse bestand, met als enige afhankelijkheid het buffer-package zelf,
// als allereerste import in main.ts garandeert de juiste volgorde.
import { Buffer } from "buffer";
(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
