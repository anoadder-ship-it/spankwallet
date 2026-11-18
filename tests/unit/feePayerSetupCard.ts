import { assert } from "chai";
import { JSDOM } from "jsdom";
import { showFeePayerSetupCard } from "../../desktop/src/feePayerSetupCard";

/**
 * Huidig gedrag van de twee kaarten na de installatie in
 * desktop/src/feePayerSetupCard.ts: de financieringskaart ("Fee-payer
 * aangemaakt", met het adres) en de kaart "Airdrop aangevraagd" (met de
 * signature). De foutkaart "Airdrop mislukt" staat in
 * confirmationCardEscape.ts en errorText.ts.
 */
describe("installatiekaart desktop: financieringskaart en airdrop-kaart", () => {
  const dom = new JSDOM(`<!doctype html><html><body><div id="preview-root"></div></body></html>`);
  const doc = dom.window.document;
  const g = global as any;
  let saved: { document: unknown; window: unknown };
  let invokeCalls: { cmd: string; args: unknown }[];
  let answers: ((cmd: string) => Promise<unknown>)[];
  before(() => {
    saved = { document: g.document, window: g.window };
    g.document = doc;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: unknown) => {
          invokeCalls.push({ cmd, args });
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
    doc.getElementById("preview-root")!.replaceChildren();
  });

  const card = () => doc.querySelector<HTMLElement>("#preview-root > .preview-card");
  const eyebrow = () => card()?.querySelector(".preview-eyebrow")?.textContent ?? null;
  const headline = () => card()!.querySelector<HTMLElement>("#preview-headline")!;
  const confirmBtn = () => doc.querySelector<HTMLButtonElement>("#preview-confirm-btn")!;
  const denyBtn = () => doc.querySelector<HTMLButtonElement>("#preview-deny-btn")!;

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

  // Doorloopt de wachtwoordkaart tot de financieringskaart er staat. Geeft
  // de flow in een object terug: een async functie die een Promise teruggeeft,
  // zou op het einde van de flow wachten.
  async function toFundingCard(pubkey: string, airdrop?: () => Promise<unknown>): Promise<{ flow: Promise<string> }> {
    answers = [async () => ({ pubkeyBase58: pubkey })];
    if (airdrop) answers.push(airdrop);
    const flow = showFeePayerSetupCard();
    await waitForCard(flow, "Eenmalige installatie");
    fill("password", "geheim123");
    fill("passwordConfirm", "geheim123");
    confirmBtn().click();
    await waitForCard(flow, "Fee-payer aangemaakt");
    return { flow };
  }

  it("financieringskaart: toont het adres in een echo-span, knoppen 'Vraag devnet-airdrop aan' en 'Ik fund zelf'", async () => {
    const { flow } = await toFundingCard("Fee1111Payer");
    const spans = headline().querySelectorAll(".preview-recipient-echo");
    assert.lengthOf(spans, 1);
    assert.strictEqual(spans[0].textContent, "Fee1111Payer");
    assert.include(headline().textContent!, "Stuur wat devnet-SOL naar dit adres om transactiekosten te dekken:");
    assert.strictEqual(confirmBtn().textContent, "Vraag devnet-airdrop aan");
    assert.strictEqual(denyBtn().textContent, "Ik fund zelf");
    assert.isNull(card()!.querySelector("input"), "geen invoervelden");
    denyBtn().click();
    assert.strictEqual(await flow, "Fee1111Payer");
  });

  it("financieringskaart: 'Ik fund zelf' vraagt geen airdrop aan", async () => {
    const { flow } = await toFundingCard("Fee2222Payer");
    denyBtn().click();
    assert.strictEqual(await flow, "Fee2222Payer");
    assert.deepEqual(
      invokeCalls.map((c) => c.cmd),
      ["setup_fee_payer"],
    );
    assert.deepEqual(invokeCalls[0].args, { password: "geheim123" });
  });

  it("financieringskaart: HTML in het adres wordt tekst, geen opmaak", async () => {
    const raw = `<img src=x onerror="alert(1)">&'`;
    const { flow } = await toFundingCard(raw);
    const span = headline().querySelector(".preview-recipient-echo")!;
    assert.strictEqual(span.textContent, raw);
    assert.strictEqual(span.childElementCount, 0);
    assert.isNull(headline().querySelector("img"));
    denyBtn().click();
    assert.strictEqual(await flow, raw);
  });

  it("airdrop-kaart: na 'Vraag devnet-airdrop aan' staat de signature in een echo-span, beide knoppen 'Doorgaan'", async () => {
    const { flow } = await toFundingCard("Fee3333Payer", async () => "Sig5555abc");
    confirmBtn().click();
    await waitForCard(flow, "Airdrop aangevraagd");
    const spans = headline().querySelectorAll(".preview-recipient-echo");
    assert.lengthOf(spans, 1);
    assert.strictEqual(spans[0].textContent, "Sig5555abc");
    assert.strictEqual(headline().textContent, "Signature:Sig5555abc");
    assert.strictEqual(confirmBtn().textContent, "Doorgaan");
    assert.strictEqual(denyBtn().textContent, "Doorgaan");
    confirmBtn().click();
    assert.strictEqual(await flow, "Fee3333Payer");
    assert.deepEqual(
      invokeCalls.map((c) => c.cmd),
      ["setup_fee_payer", "request_fee_payer_airdrop"],
    );
  });

  it("airdrop-kaart: ook 'Doorgaan' aan de weigerkant beëindigt de installatie", async () => {
    const { flow } = await toFundingCard("Fee4444Payer", async () => "Sig6666");
    confirmBtn().click();
    await waitForCard(flow, "Airdrop aangevraagd");
    denyBtn().click();
    assert.strictEqual(await flow, "Fee4444Payer");
  });

  it("airdrop-kaart: HTML in de signature wordt tekst, geen opmaak", async () => {
    const raw = `"><script>x</script>&`;
    const { flow } = await toFundingCard("Fee5555Payer", async () => raw);
    confirmBtn().click();
    await waitForCard(flow, "Airdrop aangevraagd");
    const span = headline().querySelector(".preview-recipient-echo")!;
    assert.strictEqual(span.textContent, raw);
    assert.strictEqual(span.childElementCount, 0);
    assert.isNull(headline().querySelector("script"));
    confirmBtn().click();
    assert.strictEqual(await flow, "Fee5555Payer");
  });
});
