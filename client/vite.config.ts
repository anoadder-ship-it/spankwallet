import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Expliciete, verifieerbare beveiligingscontrole tegen GHSA-4w7w-66w2-5vf9
    // (Vite dev-server path-traversal in .map-afhandeling, geldt ook voor
    // onze huidige 5.4.21 - geen 5.x-backport beschikbaar, bevestigd via
    // extern onderzoek). De advisory specificeert expliciet dat misbruik
    // vereist dat de dev-server publiek bereikbaar wordt gemaakt via
    // --host/server.host. host: false laat de server standaard alleen aan
    // localhost binden. Dat is een standaard, geen afdwinging: CLI-opties
    // zoals `vite --host` gaan vóór dit configbestand (Vite voegt ze als
    // inline-config over de bestandsconfig heen) en maken de server dan
    // wél bereikbaar vanaf het netwerk. Start de devserver dus zonder
    // --host. Zie STATUS.md voor de
    // volledige afweging (bewust GEEN major-upgrade naar Vite 6+ zonder
    // grondig, apart onderzoek daarnaar).
    host: false,
    // allowedHosts: true stond hier voor een tijdelijke Cloudflare Tunnel-
    // test (zie STATUS.md sectie 13) - niet meer nodig sinds we op
    // devnet/localhost testen, en een onnodige verruiming van de
    // dev-server-toegangscontrole. Verwijderd.
  },
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
});
