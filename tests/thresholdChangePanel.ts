import { assert } from "chai";
import { JSDOM } from "jsdom";
import {
  thresholdChangePanelState,
  renderThresholdChangePanel,
  ThresholdChangePanelState,
} from "../client/src/thresholdChangePanel";
import { ParsedPendingAction, PENDING_ACTION_TIMELOCK_SECONDS } from "../client/src/thresholdChange";

// STATUS.md sectie 135 (vervolg op 99/115/134): pure-logica-tests voor
// thresholdChangePanelState(), GEEN DOM, geen validator nodig - precies het
// mechanisme dat ontwerpvraag 2 beantwoordt ("hoe herkent de UI een
// terugkerend bezoek"). Een kunstmatig teruggedateerde `initiatedAt`
// bewijst hier de "wachtend" vs. "beschikbaar"-overgang zonder ooit 24 echte
// uren te hoeven wachten of tegen de echte devnet-wallet te testen (zie
// STATUS.md sectie 135's "wat is wel/niet automatisch getest"-paragraaf).
//
// renderThresholdChangePanel() (de DOM-effectkant) wordt verderop WEL
// getest, tegen een jsdom-gesimuleerde DOM - zelfde patroon als
// tests/thresholdBanner.ts.

function samplePending(overrides: Partial<ParsedPendingAction>): ParsedPendingAction {
  return {
    kind: 3, // PENDING_ACTION_KIND_THRESHOLD_CHANGE
    initiatedAt: 0n,
    epoch: 0n,
    actionCommitment: new Uint8Array(32),
    initiatorPasskey: new Uint8Array(33),
    confirmed: true,
    ...overrides,
  };
}

describe("thresholdChangePanel: thresholdChangePanelState (pure)", () => {
  it("geen PendingAction -> kind=none", () => {
    const state = thresholdChangePanelState(null, 1_000_000);
    assert.strictEqual(state.kind, "none");
  });

  it("PendingAction van een ANDER kind (bv. kind=0, SolWithdrawal) -> kind=blocked-other, meldt het kind", () => {
    const pending = samplePending({ kind: 0, initiatedAt: 1_000_000n });
    const state = thresholdChangePanelState(pending, 1_000_000);
    assert.strictEqual(state.kind, "blocked-other");
    if (state.kind === "blocked-other") {
      assert.strictEqual(state.otherKind, 0);
    }
  });

  it("kunstmatig teruggedateerde initiated_at, timelock NOG NIET verstreken -> kind=waiting, met de juiste availableAt", () => {
    const now = 2_000_000;
    const initiatedAt = BigInt(now) - BigInt(PENDING_ACTION_TIMELOCK_SECONDS) + 100n; // 100s te vroeg
    const pending = samplePending({ initiatedAt, confirmed: false });
    const state = thresholdChangePanelState(pending, now);
    assert.strictEqual(state.kind, "waiting");
    if (state.kind === "waiting") {
      assert.strictEqual(state.confirmed, false);
      assert.strictEqual(
        state.availableAt.getTime(),
        (Number(initiatedAt) + PENDING_ACTION_TIMELOCK_SECONDS) * 1000
      );
    }
  });

  it("kunstmatig teruggedateerde initiated_at, timelock WEL verstreken -> kind=ready", () => {
    const now = 3_000_000;
    const initiatedAt = BigInt(now) - BigInt(PENDING_ACTION_TIMELOCK_SECONDS) - 1n; // 1s over de grens
    const pending = samplePending({ initiatedAt, confirmed: true });
    const state = thresholdChangePanelState(pending, now);
    assert.strictEqual(state.kind, "ready");
    if (state.kind === "ready") {
      assert.strictEqual(state.confirmed, true);
    }
  });

  it("grensgeval: elapsed EXACT gelijk aan de timelock -> ready (>=, zelfde grens als check_pending_action_finalizable's elapsed >= PENDING_ACTION_TIMELOCK_SECONDS)", () => {
    const now = 4_000_000;
    const initiatedAt = BigInt(now) - BigInt(PENDING_ACTION_TIMELOCK_SECONDS);
    const pending = samplePending({ initiatedAt });
    const state = thresholdChangePanelState(pending, now);
    assert.strictEqual(state.kind, "ready");
  });

  it("grensgeval: elapsed 1 seconde ONDER de timelock -> nog steeds waiting", () => {
    const now = 5_000_000;
    const initiatedAt = BigInt(now) - BigInt(PENDING_ACTION_TIMELOCK_SECONDS) + 1n;
    const pending = samplePending({ initiatedAt });
    const state = thresholdChangePanelState(pending, now);
    assert.strictEqual(state.kind, "waiting");
  });

  it("confirmed wordt ongewijzigd doorgegeven, zowel bij waiting als ready (single-passkey- vs. 2-of-2-onderscheid)", () => {
    const now = 6_000_000;
    const waitingConfirmed = thresholdChangePanelState(
      samplePending({ initiatedAt: BigInt(now), confirmed: true }),
      now
    );
    const waitingUnconfirmed = thresholdChangePanelState(
      samplePending({ initiatedAt: BigInt(now), confirmed: false }),
      now
    );
    assert.strictEqual((waitingConfirmed as any).confirmed, true);
    assert.strictEqual((waitingUnconfirmed as any).confirmed, false);
  });
});

// De DOM-effectkant - zelfde jsdom-aanpak als tests/thresholdBanner.ts: een
// echte browser-DOM-implementatie, geen handgeschreven stub.
describe("thresholdChangePanel: renderThresholdChangePanel (DOM-effectkant, jsdom)", () => {
  let dom: JSDOM;
  const originalDocument = (global as any).document;

  beforeEach(() => {
    dom = new JSDOM(
      '<!DOCTYPE html><body>' +
        '<button id="step24-btn"></button>' +
        '<button id="step25-btn"></button>' +
        '<button id="step25-cancel-btn"></button>' +
        '<div id="threshold-change-status"></div>' +
        "</body>"
    );
    (global as any).document = dom.window.document;
  });

  after(() => {
    // Zelfde reden als tests/thresholdBanner.ts: voorkom dat een
    // achtergebleven jsdom-`document` naar latere testbestanden lekt
    // binnen dezelfde mocha-procesruimte (yarn test).
    (global as any).document = originalDocument;
  });

  function statusEl(): HTMLElement {
    return dom.window.document.getElementById("threshold-change-status")!;
  }
  function initiateBtn(): HTMLButtonElement {
    return dom.window.document.getElementById("step24-btn") as HTMLButtonElement;
  }
  function finalizeBtn(): HTMLButtonElement {
    return dom.window.document.getElementById("step25-btn") as HTMLButtonElement;
  }
  function cancelBtn(): HTMLButtonElement {
    return dom.window.document.getElementById("step25-cancel-btn") as HTMLButtonElement;
  }

  it('kind="none": finalize/cancel disabled, statusregel meldt "geen openstaande wijziging"', () => {
    renderThresholdChangePanel({ kind: "none" });
    assert.isTrue(finalizeBtn().disabled);
    assert.isTrue(cancelBtn().disabled);
    assert.include(statusEl().textContent!, "Geen openstaande");
  });

  it('kind="blocked-other": initiate EN finalize disabled, cancel enabled (kind-agnostisch kan altijd ontgrendelen)', () => {
    const state: ThresholdChangePanelState = { kind: "blocked-other", otherKind: 1 };
    renderThresholdChangePanel(state);
    assert.isTrue(initiateBtn().disabled);
    assert.isTrue(finalizeBtn().disabled);
    assert.isFalse(cancelBtn().disabled);
    assert.include(statusEl().textContent!, "kind=1");
  });

  it('kind="waiting": finalize disabled maar ZICHTBAAR (niet verborgen), cancel enabled, statusregel toont availableAt + confirmed-uitleg', () => {
    const availableAt = new Date(2026, 8, 4, 10, 0, 0);
    const now = new Date(2026, 8, 3, 10, 0, 0);
    renderThresholdChangePanel({ kind: "waiting", availableAt, confirmed: false }, now);

    assert.isTrue(initiateBtn().disabled, "initiate mag niet opnieuw kunnen zolang er iets openstaat");
    assert.isTrue(finalizeBtn().disabled, "finalize mag nog niet kunnen vóór de timelock");
    // De knop zelf blijft in de DOM aanwezig (nooit verwijderd) - dat is
    // precies het "niet verborgen, want de eigenaar moet weten dat hij
    // bestaat"-vereiste uit STATUS.md sectie 135, punt 3.
    assert.isFalse(cancelBtn().disabled);
    assert.include(statusEl().textContent!, "24u");
    assert.include(statusEl().textContent!, "2-of-2");
  });

  it('kind="ready": finalize enabled, statusregel meldt dat de wachttijd verstreken is', () => {
    renderThresholdChangePanel({ kind: "ready", confirmed: true });
    assert.isTrue(initiateBtn().disabled);
    assert.isFalse(finalizeBtn().disabled);
    assert.isFalse(cancelBtn().disabled);
    assert.include(statusEl().textContent!, "verstreken");
    assert.include(statusEl().textContent!, "single-passkey");
  });

  it("terugkerend-bezoek-scenario: eenmalig een backdated PendingAction lezen en direct in de juiste staat renderen, zonder enige eerdere sessie-staat", () => {
    // Simuleert een pagina-herlaad een dag later (ontwerpvraag 2): de PDA
    // bestaat al (van een vorig bezoek), er is GEEN voorafgaande
    // JS-toestand - thresholdChangePanelState()/renderThresholdChangePanel()
    // worden hier voor het eerst in deze test aangeroepen, precies zoals ze
    // dat bij een echte page-load ook zouden zijn (via refreshThresholdChangeStatus()
    // in main.ts).
    const now = 10_000_000;
    const oneDayAgo = BigInt(now) - BigInt(PENDING_ACTION_TIMELOCK_SECONDS) - 3600n; // ruim voorbij de grens
    const pending = samplePending({ initiatedAt: oneDayAgo, confirmed: true });
    const state = thresholdChangePanelState(pending, now);
    renderThresholdChangePanel(state);

    assert.strictEqual(state.kind, "ready");
    assert.isFalse(finalizeBtn().disabled, "finalize moet DIRECT bruikbaar zijn bij het eerste bezoek na de wachttijd, geen tweede stap nodig");
  });
});
