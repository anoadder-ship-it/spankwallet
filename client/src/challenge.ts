import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { SPANKWALLET_PROGRAM_ID } from "./programId";

// Fase C-opschoning: deze drie helpers stonden eerder gedupliceerd in
// execute.ts, hunt.ts, recovery.ts en initWallet.ts (vier bijna-identieke
// kopieen). Samengevoegd tot dit ene gedeelde bestand - zie STATUS.md.

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, bytes.length, true);
  return concatBytes(lenBytes, bytes);
}

/**
 * Exacte TS-tegenhanger van build_expected_challenge() in instructions.rs:
 * Keccak-256 (NIET NIST-SHA3) over program_id || wallet || domain || payload.
 */
export function buildExpectedChallenge(
  wallet: PublicKey,
  domain: string,
  payload: Uint8Array
): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const combined = concatBytes(
    SPANKWALLET_PROGRAM_ID.toBytes(),
    wallet.toBytes(),
    domainBytes,
    payload
  );
  return keccak_256(combined);
}
