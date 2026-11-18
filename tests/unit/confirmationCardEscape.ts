import { assert } from "chai";
import { JSDOM } from "jsdom";
import { escapeHtml as escapeClient } from "../../client/src/confirmationCard";
import { escapeHtml as escapeDesktop, showConfirmationCard } from "../../desktop/src/confirmationCard";

/**
 * STATUS.md sectie 196 (ronde 3c, bevinding B3).
 * (a) escapeHtml in client en desktop escapet alle vijf de HTML-tekens; de
 *     zichtbare tekst na het plaatsen via innerHTML is gelijk aan de invoer,
 *     ook in een attribuutwaarde.
 * (b) De bevestigingskaart van de desktop zet label en beginwaarde met
 *     DOM-functies: wat erin staat, wordt nooit als HTML gelezen, en de opbouw
 *     van de kaart (volgorde, klassen, ids, attributen) is dezelfde als
 *     voorheen. De volledige voor/na-vergelijking met de echte aanroepers staat
 *     in STATUS.md sectie 196.
 */

const dom = new JSDOM(`<!doctype html><html><body><div id="preview-root"></div></body></html>`);
const doc = dom.window.document;

const SAMPLES = [
  "",
  "gewone tekst",
  `&<>"'`,
  `fout "met" <b>tags</b> & 'quotes' <img src=x onerror="alert(1)">`,
  "a&amp;b &lt;al ge-escapet&gt;",
  " nbsp é 😀\n regel",
  `"><script>x</script>`,
];

for (const [name, escapeHtml] of [
  ["client", escapeClient],
  ["desktop", escapeDesktop],
] as const) {
  describe(`escapeHtml (${name}, STATUS.md sectie 196)`, () => {
    it("escapet precies de vijf HTML-tekens", () => {
      assert.strictEqual(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
      assert.strictEqual(escapeHtml("abc é 😀"), "abc é 😀");
      // Geen dubbele escape van een al aanwezige entiteit-tekst: & wordt één keer &amp;.
      assert.strictEqual(escapeHtml("&amp;"), "&amp;amp;");
    });

    it("de tekst komt ongewijzigd terug, in een element en in een attribuut", () => {
      const div = doc.createElement("div");
      for (const s of SAMPLES) {
        div.innerHTML = escapeHtml(s);
        assert.strictEqual(div.textContent, s);
        assert.strictEqual(div.children.length, 0, `geen elementen uit ${JSON.stringify(s)}`);
        div.innerHTML = `<span title="${escapeHtml(s)}" data-x='${escapeHtml(s)}'></span>`;
        const span = div.firstElementChild!;
        assert.strictEqual(span.attributes.length, 2);
        assert.strictEqual(span.getAttribute("title"), s);
        assert.strictEqual(span.getAttribute("data-x"), s);
      }
    });
  });
}

describe("bevestigingskaart desktop: velden via DOM-functies (STATUS.md sectie 196)", () => {
  const g = global as any;
  let savedDocument: unknown;
  before(() => {
    savedDocument = g.document;
    g.document = doc;
  });
  after(() => {
    g.document = savedDocument;
  });

  async function render(fields: { id: string; label: string; defaultValue: string; type?: "text" | "password" }[]) {
    const result = showConfirmationCard({
      eyebrow: "Voorstel om te ondertekenen",
      headline: () => "kop",
      fields,
      validate: (raw) => ({ values: raw }),
    });
    const card = doc.querySelector<HTMLElement>("#preview-root > .preview-card")!;
    return { card, result };
  }

  it("label en beginwaarde worden letterlijk getoond, nooit als HTML gelezen", async () => {
    const label = `Bedrag <b>vet</b> "x" & 'y'`;
    const value = `"><img src=x onerror="alert(1)"> &amp; '`;
    const { card, result } = await render([{ id: "amount", label, defaultValue: value }]);
    const labelEl = card.querySelector("label")!;
    const inputEl = card.querySelector<HTMLInputElement>("#preview-input-amount")!;
    assert.strictEqual(labelEl.textContent, label);
    assert.strictEqual(inputEl.value, value);
    assert.strictEqual(inputEl.getAttribute("value"), value);
    assert.isNull(card.querySelector("img"));
    assert.isNull(card.querySelector("b"));
    card.querySelector<HTMLButtonElement>("#preview-confirm-btn")!.click();
    assert.deepEqual(await result, { amount: value });
  });

  it("opbouw van de kaart: volgorde, klassen, ids en veldattributen zoals voorheen", async () => {
    const { card, result } = await render([
      { id: "amount", label: "Bedrag (SOL)", defaultValue: "0.0015" },
      { id: "password", label: "Wachtwoord", defaultValue: "", type: "password" },
    ]);
    assert.deepEqual(
      Array.from(card.children).map((el) => el.className),
      [
        "preview-eyebrow",
        "preview-headline",
        "preview-field",
        "preview-field",
        "preview-error",
        "preview-actions",
      ]
    );
    const attrs = (el: Element) =>
      Array.from(el.attributes)
        .map((a) => `${a.name}=${a.value}`)
        .sort();
    const fields = card.querySelectorAll(".preview-field");
    assert.deepEqual(attrs(fields[0].querySelector("label")!), ["class=preview-label", "for=preview-input-amount"]);
    assert.deepEqual(attrs(fields[0].querySelector("input")!), [
      "autocomplete=off",
      "class=preview-input",
      "id=preview-input-amount",
      "spellcheck=false",
      "type=text",
      "value=0.0015",
    ]);
    assert.deepEqual(attrs(fields[1].querySelector("input")!), [
      "autocomplete=off",
      "class=preview-input",
      "id=preview-input-password",
      "spellcheck=false",
      "type=password",
      "value=",
    ]);
    // Dezelfde witruimte als de oude opmaak, dus dezelfde tekst van de kaart.
    // Verwachte waarde vastgesteld met de kaart van main (9ec97f1), niet met de nieuwe.
    assert.strictEqual(
      card.textContent!.replace(/\n */g, "|"),
      "|Voorstel om te ondertekenen|kop|||Bedrag (SOL)||||Wachtwoord|||||Weiger|Bevestig en teken||"
    );
    card.querySelector<HTMLButtonElement>("#preview-deny-btn")!.click();
    assert.isNull(await result);
  });
});

/**
 * STATUS.md sectie 197 (restpunt B4). De foutkaarten in
 * desktop/src/feePayerSetupCard.ts en feePayerUnlockCard.ts geven
 * `JSON.stringify(err)` door aan escapeHtml. Met `err` undefined is dat
 * undefined, geen tekst. escapeHtml moet elke waarde aankunnen, net als de
 * versie van vóór 452abe0 (`div.textContent = value; return div.innerHTML`):
 * undefined en null worden "", al het andere `String(value)`, daarna
 * ge-escapet. Dat is gelijk aan de oude versie voor de waarden in NON_TEXT,
 * niet voor alles: zie de laatste drie tests per implementatie.
 */
function oldEscapeHtml(value: unknown): string {
  const div = doc.createElement("div");
  (div as any).textContent = value;
  return div.innerHTML;
}

const NON_TEXT: [string, unknown, string][] = [
  ["undefined", undefined, ""],
  ["JSON.stringify(undefined)", JSON.stringify(undefined), ""],
  ["null", null, ""],
  ["0", 0, "0"],
  ["42", 42, "42"],
  ["-1.5", -1.5, "-1.5"],
  ["NaN", NaN, "NaN"],
  ["true", true, "true"],
  ["false", false, "false"],
  ["{}", {}, "[object Object]"],
  ["{kind, message}", { kind: "Io", message: "<x>" }, "[object Object]"],
  ["[1, '<']", [1, "<"], "1,&lt;"],
  ["object met toString", { toString: () => "a<b>&c" }, "a&lt;b&gt;&amp;c"],
];

for (const [name, escapeHtml] of [
  ["client", escapeClient],
  ["desktop", escapeDesktop],
] as const) {
  describe(`escapeHtml met een waarde die geen tekst is (${name}, STATUS.md sectie 197)`, () => {
    for (const [label, value, expected] of NON_TEXT) {
      it(`${label} geeft ${JSON.stringify(expected)}, zoals de oude versie`, () => {
        assert.strictEqual(oldEscapeHtml(value), expected, "verwachting klopt met de oude versie");
        assert.strictEqual(escapeHtml(value as any), expected);
      });
    }
    // Waar String(value) afwijkt van de oude versie, of net als die gooit.
    // Legt het huidige gedrag vast; het type `string` houdt deze waarden
    // buiten de deur, behalve via `any`.
    it("Symbol: de oude versie gooide, String(value) geeft Symbol(...)", () => {
      assert.throws(() => oldEscapeHtml(Symbol("x")), TypeError);
      assert.strictEqual(escapeHtml(Symbol("<x>") as any), "Symbol(&lt;x&gt;)");
    });
    it("Object.create(null): gooit, net als de oude versie", () => {
      assert.throws(() => oldEscapeHtml(Object.create(null)), TypeError);
      assert.throws(() => escapeHtml(Object.create(null) as any), TypeError);
    });
    it("BigInt: gelijk aan de oude versie", () => {
      assert.strictEqual(oldEscapeHtml(BigInt(10)), "10");
      assert.strictEqual(escapeHtml(BigInt(10) as any), "10");
    });
  });
}

describe("foutkaarten van de desktop met err undefined (STATUS.md sectie 197)", () => {
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
  });

  const card = () => doc.querySelector<HTMLElement>("#preview-root > .preview-card");
  const eyebrow = () => card()?.querySelector(".preview-eyebrow")?.textContent ?? null;

  // Wacht tot de kaart met deze eyebrow er staat, of tot de flow zelf faalt.
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

  it("ontgrendelkaart: invoke weigert met undefined, de foutkaart verschijnt en de lus gaat door", async () => {
    const { showFeePayerUnlockCard } = await import("../../desktop/src/feePayerUnlockCard");
    answers = [() => Promise.reject(undefined), async () => ({ pubkeyBase58: "Adres111" })];
    const flow = showFeePayerUnlockCard();
    await waitForCard(flow, "Ontgrendelen");
    fill("password", "geheim");
    confirm();
    await waitForCard(flow, "Ontgrendelen mislukt");
    assert.strictEqual(card()!.querySelector("#preview-headline")!.innerHTML, "");
    confirm();
    await waitForCard(flow, "Ontgrendelen");
    fill("password", "geheim");
    confirm();
    assert.strictEqual(await flow, "Adres111");
    assert.deepEqual(invokeCalls, ["unlock_fee_payer", "unlock_fee_payer"]);
  });

  it("installatiekaart: airdrop weigert met undefined, de foutkaart verschijnt en de installatie eindigt", async () => {
    const { showFeePayerSetupCard } = await import("../../desktop/src/feePayerSetupCard");
    answers = [async () => ({ pubkeyBase58: "Adres222" }), () => Promise.reject(undefined)];
    const flow = showFeePayerSetupCard();
    await waitForCard(flow, "Eenmalige installatie");
    fill("password", "geheim123");
    fill("passwordConfirm", "geheim123");
    confirm();
    await waitForCard(flow, "Fee-payer aangemaakt");
    confirm();
    await waitForCard(flow, "Airdrop mislukt");
    assert.strictEqual(card()!.querySelector("#preview-headline")!.innerHTML, "");
    confirm();
    assert.strictEqual(await flow, "Adres222");
    assert.deepEqual(invokeCalls, ["setup_fee_payer", "request_fee_payer_airdrop"]);
  });
});
