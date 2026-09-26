import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";
import { keccak_256 } from "@noble/hashes/sha3";
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
 * STATUS.md sectie 161 (review §160, I-1): end-to-end-dekking van de
 * PendingActionStaleEpoch-check, in een echte instructie.
 *
 * Sinds sectie 160 kan een wachtende actie met een verouderde epoch via de
 * publieke instructies niet meer ontstaan (initiate_recovery sluit de
 * wachtrij, unfreeze_via_backup_authority sluit hem in dezelfde instructie
 * waarin hij de epoch verhoogt). De check blijft als tweede
 * verdedigingslaag staan. Deze test zet die toestand daarom rechtstreeks in
 * de genesis van een eigen validator (zelfde techniek als
 * cancelActionLegacyLayout.ts) en toont aan dat:
 *
 * - finalize_withdrawal (via check_pending_action_finalizable, de helper van
 *   alle vijf finalize-instructies) weigert met PendingActionStaleEpoch, en
 *   dat een controlefixture die ALLEEN in de epoch verschilt wel slaagt;
 * - confirm_pending_action, dat een eigen inline epoch-check heeft, ook
 *   weigert met PendingActionStaleEpoch, en dat de controlefixture voorbij
 *   die check komt (en pas op de volgende check, de initiërende sessie,
 *   stopt - die bestaat in de fixture bewust niet).
 *
 * De andere vier finalize-instructies (token transfer, advanced action,
 * unfreeze, drempelwijziging) roepen dezelfde helper aan; die is voor alle
 * vijf kinds gedekt door de Rust-unittests in instructions.rs. Een eigen
 * end-to-end-fixture per soort (tokenaccounts, CPI-doel, SpendWindow) is
 * bewust niet gebouwd.
 */

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const WALLET_ACCOUNT_DISCRIMINATOR = createHash("sha256").update("account:WalletAccount").digest().subarray(0, 8);
const VAULT_ACCOUNT_DISCRIMINATOR = createHash("sha256").update("account:VaultAccount").digest().subarray(0, 8);
const PENDING_ACTION_DISCRIMINATOR = createHash("sha256").update("account:PendingAction").digest().subarray(0, 8);
const WALLET_ACCOUNT_LEN = 256;
const PENDING_ACTION_LEN = 164;
const PENDING_ACTION_KIND_SOL_WITHDRAWAL = 0;
const PENDING_ACTION_KIND_ADVANCED_ACTION = 2;
const ACTION_NONCE = 4n;
const WALLET_SESSION_EPOCH = 1n;
const WITHDRAWAL_AMOUNT = 100_000_000n;
// Ruim buiten elke timelock (ook de 24u van een binary zonder test-feature).
const TIMELOCK_STARTED_AT = BigInt(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60);

const LEDGER_DIR = path.join(__dirname, "..", ".anchor", "test-ledger-stale-epoch");
const FIXTURE_DIR = path.join(__dirname, "..", ".anchor", "fixtures-stale-epoch");
const RPC_PORT = 8950;
const GOSSIP_PORT = 8051;
const FAUCET_PORT = 9951;
const DYNAMIC_PORT_RANGE = "10200-10240";

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

interface FixtureWallet {
  name: string;
  owner: TestPasskey;
  walletPda: PublicKey;
  vaultPda: PublicKey;
  passkeysPda: PublicKey;
  pendingActionPda: PublicKey;
  pendingLamports: number;
}

/**
 * Eén wallet (huidige layout, recovery_state/deposit_authority None, niet
 * bevroren, session_epoch = WALLET_SESSION_EPOCH), zijn vault, en een
 * PendingAction in de huidige 164-byte-layout met de opgegeven epoch.
 */
function buildFixtureWallet(
  name: string,
  pending: { epoch: bigint; kind: number; commitment: (walletPda: PublicKey) => Buffer; session: PublicKey | null },
  files: { address: string; filepath: string }[]
): FixtureWallet {
  const owner = generateTestPasskey();
  const seedHash = createHash("sha256").update(owner.compressedPublicKey).digest();
  const [walletPda, walletBump] = PublicKey.findProgramAddressSync([Buffer.from("wallet"), seedHash], PROGRAM_ID);
  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), walletPda.toBuffer()], PROGRAM_ID);
  const [passkeysPda] = PublicKey.findProgramAddressSync([Buffer.from("passkeys"), walletPda.toBuffer()], PROGRAM_ID);
  const [pendingActionPda, pendingBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_action"), walletPda.toBuffer()],
    PROGRAM_ID
  );

  const walletBody = Buffer.concat([
    WALLET_ACCOUNT_DISCRIMINATOR,
    Buffer.from(owner.compressedPublicKey), // seed_key
    seedHash,
    Buffer.from(owner.compressedPublicKey), // owner_passkey
    Buffer.from([walletBump, vaultBump]),
    i64Le(1_700_000_000n), // created_at
    Keypair.generate().publicKey.toBuffer(), // backup_authority
    Buffer.from([0]), // recovery_state None
    i64Le(259_200n), // recovery_timelock_seconds
    Buffer.from([0]), // deposit_authority None
    u64Le(ACTION_NONCE),
    u64Le(WALLET_SESSION_EPOCH),
    u64Le(0n), // spend_threshold_lamports
    Buffer.from([0]), // disarmed
    u64Le(0n), // recovery_nonce_snapshot
  ]);
  const walletData = Buffer.concat([walletBody, Buffer.alloc(WALLET_ACCOUNT_LEN - walletBody.length)]);

  const vaultData = Buffer.concat([VAULT_ACCOUNT_DISCRIMINATOR, walletPda.toBuffer(), Buffer.from([vaultBump])]);

  const sessionInitiated = pending.session !== null;
  const pendingData = Buffer.concat([
    PENDING_ACTION_DISCRIMINATOR,
    walletPda.toBuffer(),
    Buffer.from([pendingBump, pending.kind]),
    i64Le(TIMELOCK_STARTED_AT), // initiated_at
    u64Le(pending.epoch),
    pending.commitment(walletPda),
    // Sessie-initiatie: SESSION_INITIATOR_SENTINEL (alles nul) tot een
    // passkey bevestigt. Passkey-initiatie: de initiator zelf.
    sessionInitiated ? Buffer.alloc(33) : Buffer.from(owner.compressedPublicKey),
    Buffer.from([sessionInitiated ? 0 : 1]), // confirmed (één passkey: true)
    (pending.session ?? PublicKey.default).toBuffer(),
    i64Le(TIMELOCK_STARTED_AT),
  ]);
  assert.equal(pendingData.length, PENDING_ACTION_LEN);

  const pendingLamports = 2_000_000;
  const walletFile = path.join(FIXTURE_DIR, `${name}-wallet.json`);
  const vaultFile = path.join(FIXTURE_DIR, `${name}-vault.json`);
  const pendingFile = path.join(FIXTURE_DIR, `${name}-pending.json`);
  writeFixture(walletFile, walletPda, walletData, 3_000_000);
  writeFixture(vaultFile, vaultPda, vaultData, 1_000_000_000);
  writeFixture(pendingFile, pendingActionPda, pendingData, pendingLamports);
  files.push(
    { address: walletPda.toBase58(), filepath: walletFile },
    { address: vaultPda.toBase58(), filepath: vaultFile },
    { address: pendingActionPda.toBase58(), filepath: pendingFile }
  );

  return { name, owner, walletPda, vaultPda, passkeysPda, pendingActionPda, pendingLamports };
}

function withdrawalCommitment(walletPda: PublicKey, recipient: PublicKey, amount: bigint): Buffer {
  return Buffer.from(
    keccak_256(Buffer.concat([walletPda.toBuffer(), Buffer.from("pending_withdrawal"), recipient.toBuffer(), u64Le(amount)]))
  );
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return String(err);
  }
}

describe("spankwallet: PendingActionStaleEpoch blijft werken als tweede verdedigingslaag (genesis-fixture, STATUS.md sectie 161)", function () {
  this.timeout(180_000);

  let validator: LocalValidatorHandle;
  let connection: Connection;
  let program: Program<Spankwallet>;
  let feePayer: Keypair;
  // Eigen ontvanger per fixture: een fout in de ene test mag de saldo-
  // controle van de andere niet beïnvloeden.
  const staleRecipient = Keypair.generate().publicKey;
  const controlRecipient = Keypair.generate().publicKey;
  const initiatorSession = Keypair.generate().publicKey;
  let staleWithdrawal: FixtureWallet;
  let controlWithdrawal: FixtureWallet;
  let staleConfirm: FixtureWallet;
  let controlConfirm: FixtureWallet;

  before(async function () {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const files: { address: string; filepath: string }[] = [];

    const withdrawal = (epoch: bigint, recipient: PublicKey) => ({
      epoch,
      kind: PENDING_ACTION_KIND_SOL_WITHDRAWAL,
      commitment: (w: PublicKey) => withdrawalCommitment(w, recipient, WITHDRAWAL_AMOUNT),
      session: null,
    });
    const sessionAction = (epoch: bigint) => ({
      epoch,
      kind: PENDING_ACTION_KIND_ADVANCED_ACTION,
      commitment: () => Buffer.alloc(32, 9),
      session: initiatorSession,
    });
    staleWithdrawal = buildFixtureWallet("stale-withdrawal", withdrawal(WALLET_SESSION_EPOCH - 1n, staleRecipient), files);
    controlWithdrawal = buildFixtureWallet("control-withdrawal", withdrawal(WALLET_SESSION_EPOCH, controlRecipient), files);
    staleConfirm = buildFixtureWallet("stale-confirm", sessionAction(WALLET_SESSION_EPOCH - 1n), files);
    controlConfirm = buildFixtureWallet("control-confirm", sessionAction(WALLET_SESSION_EPOCH), files);

    validator = await startLocalValidator({
      ledgerDir: LEDGER_DIR,
      rpcPort: RPC_PORT,
      gossipPort: GOSSIP_PORT,
      faucetPort: FAUCET_PORT,
      dynamicPortRange: DYNAMIC_PORT_RANGE,
      programId: PROGRAM_ID.toBase58(),
      programSoPath: path.join(__dirname, "..", "target", "deploy", "spankwallet.so"),
      accounts: files,
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

  function finalizeWithdrawal(f: FixtureWallet, recipient: PublicKey) {
    const commitment = withdrawalCommitment(f.walletPda, recipient, WITHDRAWAL_AMOUNT);
    const payload = Buffer.concat([nonceLeBytes(ACTION_NONCE), f.pendingActionPda.toBuffer(), commitment]);
    const expectedChallenge = buildExpectedChallenge(PROGRAM_ID, f.walletPda, "finalize_withdrawal", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(f.owner, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(f.owner.compressedPublicKey, signedMessage, rawSignature);
    return program.methods
      .finalizeWithdrawal(new BN(WITHDRAWAL_AMOUNT.toString()), new BN(ACTION_NONCE.toString()), clientDataJSON)
      .accountsStrict({
        wallet: f.walletPda,
        vault: f.vaultPda,
        pendingAction: f.pendingActionPda,
        recipient,
        passkeys: f.passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closer: feePayer.publicKey,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  function confirmPendingAction(f: FixtureWallet) {
    const payload = Buffer.concat([nonceLeBytes(ACTION_NONCE), f.pendingActionPda.toBuffer(), Buffer.alloc(32, 9)]);
    const expectedChallenge = buildExpectedChallenge(PROGRAM_ID, f.walletPda, "confirm_pending_action", payload);
    const { signedMessage, rawSignature, clientDataJSON } = signTestChallenge(f.owner, expectedChallenge);
    const secp256r1Ix = buildSecp256r1Instruction(f.owner.compressedPublicKey, signedMessage, rawSignature);
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), f.walletPda.toBuffer(), initiatorSession.toBuffer()],
      PROGRAM_ID
    );
    return program.methods
      .confirmPendingAction(new BN(ACTION_NONCE.toString()), clientDataJSON)
      .accountsStrict({
        wallet: f.walletPda,
        pendingAction: f.pendingActionPda,
        passkeys: f.passkeysPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        session: sessionPda,
      })
      .preInstructions([secp256r1Ix])
      .rpc();
  }

  async function assertUntouched(f: FixtureWallet) {
    const pending = await connection.getAccountInfo(f.pendingActionPda, "confirmed");
    assert.isNotNull(pending, `${f.name}: de PendingAction moet blijven staan`);
    assert.equal(pending!.data.length, PENDING_ACTION_LEN);
    const wallet = await program.account.walletAccount.fetch(f.walletPda);
    assert.equal(wallet.actionNonce.toString(), ACTION_NONCE.toString(), `${f.name}: geen nonce verbruikt`);
  }

  it("finalize_withdrawal met pending.epoch < wallet.session_epoch faalt met PendingActionStaleEpoch; niets verplaatst, niets gesloten", async () => {
    const vaultBefore = await connection.getBalance(staleWithdrawal.vaultPda, "confirmed");
    const result = await outcome(finalizeWithdrawal(staleWithdrawal, staleRecipient));
    assert.include(result, "PendingActionStaleEpoch", "verwachtte PendingActionStaleEpoch, kreeg: " + result);
    await assertUntouched(staleWithdrawal);
    assert.equal(await connection.getBalance(staleWithdrawal.vaultPda, "confirmed"), vaultBefore);
    assert.equal(await connection.getBalance(staleRecipient, "confirmed"), 0);
  });

  it("controle: dezelfde fixture met een gelijke epoch finalizet wel (bedrag naar de ontvanger, PendingAction gesloten, nonce verbruikt)", async () => {
    const result = await outcome(finalizeWithdrawal(controlWithdrawal, controlRecipient));
    assert.equal(result, "ok", "de controlefixture had moeten slagen: " + result);
    assert.equal(await connection.getBalance(controlRecipient, "confirmed"), Number(WITHDRAWAL_AMOUNT));
    assert.isNull(await connection.getAccountInfo(controlWithdrawal.pendingActionPda, "confirmed"));
    const wallet = await program.account.walletAccount.fetch(controlWithdrawal.walletPda);
    assert.equal(wallet.actionNonce.toString(), (ACTION_NONCE + 1n).toString());
  });

  it("confirm_pending_action (eigen inline check) met een verouderde epoch faalt met PendingActionStaleEpoch; niets gewijzigd", async () => {
    const result = await outcome(confirmPendingAction(staleConfirm));
    assert.include(result, "PendingActionStaleEpoch", "verwachtte PendingActionStaleEpoch, kreeg: " + result);
    await assertUntouched(staleConfirm);
  });

  it("controle: met een gelijke epoch komt confirm_pending_action voorbij de epoch-check en stopt pas bij de (bewust ontbrekende) initiërende sessie", async () => {
    const result = await outcome(confirmPendingAction(controlConfirm));
    assert.notInclude(result, "PendingActionStaleEpoch");
    assert.include(result, "InitiatingSessionRevoked", "verwachtte de volgende check (InitiatingSessionRevoked), kreeg: " + result);
    await assertUntouched(controlConfirm);
  });
});
