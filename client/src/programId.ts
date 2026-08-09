import { PublicKey } from "@solana/web3.js";

// Eigen, klein bestand i.p.v. deze constante in initWallet.ts te laten staan
// - voorkomt een circulaire import tussen challenge.ts en initWallet.ts
// (challenge.ts heeft het programma-ID nodig, initWallet.ts heeft op zijn
// beurt de gedeelde challenge-helpers nodig). Zie STATUS.md, Fase C.
export const SPANKWALLET_PROGRAM_ID = new PublicKey(
  "ERAEjxMgxserGuj8hc6v7LVy6ZaXaVxwDtXFLbsxj8wY"
);
