import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { DEVNET_GENESIS_HASH, genesisHashProblem } from "../../scripts/lib/devnetCluster";
import {
  BPF_LOADER_UPGRADEABLE,
  contextSlotProblems,
  decodeProgramAccount,
  decodeProgramDataHeader,
  postReferenceProblem,
} from "../../scripts/lib/programDeploySlot";
import {
  decodeMultisigHeader,
  decodeProposalHeader,
  decodeVaultTransaction,
  upgradeProposalProblems,
  vaultPda,
} from "../../scripts/lib/squadsUpgradeProposal";
import type { ExpectedUpgrade, VaultTransaction } from "../../scripts/lib/squadsUpgradeProposal";

/**
 * STATUS.md sectie 167 (review §162, M-1/M-2/M-3): de pure beslislogica
 * achter de pre-flight-scripts, op echte devnet-bytes
 * (fixtures/devnetSquads20260929.json). De scripts zelf, tegen een nep-RPC:
 * tests/unit/preflightScripts.ts.
 */

// process.cwd(), niet __dirname: zie tests/verifyBinaryFresh.ts (ES-modulescope).
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "unit", "fixtures", "devnetSquads20260929.json"), "utf8"));
const b64 = (s: string) => Buffer.from(s, "base64");

const MULTISIG = new PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
const VAULT = new PublicKey("89MEwqhfdqaz45Zoov6jsMkjmTiRZpCyKNq1yGMeVQcw");
const PROGRAM_ID = new PublicKey("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");
const PROGRAM_DATA = new PublicKey("5bqcgypDa4fa4oVAYPLeYFocy9dyg1b49G9zmaGnwKEq");
const BUFFER_13 = new PublicKey("HRccWBKjfiLrTAZ9JwnukTkesSqUk2F38cRyDTvV7szK");
const RC_BUFFER = new PublicKey("F5nh9UdF4XqYzN9pX9hL8YHLrrPKjH2HCwt87TgZdG5");

describe("pre-flight-logica op echte devnet-bytes (STATUS.md sectie 167)", () => {
  describe("M-1: genesis-hash", () => {
    it("de fixture is devnet, en alleen die hash wordt geaccepteerd", () => {
      assert.equal(fx.genesisHash, DEVNET_GENESIS_HASH);
      assert.isNull(genesisHashProblem(DEVNET_GENESIS_HASH));
    });

    it("mainnet-beta en een willekeurige lokale cluster worden geweigerd", () => {
      assert.isString(genesisHashProblem("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"));
      assert.isString(genesisHashProblem(Keypair.generate().publicKey.toBase58()));
      assert.isString(genesisHashProblem(""));
    });
  });

  describe("M-2: referentieslot", () => {
    it("echt programma-account en ProgramData-kop van 9ma6 worden gedecodeerd", () => {
      const programData = decodeProgramAccount(b64(fx.programAccount), BPF_LOADER_UPGRADEABLE, true);
      assert.instanceOf(programData, PublicKey);
      assert.isTrue((programData as PublicKey).equals(PROGRAM_DATA));
      const header = decodeProgramDataHeader(b64(fx.programDataHeader), BPF_LOADER_UPGRADEABLE);
      assert.deepEqual(header, { lastDeploySlot: 501_303_135n });
    });

    it("programma-account: verkeerde owner, niet executable of verkeerde vorm is geen programma", () => {
      assert.isString(decodeProgramAccount(b64(fx.programAccount), PublicKey.default, true));
      assert.isString(decodeProgramAccount(b64(fx.programAccount), BPF_LOADER_UPGRADEABLE, false));
      const wrongTag = b64(fx.programAccount);
      wrongTag[0] = 3;
      assert.isString(decodeProgramAccount(wrongTag, BPF_LOADER_UPGRADEABLE, true));
      assert.isString(decodeProgramAccount(b64(fx.programAccount).subarray(0, 35), BPF_LOADER_UPGRADEABLE, true));
    });

    it("ProgramData-kop: verkeerde owner, tag, lengte of authority-tag wordt geweigerd", () => {
      assert.isString(decodeProgramDataHeader(b64(fx.programDataHeader), PublicKey.default));
      const wrongTag = b64(fx.programDataHeader);
      wrongTag[0] = 2;
      assert.isString(decodeProgramDataHeader(wrongTag, BPF_LOADER_UPGRADEABLE));
      assert.isString(decodeProgramDataHeader(b64(fx.programDataHeader).subarray(0, 44), BPF_LOADER_UPGRADEABLE));
      const badAuthority = b64(fx.programDataHeader);
      badAuthority[12] = 2;
      assert.isString(decodeProgramDataHeader(badAuthority, BPF_LOADER_UPGRADEABLE));
    });

    it("--post: alleen een geslaagde, bevestigde uitvoertransactie op precies de last_deploy_slot telt", () => {
      const ok = { slot: 2_000, err: null, confirmationStatus: "confirmed" };
      assert.isNull(postReferenceProblem(2_000n, ok));
      assert.isNull(postReferenceProblem(2_000n, { ...ok, confirmationStatus: "finalized" }));
      assert.isString(postReferenceProblem(2_000n, null), "onbekende handtekening");
      assert.isString(postReferenceProblem(2_000n, { ...ok, err: { InstructionError: [0, "Custom"] } }), "mislukte transactie");
      assert.isString(postReferenceProblem(2_000n, { ...ok, confirmationStatus: "processed" }), "alleen processed");
      assert.isString(postReferenceProblem(1_000n, ok), "node heeft de deploy niet gezien");
      assert.isString(postReferenceProblem(3_000n, ok), "een latere deploy dan deze transactie");
    });

    it("context.slot moet strikt groter zijn dan de referentie, voor elke aanroep apart", () => {
      assert.deepEqual(contextSlotProblems(2_000n, [{ label: "a", slot: 2_001 }, { label: "b", slot: 9_999 }]), []);
      assert.lengthOf(contextSlotProblems(2_000n, [{ label: "a", slot: 2_000 }]), 1);
      assert.lengthOf(contextSlotProblems(2_000n, [{ label: "a", slot: 1_999 }]), 1);
      assert.lengthOf(contextSlotProblems(2_000n, [{ label: "a", slot: 2_001 }, { label: "b", slot: 1_500 }]), 1);
    });
  });

  describe("M-3: het voorstel zelf", () => {
    const expected13: ExpectedUpgrade = {
      multisig: MULTISIG,
      transactionIndex: 13n,
      vaultIndex: 0,
      programId: PROGRAM_ID,
      programData: PROGRAM_DATA,
      buffer: BUFFER_13,
    };
    const vtx13 = () => decodeVaultTransaction(b64(fx.vaultTransaction13)) as VaultTransaction;

    it("echte multisig en proposal #13 worden gedecodeerd", () => {
      assert.deepEqual(decodeMultisigHeader(b64(fx.multisig)), {
        threshold: 2,
        timeLockSeconds: 259_200,
        transactionIndex: 14n,
        staleTransactionIndex: 0n,
      });
      const proposal = decodeProposalHeader(b64(fx.proposal13));
      assert.notTypeOf(proposal, "string");
      if (typeof proposal === "string") return;
      assert.isTrue(proposal.multisig.equals(MULTISIG));
      assert.equal(proposal.transactionIndex, 13n);
      assert.equal(proposal.statusTag, 5); // Executed
    });

    it("de vault-PDA volgt uit de multisig (seeds uit @sqds/multisig src/pda.ts)", () => {
      assert.isTrue(vaultPda(MULTISIG, 0).equals(VAULT));
    });

    it("echte VaultTransactions #11 en #13 worden exact en volledig gedecodeerd", () => {
      for (const key of ["vaultTransaction11", "vaultTransaction13"]) {
        const vtx = decodeVaultTransaction(b64(fx[key]));
        assert.notTypeOf(vtx, "string", key);
      }
    });

    it("groen op echte data: het uitgevoerde voorstel #13 is precies de upgrade van 9ma6 vanaf zijn eigen buffer", () => {
      assert.deepEqual(upgradeProposalProblems(vtx13(), expected13), []);
    });

    it("dezelfde echte upgrade met de RC-buffer als verwachting: afgewezen op de buffer, en alleen daarop", () => {
      const problems = upgradeProposalProblems(vtx13(), { ...expected13, buffer: RC_BUFFER });
      assert.lengthOf(problems, 1);
      assert.match(problems[0], /^buffer:/);
    });

    it("een ander voorstelnummer, programma of programdata wordt afgewezen", () => {
      assert.isNotEmpty(upgradeProposalProblems(vtx13(), { ...expected13, transactionIndex: 15n }));
      assert.isNotEmpty(upgradeProposalProblems(vtx13(), { ...expected13, programId: Keypair.generate().publicKey }));
      assert.isNotEmpty(upgradeProposalProblems(vtx13(), { ...expected13, programData: Keypair.generate().publicKey }));
      assert.isNotEmpty(upgradeProposalProblems(vtx13(), { ...expected13, multisig: Keypair.generate().publicKey }));
    });

    it("structurele afwijkingen worden afgewezen: tweede instructie, andere opcode, ander programma, spill, extra ondertekenaar, ephemeral signer", () => {
      const twoIx = vtx13();
      twoIx.instructions.push(twoIx.instructions[0]);
      assert.isNotEmpty(upgradeProposalProblems(twoIx, expected13), "tweede instructie");

      const setAuthority = vtx13();
      setAuthority.instructions[0].data = Buffer.from([4, 0, 0, 0]); // SetAuthority
      assert.isNotEmpty(upgradeProposalProblems(setAuthority, expected13), "andere opcode");

      const otherProgram = vtx13();
      otherProgram.instructions[0].programIdIndex = 5; // rent-sysvar i.p.v. de loader
      assert.isNotEmpty(upgradeProposalProblems(otherProgram, expected13), "ander programma");

      const spill = vtx13();
      spill.accountKeys.push(Keypair.generate().publicKey);
      spill.instructions[0].accountIndexes[3] = spill.accountKeys.length - 1;
      const spillProblems = upgradeProposalProblems(spill, expected13);
      assert.lengthOf(spillProblems, 1);
      assert.match(spillProblems[0], /^spill:/);

      const signers = vtx13();
      signers.numSigners = 2;
      assert.isNotEmpty(upgradeProposalProblems(signers, expected13), "extra ondertekenaar");

      const ephemeral = vtx13();
      ephemeral.ephemeralSignerBumps = Buffer.from([255]);
      assert.isNotEmpty(upgradeProposalProblems(ephemeral, expected13), "ephemeral signer");

      const outOfRange = vtx13();
      outOfRange.instructions[0].accountIndexes[2] = 200;
      assert.isNotEmpty(upgradeProposalProblems(outOfRange, expected13), "index buiten accountKeys");
    });

    it("bytes: een lookup-table, een afgekapt of een verlengd account, of een andere discriminator wordt afgewezen", () => {
      const raw = b64(fx.vaultTransaction13);
      // Laatste 4 bytes = lengte van addressTableLookups (0). Eén echte entry toevoegen.
      const withLookup = Buffer.concat([
        raw.subarray(0, raw.length - 4),
        Buffer.from([1, 0, 0, 0]),
        Keypair.generate().publicKey.toBuffer(),
        Buffer.from([1, 0, 0, 0, 1]), // writable_indexes = [1]
        Buffer.from([0, 0, 0, 0]), // readonly_indexes = []
      ]);
      const decoded = decodeVaultTransaction(withLookup);
      assert.notTypeOf(decoded, "string");
      assert.isNotEmpty(upgradeProposalProblems(decoded as VaultTransaction, expected13), "lookup-table");

      assert.isString(decodeVaultTransaction(raw.subarray(0, raw.length - 1)), "afgekapt");
      assert.isString(decodeVaultTransaction(Buffer.concat([raw, Buffer.from([0])])), "verlengd");
      assert.isString(decodeVaultTransaction(b64(fx.proposal13)), "andere discriminator");
      assert.isString(decodeProposalHeader(b64(fx.vaultTransaction13)), "andere discriminator");
      assert.isString(decodeMultisigHeader(b64(fx.proposal13)), "andere discriminator");
    });

    it("proposal: een onbekende status-tag of een afgekapt account wordt afgewezen", () => {
      const unknown = b64(fx.proposal13);
      unknown[48] = 7;
      assert.isString(decodeProposalHeader(unknown));
      assert.isString(decodeProposalHeader(b64(fx.proposal13).subarray(0, 50)));
    });
  });
});
