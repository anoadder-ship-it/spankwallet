import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const SECP256R1_PROGRAM_ID = new PublicKey(
  "Secp256r1SigVerify1111111111111111111111111"
);

const CURVE_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
);
const HALF_CURVE_ORDER = CURVE_ORDER / 2n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function derToRawSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  let offset = 0;
  if (der[offset++] !== 0x30) {
    throw new Error("Ongeldige DER-handtekening: verwacht SEQUENCE-tag 0x30");
  }
  offset++;

  if (der[offset++] !== 0x02) {
    throw new Error("Ongeldige DER-handtekening: verwacht INTEGER-tag voor r");
  }
  let rLen = der[offset++];
  let rBytes = der.slice(offset, offset + rLen);
  offset += rLen;
  while (rBytes.length > 32 && rBytes[0] === 0x00) {
    rBytes = rBytes.slice(1);
  }

  if (der[offset++] !== 0x02) {
    throw new Error("Ongeldige DER-handtekening: verwacht INTEGER-tag voor s");
  }
  let sLen = der[offset++];
  let sBytes = der.slice(offset, offset + sLen);
  while (sBytes.length > 32 && sBytes[0] === 0x00) {
    sBytes = sBytes.slice(1);
  }

  const r = new Uint8Array(32);
  r.set(rBytes, 32 - rBytes.length);
  const s = new Uint8Array(32);
  s.set(sBytes, 32 - sBytes.length);

  return { r, s };
}

function normalizeS(s: Uint8Array): Uint8Array {
  const sValue = bytesToBigInt(s);
  if (sValue > HALF_CURVE_ORDER) {
    return bigIntTo32Bytes(CURVE_ORDER - sValue);
  }
  return s;
}

export function derSignatureToRawLowS(der: Uint8Array): Uint8Array {
  const { r, s } = derToRawSignature(der);
  const normalizedS = normalizeS(s);
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(normalizedS, 32);
  return out;
}

export function buildSecp256r1Instruction(
  compressedPubkey: Uint8Array,
  message: Uint8Array,
  rawSignature: Uint8Array
): TransactionInstruction {
  if (compressedPubkey.length !== 33) {
    throw new Error("publieke sleutel moet 33 bytes zijn, kreeg " + compressedPubkey.length);
  }
  if (rawSignature.length !== 64) {
    throw new Error("handtekening moet 64 bytes zijn, kreeg " + rawSignature.length);
  }

  const NO_OWN_INSTRUCTION = 0xffff;
  const HEADER_LEN = 2;
  const OFFSETS_STRUCT_LEN = 14;
  const dataStart = HEADER_LEN + OFFSETS_STRUCT_LEN;

  const signatureOffset = dataStart;
  const publicKeyOffset = signatureOffset + rawSignature.length;
  const messageOffset = publicKeyOffset + compressedPubkey.length;

  const totalLen = messageOffset + message.length;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  data[0] = 1;
  data[1] = 0;

  let o = HEADER_LEN;
  view.setUint16(o, signatureOffset, true); o += 2;
  view.setUint16(o, NO_OWN_INSTRUCTION, true); o += 2;
  view.setUint16(o, publicKeyOffset, true); o += 2;
  view.setUint16(o, NO_OWN_INSTRUCTION, true); o += 2;
  view.setUint16(o, messageOffset, true); o += 2;
  view.setUint16(o, message.length, true); o += 2;
  view.setUint16(o, NO_OWN_INSTRUCTION, true); o += 2;

  data.set(rawSignature, signatureOffset);
  data.set(compressedPubkey, publicKeyOffset);
  data.set(message, messageOffset);

  return new TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data: Buffer.from(data),
  });
}
