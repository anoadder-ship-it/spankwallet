import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import type { FakeAccount } from "./fakeDevnetRpc";
import { squadsAccounts } from "./squadsScenario";
import type { SquadsOpts } from "./squadsScenario";

/**
 * STATUS.md sectie 168 (review §167, M-A): welk voorstel de knoppen 3 en 4
 * van admin/wallet-signer.html daadwerkelijk raken, met de EIGEN code van de
 * pagina, niet een kopie ervan. De functies en eenvoudige constanten worden
 * uit de pagina gelezen en uitgevoerd met de gevendorde web3.js en
 * @sqds/multisig (dezelfde bestanden die de browser laadt) en de gedeelde
 * admin/upgradeProposalCheck.mjs, tegen een nep-connectie over dezelfde
 * accounts als tests/unit/preflightScripts.ts. Alleen het versturen zelf
 * (multisig.transactions.*) is vervangen door een opname.
 */

const ROOT = process.cwd();
const PAGE = fs.readFileSync(path.join(ROOT, "admin", "wallet-signer.html"), "utf8");
const SCRIPT = fs.readFileSync(path.join(ROOT, "scripts", "checkProposalTimelock.ts"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "admin", "https-server.js"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("../../admin/vendor/web3.mjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("../../admin/vendor/multisig.mjs").default;

function moduleScript(html: string): string {
  const start = html.indexOf('<script type="module">');
  const end = html.indexOf("</script>", start);
  if (start < 0 || end < 0) throw new Error("module-script niet gevonden in de pagina");
  return html.slice(start + '<script type="module">'.length, end);
}

/** Index net voorbij de afsluiter die bij `open` op `from` hoort; slaat strings, templates en commentaar over. */
function matchClose(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (src[i] !== "`") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") i = matchClose(src, i + 1, "{", "}");
        else i++;
      }
      i++;
      continue;
    }
    if (c === open) depth++;
    if (c === close && --depth === 0) return i + 1;
    i++;
  }
  throw new Error(`geen afsluitende ${close} vanaf offset ${from}`);
}

interface PageCode {
  names: string[];
  source: string;
}

/** Alle functies en eenvoudige constanten (PublicKey, getal, object op één regel) op het hoogste niveau van het module-script. */
function pageCode(html: string): PageCode {
  const src = moduleScript(html);
  const consts = [...src.matchAll(/^ {6}const (\w+) = (new PublicKey\("[1-9A-HJ-NP-Za-km-z]+"\)|\d+|\{[^;\n]*\});$/gm)].map((m) => m[0]);
  const names: string[] = [];
  const functions: string[] = [];
  for (const m of src.matchAll(/^ {6}(?:async )?function (\w+)\(/gm)) {
    const paramsEnd = matchClose(src, m.index! + m[0].length - 1, "(", ")");
    const bodyStart = src.indexOf("{", paramsEnd);
    functions.push(src.slice(m.index!, matchClose(src, bodyStart, "{", "}")));
    names.push(m[1]);
  }
  return { names, source: consts.join("\n") + "\n" + functions.join("\n") };
}

interface Sent {
  kind: string;
  transactionIndex: bigint;
}

interface FakeElement {
  textContent: string;
  disabled: boolean;
  className: string;
  appendChild(child: FakeElement): void;
}

interface Page {
  fns: Record<string, (...args: any[]) => Promise<any>>;
  sent: Sent[];
  /** Wat de eigen log() van de pagina in #output zette. */
  logs: string[];
  elements: Record<string, FakeElement>;
}

function fakeConnection(accounts: Map<string, FakeAccount>) {
  const info = (address: { toBase58(): string }) => {
    const a = accounts.get(address.toBase58());
    return a ? { data: Buffer.from(a.data), owner: new web3.PublicKey(a.owner), executable: !!a.executable, lamports: 1_000_000, rentEpoch: 0 } : null;
  };
  const context = { slot: 500_000_000 };
  return {
    getAccountInfo: async (address: any) => info(address),
    getAccountInfoAndContext: async (address: any) => ({ context, value: info(address) }),
    getMultipleAccountsInfo: async (addresses: any[]) => addresses.map(info),
    getMultipleAccountsInfoAndContext: async (addresses: any[]) => ({ context, value: addresses.map(info) }),
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
  };
}

async function loadPage(state: SquadsOpts): Promise<Page> {
  const { names, source } = pageCode(PAGE);
  const sent: Sent[] = [];
  const logs: string[] = [];
  const elements: Page["elements"] = {};
  const record = (kind: string) => (args: { transactionIndex: bigint }) => {
    sent.push({ kind, transactionIndex: BigInt(args.transactionIndex) });
    return { kind };
  };
  const element = (): FakeElement => ({
    textContent: "",
    disabled: false,
    className: "",
    appendChild: (child: FakeElement) => logs.push(child.textContent),
  });
  const env: Record<string, unknown> = {
    PublicKey: web3.PublicKey,
    connection: fakeConnection(squadsAccounts(state)),
    multisig: { ...sdk, transactions: { ...sdk.transactions, vaultTransactionExecute: record("execute"), proposalApprove: record("approve") } },
    connectedWallet: { publicKey: web3.PublicKey.default, mode: "extension" },
    // Genoeg DOM voor de eigen log() van de pagina en de getoonde velden.
    document: {
      getElementById: (id: string) => (elements[id] ??= element()),
      createElement: () => element(),
    },
  };
  // De gedeelde module zoals de pagina hem na het laden heeft (sectie 168).
  // Bestaat hij nog niet, dan draait de oude paginacode zonder.
  const sharedPath = path.join(ROOT, "admin", "upgradeProposalCheck.mjs");
  if (fs.existsSync(sharedPath)) env.upgradeCheck = require(sharedPath).createUpgradeProposalCheck(web3.PublicKey);
  const factory = new Function(...Object.keys(env), `${source}\nreturn { ${names.join(", ")} };`);
  return { fns: factory(...Object.values(env)), sent, logs, elements };
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "(geen fout: de actie werd doorgezet)";
}

describe("adminpagina: knop 3/4 raken precies het voorstel dat de pre-flight toetst (STATUS.md sectie 168)", function () {
  this.timeout(30_000);

  describe("M-A: uitvoeren (knop 4)", () => {
    it("#15 goedgekeurd (upgrade + SetAuthority), #16 goedgekeurd, schoon en het laatste: weigert, voert niets uit", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: { extraInstruction: true }, 16: {} } });
      const reason = await rejection(page.fns.buildSquadsExecuteTx());
      assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
      assert.match(reason, /andere goedgekeurde voorstellen voor deze buffer: #15 \(vereist: precies één, en dat is het laatste voorstel #16\)/);
    });

    it("#15 goedgekeurd, #16 (het laatste) nog Active: weigert, want de pre-flight eist dat het laatste voorstel het goedgekeurde is", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: {}, 16: { status: 1 } } });
      const reason = await rejection(page.fns.buildSquadsExecuteTx());
      assert.deepEqual(page.sent, [], "de pagina mag niets versturen");
      assert.match(reason, /Voorstel #16 staat op status "Active", niet "Approved"/);
    });

    it("groen: #15 alleen Active, #16 goedgekeurd en het laatste: voert precies #16 uit", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: { status: 1 }, 16: {} } });
      await page.fns.buildSquadsExecuteTx();
      assert.deepEqual(page.sent, [{ kind: "execute", transactionIndex: 16n }]);
    });
  });

  describe("M-A: goedkeuren (knop 3)", () => {
    it("twee open duplicaten (#15 en #16 Active): weigert, keurt niets goed", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: { status: 1 }, 16: { status: 1 } } });
      const reason = await rejection(page.fns.buildApproveTx());
      assert.deepEqual(page.sent, [], "de pagina mag niets versturen");
      assert.match(reason, /andere open voorstellen voor deze buffer: #15 \(vereist: precies één, en dat is het laatste voorstel #16\)/);
    });

    it("groen: alleen #16 Active en het laatste: keurt precies #16 goed", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 16: { status: 1 } } });
      await page.fns.buildApproveTx();
      assert.deepEqual(page.sent, [{ kind: "approve", transactionIndex: 16n }]);
    });
  });

  describe("het nummer voor TRANSACTION_INDEX staat op de pagina", () => {
    it("uitvoerbaar voorstel: het nummer wordt getoond", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 16: {} } });
      await page.fns.showPreflightTransactionIndex();
      assert.match(page.elements["transaction-index-display"]?.textContent ?? "", /^16 \(Approved\)$/);
    });

    it("geen uitvoerbaar voorstel: geen nummer, wel de reden", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: {}, 16: {} } });
      await page.fns.showPreflightTransactionIndex();
      assert.match(page.elements["transaction-index-display"]?.textContent ?? "", /^geen: .*andere goedgekeurde voorstellen voor deze buffer: #15/);
    });
  });

  describe("één bron voor de selectie", () => {
    it("de pagina laadt admin/upgradeProposalCheck.mjs, en de server serveert hem", () => {
      assert.match(PAGE, /await import\("\.\/upgradeProposalCheck\.mjs"\)/);
      assert.match(SERVER, /"upgradeProposalCheck\.mjs": \{ file: "upgradeProposalCheck\.mjs", contentType: "text\/javascript" \}/);
    });

    it("geen eigen selectieroute meer in de pagina", () => {
      for (const gone of ["findCanonicalProposal", "vaultTxMatchesConfiguredBuffer", "MAX_PROPOSAL_SCAN"]) {
        assert.notInclude(moduleScript(PAGE), gone, `${gone} hoort niet meer in de pagina`);
      }
    });

    it("BUFFER, programma, ProgramData en multisig zijn in de pagina en in checkProposalTimelock.ts gelijk", () => {
      const pageKey = (name: string) => PAGE.match(new RegExp(`const ${name} = new PublicKey\\("(\\w+)"\\);`))?.[1];
      const scriptKey = (name: string) => SCRIPT.match(new RegExp(`const ${name} = new PublicKey\\("(\\w+)"\\);`))?.[1];
      const pairs: [string, string][] = [
        ["BUFFER", "EXPECTED_BUFFER"],
        ["SPANKWALLET_PROGRAM_ID", "PROGRAM_ID"],
        ["SPANKWALLET_PROGRAM_DATA", "PROGRAM_DATA"],
        ["MULTISIG_PDA", "MULTISIG_PDA"],
      ];
      for (const [inPage, inScript] of pairs) {
        assert.isString(pageKey(inPage), `${inPage} niet gevonden in de pagina`);
        assert.strictEqual(pageKey(inPage), scriptKey(inScript), `${inPage} (pagina) != ${inScript} (script)`);
      }
    });
  });
});
