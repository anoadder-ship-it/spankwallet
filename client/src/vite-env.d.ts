/// <reference types="vite/client" />

interface ImportMetaEnv {
  // STATUS.md sectie 194: de Helius-devnet-sleutel, een geheim. Alleen in
  // client/.env.local (genegeerd door .gitignore), nooit in git. Er is geen
  // terugvalwaarde: zonder geldige sleutel maakt main.ts geen verbinding.
  readonly VITE_HELIUS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
