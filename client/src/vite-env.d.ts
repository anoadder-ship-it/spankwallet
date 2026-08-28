/// <reference types="vite/client" />

interface ImportMetaEnv {
  // STATUS.md sectie 107/109: optionele override voor de hardcoded
  // Helius-devnet-sleutel in main.ts - geen echte secret, zie daar.
  readonly VITE_HELIUS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
