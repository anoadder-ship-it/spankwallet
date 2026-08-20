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
  // B5 (STATUS.md sectie 76): rent_destination nu gebonden in de payload
  // (nonce || target_token_account || rent_destination), in lockstep met
  // instructions.rs::hunt en client/src/hunt.ts. `signAsRentDestination`
  // laat toe om een AFWIJKENDE rentDestination te ondertekenen dan wat
  // daadwerkelijk in de instructie terechtkomt - alleen gebruikt door de
  // B5-manipulatietest hieronder om te bewijzen dat zo'n mismatch de
  // handtekeningverificatie laat falen.
  async function callHunt(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    passkeysPda: PublicKey,
    targetTokenAccount: PublicKey,
    tokenMint: PublicKey,
    rentDestination: PublicKey,
    signAsRentDestination?: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      targetTokenAccount.toBuffer(),
      (signAsRentDestination ?? rentDestination).toBuffer(),
    ]);
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

  it("hunt burnt het saldo en sluit het account, met 50/50-rentsplitsing naar zowel rent_destination als de incinerator", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
    // INCINERATOR krijgt op een verse lokale validator zijn EERSTE ooit
    // lamports-credit via deze aanroep - een losse, onmiddellijk
    // daaropvolgende balansquery bleek daarvoor empirisch niet altijd
    // betrouwbaar (RPC-lees-propagatie, zelfde categorie fenomeen als
    // STATUS.md sectie 17 al documenteert). Opgelost door de daadwerkelijke
    // pre-/post-lamport-balansen rechtstreeks uit de transactie-meta te
    // lezen (zie txInfo hieronder) i.p.v. losse balansqueries vóór/na.
    const rentDestination = provider.wallet.publicKey;

    const tokenAccountRentExempt =
      await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);

    const signature = await callHunt(
      passkey,
      walletPda,
      vaultPda,
      passkeysPda,
      tokenAccount.publicKey,
      mint.publicKey,
      rentDestination
    );

    // Harde bron van waarheid: de daadwerkelijke pre-/post-lamport-balansen
    // uit de transactie zelf (zelfde bewijspatroon als STATUS.md sectie 17 -
    // "solana confirm -v" i.p.v. een losse, mogelijk vroege balansquery).
    // Korte poll: getTransaction() bleek vlak na sendAndConfirm() soms nog
    // null terug te geven op deze lokale validator (zelfde RPC-lees-
    // propagatie-fenomeen als elders in dit project, nu op deze RPC-methode).
    let txInfo = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    for (let i = 0; i < 20 && (!txInfo || !txInfo.meta); i++) {
      await new Promise((r) => setTimeout(r, 100));
      txInfo = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    }
    if (!txInfo || !txInfo.meta) {
      throw new Error("kon de hunt-transactie niet terugvinden voor balansverificatie");
    }
    // preBalances/postBalances zijn geïndexeerd volgens de SAMENGEVOEGDE
    // accountKeys-lijst van de HELE transactie (fee-payer eerst, dan alle
    // unieke accounts uit ALLE instructies, in Solana's eigen signer-/
    // writable-gesorteerde volgorde) - NIET simpelweg de lokale keys-lijst
    // van de hunt-instructie alleen (die ook nog eens de secp256r1Ix's eigen
    // accounts mist). De index moet dus uit de transactie's eigen
    // boodschap komen, niet uit `keys` hierboven.
    const txAccountKeys = txInfo.transaction.message.getAccountKeys().staticAccountKeys;
    const incineratorIndex = txAccountKeys.findIndex((k) => k.equals(INCINERATOR));
    const incineratorTxDelta =
      txInfo.meta.postBalances[incineratorIndex] - txInfo.meta.preBalances[incineratorIndex];

    const closedAccountInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
    assert.isNull(closedAccountInfo, "target_token_account had gesloten moeten zijn na hunt");

    // Verwachte splitsing, exact zoals instructions.rs::hunt die berekent:
    // to_incinerator = reclaimed / 2 (floor), to_user = reclaimed - to_incinerator.
    const reclaimed = tokenAccountRentExempt;
    const expectedToIncinerator = Math.floor(reclaimed / 2);
    const expectedToUser = reclaimed - expectedToIncinerator;

    assert.equal(
      incineratorTxDelta,
      expectedToIncinerator,
      "incinerator had exact de helft (afgerond naar beneden) van de teruggewonnen rent moeten ontvangen"
    );

    // Zelfde bron (transactie-meta) voor rentDestination - rentDestination
    // is hier ook de fee-payer, dus een LOSSE balansquery zou ook de
    // transactiekosten meetellen; de meta geeft de exacte, geïsoleerde
    // delta van deze ene transactie, geen fudge-marge nodig.
    const rentDestinationIndex = txAccountKeys.findIndex((k) => k.equals(rentDestination));
    const rentDestinationTxDelta =
      txInfo.meta.postBalances[rentDestinationIndex] - txInfo.meta.preBalances[rentDestinationIndex];
    const fee = txInfo.meta.fee;
    assert.equal(
      rentDestinationTxDelta + fee,
      expectedToUser,
      "rentDestination had (na optellen van de betaalde fee) exact de andere helft van de teruggewonnen rent moeten ontvangen"
    );
  });

  // --- FASE A4/B4 (statische-audit-bevinding + fix): hunt miste de
  // recovery-freeze, nu gedicht ---
  //
  // Elke andere passkey-gated instructie (Execute, TransferToken,
  // AddAllowedProgram, RemoveAllowedProgram, ExecuteAdvanced, AddPasskey,
  // AddSessionKey, RemoveSessionKey, CancelRecovery, ExecuteViaSession, ...)
  // heeft `constraint = wallet.recovery_state.is_none() @
  // RecoveryAlreadyInProgress` op het wallet-account. Hunt was de ENIGE die
  // dit miste - hunt is bovendien de meest onomkeerbare instructie in het
  // hele programma: hij verbrandt de VOLLEDIGE balans van een token-account
  // zonder enig on-chain spam-criterium (dat zit uitsluitend clientside,
  // huntPreview.ts). B4 voegt dezelfde constraint toe die elke andere
  // instructie al had.
  it("[B4] hunt weigert nu tijdens een lopende recovery (RecoveryAlreadyInProgress) - was voorheen het lek", async () => {
    const { passkey, backupAuthority, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);
    const rentDestination = provider.wallet.publicKey;

    // Recovery starten - GEEN timelock afwachten, dat is precies het punt:
    // hunt moet dit nu meteen weigeren zoals elke andere passkey-gated
    // instructie, niet pas ná een verstreken timelock.
    await program.methods
      .initiateRecovery(dummyNewOwnerPasskey())
      .accounts({ wallet: walletPda, backupAuthority: backupAuthority.publicKey })
      .signers([backupAuthority])
      .rpc();

    const walletDuringRecovery = await program.account.walletAccount.fetch(walletPda);
    assert.isNotNull(walletDuringRecovery.recoveryState, "recovery had moeten lopen");

    let threw = false;
    let errorMessage = "";
    try {
      await callHunt(
        passkey,
        walletPda,
        vaultPda,
        passkeysPda,
        tokenAccount.publicKey,
        mint.publicKey,
        rentDestination
      );
    } catch (err) {
      threw = true;
      errorMessage = err.toString();
    }
    assert.isTrue(
      threw,
      "FIX GEVERIFIEERD: hunt had moeten weigeren tijdens een lopende recovery"
    );
    assert.include(
      errorMessage,
      "RecoveryAlreadyInProgress",
      "de weigering had specifiek RecoveryAlreadyInProgress moeten zijn, niet een andere fout"
    );

    // De andere tak: het token-account is NIET aangeraakt - nog steeds
    // intact, niet gesloten.
    const accountInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
    assert.isNotNull(
      accountInfo,
      "target_token_account had onaangeraakt moeten blijven na de geweigerde hunt-poging"
    );
  });
  // De andere tak - hunt slaagt gewoon WANNEER er geen recovery loopt - is
  // al gedekt door de "hunt burnt het saldo..."-test hierboven (geen
  // recovery_state daar), dus niet nogmaals herhaald.

  // --- B5 (STATUS.md sectie 76): rent_destination nu gebonden in de
  // challenge - een gewijzigde rent_destination na ondertekening moet de
  // handtekeningverificatie laten falen ---
  it("[B5] een afwijkende rent_destination t.o.v. wat ondertekend werd, maakt de handtekening ongeldig", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, tokenAccount } = await setupSpamTokenAccount(vaultPda, 1000);

    const legitimateRentDestination = provider.wallet.publicKey;
    const attackerChosenRentDestination = Keypair.generate().publicKey;

    let threw = false;
    let errorMessage = "";
    try {
      // Ondertekend alsof rent_destination = legitimateRentDestination,
      // maar de daadwerkelijke instructie gebruikt
      // attackerChosenRentDestination - simuleert een aanvaller die de
      // transactie na ondertekening manipuleert (of een client die de
      // bevestigingskaart iets anders toont dan wat hij daadwerkelijk
      // verstuurt).
      await callHunt(
        passkey,
        walletPda,
        vaultPda,
        passkeysPda,
        tokenAccount.publicKey,
        mint.publicKey,
        attackerChosenRentDestination,
        legitimateRentDestination
      );
    } catch (err) {
      threw = true;
      errorMessage = err.toString();
    }
    assert.isTrue(
      threw,
      "FIX GEVERIFIEERD: een gewijzigde rent_destination had de handtekening ongeldig moeten maken"
    );
    assert.include(
      errorMessage,
      "WebAuthnChallengeMismatch",
      "de weigering had specifiek WebAuthnChallengeMismatch moeten zijn (challenge komt niet overeen)"
    );

    // Het token-account is niet aangeraakt - de aanval faalde volledig,
    // geen gedeeltelijke uitvoering.
    const accountInfo = await provider.connection.getAccountInfo(tokenAccount.publicKey);
    assert.isNotNull(
      accountInfo,
      "target_token_account had onaangeraakt moeten blijven na de geweigerde manipulatiepoging"
    );
  });
});
