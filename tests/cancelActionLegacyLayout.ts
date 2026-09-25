import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import type { Spankwallet } from "../target/types/spankwallet";
import idl from "../target/idl/spankwallet.json";
import { startLocalValidator, LocalValidatorHandle } from "./migrateWalletAccountValidator";
import {
  generateTestPasskey,
  buildExpectedChallenge,
  signTestChallenge,
  buildSecp256r1Instruction,
  nonceLeBytes,
  TestPasskey,
} from "./webauthnTestHelper";

/**
 * STATUS.md sectie 153: cancel_action leest pending_action bewust als
 * UncheckedAccount (alleen owner + discriminator), zodat annuleren NIET
 * afhangt van de accountlayout. Deze test bewijst dat tegen een ECHTE
 * PendingAction in de oude 124-byte-layout (van vóór initiator_session/
 * timelock_started_at): die deserialiseert niet meer tegen de huidige
 * struct (fail-closed), maar de eigenaar kan het singleton-slot er toch mee
 * vrijmaken. Zonder deze eigenschap zou één zo'n achtergebleven account de
 * wachtrij van een wallet permanent blokkeren.
 *
 * Zelfde techniek als de (in sectie 155 verwijderde) migratietest: een eigen validator met
 * account-genesis (`--account`), omdat het programma zelf nooit meer een
 * 124-byte PendingAction aanmaakt. De fixtures worden hier synthetisch en
 * per run vers opgebouwd (verse test-passkey als owner_passkey), niet
 * gecommit.
 */

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const WALLET_ACCOUNT_DISCRIMINATOR = Buffer.from([0x9e, 0x62, 0xab, 0x99, 0xd4, 0x40, 0xf2, 0xd5]);
const PENDING_ACTION_DISCRIMINATOR = createHash("sha256").update("account:PendingAction").digest().subarray(0, 8);
const WALLET_ACCOUNT_LEN = 256;
const OLD_PENDING_ACTION_LEN = 124;
const ACTION_NONCE = 5n;

const LEDGER_DIR = path.join(__dirname, "..", ".anchor", "test-ledger-cancel-action-legacy");
const FIXTURE_DIR = path.join(__dirname, "..", ".anchor", "fixtures-cancel-action-legacy");
const RPC_PORT = 8940;
const GOSSIP_PORT = 8041;
const FAUCET_PORT = 9941;
const DYNAMIC_PORT_RANGE = "10100-10140";

function u64Le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function i64Le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v, 0);
  return b;
}

function writeFixture(file: string, address: PublicKey, data: Buffer, lamports: number) {
  fs.writeFileSync(
    file,
    JSON.stringify({
      pubkey: address.toBase58(),
      account: {
        lamports,
        data: [data.toString("base64"), "base64"],
        owner: PROGRAM_ID.toBase58(),
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    })
  );
}

describe("spankwallet: cancel_action sluit ook een PendingAction in de OUDE 124-byte-layout (STATUS.md sectie 153)", function () {
  this.timeout(180_000);

  let validator: LocalValidatorHandle;
  let connection: Connection;
  let program: Program<Spankwallet>;
  let feePayer: Keypair;
  let owner: TestPasskey;
  let walletPda: PublicKey;
  let passkeysPda: PublicKey;
  let pendingActionPda: PublicKey;
  let oldPendingLamports: number;

  before(async function () {
    owner = generateTestPasskey();
    const seedHash = createHash("sha256").update(owner.compressedPublicKey).digest();
    let walletBump: number;
    [walletPda, walletBump] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), seedHash], PROGRAM_ID);
    const [, vaultBump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), walletPda.toBuffer()], PROGRAM_ID);
    [passkeysPda] = PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], PROGRAM_ID);
    let pendingBump: number;
    [pendingActionPda, pendingBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_action"), walletPda.toBuffer()],
      PROGRAM_ID
    );

    // Huidige WalletAccount-layout (state.rs), recovery_state/deposit_authority
    // None, nul-gepadded tot WalletAccount::LEN - zoals een echt account.
    const walletBody = Buffer.concat([
      WALLET_ACCOUNT_DISCRIMINATOR,
      Buffer.from(owner.compressedPublicKey),
      seedHash,
      Buffer.from(owner.compressedPublicKey),
      Buffer.from([walletBump, vaultBump]),
      i64Le(1_700_000_000n),
      Keypair.generate().publicKey.toBuffer(),
      Buffer.from([0]),
      i64Le(259_200n),
      Buffer.from([0]),
      u64Le(ACTION_NONCE),
      u64Le(0n),
      u64Le(0n),
      Buffer.from([0]),
    ]);
    const walletData = Buffer.concat([walletBody, Buffer.alloc(WALLET_ACCOUNT_LEN - walletBody.length)]);

    // OUDE PendingAction-layout: exact de velden t/m `confirmed`.
    const oldPendingData = Buffer.concat([
      PENDING_ACTION_DISCRIMINATOR,
      walletPda.toBuffer(),
      Buffer.from([pendingBump, 0]),
      i64Le(1_700_000_100n),
      u64Le(0n),
      Buffer.alloc(32, 7),
      Buffer.from(owner.compressedPublicKey),
      Buffer.from([1]),
    ]);
    assert.equal(oldPendingData.length, OLD_PENDING_ACTION_LEN);

    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const walletFile = path.join(FIXTURE_DIR, "wallet.json");
    const pendingFile = path.join(FIXTURE_DIR, "pending_action_124.json");
    // Ruim boven rent-exempt voor beide groottes; exacte waarde is voor deze
    // test niet relevant, alleen dat hij volledig naar de payer gaat.
    oldPendingLamports = 2_000_000;
    writeFixture(walletFile, walletPda, walletData, 3_000_000);
    writeFixture(pendingFile, pendingActionPda, oldPendingData, oldPendingLamports);

    validator = await startLocalValidator({
      ledgerDir: LEDGER_DIR,
      rpcPort: RPC_PORT,
      gossipPort: GOSSIP_PORT,
      faucetPort: FAUCET_PORT,
      dynamicPortRange: DYNAMIC_PORT_RANGE,
      programId: PROGRAM_ID.toBase58(),
      programSoPath: path.join(__dirname, "..", "target", "deploy", "spankwallet.so"),
      accounts: [
        { address: walletPda.toBase58(), filepath: walletFile },
        { address: pendingActionPda.toBase58(), filepath: pendingFile },
      ],
    });
    connection = validator.connection;

    feePayer = Keypair.generate();
    const sig = await connection.requestAirdrop(feePayer.publicKey, 2_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");

    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(feePayer), { commitment: "confirmed" });
    program = new anchor.Program(idl as anchor.Idl, provider) as unknown as Program<Spankwallet>;
  });

  after(async function () {
    if (validator) {
      await validator.stop();
    }
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("de 124-byte PendingAction bestaat, en het PROGRAMMA weigert hem fail-closed te deserialiseren (confirm_pending_action -> AccountDidNotDeserialize)", async () => {
    const info = await connection.getAccountInfo(pendingActionPda, "confirmed");
    assert.isNotNull(info);
    assert.equal(info!.data.length, OLD_PENDING_ACTION_LEN);
    assert.isTrue(info!.owner.equals(PROGRAM_ID));

    // Bewust on-chain getoetst, niet via program.account.pendingAction.fetch:
    // de Anchor-JS-decoder is lenient bij een te kort account (leest
    // ontbrekende bytes stilzwijgend als nul/ingekorte pubkey) en bewijst
    // dus niets over wat het programma doet. Een geldig ondertekende
    // confirm_pending_action op dit account moet falen op deserialisatie,
    // vóór de instructie-body ooit draait.
    const commitment = Buffer.alloc(32, 7);
    const payload = Buffer.concat([nonceLeBytes(ACTION_NONCE), pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(PROGRAM_ID, walletPda, "confirm_pending_action", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(owner, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(owner.compressedPublicKey, signedMessage, rawSignature);
    // Met de hand opgebouwd, niet via program.methods: de seeds van het
    // sessie-account (sectie 155) hangen af van pending_action.initiator_session,
    // en de Anchor-JS-resolver zou die uit dit te korte account lezen. Het
    // sessie-adres doet hier niet ter zake - de weigering moet al op de
    // deserialisatie van pending_action vallen.
    const clientDataLen = Buffer.alloc(4);
    clientDataLen.writeUInt32LE(clientDataJSON.length, 0);
    const confirmIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: walletPda, isSigner: false, isWritable: true },
        { pubkey: pendingActionPda, isSigner: false, isWritable: true },
        { pubkey: passkeysPda, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: PublicKey.findProgramAddressSync([Buffer.from("session"), walletPda.toBuffer(), PublicKey.default.toBuffer()], PROGRAM_ID)[0], isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        createHash("sha256").update("global:confirm_pending_action").digest().subarray(0, 8),
        nonceLeBytes(ACTION_NONCE),
        clientDataLen,
        Buffer.from(clientDataJSON),
      ]),
    });
    let errString = "";
    try {
      await program.provider.sendAndConfirm!(new Transaction().add(secp256r1Ix, confirmIx));
    } catch (err) {
      errString = String(err);
    }
    assert.include(errString, "AccountDidNotDeserialize", "verwachtte een on-chain deserialisatiefout, kreeg: " + errString);
    const after = await connection.getAccountInfo(pendingActionPda, "confirmed");
    assert.equal(after!.data.length, OLD_PENDING_ACTION_LEN, "het account moet onaangeroerd zijn");
  });

  it("cancel_action sluit het oude account toch: account weg, rent naar de payer, nonce verbruikt", async () => {
    const payload = Buffer.concat([nonceLeBytes(ACTION_NONCE), pendingActionPda.toBuffer()]);
    const expectedChallenge = buildExpectedChallenge(PROGRAM_ID, walletPda, "cancel_action", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(owner, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(owner.compressedPublicKey, signedMessage, rawSignature);

    const payerBefore = await connection.getBalance(feePayer.publicKey, "confirmed");
    const sig = await program.methods
      .cancelAction(new BN(ACTION_NONCE.toString()), clientDataJSON)
      .accounts({
        wallet: walletPda,
        pendingAction: pendingActionPda,
        passkeys: passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        payer: feePayer.publicKey,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
    let tx = null;
    for (let i = 0; i < 20 && tx === null; i++) {
      tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx === null) await new Promise((r) => setTimeout(r, 250));
    }
    const payerAfter = await connection.getBalance(feePayer.publicKey, "confirmed");

    assert.isNull(await connection.getAccountInfo(pendingActionPda, "confirmed"), "het oude account had gesloten moeten zijn");
    assert.equal(payerAfter - payerBefore, oldPendingLamports - tx!.meta!.fee);
    const wallet = await program.account.walletAccount.fetch(walletPda);
    assert.equal(wallet.actionNonce.toString(), (ACTION_NONCE + 1n).toString());
  });
});
