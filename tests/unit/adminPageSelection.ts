import { assert } from "chai";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("../../admin/vendor/bs58.mjs").default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require("../../admin/vendor/tweetnacl.mjs").default;
// De gevendorde tweetnacl vindt in Node geen PRNG (in de browser: window.crypto).
nacl.setPRNG((x: Uint8Array, n: number) => x.set(crypto.randomBytes(n)));

// Sectie 172 (review §171 I-3): geldige base58-signatures van 64 bytes, zoals de echte
// confirmTransaction eist ("SIG171" bevat een I en zou daar al gooien). SIG is de verstuurde
// transactie; OTHER_SIG een andere, die de RPC wel kent.
const SIG = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const OTHER_SIG = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => 200 - i));
const ACTION_BUTTONS = ["propose-btn", "approve-btn", "squads-execute-btn", "reject-btn"];
// Sectie 173 (review §172, L-2/L-3): de verbindknoppen 1 en 1b vallen onder hetzelfde slot.
const CONNECT_BUTTONS = ["connect-btn", "connect-solflare-deeplink-btn"];
const LOCKED_BUTTONS = [...ACTION_BUTTONS, ...CONNECT_BUTTONS];

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
  /** Sectie 172: elke confirmTransaction/getSignatureStatuses/wallet-aanroep, met de stand van de actieknoppen op dat moment. */
  rpc: RpcCall[];
  /** Sectie 172: wat de pagina in localStorage zette. */
  storage: Map<string, string>;
  /** Sectie 173: timers van een minuut of langer (die lopen nooit vanzelf af); de test roept fn zelf aan. */
  longTimers: { fn: () => void; ms: number }[];
  window: { location: { search: string; pathname: string; origin: string; href: string } };
}

interface RpcCall {
  method: string;
  args: unknown[];
  /** true = uit. Sectie 173: ook de verbindknoppen 1 en 1b. */
  buttons: Record<string, boolean>;
}

interface PageOptions {
  /** Vervangt of vult de omgeving aan (bv. connectedWallet: null voor de deep-link-hervatting). */
  env?: Record<string, unknown>;
  /** Beginstand van localStorage. */
  storage?: Record<string, string>;
  /** window.location.search bij het laden. */
  search?: string;
  /** Sectie 173: de stand op de keten zodra de wallet verstuurt (bv. voorstel #15 Executed na knop 4). */
  afterSend?: SquadsOpts;
  /** Sectie 173: een klok die de test verzet (Date.now() en new Date() van de pagina). */
  clock?: { now: number };
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
    // Sectie 172: per signature. Alleen de verstuurde SIG is geland (zonder fout); elke andere onbekend.
    getSignatureStatuses: async (signatures: string[]) => ({
      context,
      value: signatures.map((s) => (s === SIG ? { slot: context.slot, confirmations: null, confirmationStatus: "confirmed", err: null } : null)),
    }),
  };
}

async function loadPage(state: SquadsOpts, connectionOverrides: Record<string, unknown> = {}, options: PageOptions = {}): Promise<Page> {
  const { names, source } = pageCode(PAGE);
  const sent: Sent[] = [];
  const logs: string[] = [];
  const scans = { count: 0 };
  const rpc: RpcCall[] = [];
  const storage = new Map(Object.entries(options.storage ?? {}));
  const elements: Page["elements"] = {};
  const buttons = () => Object.fromEntries(LOCKED_BUTTONS.map((id) => [id, !!elements[id]?.disabled]));
  const longTimers: Page["longTimers"] = [];
  const accounts = squadsAccounts(state);
  // Sectie 173: de keten na het versturen (de wallet verstuurt; de fixture volgt).
  const applyAfterSend = () => {
    if (!options.afterSend) return;
    accounts.clear();
    for (const [k, v] of squadsAccounts(options.afterSend)) accounts.set(k, v);
  };
  const record = (kind: string) => (args: { transactionIndex: bigint }) => {
    sent.push({ kind, transactionIndex: BigInt(args.transactionIndex) });
    // serialize: voor de deep-link-route (startDeeplinkSignAndSend), die de transactie versleutelt.
    return { kind, serialize: () => Uint8Array.of(1, 2, 3) };
  };
  // Sectie 172 (review §171 M-1/I-3): elke bevestigingsaanroep wordt opgenomen, wat de test ook
  // als antwoord geeft. confirmTransaction controleert de signature zoals de gevendorde web3
  // (base58, 64 bytes; anders een Error) voordat het antwoord van de test komt.
  const connection: Record<string, any> = { ...fakeConnection(accounts, scans), ...connectionOverrides };
  const confirmImpl = connection.confirmTransaction;
  const statusImpl = connection.getSignatureStatuses;
  connection.confirmTransaction = async (strategy: any, commitment?: string) => {
    rpc.push({ method: "confirmTransaction", args: [strategy, commitment], buttons: buttons() });
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(signature);
    } catch {
      throw new Error("signature must be base58 encoded: " + signature);
    }
    if (bytes.length !== 64) throw new Error("signature has invalid length");
    return confirmImpl(strategy, commitment);
  };
  connection.getSignatureStatuses = async (signatures: string[], config?: unknown) => {
    rpc.push({ method: "getSignatureStatuses", args: [signatures, config], buttons: buttons() });
    return statusImpl(signatures, config);
  };
  const window = { location: { search: options.search ?? "", pathname: "/wallet-signer.html", origin: "https://adminpagina.test", href: "" } };
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
    connection,
    multisig: { ...sdk, transactions: { ...sdk.transactions, vaultTransactionExecute: record("execute"), proposalApprove: record("approve") } },
    // Een lid (sectie 170, L-2: knop 2 toetst eerst het lidmaatschap); alles wat de wallet zou
    // versturen, wordt opgenomen i.p.v. verstuurd. De wallet geeft de geldige signature SIG terug.
    connectedWallet: {
      publicKey: new web3.PublicKey(MEMBER),
      mode: "extension",
      signAndSendTransaction: async () => {
        sent.push({ kind: "wallet-signAndSend", transactionIndex: -1n });
        rpc.push({ method: "wallet-signAndSend", args: [], buttons: buttons() });
        applyAfterSend();
        return { signature: SIG };
      },
    },
    // Genoeg DOM voor de eigen log() van de pagina en de getoonde velden.
    document: {
      getElementById: (id: string) => (elements[id] ??= element()),
      createElement: () => element(),
    },
    // Sectie 172: een echte opslag, voor de deep-link-route (knop 2-5 wissen hem aan het eind).
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
    },
    DEEPLINK_STORAGE_KEY: "test-deeplink",
    DEEPLINK_LAST_WALLET_KEY: "test-deeplink-last-wallet",
    DEEPLINK_VERIFY_KEY: "test-deeplink-verify",
    DEEPLINK_SESSION_MAX_AGE_MS: 30 * 60 * 1000,
    REDIRECT_URL: window.location.origin + "/wallet-signer.html",
    deeplinkExpiryTimer: null,
    window,
    history: { replaceState: () => undefined },
    bs58,
    nacl,
    // Stil: startDeeplinkSignAndSend logt het verzoek, logFullError de fout (die staat al in page.logs).
    console: { ...console, log: () => undefined, error: () => undefined },
    // Sectie 172 (review §171 M-1): nep-timers. Korte wachttijden (de pogingen van
    // pollSignatureStatus, 3 s) lopen meteen af, zodat "unknown" geen 27 s kost; lange (de
    // vervaltermijn van de deep-link-sessie, 30 min) nooit binnen een test.
    setTimeout: (fn: () => void, ms = 0) => {
      if (ms < 60_000) queueMicrotask(fn);
      else longTimers.push({ fn, ms });
      return 0;
    },
    clearTimeout: () => undefined,
    ...(options.clock ? { Date: fakeDate(options.clock) } : {}),
    ...options.env,
  };
  // De gedeelde module zoals de pagina hem na het laden heeft (sectie 168).
  // Bestaat hij nog niet, dan draait de oude paginacode zonder.
  const sharedPath = path.join(ROOT, "admin", "upgradeProposalCheck.mjs");
  if (fs.existsSync(sharedPath)) env.upgradeCheck = require(sharedPath).createUpgradeProposalCheck(web3.PublicKey);
  const factory = new Function(...Object.keys(env), `${source}\nreturn { ${names.join(", ")} };`);
  return { fns: factory(...Object.values(env)), sent, logs, elements, scans, rpc, storage, window, longTimers };
}

/** Sectie 173: Date met een klok die de test verzet; new Date(x) en de rest blijven echt. */
function fakeDate(clock: { now: number }): DateConstructor {
  class FakeDate extends Date {
    constructor(...args: any[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [any]));
    }
    static now(): number {
      return clock.now;
    }
  }
  return FakeDate as unknown as DateConstructor;
}

/**
 * Sectie 172 (review §171 M-1): de pagina vroeg precies de verstuurde signature op, met
 * searchTransactionHistory: true, en bevestigde precies die ene signature op "confirmed".
 */
function assertExactQueries(page: Page, signature: string = SIG): void {
  const statusCalls = page.rpc.filter((c) => c.method === "getSignatureStatuses");
  assert.isNotEmpty(statusCalls, "de pagina vroeg de status van de signature niet op");
  for (const c of statusCalls) {
    assert.deepEqual(c.args[0], [signature], "getSignatureStatuses vroeg een andere signature op");
    assert.strictEqual((c.args[1] as { searchTransactionHistory?: boolean } | undefined)?.searchTransactionHistory, true, "zonder searchTransactionHistory: true");
  }
  const confirms = page.rpc.filter((c) => c.method === "confirmTransaction");
  assert.lengthOf(confirms, 1, "confirmTransaction niet precies één keer aangeroepen");
  assert.deepEqual(confirms[0].args, [signature, "confirmed"], "confirmTransaction met een andere signature of commitment");
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
  // Sectie 172: met de geldige signature SIG, en elke test controleert welke signature en welke
  // opties de pagina gebruikte (assertExactQueries).
  const FAILED = { InstructionError: [0, { Custom: 6008 }] };
  const FAILED_TEXT = JSON.stringify(FAILED);
  const context = { slot: 500_000_000 };
  const signatureStatus = (confirmationStatus: string, err: unknown) => ({ slot: context.slot, confirmations: null, confirmationStatus, err });
  /** De RPC kent alleen de signatures in bySignature; elke andere is onbekend (null). */
  const statuses = (bySignature: Record<string, unknown>) => async (signatures: string[]) => ({ context, value: signatures.map((s) => bySignature[s] ?? null) });
  const status = (err: unknown) => statuses({ [SIG]: signatureStatus("confirmed", err) });
  const timeout = async () => {
    throw new Error("bevestiging verlopen (test)");
  };
  // Websocket-route: confirmTransaction lost op met value.err; de RPC zegt hetzelfde.
  const failedTx = { confirmTransaction: async () => ({ context, value: { err: FAILED } }), getSignatureStatuses: status(FAILED) };
  const devnetNow = (): Record<number, ProposalOpts> => ({ ...devnetLikeProposals(14), 14: { status: 2, buffer: OLD_BUFFER } });
  const SUCCESS_WORDS = /SUCCES|Bevestigd|alsnog bevestigd geland|GELAND/;
  const MISLUKT = new RegExp(`Transactie ${SIG} is on-chain MISLUKT`);

  // [knop, functie, argumenten, stand, gooit bij "unknown" (knop 2 met een open voorstel meldt alleen)]
  const buttons: [string, string, unknown[], SquadsOpts, boolean][] = [
    ["knop 2 (geen open voorstel)", "finishPropose", [SIG], { latestIndex: 14, proposals: devnetNow() }, true],
    ["knop 2 (er staat al een voorstel open voor de buffer)", "finishPropose", [SIG], { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }, false],
    ["knop 3", "finishApprove", [SIG, 15n], { latestIndex: 15, proposals: { 15: { status: 1 } } }, true],
    ["knop 4", "finishSquadsExecute", [SIG, 15n], { latestIndex: 15, proposals: { 15: {} } }, true],
    ["knop 5", "finishReject", [SIG, 15n], { latestIndex: 15, proposals: { 15: { status: 1 } } }, true],
  ];

  describe("sectie 171 (review §170 M-1): een mislukte transactie is nooit een succes", () => {
    for (const [name, fn, args, state] of buttons) {
      it(`${name}: mislukte transactie (websocket-route): geen succes, wel MISLUKT met de fout`, async () => {
        const page = await loadPage(state, failedTx);
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, MISLUKT);
        assert.include(why, FAILED_TEXT);
        assertExactQueries(page);
      });

      it(`${name}: websocket zegt mislukt, de RPC zegt geland zonder fout: tegenstrijdig, dus geen succes`, async () => {
        const page = await loadPage(state, { ...failedTx, getSignatureStatuses: status(null) });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, MISLUKT);
        assert.include(why, FAILED_TEXT);
        assertExactQueries(page);
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
        assert.match(why, MISLUKT);
        assert.include(why, FAILED_TEXT);
        assertExactQueries(page);
      });

      it(`${name}: timeout, daarna blijkt de transactie mislukt: geen succes`, async () => {
        const page = await loadPage(state, { confirmTransaction: timeout, getSignatureStatuses: status(FAILED) });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.match(why, MISLUKT);
        assertExactQueries(page);
      });
    }

    // Controle: de tests hierboven zien het succespad wel. Met err null op beide routes meldt
    // elke knop succes (knop 2 zonder open voorstel vooraf: de stand ná het voorstel is #15).
    const succeeded: [string, string, unknown[], SquadsOpts][] = [
      ["knop 2", "finishPropose", [SIG], { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }],
      ["knop 3", "finishApprove", [SIG, 15n], { latestIndex: 15, proposals: { 15: {} } }],
      // Sectie 173 (review §172, L-4): na het uitvoeren staat #15 op Executed.
      ["knop 4", "finishSquadsExecute", [SIG, 15n], { latestIndex: 15, proposals: { 15: { status: 5 } } }],
      ["knop 5", "finishReject", [SIG, 15n], { latestIndex: 15, proposals: { 15: { status: 2 } } }],
    ];
    for (const [name, fn, args, state] of succeeded) {
      it(`controle, ${name}: gelukt (err null op beide routes): meldt SUCCES`, async () => {
        const page = await loadPage(state);
        await page.fns[fn](...args);
        assert.match(page.logs.join("\n"), /^SUCCES/m);
        assertExactQueries(page);
      });
    }

    // Sectie 172 (review §171 I-2): deze test telt tekst en is te omzeilen, bijvoorbeeld met
    // connection["confirmTransaction"](…), een alias (const c = connection) of een tweede
    // verbinding. De echte bescherming zijn de gedragstests hierboven en in sectie 172 hieronder
    // (assertExactQueries, "unknown", "processed", een andere signature, een fout als tekst).
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

  // Sectie 172 (review §171 M-1/I-3): wat de mock van sectie 171 niet nabootste. Met nep-timers
  // kost "unknown" (10 pogingen, 3 s ertussen) geen 27 s meer.
  describe("sectie 172 (review §171 M-1): unknown, processed, een andere signature en een fout als tekst", () => {
    for (const [name, fn, args, state, throwsOnUnknown] of buttons) {
      it(`${name}: time-out en de RPC ziet de signature niet (unknown): geen succes, wel het advies te wachten op de blockhash`, async () => {
        const page = await loadPage(state, { confirmTransaction: timeout, getSignatureStatuses: statuses({}) });
        const why = await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assert.notMatch(why, /MISLUKT/);
        if (throwsOnUnknown) {
          assert.match(why, new RegExp(`niet vaststellen of transactie ${SIG} geland is`));
          assert.match(why, /tot haar blockhash verloopt, ongeveer 2 minuten na het versturen/);
          assert.match(why, /Wacht daarom tot ten minste \d\d:\d\d:\d\d/);
        } else {
          assert.strictEqual(why, "(geen fout: de actie werd doorgezet)");
          assert.match(logs, /Klik NIET opnieuw op '2\. Voorstel indienen'/);
        }
        assert.lengthOf(page.rpc.filter((c) => c.method === "getSignatureStatuses"), 10, "niet alle pogingen gedaan");
        assertExactQueries(page);
      });

      it(`${name}: confirmTransaction zonder fout, maar de RPC ziet de signature niet (status null): geen succes`, async () => {
        const page = await loadPage(state, { getSignatureStatuses: statuses({}) });
        await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assertExactQueries(page);
      });

      it(`${name}: de RPC ziet de signature alleen op "processed" (zonder fout): telt niet als geland, geen succes`, async () => {
        const page = await loadPage(state, { confirmTransaction: timeout, getSignatureStatuses: statuses({ [SIG]: signatureStatus("processed", null) }) });
        await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assertExactQueries(page);
      });

      it(`${name}: de RPC kent alleen een andere signature (geland, zonder fout): geen succes`, async () => {
        const page = await loadPage(state, { confirmTransaction: timeout, getSignatureStatuses: statuses({ [OTHER_SIG]: signatureStatus("finalized", null) }) });
        await rejection(page.fns[fn](...args));
        const logs = page.logs.join("\n");
        assert.notMatch(logs, SUCCESS_WORDS, `de pagina meldde succes:\n${logs}`);
        assertExactQueries(page);
      });

      it(`${name}: een fout als tekst ("AccountInUse") op beide routes: MISLUKT`, async () => {
        const page = await loadPage(state, {
          confirmTransaction: async () => ({ context, value: { err: "AccountInUse" } }),
          getSignatureStatuses: status("AccountInUse"),
        });
        const why = await rejection(page.fns[fn](...args));
        assert.notMatch(page.logs.join("\n"), SUCCESS_WORDS);
        assert.match(why, MISLUKT);
        assert.include(why, '"AccountInUse"');
        assertExactQueries(page);
      });

      it(`${name}: een fout als tekst alleen via de websocket, de RPC zegt zonder fout: MISLUKT`, async () => {
        const page = await loadPage(state, {
          confirmTransaction: async () => ({ context, value: { err: "AccountInUse" } }),
          getSignatureStatuses: status(null),
        });
        const why = await rejection(page.fns[fn](...args));
        assert.notMatch(page.logs.join("\n"), SUCCESS_WORDS);
        assert.match(why, MISLUKT);
        assertExactQueries(page);
      });
    }

    // Review §171 L-2: "SUCCES" is voorbehouden aan een transactie die aantoonbaar zonder fout landde.
    it('"SUCCES" staat alleen in finishPropose, finishApprove, finishReject en finishSquadsExecute', () => {
      const src = moduleScript(PAGE);
      const places = [...src.matchAll(/log\(\s*"SUCCES/g)].map((m) => {
        const before = src.slice(0, m.index);
        return before.slice(before.lastIndexOf("function ")).match(/^function (\w+)/)![1];
      });
      assert.isNotEmpty(places);
      for (const place of places) assert.include(["finishPropose", "finishApprove", "finishReject", "finishSquadsExecute"], place);
    });
  });

  // Gedeeld door sectie 172 en 173.
  const CHECK = ["wallet-signAndSend", "confirmTransaction", "getSignatureStatuses"];
  // Sectie 173 (review §172, L-2/L-3): ook de verbindknoppen 1 en 1b.
  const allOff = (page: Page) => {
    const during = page.rpc.filter((c) => CHECK.includes(c.method));
    assert.isNotEmpty(during, "geen controle gezien");
    for (const c of during) assert.deepEqual(c.buttons, Object.fromEntries(LOCKED_BUTTONS.map((id) => [id, true])), `knop aan tijdens ${c.method}`);
  };
  const allOn = (page: Page) => {
    for (const id of LOCKED_BUTTONS) assert.isFalse(!!page.elements[id]?.disabled, `${id} bleef uit`);
  };

  /** De stand na een omleiding terug van Solflare met { signature } als versleuteld antwoord. */
  const deeplinkReturn = (pendingAction: string, index: string | null, signature: string = SIG, wallet: string = MEMBER): PageOptions => {
    const sharedSecret = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(24);
    const data = nacl.box.after(new TextEncoder().encode(JSON.stringify({ signature })), nonce, sharedSecret);
    return {
      env: { connectedWallet: null },
      storage: {
        "test-deeplink": JSON.stringify({
          dappSecretKey: [],
          dappPublicKey: [],
          sharedSecret: Array.from(sharedSecret),
          session: "sessie",
          walletPublicKey: MEMBER,
          pendingAction,
          pendingActionStartedAt: new Date().toISOString(),
          pendingActionTransactionIndex: index,
          sessionCreatedAt: Date.now(),
        }),
        "test-deeplink-last-wallet": JSON.stringify({ walletPublicKey: wallet, savedAt: Date.now() }),
      },
      search: "?" + new URLSearchParams({ nonce: bs58.encode(nonce), data: bs58.encode(data) }).toString(),
    };
  };

  // Sectie 172 (review §171 L-1, L-2, L-5): de actieknoppen staan uit van het versturen tot het
  // einde van de controle, ook op de deep-link-hervatroute; de connect-melding is geen "SUCCES";
  // uitvoeren via de deep-link bewaart het voorstelnummer.
  describe("sectie 172 (review §171 L-1/L-2/L-5): knoppen uit tijdens de controle, voorstelnummer bij uitvoeren", () => {
    // [knop, functie, argumenten, stand, stand na het versturen]
    const runs: [string, string, unknown[], SquadsOpts, SquadsOpts?][] = [
      ["knop 2", "runProposeAction", [], { latestIndex: 14, proposals: devnetNow() }],
      ["knop 3", "runApproveAction", [], { latestIndex: 15, proposals: { 15: { status: 1 } } }],
      ["knop 4", "runExecuteAction", [], { latestIndex: 15, proposals: { 15: {} } }, { latestIndex: 15, proposals: { 15: { status: 5 } } }],
      ["knop 5", "runRejectAction", [15n], { latestIndex: 15, proposals: { 15: { status: 1 } } }],
    ];
    for (const [name, fn, args, state, afterSend] of runs) {
      it(`L-1, ${name} (extensie): alle actieknoppen uit tijdens versturen en controle, daarna weer aan`, async () => {
        const page = await loadPage(state, {}, { afterSend });
        page.fns.enableActionButtons();
        await page.fns[fn](...args);
        assert.match(page.logs.join("\n"), /^SUCCES/m);
        allOff(page);
        allOn(page);
      });
    }

    it("L-1, knop 4 (extensie), mislukte transactie: knoppen uit tijdens de controle, daarna weer aan", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, failedTx);
      page.fns.enableActionButtons();
      assert.match(await rejection(page.fns.runExecuteAction()), MISLUKT);
      allOff(page);
      allOn(page);
    });

    const resumes: [string, string, string | null, SquadsOpts][] = [
      ["knop 2", "propose", null, { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }],
      ["knop 3", "approve", "15", { latestIndex: 15, proposals: { 15: {} } }],
      ["knop 4", "execute", "15", { latestIndex: 15, proposals: { 15: { status: 5 } } }],
      ["knop 5", "reject", "15", { latestIndex: 15, proposals: { 15: { status: 2 } } }],
    ];
    for (const [name, action, index, state] of resumes) {
      it(`L-1/L-2, ${name} (deep-link-hervatting): knoppen uit tijdens de controle, daarna aan; de connect-melding is geen SUCCES`, async () => {
        const page = await loadPage(state, {}, deeplinkReturn(action, index));
        await page.fns.resumeAfterLoad();
        const logs = page.logs.join("\n");
        assert.match(logs, /^Verbonden met Solflare/m);
        assert.notMatch(logs, /^SUCCES - verbonden/m);
        assert.match(logs, /^SUCCES/m, `geen succesmelding:\n${logs}`);
        allOff(page);
        allOn(page);
        assertExactQueries(page);
      });
    }

    it("L-2, knop 4 (deep-link-hervatting), mislukte transactie: geen enkele regel begint met SUCCES", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, failedTx, deeplinkReturn("execute", "15"));
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.match(logs, MISLUKT);
      assert.notMatch(logs, /^SUCCES/m, `een regel begon met SUCCES:\n${logs}`);
      allOff(page);
      allOn(page);
    });

    it("L-5: knop 4 via de deep-link bewaart het voorstelnummer over de omleiding heen", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, {}, {
        env: { connectedWallet: { mode: "deeplink", publicKey: new web3.PublicKey(MEMBER), walletName: "Solflare (test)" } },
        storage: {
          "test-deeplink": JSON.stringify({
            dappSecretKey: [],
            dappPublicKey: Array.from(new Uint8Array(32)),
            sharedSecret: Array.from(nacl.randomBytes(32)),
            session: "sessie",
            walletPublicKey: MEMBER,
            pendingAction: null,
            sessionCreatedAt: Date.now(),
          }),
        },
      });
      await page.fns.runExecuteAction();
      assert.deepEqual(page.sent, [{ kind: "execute", transactionIndex: 15n }]);
      assert.match(page.window.location.href, /^https:\/\/solflare\.com\/ul\/v1\/signAndSendTransaction\?/);
      const saved = JSON.parse(page.storage.get("test-deeplink")!);
      assert.strictEqual(saved.pendingAction, "execute");
      assert.strictEqual(saved.pendingActionTransactionIndex, "15");
    });

    it("L-5: na de omleiding noemt de uitkomst van knop 4 het voorstelnummer", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 5 } } }, {}, deeplinkReturn("execute", "15"));
      await page.fns.resumeAfterLoad();
      assert.match(page.logs.join("\n"), /^SUCCES - voorstel #15 uitgevoerd \(geland, zonder fout; op de keten Executed\)/m);
    });

    // Sectie 173 (review §172, L-4): zonder nummer valt er niets terug te lezen, dus geen SUCCES.
    it("L-5: een oudere stand zonder voorstelnummer: de controle loopt toch, geen SUCCES, en de uitkomst zegt dat het nummer ontbreekt", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 5 } } }, {}, deeplinkReturn("execute", null));
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.notMatch(logs, /^SUCCES/m);
      assert.match(logs, /geland zonder fout, maar het voorstelnummer is niet bewaard: niet vastgesteld welk voorstel is uitgevoerd/);
      assertExactQueries(page);
    });
  });

  // Sectie 173 (review §172): M-1 herladen midden in de controle, L-1 een uitweg uit het slot,
  // L-2/L-3 de verbindknoppen onder het slot, L-4 knop 4 leest het voorstel terug, L-5 de
  // betrokken knop blijft uit tot het genoemde tijdstip; en de mutaties B, C en H van de review.
  describe("sectie 173 (review §172): herladen midden in de controle, uitweg uit het slot, knop 4 leest terug", () => {
    const VERIFY = "test-deeplink-verify";
    const verifyState = (page: Page) => (page.storage.has(VERIFY) ? JSON.parse(page.storage.get(VERIFY)!) : null);
    const flush = async () => {
      for (let i = 0; i < 300; i++) await new Promise((r) => setImmediate(r));
    };
    const never = () => new Promise<never>(() => undefined);
    const off = (page: Page, id: string) => !!page.elements[id]?.disabled;
    const onlyOff = (page: Page, ids: string[]) => {
      for (const id of LOCKED_BUTTONS) assert.strictEqual(off(page, id), ids.includes(id), `${id} ${ids.includes(id) ? "hoort uit" : "hoort aan"}`);
    };
    const MULTISIG_ADDRESS = new web3.PublicKey("A5iDbqC8UvF6a88WpnEmW6w64x6fEr9JWf8CA5zR3tMp");
    const proposal15 = sdk.getProposalPda({ multisigPda: MULTISIG_ADDRESS, transactionIndex: 15n })[0].toBase58();

    /** Eerste lading na een terugkeer uit Solflare; confirmTransaction antwoordt niet, dus de controle loopt nog. */
    const midCheck = async (action: string, index: string | null, state: SquadsOpts) => {
      const opts = deeplinkReturn(action, index);
      const first = await loadPage(state, { confirmTransaction: never }, opts);
      void first.fns.resumeAfterLoad();
      await flush();
      assert.lengthOf(first.rpc.filter((c) => c.method === "confirmTransaction"), 1, "de eerste lading startte de controle niet");
      return { first, storage: Object.fromEntries(first.storage), search: opts.search };
    };
    /** Tweede lading: dezelfde opslag en dezelfde URL (de browser herlaadt met ?nonce=…&data=…). */
    const reload = (state: SquadsOpts, mid: { storage: Record<string, string>; search?: string }, overrides: Record<string, unknown> = {}) =>
      loadPage(state, overrides, { env: { connectedWallet: null }, storage: mid.storage, search: mid.search });

    // [knop, actie, nummer, stand op de keten na het versturen]
    const reloads: [string, string, string | null, SquadsOpts][] = [
      ["knop 2", "propose", null, { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } }],
      ["knop 3", "approve", "15", { latestIndex: 15, proposals: { 15: {} } }],
      ["knop 4", "execute", "15", { latestIndex: 15, proposals: { 15: { status: 5 } } }],
      ["knop 5", "reject", "15", { latestIndex: 15, proposals: { 15: { status: 2 } } }],
    ];
    for (const [name, action, index, state] of reloads) {
      it(`M-1, ${name}: herladen midden in de controle; de tweede lading controleert, meldt de uitkomst en zet de knoppen goed`, async () => {
        const mid = await midCheck(action, index, state);
        const saved = verifyState(mid.first);
        assert.isNotNull(saved, "geen te-controleren stand bewaard vóór de controle");
        assert.strictEqual(saved.action, action);
        assert.strictEqual(saved.signature, SIG);
        assert.strictEqual(saved.transactionIndex, index);
        assert.isNumber(saved.savedAt);

        const page = await reload(state, mid);
        await page.fns.resumeAfterLoad();
        const logs = page.logs.join("\n");
        assert.match(logs, /^SUCCES/m, `geen uitkomst na herladen:\n${logs}`);
        assert.isNull(verifyState(page), "de stand bleef staan na het oordeel");
        assertExactQueries(page);
        allOff(page);
        allOn(page);
      });
    }

    it("M-1, knop 4: herladen, de transactie blijkt mislukt: MISLUKT, stand gewist, knoppen aan", async () => {
      const state = { latestIndex: 15, proposals: { 15: {} } };
      const mid = await midCheck("execute", "15", state);
      const page = await reload(state, mid, failedTx);
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.match(logs, MISLUKT);
      assert.notMatch(logs, /^SUCCES/m);
      assert.isNull(verifyState(page));
      allOn(page);
    });

    it("M-1, knop 4: herladen, uitkomst onbekend: het advies met tijdstip, stand gewist, alleen knop 4 blijft uit", async () => {
      const state = { latestIndex: 15, proposals: { 15: {} } };
      const mid = await midCheck("execute", "15", state);
      const page = await reload(state, mid, { confirmTransaction: timeout, getSignatureStatuses: statuses({}) });
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.match(logs, /Wacht daarom tot ten minste \d\d:\d\d:\d\d/);
      assert.notMatch(logs, /^SUCCES/m);
      assert.isNull(verifyState(page));
      onlyOff(page, ["squads-execute-btn"]);
    });

    it("M-1: de RPC faalt bij het teruglezen (geen oordeel): de stand blijft, voor het volgende laden", async () => {
      const state = { latestIndex: 15, proposals: { 15: { status: 5 } } };
      const mid = await midCheck("execute", "15", state);
      const base = fakeConnection(squadsAccounts(state));
      const page = await reload(state, mid, {
        getAccountInfo: async (address: any, ...rest: unknown[]) => {
          if (address.toBase58() === proposal15) throw new Error("RPC down (test)");
          return (base.getAccountInfo as any)(address, ...rest);
        },
      });
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.notMatch(logs, /^SUCCES/m);
      assert.isNotNull(verifyState(page), "de stand is gewist zonder oordeel");
      assert.match(logs, /bij het volgende laden opnieuw/);
    });

    it("M-1: een verlopen stand wordt niet gecontroleerd en niet aan iets gekoppeld; de signature wordt wel genoemd", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 5 } } }, {}, {
        env: { connectedWallet: null },
        storage: {
          [VERIFY]: JSON.stringify({ action: "execute", signature: SIG, transactionIndex: "15", savedAt: Date.now() - 31 * 60 * 1000 }),
          "test-deeplink-last-wallet": JSON.stringify({ walletPublicKey: MEMBER, savedAt: Date.now() }),
        },
      });
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.lengthOf(page.rpc.filter((c) => c.method === "confirmTransaction"), 0);
      assert.isNull(verifyState(page));
      assert.match(logs, /verlopen/);
      assert.include(logs, SIG);
      assert.notMatch(logs, /^SUCCES/m);
    });

    it("M-1: een stand van een andere actie (knop 3) wordt als die actie gemeld, niet als uitvoeren", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, {}, {
        env: { connectedWallet: null },
        storage: {
          [VERIFY]: JSON.stringify({ action: "approve", signature: SIG, transactionIndex: "15", savedAt: Date.now() }),
          "test-deeplink-last-wallet": JSON.stringify({ walletPublicKey: MEMBER, savedAt: Date.now() }),
        },
      });
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.match(logs, /^SUCCES - voorstel #15 status: .*goedgekeurd door/m);
      assert.notMatch(logs, /uitgevoerd/);
      assert.isNull(verifyState(page));
    });

    it("M-1: een nieuwe verbinding ruimt een open stand op en noemt de ongecontroleerde signature", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, {}, {
        storage: { [VERIFY]: JSON.stringify({ action: "approve", signature: SIG, transactionIndex: "15", savedAt: Date.now() }) },
      });
      page.fns.beginFreshDeeplinkConnect("execute");
      assert.isNull(verifyState(page));
      assert.include(page.logs.join("\n"), SIG);
    });

    it("M-1: een ongeldige stand (onbekende actie) wordt gewist zonder controle", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, {}, {
        env: { connectedWallet: null },
        storage: { [VERIFY]: JSON.stringify({ action: "connect", signature: SIG, transactionIndex: null, savedAt: Date.now() }) },
      });
      await page.fns.resumeAfterLoad();
      assert.lengthOf(page.rpc.filter((c) => c.method === "confirmTransaction"), 0);
      assert.isNull(verifyState(page));
    });

    // Review §172 L-2 en mutaties B/H: knop 2 blijft na het ontgrendelen uit bij een open voorstel.
    const open15 = { latestIndex: 15, proposals: { ...devnetNow(), 15: { status: 1 } } };
    const heldOff: [string, Record<string, unknown>][] = [
      ["mislukt via de websocket (geen time-out)", failedTx],
      ["confirmTransaction zonder fout, status null (geen time-out)", { getSignatureStatuses: statuses({}) }],
      ["time-out, uitkomst onbekend", { confirmTransaction: timeout, getSignatureStatuses: statuses({}) }],
    ];
    for (const [name, overrides] of heldOff) {
      it(`L-2, knop 2 ${name}, er staat een voorstel open: na het ontgrendelen alleen knop 2 uit`, async () => {
        const page = await loadPage(open15, overrides);
        page.fns.enableActionButtons();
        await rejection(page.fns.withActionButtonsLocked(() => page.fns.finishPropose(SIG)));
        allOff(page);
        onlyOff(page, ["propose-btn"]);
      });
    }

    it("L-2/L-3: tijdens de controle na een deep-link-terugkeer staan ook 1 en 1b uit", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 5 } } }, {}, deeplinkReturn("execute", "15"));
      await page.fns.resumeAfterLoad();
      allOff(page);
      allOn(page);
    });

    // Mutatie C: ontgrendelen zet geen knop aan zonder verbonden lid.
    it("ontgrendelen zonder verbonden lid: de actieknoppen blijven uit, 1 en 1b gaan aan", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } });
      await page.fns.withActionButtonsLocked(async () => undefined);
      onlyOff(page, ACTION_BUTTONS);
    });

    it("deep-link-terugkeer van een adres dat geen lid is: na de controle blijven de actieknoppen uit", async () => {
      const outsider = OLD_BUFFER.toBase58(); // een geldig adres dat geen lid is
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 5 } } }, {}, deeplinkReturn("execute", "15", SIG, outsider));
      await page.fns.resumeAfterLoad();
      assert.match(page.logs.join("\n"), /GEEN geregistreerd lid/);
      onlyOff(page, ACTION_BUTTONS);
    });

    // L-1: een wallet die nooit antwoordt.
    it("L-1: de wallet antwoordt nooit: na verloop van tijd een melding dat herladen kan; de knoppen blijven uit", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 1 } } }, {}, {
        env: { connectedWallet: { publicKey: new web3.PublicKey(MEMBER), mode: "extension", walletName: "W", signAndSendTransaction: never } },
      });
      page.fns.enableActionButtons();
      void page.fns.runApproveAction();
      await flush();
      onlyOff(page, LOCKED_BUTTONS);
      assert.isNotEmpty(page.longTimers, "geen timer voor de uitweg");
      assert.isAtLeast(Math.min(...page.longTimers.map((t) => t.ms)), 60_000);
      for (const t of page.longTimers) t.fn();
      const logs = page.logs.join("\n");
      assert.match(logs, /pagina herladen/);
      assert.match(logs, /mogelijk toch verstuurd/);
      assert.match(logs, /eerst de keten/);
      onlyOff(page, LOCKED_BUTTONS);
    });

    it("L-1: na een gewone controle geeft de timer geen melding meer", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 1 } } });
      page.fns.enableActionButtons();
      await page.fns.runApproveAction();
      const before = page.logs.length;
      for (const t of page.longTimers) t.fn();
      assert.notMatch(page.logs.slice(before).join("\n"), /mogelijk toch verstuurd/);
    });

    // L-4: knop 4 leest het voorstel terug.
    it("L-4, knop 4: geland zonder fout, maar #15 staat nog op Approved: geen SUCCES, wel 'niet vastgesteld'", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } });
      const why = await rejection(page.fns.finishSquadsExecute(SIG, 15n));
      assert.notMatch(page.logs.join("\n"), /^SUCCES/m);
      assert.match(why, /voorstel #15 staat op de keten op Approved, niet op Executed: niet vastgesteld/);
      assertExactQueries(page);
    });

    it("L-4, knop 4 via de deep-link: #15 Approved na terugkeer: geen SUCCES", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } }, {}, deeplinkReturn("execute", "15"));
      await page.fns.resumeAfterLoad();
      const logs = page.logs.join("\n");
      assert.notMatch(logs, /^SUCCES/m);
      assert.match(logs, /niet op Executed: niet vastgesteld/);
    });

    it("L-4, knop 4 (extensie): de keten verandert niet: geen SUCCES", async () => {
      const page = await loadPage({ latestIndex: 15, proposals: { 15: {} } });
      page.fns.enableActionButtons();
      await rejection(page.fns.runExecuteAction());
      assert.notMatch(page.logs.join("\n"), /^SUCCES/m);
    });

    // L-5: bij "unknown" blijft de betrokken knop uit tot het genoemde tijdstip.
    it("L-5, knop 3: uitkomst onbekend: alleen knop 3 uit tot het genoemde tijdstip, ook na opnieuw verbinden", async () => {
      const clock = { now: Date.parse("2026-10-01T10:00:00Z") };
      const page = await loadPage({ latestIndex: 15, proposals: { 15: { status: 1 } } }, { confirmTransaction: timeout, getSignatureStatuses: statuses({}) }, { clock });
      page.fns.enableActionButtons();
      const why = await rejection(page.fns.runApproveAction());
      const until = new Date(clock.now + 2 * 60 * 1000).toLocaleTimeString("nl-NL", { hour12: false });
      assert.include(why, "Wacht daarom tot ten minste " + until);
      onlyOff(page, ["approve-btn"]);
      page.fns.enableActionButtons();
      onlyOff(page, ["approve-btn"]);
      clock.now += 2 * 60 * 1000 - 1000;
      page.fns.refreshActionButtons();
      onlyOff(page, ["approve-btn"]);
      clock.now += 2000;
      for (const t of page.longTimers) t.fn();
      onlyOff(page, []);
    });

    it("L-5, knop 2: uitkomst onbekend en geen voorstel gevonden: knop 2 uit tot het genoemde tijdstip", async () => {
      const clock = { now: Date.parse("2026-10-01T10:00:00Z") };
      const page = await loadPage({ latestIndex: 14, proposals: devnetNow() }, { confirmTransaction: timeout, getSignatureStatuses: statuses({}) }, { clock });
      page.fns.enableActionButtons();
      await rejection(page.fns.withActionButtonsLocked(() => page.fns.finishPropose(SIG)));
      onlyOff(page, ["propose-btn"]);
      clock.now += 2 * 60 * 1000 + 1000;
      for (const t of page.longTimers) t.fn();
      onlyOff(page, []);
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
