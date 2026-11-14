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
