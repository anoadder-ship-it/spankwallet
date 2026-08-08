import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { ConnectedWallet } from "./wallet";
import { signWithPasskey } from "./webauthnSign";
import { buildSecp256r1Instruction } from "./secp256r1";
import { SPANKWALLET_PROGRAM_ID } from "./initWallet";

const HUNT_DISCRIMINATOR = Uint8Array.from([
  0x94, 0x1e, 0x1c, 0x39, 0x31, 0xf9, 0x1d, 0x41,
]);

// Solana's algemeen erkende "dead address" - zelfde adres als in
// instructions.rs's INCINERATOR-constante. Zie STATUS.md voor de motivatie
// (helft van hunt's teruggewonnen rent gaat hierheen, permanent uit omloop).
export const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function encodeBorshVecU8(bytes: Uint8Array): Uint8Array {
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, bytes.length, true);
  return concatBytes(lenBytes, bytes);
}

function buildExpectedChallenge(
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

export interface SpamTokenSetupResult {
  mint: PublicKey;
  tokenAccount: PublicKey;
}

export async function setupSpamTokenAccount(
  connection: Connection,
  wallet: ConnectedWallet,
  vaultPda: PublicKey
): Promise<SpamTokenSetupResult> {
  const mintKeypair = Keypair.generate();
  const rentExemptLamports = await getMinimumBalanceForRentExemptMint(connection);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SIZE,
      lamports: rentExemptLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintKeypair.publicKey, 0, wallet.publicKey, null)
  );
  createMintTx.feePayer = wallet.publicKey;
  const { blockhash: bh1 } = await connection.getLatestBlockhash();
  createMintTx.recentBlockhash = bh1;
  createMintTx.partialSign(mintKeypair);

  const { signature: mintSig } = await wallet.signAndSendTransaction(createMintTx);
  await connection.confirmTransaction(mintSig, "confirmed");

  const tokenAccount = getAssociatedTokenAddressSync(mintKeypair.publicKey, vaultPda, true);

  const setupTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      tokenAccount,
      vaultPda,
      mintKeypair.publicKey
    ),
    createMintToInstruction(mintKeypair.publicKey, tokenAccount, wallet.publicKey, 1000)
  );
  setupTx.feePayer = wallet.publicKey;
  const { blockhash: bh2 } = await connection.getLatestBlockhash();
  setupTx.recentBlockhash = bh2;

  const { signature: setupSig } = await wallet.signAndSendTransaction(setupTx);
  await connection.confirmTransaction(setupSig, "confirmed");

  return { mint: mintKeypair.publicKey, tokenAccount };
}

export interface HuntResult {
  transaction: Transaction;
}

export async function buildHuntTransaction(
  connection: Connection,
  payer: PublicKey,
  walletPda: PublicKey,
  vaultPda: PublicKey,
  targetTokenAccount: PublicKey,
  tokenMint: PublicKey,
  passkeyCompressedPublicKey: Uint8Array,
  credentialId: Uint8Array,
  rpId: string
): Promise<HuntResult> {
  const expectedChallenge = buildExpectedChallenge(
    walletPda,
    "hunt",
    targetTokenAccount.toBytes()
  );

  const { signedMessage, rawSignature, clientDataJSON } = await signWithPasskey(
    rpId,
    credentialId,
    expectedChallenge
  );

  const secp256r1Ix = buildSecp256r1Instruction(
    passkeyCompressedPublicKey,
    signedMessage,
    rawSignature
  );

  const data = concatBytes(HUNT_DISCRIMINATOR, encodeBorshVecU8(clientDataJSON));

  const huntIx = new TransactionInstruction({
    programId: SPANKWALLET_PROGRAM_ID,
    keys: [
      { pubkey: walletPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: targetTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: INCINERATOR, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const transaction = new Transaction().add(secp256r1Ix, huntIx);
  transaction.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction };
}
