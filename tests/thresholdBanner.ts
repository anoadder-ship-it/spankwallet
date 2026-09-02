import { assert } from "chai";
import { JSDOM } from "jsdom";
import {
  formatSolExact,
  renderThresholdBanner,
  thresholdBannerState,
} from "../client/src/thresholdBanner";

// thresholdBanner.ts (STATUS.md sectie 127/128/129, stap A): pure-logica-
// tests voor thresholdBannerState() en formatSolExact() hieronder, GEEN
// DOM, geen validator nodig. renderThresholdBanner() (de DOM-effectkant in
// hetzelfde bestand) wordt verderop WEL getest, tegen een jsdom-
// gesimuleerde DOM - dat dichtte het gat dat de oorspronkelijke docstring
// boven renderThresholdBanner() in client/src/thresholdBanner.ts nog
// "niet automatisch getest" noemde.

describe("thresholdBanner: formatSolExact", () => {
  it("hele SOL-bedragen tonen geen decimaal punt", () => {
    assert.strictEqual(formatSolExact(1_000_000_000n), "1");
    assert.strictEqual(formatSolExact(2_000_000_000n), "2");
  });

  it("0 lamports formatteert als \"0\"", () => {
    assert.strictEqual(formatSolExact(0n), "0");
  });

  it("een fractioneel bedrag toont alleen de niet-nul decimalen, geen afronding", () => {
    // 1.5 SOL
    assert.strictEqual(formatSolExact(1_500_000_000n), "1.5");
    // 1 lamport = 0.000000001 SOL
    assert.strictEqual(formatSolExact(1n), "0.000000001");
  });

  it("géén precisie-overclaim: trailing zeros in het fractionele deel worden weggelaten, niet afgerond", () => {
    // 1.100000000 SOL -> "1.1", niet "1.100000000"
    assert.strictEqual(formatSolExact(1_100_000_000n), "1.1");
  });
});

describe("thresholdBanner: thresholdBannerState", () => {
  it("threshold = 0: showNudge is true (fail-safe default, nudge hoort getoond te worden)", () => {
    const state = thresholdBannerState(0n);
    assert.isTrue(state.showNudge);
    assert.isNotEmpty(state.nudgeHeadline);
    assert.isNotEmpty(state.nudgeBody);
    assert.isNotEmpty(state.statusLine);
  });

  it("threshold = 0: de statusregel meldt expliciet dat er geen drempel is", () => {
    const state = thresholdBannerState(0n);
    assert.include(state.statusLine, "geen (0)");
  });

  it("threshold > 0: showNudge is false, alleen de statusregel is relevant (punt 4)", () => {
    const state = thresholdBannerState(1_000_000_000n);
    assert.isFalse(state.showNudge);
    assert.strictEqual(state.nudgeHeadline, "");
    assert.strictEqual(state.nudgeBody, "");
    assert.isNotEmpty(state.statusLine);
  });

  it("threshold > 0: de statusregel bevat het geformatteerde SOL-bedrag", () => {
    const state = thresholdBannerState(2_500_000_000n);
    assert.include(state.statusLine, "2.5");
  });

  it("statusLine is ALTIJD relevant, onafhankelijk van showNudge (punt 4: een weigering moet beoordeelbaar blijven)", () => {
    const zero = thresholdBannerState(0n);
    const nonZero = thresholdBannerState(500_000_000n);
    assert.isNotEmpty(zero.statusLine);
    assert.isNotEmpty(nonZero.statusLine);
    assert.notStrictEqual(zero.statusLine, nonZero.statusLine);
  });

  it("beide varianten vermelden de scope-disclaimer (alleen SOL via execute/hunt)", () => {
    const zero = thresholdBannerState(0n);
    const nonZero = thresholdBannerState(1_000_000_000n);
    assert.include(zero.statusLine + zero.nudgeBody, "execute/hunt");
    assert.include(nonZero.statusLine, "execute/hunt");
  });
});

// De DOM-effectkant: renderThresholdBanner() zelf, tegen een jsdom-
// gesimuleerde `document` - een echte browser-DOM-implementatie (geen
// handgeschreven stub), zodat innerHTML-parsing, querySelector en
// dispatchEvent zich precies zo gedragen als in de vite-dev-server/echte
// browser die main.ts::runStep2() daadwerkelijk aanroept.
describe("thresholdBanner: renderThresholdBanner (DOM-effectkant, jsdom)", () => {
  let dom: JSDOM;
  const originalDocument = (global as any).document;

  beforeEach(() => {
    dom = new JSDOM(
      '<!DOCTYPE html><body><div id="threshold-nudge"></div><div id="threshold-status"></div></body>'
    );
    (global as any).document = dom.window.document;
  });

  after(() => {
    // Deze suite draait binnen dezelfde mocha-procesruimte als de rest van
    // `tests/**/*.ts` (yarn test) - een achtergebleven jsdom-`document` op
    // de Node-global zou onbedoeld kunnen lekken naar bestanden die ná dit
    // bestand laden. Altijd terugzetten, ook al gebruikt vandaag geen
    // ander testbestand `document`.
    (global as any).document = originalDocument;
  });

  function nudgeRoot(): HTMLElement {
    return dom.window.document.getElementById("threshold-nudge")!;
  }
  function statusEl(): HTMLElement {
    return dom.window.document.getElementById("threshold-status")!;
  }

  it("threshold = 0: #threshold-nudge bevat de banner met de juiste headline/body-tekst, #threshold-status toont de \"geen drempel\"-regel", () => {
    renderThresholdBanner(0n);
    const state = thresholdBannerState(0n);

    const banner = nudgeRoot().querySelector(".threshold-nudge-banner");
    assert.isNotNull(banner, "nudge-banner moet in de DOM staan bij threshold=0");
    assert.strictEqual(
      nudgeRoot().querySelector(".threshold-nudge-headline")!.textContent,
      state.nudgeHeadline
    );
    assert.strictEqual(
      nudgeRoot().querySelector(".threshold-nudge-body")!.textContent,
      state.nudgeBody
    );
    assert.strictEqual(statusEl().textContent, state.statusLine);
  });

  it("threshold > 0: #threshold-nudge is leeg, #threshold-status toont het bedrag via formatSolExact", () => {
    const threshold = 2_500_000_000n;
    renderThresholdBanner(threshold);

    assert.strictEqual(
      nudgeRoot().innerHTML,
      "",
      "geen banner-markup mag achterblijven bij een niet-nul drempel"
    );
    assert.include(statusEl().textContent!, formatSolExact(threshold));
  });

  it("idempotent: opeenvolgende aanroepen met verschillende waarden OVERSCHRIJVEN de vorige staat, stapelen niet (bewijs, geen aanname op de doc-comment)", () => {
    renderThresholdBanner(0n);
    assert.strictEqual(
      nudgeRoot().querySelectorAll(".threshold-nudge-banner").length,
      1,
      "eerste aanroep (threshold=0) moet precies een banner geven"
    );

    renderThresholdBanner(1_000_000_000n);
    assert.strictEqual(
      nudgeRoot().querySelectorAll(".threshold-nudge-banner").length,
      0,
      "een niet-nul drempel NA een 0-drempel moet de vorige banner VERVANGEN (root leegmaken), niet ernaast laten staan"
    );

    renderThresholdBanner(0n);
    assert.strictEqual(
      nudgeRoot().querySelectorAll(".threshold-nudge-banner").length,
      1,
      "opnieuw threshold=0 ná threshold>0 moet weer precies EEN banner geven, niet stapelen op een root die al eerder gevuld is geweest"
    );
  });

  it("dismiss-knop verwijdert de banner uit de DOM bij een klik", () => {
    renderThresholdBanner(0n);
    const dismissBtn = nudgeRoot().querySelector<HTMLButtonElement>(".threshold-nudge-dismiss");
    assert.isNotNull(dismissBtn, "dismiss-knop moet aanwezig zijn zolang de banner getoond wordt");

    dismissBtn!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    assert.strictEqual(
      nudgeRoot().innerHTML,
      "",
      "banner moet volledig uit de DOM verwijderd zijn na een klik op de dismiss-knop"
    );
    assert.strictEqual(
      statusEl().textContent,
      thresholdBannerState(0n).statusLine,
      "dismiss raakt alleen de nudge-banner - de statusregel (punt 4, altijd relevant) blijft ongewijzigd staan"
    );
  });
});
