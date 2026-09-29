import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { startFakeRpc } from "./fakeDevnetRpc";
import type { FakeRpcState } from "./fakeDevnetRpc";

/**
 * STATUS.md sectie 167 (review §162, M-1/M-2/M-3, L-1/L-2): de echte
 * pre-flight-scripts als subprocess, tegen een nep-RPC (tests/unit/
 * fakeDevnetRpc.ts). Dit test de bedrading en de exit-codes, niet alleen de
 * pure logica: precies de rode reproducties uit de review (een andere
 * cluster, een achterlopende node, een verkeerd voorstelnummer).
 *
 * Basis zijn echte devnet-bytes (fixtures/devnetSquads20260929.json); elke
 * afwijking is een gerichte patch daarop.
 */

// process.cwd(), niet __dirname: zie tests/verifyBinaryFresh.ts (ES-modulescope).
const ROOT = process.cwd();
const TS_NODE = path.join(ROOT, "node_modules", ".bin", "ts-node");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "unit", "fixtures", "devnetSquads20260929.json"), "utf8"));

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OTHER_GENESIS = Keypair.generate().publicKey.toBase58(); // bv. een lokale test-validator
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const PROGRAM_DATA = "5bqcgypDa4fa4oVAYPLeYFocy9dyg1b49G9zmaGnwKEq";
const SQUADS = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const MULTISIG = new PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
const RC_BUFFER = new PublicKey("F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5");
const OLD_BUFFER = new PublicKey("HRccWBKjfiLrTAZ9JwnukTkesSqUk2F38cRyDTvV7szK"); // buffer van voorstel #13
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
// Willekeurige, vaste handtekening: de nep-RPC kent alleen deze.
const EXECUTE_SIGNATURE = "5TyqfwS8wPU1YCtZ3F6kPc3JWLF7wR3fLJ4B8M3xN6qZ2kR7vYhPq9sD4mX1eT8uWb5cN3aG6jH2kL9pQ7rS4vX";
const NOW = 1_790_000_000;
const TIME_LOCK = 259_200;

// --- spankwallet-accounts (zelfde layout als tests/unit/recoveryQueueInvariant.ts) ---

const disc = (name: string) => createHash("sha256").update("account:" + name).digest().subarray(0, 8);
const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

function walletBytes(recoverySome: boolean): Buffer {
  const body = Buffer.concat([
    disc("WalletAccount"),
    Buffer.alloc(140),
    recoverySome ? Buffer.concat([Buffer.from([1]), Buffer.alloc(41)]) : Buffer.from([0]),
    u64(259_200), // recovery_timelock_seconds
    Buffer.from([0]), // deposit_authority None
    u64(0), // action_nonce
    u64(0), // session_epoch
  ]);
  return Buffer.concat([body, Buffer.alloc(256 - body.length)]);
}

function pendingBytes(wallet: PublicKey): Buffer {
  return Buffer.concat([disc("PendingAction"), wallet.toBuffer(), Buffer.alloc(2), u64(0), u64(0), Buffer.alloc(106)]);
}

function programDataHeader(lastDeploySlot: number): Buffer {
  const b = Buffer.from(fx.programDataHeader, "base64");
  b.writeBigUInt64LE(BigInt(lastDeploySlot), 4);
  return b;
}

interface InvariantOpts {
  genesisHash?: string;
  slot: number;
  lastDeploySlot: number;
  honorMinContextSlot?: boolean;
  signatureSlot?: number;
  recoveryWithPending?: boolean;
}

function invariantState(o: InvariantOpts): FakeRpcState {
  const accounts = new Map<string, { owner: string; data: Buffer; executable?: boolean }>();
  const programOwner = PROGRAM_ID.toBase58();
  accounts.set(programOwner, { owner: LOADER, data: Buffer.from(fx.programAccount, "base64"), executable: true });
  accounts.set(PROGRAM_DATA, { owner: LOADER, data: programDataHeader(o.lastDeploySlot) });
  for (let i = 0; i < 19; i++) {
    const wallet = Keypair.generate().publicKey;
    const inRecovery = o.recoveryWithPending === true && i === 0;
    accounts.set(wallet.toBase58(), { owner: programOwner, data: walletBytes(inRecovery) });
    accounts.set(Keypair.generate().publicKey.toBase58(), {
      owner: programOwner,
      data: Buffer.concat([disc("VaultAccount"), wallet.toBuffer(), Buffer.from([254])]),
    });
    if (inRecovery) {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pending_action"), wallet.toBuffer()], PROGRAM_ID);
      accounts.set(pda.toBase58(), { owner: programOwner, data: pendingBytes(wallet) });
    }
  }
  const signatureStatuses = new Map();
  if (o.signatureSlot !== undefined) {
    signatureStatuses.set(EXECUTE_SIGNATURE, { slot: o.signatureSlot, err: null, confirmationStatus: "confirmed" });
  }
  return {
    genesisHash: o.genesisHash ?? DEVNET_GENESIS,
    slot: o.slot,
    honorMinContextSlot: o.honorMinContextSlot ?? true,
    accounts,
    signatureStatuses,
  };
}

// --- Squads-accounts ---

function txPda(index: number, suffix?: string): string {
  const seeds = [Buffer.from("multisig"), MULTISIG.toBuffer(), Buffer.from("transaction"), u64(index)];
  if (suffix) seeds.push(Buffer.from(suffix));
  return PublicKey.findProgramAddressSync(seeds, SQUADS)[0].toBase58();
}

interface ProposalOpts {
  status?: number; // 3 = Approved
  approvedAt?: number;
  buffer?: PublicKey;
  proposalOwner?: string;
}

interface TimelockOpts {
  genesisHash?: string;
  latestIndex: number;
  proposals: Record<number, ProposalOpts>;
}

function timelockState(o: TimelockOpts): FakeRpcState {
  const accounts = new Map<string, { owner: string; data: Buffer; executable?: boolean }>();
  const multisig = Buffer.from(fx.multisig, "base64");
  multisig.writeBigUInt64LE(BigInt(o.latestIndex), 78);
  accounts.set(MULTISIG.toBase58(), { owner: SQUADS.toBase58(), data: multisig });
  for (const [key, p] of Object.entries(o.proposals)) {
    const index = Number(key);
    const proposal = Buffer.from(fx.proposal13, "base64");
    proposal.writeBigUInt64LE(BigInt(index), 40);
    proposal[48] = p.status ?? 3;
    proposal.writeBigInt64LE(BigInt(p.approvedAt ?? NOW - TIME_LOCK - 3600), 49);
    accounts.set(txPda(index, "proposal"), { owner: p.proposalOwner ?? SQUADS.toBase58(), data: proposal });
    const vtx = Buffer.from(fx.vaultTransaction13, "base64");
    vtx.writeBigUInt64LE(BigInt(index), 72);
    const at = vtx.indexOf(OLD_BUFFER.toBuffer());
    (p.buffer ?? RC_BUFFER).toBuffer().copy(vtx, at);
    accounts.set(txPda(index), { owner: SQUADS.toBase58(), data: vtx });
  }
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(500_000_000n, 0);
  clock.writeBigInt64LE(BigInt(NOW), 32);
  accounts.set(CLOCK, { owner: SYSVAR_OWNER, data: clock });
  return { genesisHash: o.genesisHash ?? DEVNET_GENESIS, slot: 500_000_000, honorMinContextSlot: true, accounts, signatureStatuses: new Map() };
}

// --- uitvoeren ---

interface RunResult {
  code: number | null;
  output: string;
}

async function run(state: FakeRpcState, script: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const rpc = await startFakeRpc(state);
  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, RPC_URL: rpc.url, ...env };
    for (const k of ["TRANSACTION_INDEX", "EXECUTE_SIGNATURE"]) if (!(k in env)) delete childEnv[k];
    return await new Promise<RunResult>((resolve, reject) => {
      // Asynchroon (niet spawnSync): de nep-RPC draait in dit proces.
      const child = spawn(TS_NODE, ["--transpile-only", script, ...args], { cwd: ROOT, env: childEnv });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  } finally {
    await rpc.close();
  }
}

/** Exit-code EN reden: exit 2 is ook wat een crash oplevert, dus de code alleen bewijst niets. */
function expectExit(r: RunResult, code: number, why: string, reason: RegExp) {
  assert.strictEqual(r.code, code, `${why}\n--- uitvoer ---\n${r.output}`);
  assert.match(r.output, reason, `${why}: verkeerde reden\n--- uitvoer ---\n${r.output}`);
}

const INVARIANT = "scripts/checkRecoveryQueueInvariant.ts";
const TIMELOCK = "scripts/checkProposalTimelock.ts";
const WRAPPER = "scripts/preUpgradeChecks.ts";

describe("pre-flight-scripts tegen een nep-RPC (STATUS.md sectie 167)", function () {
  this.timeout(120_000);

  describe("M-1: alleen devnet (genesis-hash)", () => {
    it("invariant-check: een andere cluster met een schone staat geeft exit 2, niet groen", async () => {
      const r = await run(invariantState({ genesisHash: OTHER_GENESIS, slot: 5_000, lastDeploySlot: 1_000 }), INVARIANT, ["--pre"]);
      expectExit(r, 2, "andere genesis-hash moet exit 2 geven", /CLUSTER GEWEIGERD/);
    });

    it("timelock-check: een andere cluster met een verder geldig voorstel geeft exit 2", async () => {
      const r = await run(timelockState({ genesisHash: OTHER_GENESIS, latestIndex: 15, proposals: { 15: {} } }), TIMELOCK, [], {
        TRANSACTION_INDEX: "15",
      });
      expectExit(r, 2, "andere genesis-hash moet exit 2 geven", /CLUSTER GEWEIGERD/);
    });
  });

  describe("M-2: de gelezen staat moet na de referentieslot liggen", () => {
    it("--post: node heeft de deploy nog niet gezien (last_deploy_slot < slot van de uitvoertransactie) geeft exit 2", async () => {
      const state = invariantState({ slot: 1_500, lastDeploySlot: 1_000, signatureSlot: 2_000 });
      const r = await run(state, INVARIANT, ["--post"], { EXECUTE_SIGNATURE });
      expectExit(r, 2, "achterlopende node moet exit 2 geven", /last_deploy_slot 1000 is niet de slot van de uitvoertransactie \(2000\)/);
    });

    it("--post: context.slot niet groter dan de uitvoerslot, ook als de node minContextSlot negeert, geeft exit 2", async () => {
      const state = invariantState({ slot: 2_000, lastDeploySlot: 2_000, signatureSlot: 2_000, honorMinContextSlot: false });
      const r = await run(state, INVARIANT, ["--post"], { EXECUTE_SIGNATURE });
      expectExit(r, 2, "context.slot == uitvoerslot moet exit 2 geven", /gelezen op slot 2000, niet na de referentieslot 2000/);
    });

    it("--post: onbekende uitvoertransactie geeft exit 2", async () => {
      const r = await run(invariantState({ slot: 5_000, lastDeploySlot: 2_000 }), INVARIANT, ["--post"], { EXECUTE_SIGNATURE });
      expectExit(r, 2, "onbekende handtekening moet exit 2 geven", /uitvoertransactie onbekend bij deze node/);
    });

    it("--post zonder EXECUTE_SIGNATURE geeft exit 2", async () => {
      const r = await run(invariantState({ slot: 5_000, lastDeploySlot: 2_000 }), INVARIANT, ["--post"]);
      expectExit(r, 2, "--post zonder handtekening moet exit 2 geven", /CONTROLE ONBETROUWBAAR: --post vereist EXECUTE_SIGNATURE/);
    });

    it("--pre: context.slot niet groter dan last_deploy_slot geeft exit 2", async () => {
      const r = await run(invariantState({ slot: 1_000, lastDeploySlot: 1_000, honorMinContextSlot: false }), INVARIANT, ["--pre"]);
      expectExit(r, 2, "context.slot == last_deploy_slot moet exit 2 geven", /gelezen op slot 1000, niet na de referentieslot 1000/);
    });

    it("zonder --pre/--post geeft exit 2", async () => {
      const r = await run(invariantState({ slot: 5_000, lastDeploySlot: 1_000 }), INVARIANT, []);
      expectExit(r, 2, "zonder modus moet exit 2 geven", /gebruik: checkRecoveryQueueInvariant.ts --pre \| --post/);
    });

    it("groen: --pre na de laatste deploy, en --post na de uitvoerslot", async () => {
      expectExit(await run(invariantState({ slot: 5_000, lastDeploySlot: 1_000 }), INVARIANT, ["--pre"]), 0, "--pre moet groen zijn", /GROEN/);
      const post = invariantState({ slot: 2_001, lastDeploySlot: 2_000, signatureSlot: 2_000 });
      expectExit(await run(post, INVARIANT, ["--post"], { EXECUTE_SIGNATURE }), 0, "--post moet groen zijn", /gelijk aan last_deploy_slot[\s\S]*GROEN/);
    });

    it("een treffer blijft exit 1 (recovery + wachtende actie), ook met de nieuwe controles", async () => {
      const r = await run(invariantState({ slot: 5_000, lastDeploySlot: 1_000, recoveryWithPending: true }), INVARIANT, ["--pre"]);
      expectExit(r, 1, "treffer moet exit 1 geven", /ROOD: 1 treffer\(s\)[\s\S]*recovery_in_progress/);
    });
  });

  describe("M-3, L-1, L-2: precies het laatste voorstel, en precies deze upgrade", () => {
    it("TRANSACTION_INDEX is niet het laatste voorstel (#13 goedgekeurd, maar #15 is het laatste) geeft exit 1", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 13: {}, 15: {} } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "13" }), 1, "niet-laatste voorstel moet falen", /TRANSACTION_INDEX 13 is niet het laatste voorstel \(multisig.transactionIndex = 15\)/);
    });

    it("het laatste voorstel upgradet met een andere buffer (die van #13) geeft exit 1", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 15: { buffer: OLD_BUFFER } } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 1, "andere buffer moet falen", /buffer: HRccWBKjfiLrTAZ9JwnukTkesSqUk2F38cRyDTvV7szK, verwacht F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5/);
    });

    it("een proposal-account dat niet van Squads is, geeft exit 1 (L-2)", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 15: { proposalOwner: PublicKey.default.toBase58() } } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 1, "verkeerde owner moet falen", /Proposal-account \S+ is niet van het Squads-programma/);
    });

    it("zonder TRANSACTION_INDEX geen standaardvoorstel meer: exit 2 (L-1)", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 15: {} } });
      expectExit(await run(state, TIMELOCK, []), 2, "zonder TRANSACTION_INDEX moet exit 2 geven", /TRANSACTION_INDEX ontbreekt/);
    });

    it("timelock nog niet verstreken blijft exit 1", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 15: { approvedAt: NOW - TIME_LOCK + 60 } } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 1, "lopende timelock moet falen", /TIMELOCK NIET VERSTREKEN/);
    });

    it("groen: laatste voorstel, goedgekeurd, timelock verstreken, upgrade van 9ma6 met buffer F5nh9UdF", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 15: {} } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 0, "geldig voorstel moet groen zijn", /alleen Upgrade van 9ma6\S+ vanaf buffer F5nh9UdF\S+[\s\S]*TIMELOCK VERSTREKEN/);
    });
  });

  describe("wrapper preUpgradeChecks.ts", () => {
    it("--post zonder EXECUTE_SIGNATURE: exit 2 vóór er iets draait", async () => {
      const r = await run(invariantState({ slot: 5_000, lastDeploySlot: 1_000 }), WRAPPER, ["--post"]);
      expectExit(r, 2, "--post zonder handtekening moet exit 2 geven", /preUpgradeChecks: --post vereist EXECUTE_SIGNATURE/);
    });

    it("--post geeft de handtekening door en is groen bij een verse node", async () => {
      const state = invariantState({ slot: 2_001, lastDeploySlot: 2_000, signatureSlot: 2_000 });
      expectExit(await run(state, WRAPPER, ["--post"], { EXECUTE_SIGNATURE }), 0, "--post moet groen zijn", /Alle 1 stap\(pen\) van --post groen/);
    });

    it("--pre groen van begin tot eind: beide stappen tegen dezelfde node", async () => {
      const state = invariantState({ slot: 500_000_000, lastDeploySlot: 1_000 });
      for (const [address, account] of timelockState({ latestIndex: 15, proposals: { 15: {} } }).accounts) {
        state.accounts.set(address, account);
      }
      const r = await run(state, WRAPPER, ["--pre"], { TRANSACTION_INDEX: "15" });
      expectExit(r, 0, "--pre moet groen zijn", /TIMELOCK VERSTREKEN[\s\S]*GROEN[\s\S]*Alle 2 stap\(pen\) van --pre groen/);
    });

    it("--pre stopt bij een niet-laatste TRANSACTION_INDEX in stap 1", async () => {
      const state = timelockState({ latestIndex: 15, proposals: { 13: {}, 15: {} } });
      const r = await run(state, WRAPPER, ["--pre"], { TRANSACTION_INDEX: "13" });
      expectExit(r, 1, "stap 1 moet falen", /niet het laatste voorstel[\s\S]*STOP: scripts\/checkProposalTimelock.ts faalde \(exit 1\)/);
      assert.notInclude(r.output, "stap 2/2", "stap 2 mag niet draaien");
    });
  });
});
