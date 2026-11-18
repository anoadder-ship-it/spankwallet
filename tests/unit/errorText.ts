import { assert } from "chai";
import { JSDOM } from "jsdom";
import { errorText, UNREADABLE_ERROR_TEXT } from "../../desktop/src/errorText";

/**
 * Veilige fouttekst voor de desktop (desktop/src/errorText.ts). Vervangt
 * `typeof err?.message === "string" ? err.message : JSON.stringify(err)` in
 * feePayerSetupCard.ts, feePayerUnlockCard.ts en main.ts. JSON.stringify kan
 * zelf gooien (BigInt, kringverwijzing); een foutmelding mag nooit een tweede
 * fout veroorzaken.
 */

function oldExpression(err: any): string | undefined {
  return typeof err?.message === "string" ? err.message : JSON.stringify(err);
}

function cyclic(): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: "Io" };
  o.self = o;
  return o;
}

describe("errorText (desktop): gelijk aan de oude regel zolang die niet gooide", () => {
  const SAME: [string, unknown][] = [
    ["Error", new Error("mislukt <x>")],
    ["Rust-fout {kind, message}", { kind: "Io", message: "geen verbinding" }],
    ["{kind} zonder message", { kind: "NotSetUp" }],
    ["message geen tekst", { message: 42 }],
    ["tekst", "los"],
    ["getal", 7],
    ["null", null],
    ["array", [1, "a"]],
    ["Object.create(null)", Object.create(null)],
  ];
  for (const [label, value] of SAME) {
    it(label, () => {
      assert.strictEqual(errorText(value), oldExpression(value));
    });
  }

  it("undefined geeft \"\" (de oude regel gaf undefined; de foutkaart toonde al \"\")", () => {
    assert.isUndefined(oldExpression(undefined));
    assert.strictEqual(errorText(undefined), "");
  });
});

describe("errorText (desktop): gooit nooit", () => {
  const THROWING: [string, () => unknown][] = [
    ["BigInt", () => ({ kind: "Io", amount: BigInt(1) })],
    ["BigInt los", () => BigInt(1)],
    ["kringverwijzing", cyclic],
    ["toJSON gooit", () => ({ toJSON: () => { throw new Error("toJSON"); } })],
    ["getter message gooit", () => ({ get message(): string { throw new Error("getter"); } })],
    ["Proxy die bij elke lees gooit", () => new Proxy({}, { get: () => { throw new Error("proxy"); } })],
  ];
  for (const [label, make] of THROWING) {
    it(`${label}: de oude regel gooide, errorText geeft de vaste tekst`, () => {
      assert.throws(() => oldExpression(make()));
      assert.strictEqual(errorText(make()), UNREADABLE_ERROR_TEXT);
    });
  }

  it("Error met een message blijft de message, ook als de rest een kring is", () => {
    const e = new Error("echte fout") as Error & { self?: unknown };
    e.self = e;
    assert.strictEqual(errorText(e), "echte fout");
  });
});

describe("foutkaarten van de desktop met een fout die JSON.stringify laat gooien", () => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="preview-root"></div></body></html>`);
  const doc = dom.window.document;
  const g = global as any;
  let saved: { document: unknown; window: unknown };
  let invokeCalls: string[];
  let answers: ((cmd: string) => Promise<unknown>)[];
  before(() => {
    saved = { document: g.document, window: g.window };
    g.document = doc;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string) => {
          invokeCalls.push(cmd);
          const next = answers.shift();
          if (!next) throw new Error(`onverwachte invoke ${cmd}`);
          return next(cmd);
        },
      },
    };
  });
  after(() => {
    g.document = saved.document;
    g.window = saved.window;
  });
  beforeEach(() => {
    invokeCalls = [];
    answers = [];
    doc.getElementById("preview-root")!.innerHTML = "";
  });

  const card = () => doc.querySelector<HTMLElement>("#preview-root > .preview-card");
  const eyebrow = () => card()?.querySelector(".preview-eyebrow")?.textContent ?? null;
  const headline = () => card()!.querySelector("#preview-headline")!.textContent;

  async function waitForCard(flow: Promise<unknown>, wanted: string): Promise<void> {
    let failure: unknown = null;
    flow.catch((e) => {
      failure = e;
    });
    for (let i = 0; i < 200; i++) {
      if (failure) throw failure;
      if (eyebrow() === wanted) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`kaart "${wanted}" verscheen niet (nu: ${eyebrow()})`);
  }
  function fill(id: string, value: string) {
    doc.querySelector<HTMLInputElement>(`#preview-input-${id}`)!.value = value;
  }
  const confirm = () => doc.querySelector<HTMLButtonElement>("#preview-confirm-btn")!.click();

  it("ontgrendelkaart: invoke weigert met een kringverwijzing, de foutkaart toont de vaste tekst", async () => {
    const { showFeePayerUnlockCard } = await import("../../desktop/src/feePayerUnlockCard");
    answers = [() => Promise.reject(cyclic()), async () => ({ pubkeyBase58: "Adres333" })];
    const flow = showFeePayerUnlockCard();
    await waitForCard(flow, "Ontgrendelen");
    fill("password", "geheim");
    confirm();
    await waitForCard(flow, "Ontgrendelen mislukt");
    assert.strictEqual(headline(), UNREADABLE_ERROR_TEXT);
    confirm();
    await waitForCard(flow, "Ontgrendelen");
    fill("password", "geheim");
    confirm();
    assert.strictEqual(await flow, "Adres333");
    assert.deepEqual(invokeCalls, ["unlock_fee_payer", "unlock_fee_payer"]);
  });

  it("installatiekaart: airdrop weigert met een BigInt, de foutkaart toont de vaste tekst", async () => {
    const { showFeePayerSetupCard } = await import("../../desktop/src/feePayerSetupCard");
    answers = [async () => ({ pubkeyBase58: "Adres444" }), () => Promise.reject({ kind: "Rpc", lamports: BigInt(5) })];
    const flow = showFeePayerSetupCard();
    await waitForCard(flow, "Eenmalige installatie");
    fill("password", "geheim123");
    fill("passwordConfirm", "geheim123");
    confirm();
    await waitForCard(flow, "Fee-payer aangemaakt");
    confirm();
    await waitForCard(flow, "Airdrop mislukt");
    assert.strictEqual(headline(), UNREADABLE_ERROR_TEXT);
    confirm();
    assert.strictEqual(await flow, "Adres444");
    assert.deepEqual(invokeCalls, ["setup_fee_payer", "request_fee_payer_airdrop"]);
  });
});
