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

// C-1-fix (STATUS.md sectie 69): action_nonce staat als laatste veld
// aangehangen aan WalletAccount, NA twee Option<T>-velden (recovery_state,
// deposit_authority). Borsh codeert Option::None als exact 1 tagbyte, NIET
// als de volledige "maximale" ruimte - WalletAccount::LEN is puur de
// TOEGEWEZEN accountgrootte (space bij aanmaak), geen garantie dat elk veld
// altijd op een vaste offset staat. Een NAIEF vast offset (231, "231-byte
// oude layout + 8") bleek daardoor FOUT zodra recovery_state/
// deposit_authority None zijn (het gewone geval) - empirisch ontdekt: Anchors
// eigen program.account.walletAccount.fetch() gaf actionNonce=1 na een
// geslaagde add_passkey, terwijl handmatig lezen op offset 231 stug 0 bleef
// tonen (zowel "confirmed" als "finalized" - geen commitment-race, een
// echt fout offset). Dus: de tag-bytes daadwerkelijk lezen en het echte,
// variabele offset opbouwen - zelfde aanpak als recovery.ts al voor
// recovery_state deed, hier doorgetrokken tot en met action_nonce.
const OFFSET_RECOVERY_STATE_TAG = 148; // discriminator(8)+seed_key(33)+wallet_seed_hash(32)+owner_passkey(33)+bump(1)+vault_bump(1)+created_at(8)+backup_authority(32)
const RECOVERY_STATE_LEN = 41; // initiated_at(8) + new_owner_passkey(33), zonder de 1-byte Option-tag

export function actionNonceOffset(data: Buffer): number {
  let offset = OFFSET_RECOVERY_STATE_TAG;
  const recoveryStateTag = data[offset];
  offset += 1;
  if (recoveryStateTag === 1) offset += RECOVERY_STATE_LEN;
  offset += 8; // recovery_timelock_seconds: i64, geen Option, altijd aanwezig
  const depositAuthorityTag = data[offset];
  offset += 1;
  if (depositAuthorityTag === 1) offset += 32; // Pubkey
  return offset;
}

export async function fetchActionNonce(
  connection: Connection,
  walletPda: PublicKey
): Promise<bigint> {
  // Poll tot twee opeenvolgende reads IDENTIEKE bytes teruggeven, i.p.v. te
  // stoppen zodra het account uberhaupt bestaat: een lokale validator onder
  // belasting (veel testtransacties kort na elkaar, gedeelde machine) bleek
  // soms een NIET-lege maar nog VEROUDERDE snapshot terug te geven vlak na
  // een net bevestigde transactie (RPC-lees-propagatie-gat, geen echte
  // account-afwezigheid) - een enkele niet-null-check ving dat niet, een
  // eenmalig stale nonce leidde verderop tot StaleActionNonce. Twee
  // stabiele, gelijke reads na elkaar is een goedkope, generieke garantie
  // dat de data niet meer aan het verschuiven is - zelfde categorie
  // RPC-consistentie-fenomeen als STATUS.md sectie 17/38 al documenteren.
  let previous: Buffer | null = null;
  let info = await connection.getAccountInfo(walletPda, "confirmed");
  for (let i = 0; i < 30; i++) {
    if (info !== null && previous !== null && info.data.equals(previous)) {
      break;
    }
    previous = info?.data ?? null;
    await new Promise((r) => setTimeout(r, 100));
    info = await connection.getAccountInfo(walletPda, "confirmed");
  }
  if (!info) {
    throw new Error("fetchActionNonce: WalletAccount bestaat niet: " + walletPda.toBase58());
  }
  return info.data.readBigUInt64LE(actionNonceOffset(info.data));
}

export function nonceLeBytes(nonce: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(nonce);
  return buf;
}

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
 * Slot-tegenhanger van advanceOnChainClockPast hierboven - voor
 * session-key-expiry (STATUS.md), die bewust slot-hoogte gebruikt, geen
 * unix-timestamp (zie ontwerppunt 1/5). Zelfde aanpak: actief kleine, echte
 * transacties versturen totdat de on-chain slot de gewenste hoogte
 * daadwerkelijk gepasseerd is, i.p.v. blind wachten - een idle lokale
 * validator produceert nauwelijks nieuwe slots uit zichzelf.
 */
export async function advanceSlotPast(
  connection: Connection,
  payer: Keypair,
  targetSlot: number,
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
    if (slot > targetSlot) {
      return;
    }
    if (Date.now() - start > maxRealMs) {
      throw new Error("advanceSlotPast: on-chain slot bereikte targetSlot niet binnen maxRealMs");
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
