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

// BLOKKADE (STATUS.md sectie 76/77): B6 wijzigde transfer_token's challenge-
// payload - een live, fondsen-rakende instructie - zonder dat er ooit een
// lokale test voor transfer_token zelf bestond (alleen voor de
// sessievariant, tests/sessionKeys.ts). Dit bestand is nieuw, zelfde
// diepgang als tests/hunt.ts: gelukkige weg met exacte
// transactie-meta-gebaseerde saldiverificatie, plus een manipulatietest
// voor de nieuw-gebonden vault_token_account.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_LEN = 82;
const TOKEN_ACCOUNT_LEN = 165;

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

function readTokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

describe("spankwallet: transfer_token (SPL-token-transfer, passkey-gated)", () => {
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

  /// Zet een verse SPL-mint + vault-eigen token-account (gemint met
  /// mintAmount) + een los ontvanger-token-account op.
  async function setupMintAndAccounts(
    vaultPda: PublicKey,
    recipientOwner: PublicKey,
    mintAmount: number
  ): Promise<{ mint: Keypair; vaultTokenAccount: Keypair; recipientTokenAccount: Keypair }> {
    const mint = Keypair.generate();
    const vaultTokenAccount = Keypair.generate();
    const recipientTokenAccount = Keypair.generate();
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
        newAccountPubkey: vaultTokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(vaultTokenAccount.publicKey, mint.publicKey, vaultPda),
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: recipientTokenAccount.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(recipientTokenAccount.publicKey, mint.publicKey, recipientOwner),
      encodeMintToIx(mint.publicKey, vaultTokenAccount.publicKey, provider.wallet.publicKey, mintAmount)
    );
    await provider.sendAndConfirm(setupTx, [mint, vaultTokenAccount, recipientTokenAccount]);
    return { mint, vaultTokenAccount, recipientTokenAccount };
  }

  /// Een TWEEDE, eveneens geldig vault-eigen token-account van DEZELFDE
  /// mint (i.t.t. setupMintAndAccounts, dat een eigen, nieuwe mint
  /// aanmaakt) - nodig voor de B6-manipulatietest: het moet een account
  /// zijn dat alle Anchor-constraints (owner==vault, mint==token_mint) al
  /// passeert, zodat de test daadwerkelijk de signature-verificatie test
  /// i.p.v. eerder al op een constraint-mismatch te stranden.
  async function createExtraVaultTokenAccount(
    mint: PublicKey,
    vaultPda: PublicKey
  ): Promise<Keypair> {
    const extra = Keypair.generate();
    const tokenAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_LEN);
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: extra.publicKey,
        lamports: tokenAccountRent,
        space: TOKEN_ACCOUNT_LEN,
        programId: TOKEN_PROGRAM_ID,
      }),
      encodeInitializeAccountIx(extra.publicKey, mint, vaultPda)
    );
    await provider.sendAndConfirm(tx, [extra]);
    return extra;
  }

  // B6 (STATUS.md sectie 76/77): vault_token_account nu gebonden in de
  // challenge-payload. `signAsVaultTokenAccount` laat toe om een AFWIJKEND
  // vault_token_account te ondertekenen dan wat daadwerkelijk in de
  // instructie terechtkomt - alleen gebruikt door de manipulatietest
  // hieronder.
  async function callTransferToken(
    signingPasskey: TestPasskey,
    walletPda: PublicKey,
    vaultPda: PublicKey,
    passkeysPda: PublicKey,
    vaultTokenAccount: PublicKey,
    recipientTokenAccount: PublicKey,
    tokenMint: PublicKey,
    amount: number,
    signAsVaultTokenAccount?: PublicKey
  ) {
    const nonce = await fetchActionNonce(provider.connection, walletPda);
    const amountBytes = Buffer.alloc(8);
    amountBytes.writeBigUInt64LE(BigInt(amount), 0);
    const payload = Buffer.concat([
      nonceLeBytes(nonce),
      recipientTokenAccount.toBuffer(),
      tokenMint.toBuffer(),
      amountBytes,
      (signAsVaultTokenAccount ?? vaultTokenAccount).toBuffer(),
    ]);
    const expectedChallenge = buildExpectedChallenge(
      program.programId,
      walletPda,
      "transfer_token",
      payload
    );
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(
      signingPasskey,
      expectedChallenge
    );
    const secp256r1Ix = buildSecp256r1Instruction(
      signingPasskey.compressedPublicKey,
      signedMessage,
      rawSignature
    );

    return program.methods
      .transferToken(new BN(amount), new BN(nonce.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        vault: vaultPda,
        vaultTokenAccount,
        recipientTokenAccount,
        tokenMint,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  it("transfer_token verplaatst het exacte bedrag van vault_token_account naar recipient_token_account", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
      vaultPda,
      provider.wallet.publicKey,
      1000
    );

    const signature = await callTransferToken(
      passkey,
      walletPda,
      vaultPda,
      passkeysPda,
      vaultTokenAccount.publicKey,
      recipientTokenAccount.publicKey,
      mint.publicKey,
      400
    );

    // Harde bron van waarheid: de daadwerkelijke token-accountsaldi NA de
    // transactie, rechtstreeks uitgelezen - niet uit een losse, mogelijk
    // te vroege balansquery (zelfde discipline als tests/hunt.ts).
    let vaultAccountInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
    let recipientAccountInfo = await provider.connection.getAccountInfo(
      recipientTokenAccount.publicKey
    );
    for (
      let i = 0;
      i < 20 &&
      (readTokenAccountAmount(vaultAccountInfo!.data) !== 600n ||
        readTokenAccountAmount(recipientAccountInfo!.data) !== 400n);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
      vaultAccountInfo = await provider.connection.getAccountInfo(vaultTokenAccount.publicKey);
      recipientAccountInfo = await provider.connection.getAccountInfo(
        recipientTokenAccount.publicKey
      );
    }

    assert.equal(
      readTokenAccountAmount(vaultAccountInfo!.data),
      600n,
      "vault_token_account had exact 600 (1000 - 400) moeten overhouden"
    );
    assert.equal(
      readTokenAccountAmount(recipientAccountInfo!.data),
      400n,
      "recipient_token_account had exact 400 moeten ontvangen"
    );

    // Aanvullend, harde bevestiging via de transactie-meta zelf (dezelfde
    // discipline als STATUS.md sectie 17/hunt: niet vertrouwen op een losse
    // her-lees-actie zonder de transactie zelf te controleren).
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
    assert.isNotNull(txInfo, "kon de transfer_token-transactie niet terugvinden");
    assert.isNull(txInfo!.meta!.err, "de transactie had zonder fout moeten slagen");
  });

  it("[B6] een afwijkend vault_token_account t.o.v. wat ondertekend werd, maakt de handtekening ongeldig (WebAuthnChallengeMismatch)", async () => {
    const { passkey, walletPda, vaultPda, passkeysPda } = await createWallet();
    const { mint, vaultTokenAccount, recipientTokenAccount } = await setupMintAndAccounts(
      vaultPda,
      provider.wallet.publicKey,
      1000
    );
    // Tweede, EVENEENS geldig vault-eigen token-account van DEZELFDE mint -
    // simuleert precies het scenario uit de audit-bevinding: meerdere
    // vault-eigen token-accounts van dezelfde mint, waarbij de handtekening
    // vóór B6 niet specificeerde WELKE ene bedoeld was. Moet dezelfde mint
    // zijn, anders vangt de al-bestaande mint-constraint dit af vóórdat de
    // signature-verificatie ooit bereikt wordt (precies de fout die deze
    // test aanvankelijk zelf maakte - zie STATUS.md sectie 76/77).
    const otherVaultTokenAccount = await createExtraVaultTokenAccount(mint.publicKey, vaultPda);

    let threw = false;
    let errorMessage = "";
    try {
      // Ondertekend alsof vault_token_account = vaultTokenAccount, maar de
      // daadwerkelijke instructie gebruikt otherVaultTokenAccount (een
      // ANDER, eveneens geldig vault-eigen token-account) - simuleert een
      // client/aanvaller die na ondertekening de bron omwisselt.
      await callTransferToken(
        passkey,
        walletPda,
        vaultPda,
        passkeysPda,
        otherVaultTokenAccount.publicKey,
        recipientTokenAccount.publicKey,
        mint.publicKey,
        400,
        vaultTokenAccount.publicKey
      );
    } catch (err) {
      threw = true;
      errorMessage = err.toString();
    }
    assert.isTrue(
      threw,
      "FIX GEVERIFIEERD: een afwijkend vault_token_account had de handtekening ongeldig moeten maken"
    );
    assert.include(
      errorMessage,
      "WebAuthnChallengeMismatch",
      "de weigering had specifiek WebAuthnChallengeMismatch moeten zijn (challenge komt niet overeen)"
    );

    // Geen enkele beweging heeft plaatsgevonden - de aanval faalde volledig.
    const otherVaultInfo = await provider.connection.getAccountInfo(
      otherVaultTokenAccount.publicKey
    );
    assert.equal(
      readTokenAccountAmount(otherVaultInfo!.data),
      0n,
      "otherVaultTokenAccount had onaangeraakt moeten blijven (leeg) na de geweigerde manipulatiepoging"
    );
  });
});
