import { p256 } from "@noble/curves/p256";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash, randomBytes } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export const SECP256R1_PROGRAM_ID = new PublicKey(
  "Secp256r1SigVerify1111111111111111111111111"
);

export interface TestPasskey {
  privateKey: Uint8Array;
  compressedPublicKey: Buffer;
}

export function generateTestPasskey(): TestPasskey {
  const privateKey = p256.utils.randomPrivateKey();
  const compressedPublicKey = Buffer.from(p256.getPublicKey(privateKey, true));
  return { privateKey, compressedPublicKey };
}

function base64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildExpectedChallenge(
  programId: PublicKey,
  wallet: PublicKey,
  domain: string,
  payload: Buffer
): Buffer {
  const domainBytes = Buffer.from(domain, "utf-8");
  const combined = Buffer.concat([
    programId.toBuffer(),
    wallet.toBuffer(),
    domainBytes,
    payload,
  ]);
  return Buffer.from(keccak_256(combined));
}

export interface SignedTestChallenge {
  signedMessage: Buffer;
  rawSignature: Buffer;
  clientDataJSON: Buffer;
}

// UP (User Present, bit 0x01) | UV (User Verified, bit 0x04) - de vlaggen
// die een echte authenticator zet wanneer userVerification: "required" is
// aangevraagd (zie client/src/webauthnSign.ts). Dit is de default voor alle
// gewone happy-path-tests; signTestChallenge accepteert een override zodat
// de UV-hardening (STATUS.md) ook expliciet getest kan worden met een vlag
// die UV NIET zet. Idem voor het optionele webauthnType-argument: default
// "webauthn.get" (de enige geldige waarde voor een assertie), met een
// override zodat de "type"-hardening ook expliciet getest kan worden met
// een verkeerde/ontbrekende waarde.
export const AUTHENTICATOR_FLAGS_UP_UV = 0x05;

export function signTestChallenge(
  passkey: TestPasskey,
  expectedChallenge: Buffer,
  authenticatorFlags: number = AUTHENTICATOR_FLAGS_UP_UV,
  webauthnType: string = "webauthn.get"
): SignedTestChallenge {
  const challengeB64url = base64url(expectedChallenge);
  const clientData = {
    type: webauthnType,
    challenge: challengeB64url,
    origin: "https://spankwallet-tests.local",
    crossOrigin: false,
  };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData), "utf-8");
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();

  // authenticatorData-layout (WebAuthn spec §6.1): rpIdHash(32) + flags(1) +
  // signCount(4). rpIdHash/signCount worden door dit programma niet
  // gecontroleerd (willekeurige bytes volstaan voor tests) - de flags-byte
  // WEL sinds de UV-hardening, vandaar hier expliciet en niet langer
  // onderdeel van volledig willekeurige bytes (de oude `randomBytes(37)`
  // had ~50% kans om de UV-bit NIET te zetten en zou nu willekeurig falen).
  const rpIdHash = randomBytes(32);
  const signCount = randomBytes(4);
  const authenticatorData = Buffer.concat([
    rpIdHash,
    Buffer.from([authenticatorFlags]),
    signCount,
  ]);

  const signedMessage = Buffer.concat([authenticatorData, clientDataHash]);
  const messageHash = createHash("sha256").update(signedMessage).digest();

  const signature = p256.sign(messageHash, passkey.privateKey, { lowS: true });
  const rawSignature = Buffer.from(signature.toCompactRawBytes());

  return { signedMessage, rawSignature, clientDataJSON };
}

export function buildSecp256r1Instruction(
  compressedPubkey: Buffer,
  message: Buffer,
  rawSignature: Buffer
): TransactionInstruction {
  if (compressedPubkey.length !== 33) {
    throw new Error(`publieke sleutel moet 33 bytes zijn, kreeg ${compressedPubkey.length}`);
  }
  if (rawSignature.length !== 64) {
    throw new Error(`handtekening moet 64 bytes zijn, kreeg ${rawSignature.length}`);
  }

  const NO_OWN_INSTRUCTION = 0xffff;
  const HEADER_LEN = 2;
  const OFFSETS_STRUCT_LEN = 14;
  const dataStart = HEADER_LEN + OFFSETS_STRUCT_LEN;

  const signatureOffset = dataStart;
  const publicKeyOffset = signatureOffset + rawSignature.length;
  const messageOffset = publicKeyOffset + compressedPubkey.length;
  const totalLen = messageOffset + message.length;

  const data = Buffer.alloc(totalLen);
  data[0] = 1;
  data[1] = 0;

  let o = HEADER_LEN;
  data.writeUInt16LE(signatureOffset, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;
  data.writeUInt16LE(publicKeyOffset, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;
  data.writeUInt16LE(messageOffset, o); o += 2;
  data.writeUInt16LE(message.length, o); o += 2;
  data.writeUInt16LE(NO_OWN_INSTRUCTION, o); o += 2;

  rawSignature.copy(data, signatureOffset);
  compressedPubkey.copy(data, publicKeyOffset);
  message.copy(data, messageOffset);

  return new TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data,
  });
}

/**
 * Forceert het produceren van nieuwe slots (en dus klok-voortgang) op de
 * lokale test-validator door herhaaldelijk kleine, echte transacties te
 * versturen, totdat de on-chain klok (Clock-sysvar, via getBlockTime)
 * `targetUnixTime` gepasseerd is. Nodig omdat een pure `sleep()` NIET
 * betrouwbaar is: de lokale solana-test-validator produceert nieuwe slots
 * primair naar aanleiding van transactie-activiteit, niet puur op basis van
 * verstreken werkelijke tijd - tijdens een idle sleep kan de on-chain klok
 * daardoor ver achterblijven bij de werkelijke tijd (empirisch bevestigd
 * tijdens het debuggen hiervan: 11 seconden slapen leverde slechts ~1
 * seconde on-chain klokvooruitgang op). Dit is de daadwerkelijke oorzaak
 * achter de al langer bekende flaky recovery-timing-tests (STATUS.md sectie
 * 34-37) - een grotere sleep-marge verhelpt het niet structureel, actief
 * nieuwe transacties forceren wel.
 */
export async function advanceOnChainClockPast(
  connection: Connection,
  payer: Keypair,
  targetUnixTime: number,
  maxRealMs: number = 60000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });

    const slot = await connection.getSlot();
    const chainNow = await connection.getBlockTime(slot);
    if (chainNow !== null && chainNow > targetUnixTime) {
      return;
    }
    if (Date.now() - start > maxRealMs) {
      throw new Error(
        "advanceOnChainClockPast: on-chain klok bereikte targetUnixTime niet binnen maxRealMs"
      );
    }
  }
}

/**
 * Exacte TS-tegenhanger van encode_optional_i64() in instructions.rs - voor
 * de init_wallet-challenge-payload (bindt backup_authority en
 * recovery_timelock_seconds aan de handtekening, zie STATUS.md sectie 22).
 */
export function encodeOptionalI64(value: number | null): Buffer {
  const out = Buffer.alloc(9);
  if (value !== null) {
    out[0] = 1;
    out.writeBigInt64LE(BigInt(value), 1);
  }
  return out;
}
