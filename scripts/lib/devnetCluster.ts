import { Connection } from "@solana/web3.js";

/**
 * STATUS.md sectie 167 (review §162, M-1): beide pre-flight-scripts lezen
 * alleen van devnet. RPC_URL mag een andere devnet-node kiezen, nooit een
 * andere cluster: een lokale test-validator heeft hetzelfde programma-ID
 * (Anchor.toml) en kan dus een "groene" staat tonen die niets over devnet
 * zegt. De genesis-hash identificeert de cluster, los van de URL.
 *
 * Devnet-genesis, gelezen via getGenesisHash op 2026-09-29 en vastgelegd in
 * tests/unit/fixtures/devnetSquads20260929.json.
 */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function genesisHashProblem(actual: string): string | null {
  return actual === DEVNET_GENESIS_HASH ? null : `genesis-hash ${actual} is niet die van devnet (${DEVNET_GENESIS_HASH})`;
}

/** Eerste aanroep van elk script: exit 2 bij een andere cluster, vóór er iets anders gelezen wordt. */
export async function exitUnlessDevnet(connection: Connection, rpcUrl: string): Promise<void> {
  const problem = genesisHashProblem(await connection.getGenesisHash());
  if (problem) {
    console.error(`CLUSTER GEWEIGERD (${rpcUrl}): ${problem}. Niets verder gecontroleerd.`);
    process.exit(2);
  }
}
