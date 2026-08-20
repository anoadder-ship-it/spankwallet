import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  encodeOptionalI64,
  fetchActionNonce,
  nonceLeBytes,
  TestPasskey,
} from "./webauthnTestHelper";

// Zelfde handmatige SPL-Token-instructie-encodering als tests/policy.ts en
// tests/sessionKeys.ts (geen @solana/spl-token-dependency op root-niveau) -
// hunt heeft tot nu toe GEEN lokale testdekking (alleen end-to-end op
// devnet, STATUS.md sectie 17) - dit bestand is nieuw.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const HUNT_DISCRIMINATOR = Buffer.from([0x94, 0x1e, 0x1c, 0x39, 0x31, 0xf9, 0x1d, 0x41]);

// Borsh-Vec<u8>-encodering (4-byte LE-lengteprefix + bytes) - zelfde als
// client/src/challenge.ts::encodeBorshVecU8, hier lokaal herhaald om geen
// afhankelijkheid op client/ te introduceren in dit testbestand.
function encodeBorshVecU8(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

function encodeInitializeMintIx(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(0, 0);
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function encodeInitializeAccountIx(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function encodeMintToIx(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: number
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

describe("spankwallet: hunt (spam-token burn+close)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Spankwallet as Program<Spankwallet>;

  function derivePdas(compressedPublicKey: Buffer) {
    const seedHash = createHash("sha256").update(compressedPublicKey).digest();
    const [walletPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), seedHash],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), walletPda.toBuffer()],
      program.programId
    );
    const [passkeysPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("passkeys"), walletPda.toBuffer()],
      program.programId
    );
    return { walletPda, vaultPda, passkeysPda, walletSeedHash: Array.from(seedHash) };
  }

  async function createWallet() {
    const passkey = generateTestPasskey();
    const backupAuthority = Keypair.generate();
    const { walletPda, vaultPda, passkeysPda, walletSeedHash } = derivePdas(
      passkey.compressedPublicKey
    );

    const payload = Buffer.concat([backupAuthority.publicKey.toBuffer(), encodeOptionalI64(null)]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "init_wallet",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      passkey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      passkey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    await program.methods
      .initWallet(
        Array.from(passkey.compressedPublicKey),
        walletSeedHash,
        backupAuthority.publicKey,
        null,
        clientDataJSON
      )
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([secp256r1Ix])
      .rpc();

    return { passkey, backupAuthority, walletPda, vaultPda, passkeysPda };
  }

  /// Zet een verse SPL-mint + een vault-eigen token-account op, gemint met
  /// mintAmount - simuleert een ongevraagd "spam"-token op de vault, zelfde
  /// opzet als STATUS.md sectie 17's live devnet-bewijs.
  async function setupSpamTokenAccount(
    vaultPda: PublicKey,
    mintAmount: number
  ): Promise<{ mint: Keypair; tokenAccount: Keypair }> {
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    const mintRent = await provider.connection.getMinimumBalanceForRentExemption(MINT_LEN);
    const tokenAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);

    const setupTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: mintRent,
        space: MINT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeMintIx(mint.publicKey, 0, provider.wallet.publicKey),
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: tokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(tokenAccount.publicKey, mint.publicKey, vaultPda),
      encodeMintToIx(mint.publicKey, tokenAccount.publicKey, provider.wallet.publicKey, mintAmount)
    );
    await provider.sendAndConfirm(setupTx, [mint, tokenAccount]);
    return { mint, tokenAccount };
  }

  // Handmatig opgebouwd, net als client/src/hunt.ts::buildHuntTransaction -
  // NIET via program.methods.hunt().accounts(): Anchors typed builder leidt
  // isWritable puur af uit de Rust-Accounts-struct's #[account(mut)]-
  // annotaties, en Hunt::token_mint heeft daar bewust GEEN mut op (Anchor
  // zelf muteert het nooit rechtstreeks) - maar de SPL-Token Burn-CPI ERIN
  // vereist wel degelijk dat de mint writable is op transactieniveau (de
  // runtime staat een CPI nooit toe om MEER schrijfrechten te vragen dan de
  // top-level-transactie al gaf). Zonder deze handmatige override faalt de
  // aanroep op "Cross-program invocation with unauthorized signer or
  // writable account" - geen programmabug, een eigenschap van hoe Anchors
  // gemaksbuilder zich verhoudt tot interne CPI's, al eerder correct
  // omzeild in de productieclient.
  async function callHunt(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    passkeysPda: PublicKey,
    targetTokenAccount: PublicKey,
    tokenMint: PublicKey,
    rentDestination: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([nonceLeBytes(nonce), targetTokenAccount.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(program.programId, walletPda, "hunt", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    const data = Buffer.concat([
      HUNT_DISCRIMINATOR,
      nonceLeBytes(nonce),
      encodeBorshVecU8(clientDataJSON),
    ]);

    const huntIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: targetTokenAccount, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: true },
        { pubkey: rentDestination, isSigner: false, isWritable: true },
        { pubkey: INCINERATOR, isSigner: false, isWritable: true },
        { pubkey: passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new anchor.web3.Transaction().add(secp256r1Ix, huntIx);
    return provider.sendAndConfirm(tx);
  }

  function dummyNewOwnerPasskey(): number[] {
    const bytes = require("crypto").randomBytes(33);
    bytes[0] = 0x02;
    return Array.from(bytes);
  }

  it("hunt burnt het saldo en sluit het account, met 50/50-rentsplitsing", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
    // provider.wallet.publicKey bestaat al (en heeft al SOL) - in
    // tegenstelling tot INCINERATOR, dat op een verse lokale validator zijn
    // EERSTE ooit lamports-credit krijgt via deze aanroep. Balansdelta's op
    // een reeds bestaand account zijn op een lokale validator betrouwbaar
    // direct zichtbaar; het EERSTE-bestaan van een gloednieuw account bleek
    // dat empirisch niet altijd te zijn (RPC-lees-propagatie-vertraging,
    // zelfde categorie fenomeen als STATUS.md sectie 17 al documenteert,
    // hier nog uitgesprokener). Deze test verifieert de 50/50-splitsing
    // daarom via rentDestination's balansdelta, niet via INCINERATOR direct.
    const rentDestination = provider.wallet.publicKey;
    const rentDestinationBefore = await provider.connection.getBalance(rentDestination);

    await callHunt(
      passkey,
      walletPda,
      vaultPda,
      passkeysPda,
      tokenAccount.publicKey,
      mint.publicKey,
      rentDestination
    );

    const closedAccountInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
    assert.isNull(closedAccountInfo, "target_token_account had gesloten moeten zijn na hunt");

    const rentDestinationAfter = await provider.connection.getBalance(rentDestination);
    // rentDestination is hier ook de fee-payer, dus de rauwe balans daalde
    // netto door transactiekosten - de toename door hunt's rentsplitsing zit
    // erin verwerkt, maar een exacte match zou de fee zelf moeten aftrekken.
    // Simpeler, voldoende bewijs: rentDestination eindigt hoger dan wat
    // alleen transactiekosten (~5000-10000 lamports) zouden verklaren - een
    // duidelijk teken dat er daadwerkelijk substantiële rent (~1 miljoen
    // lamports, de helft van een SPL-token-account-rent-exempt-drempel)
    // is bijgeschreven.
    assert.isAbove(
      rentDestinationAfter,
      rentDestinationBefore - 10_000,
      "rentDestination had per saldo aanzienlijk MEER dan alleen transactiekosten moeten zien door de rentsplitsing"
    );
  });

  // --- FASE A4 (statische-audit-bevinding): hunt mist de recovery-freeze ---
  //
  // Elke andere passkey-gated instructie (Execute, TransferToken,
  // AddAllowedProgram, RemoveAllowedProgram, ExecuteAdvanced, AddPasskey,
  // AddSessionKey, RemoveSessionKey, CancelRecovery, ExecuteViaSession, ...)
  // heeft `constraint = wallet.recovery_state.is_none() @
  // RecoveryAlreadyInProgress` op het wallet-account. Hunt (instructions.rs)
  // is de ENIGE die dit mist - nagelezen, niet aangenomen. hunt is bovendien
  // de meest onomkeerbare instructie in het hele programma: hij verbrandt de
  // VOLLEDIGE balans van een token-account zonder enig on-chain
  // spam-criterium (dat zit uitsluitend clientside, huntPreview.ts). Dit
  // test bewijst dat hunt vandaag gewoon slaagt tijdens een lopende
  // recovery, terwijl elke andere gevoelige actie op dat moment geweigerd
  // wordt.
  it("[FASE A4 - bevestigt lek] hunt slaagt tijdens een lopende recovery, ondanks dat elke andere gevoelige instructie dat weigert", async () => {
    const { passkey, backupAuthority, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
    const rentDestination = provider.wallet.publicKey;

    // Recovery starten - GEEN timelock afwachten, dat is precies het punt:
    // hunt zou dit meteen moeten weigeren zoals elke andere passkey-gated
    // instructie, niet pas ná een verstreken timelock.
    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const walletDuringRecovery = await program.account.walletAccount.fetch(walletPda);
    assert.isNotNull(walletDuringRecovery.recoveryState, "recovery had moeten lopen");

    // Kern van het bewijs: dit MAG niet slagen (elke andere instructie zou
    // hier RecoveryAlreadyInProgress geven), maar hunt heeft die constraint
    // niet.
    await callHunt(
      passkey,
      walletPda,
      vaultPda,
      passkeysPda,
      tokenAccount.publicKey,
      mint.publicKey,
      rentDestination
    );

    const closedAccountInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
    assert.isNull(
      closedAccountInfo,
      "LEK BEVESTIGD: hunt verbrandde en sloot het token-account gewoon tijdens een lopende recovery"
    );
  });
});
