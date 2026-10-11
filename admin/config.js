// STATUS.md sectie 180: de Helius-sleutel staat niet (meer) in git. De
// eerdere, gecommitte sleutel (sectie 107/109) bleek wél een geheim: hij
// stond openbaar en het tegoed was op. admin/https-server.js serveert
// /config.js nu uit een lokaal bestand buiten de repo
// (~/.config/spankwallet/helius-devnet.key, rechten 600, alleen de sleutel;
// pad te overschrijven met SPANKWALLET_HELIUS_KEY_FILE), als
// `export const HELIUS_API_KEY = "...";`.
//
// Dit gecommitte bestand is alleen de terugval als dat lokale bestand
// ontbreekt of afwijkt: het gooit een fout, zodat de pagina dat meteen
// meldt (window.onerror in de debuglog) in plaats van later een
// onduidelijke 401 van de RPC. Zet hier nooit een sleutel in.
throw new Error("Geen Helius-sleutel: zet ~/.config/spankwallet/helius-devnet.key (rechten 600, alleen de sleutel) en herstart admin/https-server.js");
