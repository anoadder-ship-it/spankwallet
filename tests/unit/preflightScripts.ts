import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import { startFakeRpc } from "./fakeDevnetRpc";
import type { FakeRpcState } from "./fakeDevnetRpc";
import { devnetLikeProposals, fx, LOADER, NOW, OLD_BUFFER, RC_BINARY, squadsAccounts, TIME_LOCK, u64 } from "./squadsScenario";
import type { BufferOpts, ProposalOpts } from "./squadsScenario";

/**
 * STATUS.md sectie 167 (review §162, M-1/M-2/M-3, L-1/L-2): de echte
 * pre-flight-scripts als subprocess, tegen een nep-RPC (tests/unit/
 * fakeDevnetRpc.ts). Dit test de bedrading en de exit-codes, niet alleen de
 * pure logica: precies de rode reproducties uit de review (een andere
 * cluster, een achterlopende node, een verkeerd voorstelnummer).
 *
 * Sectie 168 (review §167, M-A/M-B): een tweede goedgekeurd voorstel voor
 * dezelfde buffer, en een buffer op het juiste adres met de verkeerde inhoud
 * of authority.
 *
 * De Squads- en bufferaccounts komen uit tests/unit/squadsScenario.ts.
 */

// process.cwd(), niet __dirname: zie tests/verifyBinaryFresh.ts (ES-modulescope).
const ROOT = process.cwd();
const TS_NODE = path.join(ROOT, "node_modules", ".bin", "ts-node");

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OTHER_GENESIS = Keypair.generate().publicKey.toBase58(); // bv. een lokale test-validator
const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const PROGRAM_DATA = "5bqcgypDa4fa4oVAYPLeYFocy9dyg1b49G9zmaGnwKEq";
// Willekeurige, vaste handtekening: de nep-RPC kent alleen deze.
const EXECUTE_SIGNATURE = "5TyqfwS8wPU1YCtZ3F6kPc3JWLF7wR3fLJ4B8M3xN6qZ2kR7vYhPq9sD4mX1eT8uWb5cN3aG6jH2kL9pQ7rS4vX";

// --- spankwallet-accounts (zelfde layout als tests/unit/recoveryQueueInvariant.ts) ---

const disc = (name: string) => createHash("sha256").update("account:" + name).digest().subarray(0, 8);

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

// --- Squads-accounts (tests/unit/squadsScenario.ts) ---

interface TimelockOpts {
  genesisHash?: string;
  latestIndex: number;
  staleIndex?: number;
  proposals: Record<number, ProposalOpts>;
  buffer?: BufferOpts;
}

function timelockState(o: TimelockOpts): FakeRpcState {
  const accounts = squadsAccounts(o);
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

  describe("sectie 168, M-A: precies één goedgekeurd voorstel voor deze buffer, en dat is het laatste", () => {
    it("#15 goedgekeurd (upgrade + SetAuthority), #16 goedgekeurd en schoon en het laatste: exit 1, #15 genoemd", async () => {
      const state = timelockState({ latestIndex: 16, proposals: { 15: { extraInstruction: true }, 16: {} } });
      expectExit(
        await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "16" }),
        1,
        "tweede goedgekeurd voorstel voor deze buffer moet falen",
        /andere goedgekeurde of lopende voorstellen \(Approved\/Executing\), ongeacht de inhoud: #15 \(Approved\) \(vereist: geen enkel, naast het laatste voorstel #16/
      );
    });

    it("een stale maar goedgekeurd voorstel voor deze buffer telt ook mee (Squads voert stale goedgekeurde voorstellen uit)", async () => {
      const state = timelockState({ latestIndex: 16, staleIndex: 10, proposals: { 3: {}, 16: {} } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "16" }), 1, "oud goedgekeurd voorstel moet falen", /ongeacht de inhoud: #3 \(Approved\)/);
    });

    it("groen: #15 alleen Active (niet goedgekeurd) naast het goedgekeurde, laatste #16", async () => {
      const state = timelockState({ latestIndex: 16, proposals: { 15: { status: 1 }, 16: {} } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "16" }), 0, "een open, niet-goedgekeurd voorstel blokkeert uitvoeren niet", /TIMELOCK VERSTREKEN/);
    });
  });

  describe("sectie 169 (review §168 M-1/M-2): geen enkel ander voorstel Approved of Executing, ongeacht de inhoud", () => {
    const OTHER = /andere goedgekeurde of lopende voorstellen \(Approved\/Executing\), ongeacht de inhoud: #15 \((Approved|Executing)\)/;
    const cases: [string, ProposalOpts][] = [
      ["B: #15 goedgekeurd, Upgrade met één extra byte in de instructiedata (loader accepteert dat)", { upgradeDataSuffix: Buffer.from([0]) }],
      ["C: #15 goedgekeurd, Upgrade van hetzelfde programma vanaf een andere buffer", { buffer: OLD_BUFFER }],
      ["#15 is een goedgekeurde Batch", { kind: "batch" }],
      ["#15 is een Batch in uitvoering (Executing)", { kind: "batch", status: 4 }],
      ["#15 is een goedgekeurde ConfigTransaction (SetTimeLock 0)", { kind: "config" }],
    ];
    for (const [name, other] of cases) {
      it(`${name}, #16 schoon en het laatste: exit 1`, async () => {
        const state = timelockState({ latestIndex: 16, proposals: { 15: other, 16: {} } });
        expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "16" }), 1, `${name} moet falen`, OTHER);
      });
    }

    it("ook stale: goedgekeurde Upgrade #3 vanaf een andere buffer (staleTransactionIndex 10): exit 1", async () => {
      const state = timelockState({ latestIndex: 16, staleIndex: 10, proposals: { 3: { buffer: OLD_BUFFER }, 16: {} } });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "16" }), 1, "stale goedgekeurd voorstel moet falen", /ongeacht de inhoud: #3 \(Approved\)/);
    });

    it("groen: de echte devnet-stand (Active-, Executed-, Cancelled- en Rejected-restanten) plus een schone, goedgekeurde #15", async () => {
      const state = timelockState({ latestIndex: 15, proposals: devnetLikeProposals(15) });
      expectExit(await run(state, TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 0, "de devnet-stand mag niet blokkeren", /TIMELOCK VERSTREKEN/);
    });
  });

  describe("sectie 168, M-B: de buffer zelf (loader, tag, authority = vault, sha256, rest nul)", () => {
    const withBuffer = (buffer: BufferOpts) => timelockState({ latestIndex: 15, proposals: { 15: {} }, buffer });
    const cases: [string, BufferOpts, RegExp][] = [
      ["buffer bestaat niet", { absent: true }, /buffer F5nh\S+ bestaat niet/],
      ["buffer niet van de upgradeable loader", { owner: PublicKey.default.toBase58() }, /buffer F5nh\S+ is niet van de upgradeable loader/],
      ["geen Buffer-account (tag 3 = ProgramData)", { tag: 3 }, /geen Buffer-account \(tag 3\)/],
      ["authority None", { authority: null }, /buffer-authority is None, verwacht de vault 89ME\S+/],
      ["authority een andere sleutel (bv. nog het deploy-keypair)", { authority: OLD_BUFFER }, /buffer-authority HRcc\S+, verwacht de vault 89ME\S+/],
      [
        "verkeerde inhoud (één byte anders)",
        { program: Buffer.concat([RC_BINARY.subarray(0, 1000), Buffer.from([RC_BINARY[1000] ^ 1]), RC_BINARY.subarray(1001)]) },
        /sha256 van de eerste 737080 bytes na de kop is [0-9a-f]{64}, verwacht 33598b3d\S+/,
      ],
      ["te kort", { program: RC_BINARY.subarray(0, 700_000) }, /buffer is 700037 bytes, verwacht minstens 737117/],
      ["niet-nul byte na het programma", { tail: Buffer.from([0, 0, 7]) }, /niet-nul byte na het programma op offset 737119/],
    ];
    for (const [name, buffer, reason] of cases) {
      it(`${name}: exit 1`, async () => {
        expectExit(await run(withBuffer(buffer), TIMELOCK, [], { TRANSACTION_INDEX: "15" }), 1, `${name} moet falen`, reason);
      });
    }

    it("groen: juiste buffer met nullen na het programma (ruimer gealloceerd)", async () => {
      const r = await run(withBuffer({ tail: Buffer.alloc(4096) }), TIMELOCK, [], { TRANSACTION_INDEX: "15" });
      expectExit(r, 0, "juiste buffer moet groen zijn", /Buffer F5nh\S+: authority de vault, sha256 33598b3d\S+ over 737080 bytes, rest nul[\s\S]*TIMELOCK VERSTREKEN/);
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
