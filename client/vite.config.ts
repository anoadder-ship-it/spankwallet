import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Oorspronkelijk (STATUS.md sectie 20) een mitigatie tegen
    // GHSA-4w7w-66w2-5vf9 (Vite dev-server path-traversal in
    // .map-afhandeling), toen de client nog op Vite 5.4.21 stond zonder
    // 5.x-backport. Sinds sectie 100 draait de client op Vite 6 (nu 6.4.5)
    // en is die advisory gesloten; host: false blijft als extra verdediging:
    // een devserver die alleen aan localhost bindt, is van buitenaf niet
    // bereikbaar. host: false laat de server standaard alleen aan
    // localhost binden. Dat is een standaard, geen afdwinging: CLI-opties
    // zoals `vite --host` gaan vóór dit configbestand (Vite voegt ze als
    // inline-config over de bestandsconfig heen) en maken de server dan
    // wél bereikbaar vanaf het netwerk. Start de devserver dus zonder
    // --host.
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
