import { assert } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { FakeAccount } from "./fakeDevnetRpc";
import { devnetLikeProposals, OLD_BUFFER, squadsAccounts } from "./squadsScenario";
import type { ProposalOpts, SquadsOpts } from "./squadsScenario";

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
  /** Sectie 170 (L-3): aantal getMultipleAccounts-aanroepen, dus of de voorstellen gescand werden. */
  scans: { count: number };
}

// Een echt lid van de multisig uit de fixture (devnet): nodig voor knop 2, die eerst het lidmaatschap toetst.
const MEMBER = "2jDzaP3FbW5583hb4FeGZVU9MYseqBeFHwxycjzcvT7Q";

function fakeConnection(accounts: Map<string, FakeAccount>, scans: { count: number } = { count: 0 }) {
  const info = (address: { toBase58(): string }) => {
    const a = accounts.get(address.toBase58());
    return a ? { data: Buffer.from(a.data), owner: new web3.PublicKey(a.owner), executable: !!a.executable, lamports: 1_000_000, rentEpoch: 0 } : null;
  };
  const context = { slot: 500_000_000 };
  return {
    getAccountInfo: async (address: any) => info(address),
    getAccountInfoAndContext: async (address: any) => ({ context, value: info(address) }),
    getMultipleAccountsInfo: async (addresses: any[]) => addresses.map(info),
    getMultipleAccountsInfoAndContext: async (addresses: any[]) => {
      scans.count++;
      return { context, value: addresses.map(info) };
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    // Alleen voor de controle dat knop 2 met de juiste instellingen wél verstuurt (review §170, L-2),
    // en voor de bevestiging van knop 2-5 (sectie 171). Standaard: geland, zonder fout.
    confirmTransaction: async () => ({ context, value: { err: null } }),
    getSignatureStatuses: async () => ({ context, value: [{ slot: context.slot, confirmations: null, confirmationStatus: "confirmed", err: null }] }),
  };
}

async function loadPage(state: SquadsOpts, connectionOverrides: Record<string, unknown> = {}): Promise<Page> {
  const { names, source } = pageCode(PAGE);
  const sent: Sent[] = [];
  const logs: string[] = [];
  const scans = { count: 0 };
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
    // De overige web3-namen die de pagina uit de gevendorde web3 haalt; knop 2 bouwt zijn
    // transactie zelf (review §170, L-2: de controle dat knop 2 met de juiste instellingen verstuurt).
    TransactionMessage: web3.TransactionMessage,
    TransactionInstruction: web3.TransactionInstruction,
    VersionedTransaction: web3.VersionedTransaction,
    SYSVAR_RENT_PUBKEY: web3.SYSVAR_RENT_PUBKEY,
    SYSVAR_CLOCK_PUBKEY: web3.SYSVAR_CLOCK_PUBKEY,
    connection: { ...fakeConnection(squadsAccounts(state), scans), ...connectionOverrides },
    multisig: { ...sdk, transactions: { ...sdk.transactions, vaultTransactionExecute: record("execute"), proposalApprove: record("approve") } },
    // Een lid (sectie 170, L-2: knop 2 toetst eerst het lidmaatschap); alles wat de wallet zou
    // versturen, wordt opgenomen i.p.v. verstuurd.
    connectedWallet: {
      publicKey: new web3.PublicKey(MEMBER),
      mode: "extension",
      signAndSendTransaction: async () => {
        sent.push({ kind: "wallet-signAndSend", transactionIndex: -1n });
        return { signature: "opgenomen" };
      },
    },
    // Genoeg DOM voor de eigen log() van de pagina en de getoonde velden.
    document: {
      getElementById: (id: string) => (elements[id] ??= element()),
      createElement: () => element(),
    },
    // Voor clearDeeplinkSecretState() aan het eind van knop 2-5 (sectie 171).
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    DEEPLINK_STORAGE_KEY: "test-deeplink",
    deeplinkExpiryTimer: null,
  };
  // De gedeelde module zoals de pagina hem na het laden heeft (sectie 168).
  // Bestaat hij nog niet, dan draait de oude paginacode zonder.
  const sharedPath = path.join(ROOT, "admin", "upgradeProposalCheck.mjs");
  if (fs.existsSync(sharedPath)) env.upgradeCheck = require(sharedPath).createUpgradeProposalCheck(web3.PublicKey);
  const factory = new Function(...Object.keys(env), `${source}\nreturn { ${names.join(", ")} };`);
  return { fns: factory(...Object.values(env)), sent, logs, elements, scans };
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
      assert.match(reason, /andere goedgekeurde of lopende voorstellen \(Approved\/Executing\), ongeacht de inhoud: #15 \(Approved\) \(vereist: geen enkel, naast het laatste voorstel #16/);
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
      assert.match(page.elements["transaction-index-display"]?.textContent ?? "", /^geen: .*andere goedgekeurde of lopende voorstellen \(Approved\/Executing\), ongeacht de inhoud: #15 \(Approved\)/);
    });
  });

  describe("sectie 169 (review §168 M-1/M-2): een ander voorstel Approved of Executing blokkeert, ongeacht de inhoud", () => {
    const OTHER = /andere goedgekeurde of lopende voorstellen \(Approved\/Executing\), ongeacht de inhoud: #15 \((Approved|Executing)\)/;
    const others: [string, ProposalOpts][] = [
      ["B: Upgrade met één extra byte", { upgradeDataSuffix: Buffer.from([0]) }],
      ["C: Upgrade vanaf een andere buffer", { buffer: OLD_BUFFER }],
      ["goedgekeurde Batch", { kind: "batch" }],
      ["Batch in uitvoering", { kind: "batch", status: 4 }],
      ["goedgekeurde ConfigTransaction", { kind: "config" }],
    ];
    for (const [name, other] of others) {
      it(`knop 4: #15 ${name}, #16 schoon en het laatste: weigert, voert niets uit`, async () => {
        const page = await loadPage({ latestIndex: 16, proposals: { 15: other, 16: {} } });
        const reason = await rejection(page.fns.buildSquadsExecuteTx());
        assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
        assert.match(reason, OTHER);
      });

      it(`knop 3: #15 ${name}, #16 Active en het laatste: weigert, keurt niets goed`, async () => {
        const page = await loadPage({ latestIndex: 16, proposals: { 15: other, 16: { status: 1 } } });
        const reason = await rejection(page.fns.buildApproveTx());
        assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
        assert.match(reason, OTHER);
      });
    }

    it("groen: de echte devnet-stand plus een schone, goedgekeurde #15: knop 4 voert precies #15 uit", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: devnetLikeProposals(15) });
      await page.fns.buildSquadsExecuteTx();
      assert.deepEqual(page.sent, [{ kind: "execute", transactionIndex: 15n }]);
    });

    it("groen: de echte devnet-stand plus #15 Active: knop 3 keurt precies #15 goed", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { ...devnetLikeProposals(15), 15: { status: 1 } } });
      await page.fns.buildApproveTx();
      assert.deepEqual(page.sent, [{ kind: "approve", transactionIndex: 15n }]);
    });
  });

  describe("sectie 169 (review §168 I-1): de statusmelding bij verbinden klopt met wat knop 3/4 doen", () => {
    it("een ander goedgekeurd voorstel (andere buffer) wordt gemeld als blokkade voor knop 3 en 4", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: { buffer: OLD_BUFFER }, 16: {} } });
      await page.fns.logCurrentProposalStatus();
      const logs = page.logs.join("\n");
      assert.match(logs, /#15 \(Approved\)[^\n]*knop 3 en knop 4 weigeren/i);
      assert.match(page.elements["transaction-index-display"]?.textContent ?? "", /^geen: .*ongeacht de inhoud: #15 \(Approved\)/);
    });

    it("twee Active-duplicaten: alleen knop 3 weigert (een Active-voorstel is niet uitvoerbaar)", async () => {
      const page = await loadPage({ latestIndex: 16, proposals: { 15: { status: 1 }, 16: { status: 1 } } });
      await page.fns.logCurrentProposalStatus();
      const logs = page.logs.join("\n");
      assert.notInclude(logs, "Knoppen 3/4 weigeren zolang er meer dan een is");
      assert.match(logs, /Knop 3 weigert zolang er meer dan één open voorstel voor deze buffer is/);
    });
  });

  describe("sectie 170 (review §169 L-1): de multisig-instellingen waarop de timelock rust", () => {
    const settings: [string, Partial<SquadsOpts>, RegExp][] = [
      ["een aparte config_authority", { configAuthority: OLD_BUFFER }, /config_authority HRcc\S+, verwacht 11111111111111111111111111111111 \(autonome multisig\)/],
      ["time_lock 0", { timeLock: 0 }, /time_lock 0 s, verwacht exact 259200 s/],
      ["threshold 1", { threshold: 1 }, /threshold 1, verwacht minstens 2/],
      // Review §170 (L-1): exact, niet "minstens": ook een langere time_lock weigert; en threshold 0.
      ["time_lock 259201", { timeLock: 259_201 }, /time_lock 259201 s, verwacht exact 259200 s/],
      ["time_lock 4294967295", { timeLock: 4_294_967_295 }, /time_lock 4294967295 s, verwacht exact 259200 s/],
      ["threshold 0", { threshold: 0 }, /threshold 0, verwacht minstens 2/],
    ];
    for (const [name, multisig, reason] of settings) {
      it(`knop 4: ${name}, #15 schoon, goedgekeurd en het laatste: weigert, voert niets uit`, async () => {
        const page = await loadPage({ latestIndex: 15, proposals: { 15: {} }, ...multisig });
        const why = await rejection(page.fns.buildSquadsExecuteTx());
        assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
        assert.match(why, reason);
      });

      it(`knop 3: ${name}, #15 Active en het laatste: weigert, keurt niets goed`, async () => {
        const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 1 } }, ...multisig });
        const why = await rejection(page.fns.buildApproveTx());
        assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
        assert.match(why, reason);
      });
    }

    // De echte devnet-stand vóór upgrade 1 (sectie 169 punt 5): #1-14, #14 Rejected, dus GEEN open
    // voorstel voor deze buffer. Alleen dan zou knop 2 zonder de instellingencontrole een nieuw
    // voorstel versturen (review §170, L-2); met devnetLikeProposals(14) weigerde hij al op "#14 open".
    const devnetNow = (): Record<number, ProposalOpts> => ({ ...devnetLikeProposals(14), 14: { status: 2, buffer: OLD_BUFFER } });

    it("melding bij verbinden: zegt welke instelling afwijkt, en niet 'geen open voorstel, knop 2 zou een nieuw voorstel aanmaken'", async () => {
      const page = await loadPage({ latestIndex: 14, proposals: devnetNow(), timeLock: 0 });
      await page.fns.logCurrentProposalStatus();
      const logs = page.logs.join("\n");
      assert.match(logs, /multisig-instellingen wijken af[^\n]*time_lock 0 s, verwacht exact 259200 s/i);
      assert.notInclude(logs, "Knop 2 zou een NIEUW voorstel aanmaken");
      assert.notInclude(logs, "Niet elk voorstel was te lezen");
      assert.match(page.elements["transaction-index-display"]?.textContent ?? "", /^geen: multisig-instellingen wijken af.*time_lock 0 s/i);
    });

    // L-2: knop 2 weigert en verstuurt niets. I-1: de reden is de afwijkende waarde, niet "herlaad de pagina".
    for (const [name, multisig, reason] of settings) {
      it(`knop 2: ${name}: weigert, verstuurt niets, en noemt de afwijkende waarde`, async () => {
        const page = await loadPage({ latestIndex: 14, proposals: devnetNow(), ...multisig });
        const why = await rejection(page.fns.runProposeAction());
        assert.deepEqual(page.sent, [], `de pagina verstuurde ${JSON.stringify(page.sent, (_, v) => (typeof v === "bigint" ? `#${v}` : v))}`);
        assert.match(why, reason);
        assert.match(why, /multisig-instellingen wijken af/i);
        assert.notInclude(why, "herlaad de pagina");
        assert.notInclude(why, "Kon niet met zekerheid vaststellen");
      });
    }

    // Review §170 (L-2): zonder deze controle zou "verstuurt niets" hierboven ook groen zijn als de
    // opname het verstuurpad van knop 2 niet zag. Met de juiste instellingen en geen open voorstel
    // voor de buffer verstuurt knop 2 precies één transactie via de wallet. Wat na het versturen
    // gebeurt (bevestiging, deeplink-opruiming) valt buiten deze test en mag hier falen: alleen
    // de opname telt.
    it("L-2 controle: met de juiste instellingen verstuurt knop 2 wel (één transactie via de wallet)", async () => {
      const page = await loadPage({ latestIndex: 14, proposals: devnetNow() });
      await page.fns.runProposeAction().catch(() => undefined);
      assert.deepEqual(page.sent.map((s) => s.kind), ["wallet-signAndSend"]);
    });

    // Review §170 (I-1): de hercontrole van knop 2 na een bevestigings-timeout (finishPropose).
    // Bevestiging time-out, de signatuur blijkt geland, de herlezing ziet time_lock 0: de melding
    // noemt de afwijkende waarde (niet "herlaad de pagina") en knop 2 blijft uit.
    it("I-1: knop 2 na een bevestigings-timeout noemt de afwijkende instelling en blijft uit", async () => {
      const page = await loadPage({ latestIndex: 14, proposals: devnetNow(), timeLock: 0 }, {
        confirmTransaction: async () => {
          throw new Error("bevestiging verlopen (test)");
        },
        getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
      });
      const why = await rejection(page.fns.finishPropose("SIG170"));
      assert.match(why, /^Kon niet controleren of transactie SIG170 een voorstel aanmaakte\. Multisig-instellingen wijken af: multisig: time_lock 0 s, verwacht exact 259200 s/);
      assert.notInclude(why, "Herlaad de pagina");
      assert.isTrue(page.elements["propose-btn"]?.disabled, "knop 2 kwam weer vrij");
      assert.deepEqual(page.sent, []);
    });

    it("I-1: knop 3 en 4 zeggen dat de instellingen afwijken, niet 'klik eerst op knop 2'", async () => {
      const approve = await loadPage({ latestIndex: 15, proposals: { 15: { status: 1 } }, timeLock: 0 });
      const whyApprove = await rejection(approve.fns.buildApproveTx());
      assert.match(whyApprove, /multisig-instellingen wijken af/i);
      assert.notInclude(whyApprove, "Klik eerst op '2. Voorstel indienen'");
      const execute = await loadPage({ latestIndex: 15, proposals: { 15: {} }, timeLock: 0 });
      assert.match(await rejection(execute.fns.buildSquadsExecuteTx()), /multisig-instellingen wijken af/i);
    });

    it("L-3: bij afwijkende instellingen worden de voorstellen niet gescand (500 voorstellen, time_lock 0)", async () => {
      const proposals: Record<number, ProposalOpts> = {};
      for (let i = 1; i <= 500; i++) proposals[i] = { status: 1 };
      const page = await loadPage({ latestIndex: 500, proposals, timeLock: 0 });
      const why = await rejection(page.fns.buildSquadsExecuteTx());
      assert.match(why, /time_lock 0 s, verwacht exact 259200 s/);
      assert.strictEqual(page.scans.count, 0, `de voorstellen werden gescand (${page.scans.count} getMultipleAccounts-aanroepen)`);
    });

    it("L-3: ook loadProposalEntries zelf weigert te scannen bij afwijkende instellingen", async () => {
      const check = require(path.join(ROOT, "admin", "upgradeProposalCheck.mjs")).createUpgradeProposalCheck(web3.PublicKey);
      const scans = { count: 0 };
      const connection = fakeConnection(squadsAccounts({ latestIndex: 500, proposals: {}, timeLock: 0 }), scans);
      const why = await rejection(check.loadProposalEntries(connection, new web3.PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp"), "confirmed"));
      assert.match(why, /multisig-instellingen wijken af.*time_lock 0 s/i);
      assert.strictEqual(scans.count, 0);
    });

    it("controle: met de juiste instellingen worden de voorstellen wel gescand", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } });
      await page.fns.buildSquadsExecuteTx();
      assert.isAbove(page.scans.count, 0);
    });

    // Review §170 (L-3): transactionIndex absurd hoog (2^63) en time_lock afwijkend. Een scan
    // zou 2^64 PDA's afleiden en de event-loop blokkeren; daarom in een apart proces met een
    // harde timeout, zodat een regressie hier faalt in plaats van de suite te laten hangen.
    // Dezelfde loadAndSelect/loadProposalEntries die de pagina (knop 2/3/4) en het script gebruiken.
    it("L-3: transactionIndex 2^63 en time_lock 0: loadAndSelect en loadProposalEntries weigeren snel, zonder scan", function () {
      this.timeout(30_000);
      const multisig = squadsAccounts({ latestIndex: 0, proposals: {}, timeLock: 0 }).get("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp")!;
      const data = Buffer.from(multisig.data);
      data.writeBigUInt64LE(1n << 63n, 78);
      const url = (p: string) => JSON.stringify(pathToFileURL(path.join(ROOT, p)).href);
      const code = `
        import { createUpgradeProposalCheck } from ${url("admin/upgradeProposalCheck.mjs")};
        import * as web3 from ${url("admin/vendor/web3.mjs")};
        const check = createUpgradeProposalCheck(web3.PublicKey);
        let scans = 0;
        const value = { data: Buffer.from(process.env.MULTISIG_B64, "base64"), owner: new web3.PublicKey(${JSON.stringify(multisig.owner)}), executable: false, lamports: 1, rentEpoch: 0 };
        const connection = {
          getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value }),
          getMultipleAccountsInfoAndContext: async (a) => { scans++; return { context: { slot: 1 }, value: a.map(() => null) }; },
        };
        const address = new web3.PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
        const out = {};
        for (const purpose of ["propose", "approve", "execute"]) {
          const s = await check.loadAndSelect(connection, { multisigAddress: address, expected: null, purpose });
          out[purpose] = { transactionIndex: String(s.multisig.transactionIndex), target: s.target, settingsProblems: s.settingsProblems };
        }
        try { await check.loadProposalEntries(connection, address, "confirmed"); out.entries = "geen fout"; } catch (e) { out.entries = e.message; }
        out.scans = scans;
        console.log(JSON.stringify(out));
      `;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: ROOT,
        env: { ...process.env, MULTISIG_B64: data.toString("base64") },
        timeout: 20_000,
        encoding: "utf8",
      });
      assert.isNull(r.signal, `het proces bleef scannen en werd na 20 s gestopt (${r.signal})\n${r.stderr}`);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
      for (const purpose of ["propose", "approve", "execute"]) {
        assert.strictEqual(out[purpose].transactionIndex, (1n << 63n).toString(), purpose);
        assert.isNull(out[purpose].target, purpose);
        assert.deepEqual(out[purpose].settingsProblems, ["multisig: time_lock 0 s, verwacht exact 259200 s (72u)"], purpose);
      }
      assert.match(out.entries, /^multisig-instellingen wijken af: multisig: time_lock 0 s/);
      assert.strictEqual(out.scans, 0);
    });
  });

  // Sectie 171 (review §170, M-1): confirmTransaction gooit niet als de transactie on-chain
  // mislukt. Via de websocket-route komt het antwoord binnen als { value: { err } }. De pagina
  // meldde dan "Bevestigd." en "SUCCES". Geen enkele knop mag succes melden tenzij err null bleek.
  describe("sectie 171 (review §170 M-1): een mislukte transactie is nooit een succes", () => {
    const FAILED = { InstructionError: [0, { Custom: 6008 }] };
    const FAILED_TEXT = JSON.stringify(FAILED);
    const context = { slot: 500_000_000 };
    const status = (err: unknown) => async () => ({ context, value: [{ slot: context.slot, confirmations: null, confirmationStatus: "confirmed", err }] });
    // Websocket-route: confirmTransaction lost op met value.err; de RPC zegt hetzelfde.
    const failedTx = { confirmTransaction: async () => ({ context, value: { err: FAILED } }), getSignatureStatuses: status(FAILED) };
    const devnetNow = (): Record<number, ProposalOpts> => ({ ...devnetLikeProposals(14), 14: { status: 2, buffer: OLD_BUFFER } });
    const SUCCESS_WORDS = /SUCCES|Bevestigd|alsnog bevestigd geland|GELAND/;

    // [knop, functie, argumenten, stand]
    const buttons: [string, string, unknown[], SquadsOpts][] = [
      ["knop 2 (geen open voorstel)", "finishPropose", ["SIG171"], { latestIndex: 14, proposals: devnetNow() }],
      ["knop 2 (er staat al een voorstel open voor de buffer)", "finishPropose", ["SIG171"], { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }],
      ["knop 3", "finishApprove", ["SIG171", 15n], { latestIndex: 15, proposals: { 15: { status: 1 } } }],
      ["knop 4", "finishSquadsExecute", ["SIG171"], { latestIndex: 15, proposals: { 15: {} } }],
      ["knop 5", "finishReject", ["SIG171", 15n], { latestIndex: 15, proposals: { 15: { status: 1 } } }],
    ];

    for (const [name, fn, args, state] of buttons) {
      it(`${name}: mislukte transactie (websocket-route): geen succes, wel MISLUKT met de fout`, async () => {
        const page = await loadPage(state, failedTx);
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, /Transactie SIG171 is on-chain MISLUKT/);
        assert.include(why, FAILED_TEXT);
      });

      it(`${name}: websocket zegt mislukt, de RPC zegt geland zonder fout: tegenstrijdig, dus geen succes`, async () => {
        const page = await loadPage(state, { ...failedTx, getSignatureStatuses: status(null) });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, /Transactie SIG171 is on-chain MISLUKT/);
        assert.include(why, FAILED_TEXT);
      });

      // De eenmalige statuscontrole in confirmTransaction gooit de transactiefout zelf (geen Error).
      it(`${name}: confirmTransaction gooit de transactiefout zelf, de RPC zegt geland zonder fout: geen succes`, async () => {
        const page = await loadPage(state, {
          confirmTransaction: async () => {
            throw FAILED;
          },
          getSignatureStatuses: status(null),
        });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, /Transactie SIG171 is on-chain MISLUKT/);
        assert.include(why, FAILED_TEXT);
      });

      it(`${name}: timeout, daarna blijkt de transactie mislukt: geen succes`, async () => {
        const page = await loadPage(state, {
          confirmTransaction: async () => {
            throw new Error("bevestiging verlopen (test)");
          },
          getSignatureStatuses: status(FAILED),
        });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, /Transactie SIG171 is on-chain MISLUKT/);
      });
    }

    // Controle: de tests hierboven zien het succespad wel. Met err null op beide routes meldt
    // elke knop succes (knop 2 zonder open voorstel vooraf: de stand ná het voorstel is #15).
    const succeeded: [string, string, unknown[], SquadsOpts][] = [
      ["knop 2", "finishPropose", ["SIG171"], { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }],
      ["knop 3", "finishApprove", ["SIG171", 15n], { latestIndex: 15, proposals: { 15: {} } }],
      ["knop 4", "finishSquadsExecute", ["SIG171"], { latestIndex: 15, proposals: { 15: {} } }],
      ["knop 5", "finishReject", ["SIG171", 15n], { latestIndex: 15, proposals: { 15: { status: 2 } } }],
    ];
    for (const [name, fn, args, state] of succeeded) {
      it(`controle, ${name}: gelukt (err null op beide routes): meldt SUCCES`, async () => {
        const page = await loadPage(state);
        await page.fns[fn](...args);
        assert.match(page.logs.join("\n"), /^SUCCES/m);
      });
    }

    it("één plek beslist: confirmTransaction en getSignatureStatuses elk één keer, awaitConfirmation alleen in knop 2-5", () => {
      const src = moduleScript(PAGE);
      assert.lengthOf([...src.matchAll(/connection\.confirmTransaction\(/g)], 1);
      assert.lengthOf([...src.matchAll(/connection\.getSignatureStatuses\(/g)], 1);
      const callers = [...src.matchAll(/await awaitConfirmation\(/g)].map((m) => {
        const before = src.slice(0, m.index);
        return before.slice(before.lastIndexOf("async function ")).match(/^async function (\w+)/)![1];
      });
      assert.sameMembers(callers, ["finishPropose", "finishApprove", "finishReject", "finishSquadsExecute"]);
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
