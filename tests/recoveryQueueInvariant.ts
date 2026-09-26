import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import { findInvariantViolations, ProgramAccountBytes } from "../scripts/lib/recoveryQueueInvariant";

/**
 * STATUS.md sectie 161: unittest (geen validator) van de decodeer- en
 * beslislogica achter scripts/checkRecoveryQueueInvariant.ts - de harde
 * voorwaarde vóór en ná de deploy van upgrade 1. Synthetische accountbytes
 * in de on-chain-layout; de vier gevraagde gevallen plus de fail-closed-
 * gevallen (wat het script niet kan verifiëren, telt als treffer).
 */

const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const WALLET_DISC = createHash("sha256").update("account:WalletAccount").digest().subarray(0, 8);
const PENDING_DISC = createHash("sha256").update("account:PendingAction").digest().subarray(0, 8);

function u64Le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function walletBytes(opts: { recoverySome: boolean; sessionEpoch: bigint; depositSome?: boolean; len?: number }): Buffer {
  const body = Buffer.concat([
    WALLET_DISC,
    Buffer.alloc(33, 2), // seed_key
    Buffer.alloc(32, 1), // wallet_seed_hash
    Buffer.alloc(33, 3), // owner_passkey
    Buffer.from([254, 253]), // bump, vault_bump
    u64Le(1_700_000_000n), // created_at
    Buffer.alloc(32, 4), // backup_authority
    opts.recoverySome
      ? Buffer.concat([Buffer.from([1]), u64Le(1_700_000_100n), Buffer.alloc(33, 2)])
      : Buffer.from([0]),
    u64Le(259_200n), // recovery_timelock_seconds
    opts.depositSome ? Buffer.concat([Buffer.from([1]), Buffer.alloc(32, 5)]) : Buffer.from([0]),
    u64Le(7n), // action_nonce
    u64Le(opts.sessionEpoch),
    u64Le(0n), // spend_threshold_lamports
    Buffer.from([0]), // disarmed
    u64Le(0n), // recovery_nonce_snapshot
  ]);
  const len = opts.len ?? 256;
  return len >= body.length ? Buffer.concat([body, Buffer.alloc(len - body.length)]) : body.subarray(0, len);
}

function pendingBytes(wallet: PublicKey, epoch: bigint, len = 164): Buffer {
  const body = Buffer.concat([
    PENDING_DISC,
    wallet.toBuffer(),
    Buffer.from([255, 0]), // bump, kind
    u64Le(1_700_000_200n), // initiated_at
    u64Le(epoch),
    Buffer.alloc(32, 7), // action_commitment
    Buffer.alloc(33, 3), // initiator_passkey
    Buffer.from([1]), // confirmed
    Buffer.alloc(32, 0), // initiator_session
    u64Le(1_700_000_200n), // timelock_started_at
  ]);
  return body.subarray(0, len);
}

function pendingPdaOf(wallet: PublicKey): string {
  return PublicKey.findProgramAddressSync([Buffer.from("pending_action"), wallet.toBuffer()], PROGRAM_ID)[0].toBase58();
}

function scenario(wallet: { recoverySome: boolean; sessionEpoch: bigint; depositSome?: boolean; len?: number } | null, pendingEpoch: bigint, pendingLen = 164) {
  const walletKey = Keypair.generate().publicKey;
  const pending: ProgramAccountBytes = {
    address: pendingPdaOf(walletKey),
    data: pendingBytes(walletKey, pendingEpoch, pendingLen),
    owner: PROGRAM_ID,
  };
  const wallets = new Map<string, ProgramAccountBytes | null>();
  wallets.set(
    walletKey.toBase58(),
    wallet === null ? null : { address: walletKey.toBase58(), data: walletBytes(wallet), owner: PROGRAM_ID }
  );
  return findInvariantViolations(PROGRAM_ID, [pending], wallets);
}

describe("checkRecoveryQueueInvariant: decodeer- en beslislogica (STATUS.md sectie 161)", () => {
  it("recovery_state Some + een PendingAction wordt geflagd (recovery_in_progress)", () => {
    const v = scenario({ recoverySome: true, sessionEpoch: 2n }, 2n);
    assert.lengthOf(v, 1);
    assert.deepEqual(v[0].reasons, ["recovery_in_progress"]);
  });

  it("pending.epoch != wallet.session_epoch wordt geflagd (stale_epoch), in beide richtingen", () => {
    const older = scenario({ recoverySome: false, sessionEpoch: 2n }, 1n);
    assert.lengthOf(older, 1);
    assert.deepEqual(older[0].reasons, ["stale_epoch"]);
    const newer = scenario({ recoverySome: false, sessionEpoch: 2n }, 3n);
    assert.lengthOf(newer, 1);
    assert.deepEqual(newer[0].reasons, ["stale_epoch"]);
  });

  it("beide tegelijk: allebei de redenen", () => {
    const v = scenario({ recoverySome: true, sessionEpoch: 2n }, 1n);
    assert.lengthOf(v, 1);
    assert.sameMembers(v[0].reasons, ["recovery_in_progress", "stale_epoch"]);
  });

  it("gelijke epoch zonder recovery wordt NIET geflagd", () => {
    assert.lengthOf(scenario({ recoverySome: false, sessionEpoch: 2n }, 2n), 0);
  });

  it("lege wachtrij wordt NIET geflagd, ook niet bij een wallet met een lopende recovery (zoals 5MoXqg…)", () => {
    const walletKey = Keypair.generate().publicKey;
    const wallets = new Map<string, ProgramAccountBytes | null>();
    wallets.set(walletKey.toBase58(), {
      address: walletKey.toBase58(),
      data: walletBytes({ recoverySome: true, sessionEpoch: 0n }),
      owner: PROGRAM_ID,
    });
    assert.lengthOf(findInvariantViolations(PROGRAM_ID, [], wallets), 0);
  });

  it("de epoch wordt op de juiste offset gelezen, ook met deposit_authority Some en recovery_state Some", () => {
    assert.lengthOf(scenario({ recoverySome: true, sessionEpoch: 5n, depositSome: true, len: 264 }, 5n), 1);
    assert.deepEqual(scenario({ recoverySome: true, sessionEpoch: 5n, depositSome: true, len: 264 }, 5n)[0].reasons, ["recovery_in_progress"]);
    assert.lengthOf(scenario({ recoverySome: false, sessionEpoch: 5n, depositSome: true }, 5n), 0);
  });

  it("oude 124-byte-PendingAction-layout: de epoch staat op dezelfde offset en wordt gewoon beoordeeld", () => {
    assert.lengthOf(scenario({ recoverySome: false, sessionEpoch: 2n }, 2n, 124), 0);
    assert.deepEqual(scenario({ recoverySome: false, sessionEpoch: 2n }, 1n, 124)[0].reasons, ["stale_epoch"]);
  });

  it("fail-closed: niet-bestaande wallet, te korte wallet of te korte PendingAction telt als treffer (unverifiable)", () => {
    assert.deepEqual(scenario(null, 0n)[0].reasons, ["unverifiable"]);
    assert.deepEqual(scenario({ recoverySome: false, sessionEpoch: 0n, len: 150 }, 0n)[0].reasons, ["unverifiable"]);
    assert.deepEqual(scenario({ recoverySome: false, sessionEpoch: 0n }, 0n, 40)[0].reasons, ["unverifiable"]);
  });

  it("fail-closed: een PendingAction die niet op het canonieke PDA van zijn wallet staat, telt als treffer", () => {
    const walletKey = Keypair.generate().publicKey;
    const wallets = new Map<string, ProgramAccountBytes | null>();
    wallets.set(walletKey.toBase58(), {
      address: walletKey.toBase58(),
      data: walletBytes({ recoverySome: false, sessionEpoch: 0n }),
      owner: PROGRAM_ID,
    });
    const v = findInvariantViolations(
      PROGRAM_ID,
      [{ address: Keypair.generate().publicKey.toBase58(), data: pendingBytes(walletKey, 0n), owner: PROGRAM_ID }],
      wallets
    );
    assert.deepEqual(v[0].reasons, ["unverifiable"]);
  });
});
