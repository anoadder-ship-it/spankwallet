import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import {
  evaluateProgramScan,
  findInvariantViolations,
  ProgramAccountBytes,
  ProgramScanResult,
} from "../scripts/lib/recoveryQueueInvariant";

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
const VAULT_DISC = createHash("sha256").update("account:VaultAccount").digest().subarray(0, 8);
const MIN_WALLETS = 19;

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

/**
 * STATUS.md sectie 162 (review §161, L-3 en L-4). evaluateProgramScan krijgt
 * het ongefilterde getProgramAccounts-antwoord plus de adressen uit de
 * gefilterde PendingAction-lijst. Groen = geen treffers EN geen
 * tellingsprobleem.
 */
function vaultBytes(wallet: PublicKey): Buffer {
  return Buffer.concat([VAULT_DISC, wallet.toBuffer(), Buffer.from([254])]);
}

function isGreen(r: ProgramScanResult): boolean {
  return r.violations.length === 0 && r.censusProblems.length === 0;
}

/** `n` wallets zonder recovery, elk met een vault; `walletLen` voor de eerste wallet. */
function census(n: number, opts: { vaults?: number; walletLen?: number } = {}) {
  const accounts: ProgramAccountBytes[] = [];
  const walletKeys: PublicKey[] = [];
  for (let i = 0; i < n; i++) {
    const key = Keypair.generate().publicKey;
    walletKeys.push(key);
    const len = i === 0 && opts.walletLen !== undefined ? opts.walletLen : 256;
    accounts.push({ address: key.toBase58(), data: walletBytes({ recoverySome: false, sessionEpoch: 0n, len }), owner: PROGRAM_ID });
  }
  for (let i = 0; i < (opts.vaults ?? n); i++) {
    accounts.push({ address: Keypair.generate().publicKey.toBase58(), data: vaultBytes(walletKeys[i % n]), owner: PROGRAM_ID });
  }
  return { accounts, walletKeys };
}

function withPending(accounts: ProgramAccountBytes[], wallet: PublicKey, epoch: bigint, len = 164): string {
  const address = pendingPdaOf(wallet);
  accounts.push({ address, data: pendingBytes(wallet, epoch, len), owner: PROGRAM_ID });
  return address;
}

describe("checkRecoveryQueueInvariant: tegencontrole op het RPC-antwoord (STATUS.md sectie 162, L-3)", () => {
  it("een leeg RPC-antwoord is NIET groen (sectie 161 telde dit als groen)", () => {
    // Zo besliste sectie 161: geen PendingActions gezien = geen treffers = groen.
    assert.lengthOf(findInvariantViolations(PROGRAM_ID, [], new Map()), 0);
    const r = evaluateProgramScan(PROGRAM_ID, [], [], MIN_WALLETS);
    assert.isFalse(isGreen(r));
    assert.isTrue(r.censusProblems.some((p) => p.includes("WalletAccounts")));
  });

  it("minder WalletAccounts dan het bekende minimum is NIET groen (onvolledig antwoord)", () => {
    const { accounts } = census(MIN_WALLETS - 1);
    assert.isFalse(isGreen(evaluateProgramScan(PROGRAM_ID, accounts, [], MIN_WALLETS)));
  });

  it("ongelijk aantal Vault- en WalletAccounts is NIET groen", () => {
    const { accounts } = census(MIN_WALLETS, { vaults: MIN_WALLETS - 1 });
    const r = evaluateProgramScan(PROGRAM_ID, accounts, [], MIN_WALLETS);
    assert.isFalse(isGreen(r));
    assert.isTrue(r.censusProblems.some((p) => p.includes("VaultAccounts")));
  });

  it("gefilterde en ongefilterde PendingAction-lijst verschillen: NIET groen, in beide richtingen", () => {
    const a = census(MIN_WALLETS);
    const seen = withPending(a.accounts, a.walletKeys[0], 0n);
    // Het filter mist een PendingAction die de ongefilterde lijst wel heeft.
    assert.isFalse(isGreen(evaluateProgramScan(PROGRAM_ID, a.accounts, [], MIN_WALLETS)));
    // Het filter levert een PendingAction die de ongefilterde lijst niet heeft.
    const b = census(MIN_WALLETS);
    assert.isFalse(isGreen(evaluateProgramScan(PROGRAM_ID, b.accounts, [seen], MIN_WALLETS)));
  });

  it("een account in het antwoord dat niet van het programma is, is NIET groen", () => {
    const { accounts } = census(MIN_WALLETS);
    accounts.push({ address: Keypair.generate().publicKey.toBase58(), data: vaultBytes(PublicKey.default), owner: PublicKey.default });
    assert.isFalse(isGreen(evaluateProgramScan(PROGRAM_ID, accounts, [], MIN_WALLETS)));
  });

  it("een volledig en consistent antwoord is groen, met en zonder wachtende actie", () => {
    const empty = census(MIN_WALLETS);
    const r = evaluateProgramScan(PROGRAM_ID, empty.accounts, [], MIN_WALLETS);
    assert.deepEqual(r.censusProblems, []);
    assert.equal(r.walletCount, MIN_WALLETS);
    assert.equal(r.vaultCount, MIN_WALLETS);
    assert.isTrue(isGreen(r));

    const one = census(MIN_WALLETS);
    const address = withPending(one.accounts, one.walletKeys[3], 0n);
    assert.isTrue(isGreen(evaluateProgramScan(PROGRAM_ID, one.accounts, [address], MIN_WALLETS)));
  });

  it("een treffer blijft een treffer: recovery_state Some + wachtende actie", () => {
    const { accounts, walletKeys } = census(MIN_WALLETS);
    accounts[0] = { ...accounts[0], data: walletBytes({ recoverySome: true, sessionEpoch: 0n }) };
    const address = withPending(accounts, walletKeys[0], 0n);
    const r = evaluateProgramScan(PROGRAM_ID, accounts, [address], MIN_WALLETS);
    assert.deepEqual(r.censusProblems, []);
    assert.deepEqual(r.violations.map((v) => v.reasons), [["recovery_in_progress"]]);
    assert.deepEqual(r.inRecovery, [walletKeys[0].toBase58()]);
  });
});

describe("checkRecoveryQueueInvariant: alleen bekende accountlengtes (STATUS.md sectie 162, L-4)", () => {
  it("WalletAccount: 256 (bestaande devnet-wallets) en 264 (WalletAccount::LEN sinds sectie 159) worden beoordeeld", () => {
    for (const len of [256, 264]) {
      assert.lengthOf(scenario({ recoverySome: false, sessionEpoch: 2n, len }, 2n), 0, `len ${len}`);
      assert.deepEqual(scenario({ recoverySome: false, sessionEpoch: 2n, len }, 1n)[0].reasons, ["stale_epoch"], `len ${len}`);
    }
  });

  it("WalletAccount met een andere lengte is unverifiable, ook als de velden erin passen", () => {
    for (const len of [248, 255, 257, 263, 265, 300]) {
      const v = scenario({ recoverySome: false, sessionEpoch: 2n, len }, 2n);
      assert.lengthOf(v, 1, `len ${len}`);
      assert.deepEqual(v[0].reasons, ["unverifiable"], `len ${len}`);
    }
  });

  it("PendingAction: 124 (oude layout) en 164 (huidige) worden beoordeeld, elke andere lengte is unverifiable", () => {
    for (const len of [124, 164]) {
      assert.lengthOf(scenario({ recoverySome: false, sessionEpoch: 2n }, 2n, len), 0, `len ${len}`);
    }
    for (const len of [58, 123, 125, 163]) {
      const v = scenario({ recoverySome: false, sessionEpoch: 2n }, 2n, len);
      assert.lengthOf(v, 1, `len ${len}`);
      assert.deepEqual(v[0].reasons, ["unverifiable"], `len ${len}`);
    }
    const walletKey = Keypair.generate().publicKey;
    const wallets = new Map<string, ProgramAccountBytes | null>();
    wallets.set(walletKey.toBase58(), { address: walletKey.toBase58(), data: walletBytes({ recoverySome: false, sessionEpoch: 2n }), owner: PROGRAM_ID });
    const longer = Buffer.concat([pendingBytes(walletKey, 2n), Buffer.alloc(8)]);
    const v = findInvariantViolations(PROGRAM_ID, [{ address: pendingPdaOf(walletKey), data: longer, owner: PROGRAM_ID }], wallets);
    assert.deepEqual(v[0].reasons, ["unverifiable"]);
  });

  it("een WalletAccount met een onbekende lengte maakt de scan NIET groen, ook zonder wachtende actie", () => {
    const { accounts } = census(MIN_WALLETS, { walletLen: 300 });
    const r = evaluateProgramScan(PROGRAM_ID, accounts, [], MIN_WALLETS);
    assert.isFalse(isGreen(r));
    assert.isTrue(r.censusProblems.some((p) => p.includes("300")));
  });
});
