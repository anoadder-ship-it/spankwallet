import { assert } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { showAddSessionKeyPreview } from "../client/src/addSessionKeyPreview";
import {
  buildAddSessionKeyTransaction,
  EXECUTE_ADVANCED_SESSIONS_BLOCKED_MESSAGE,
} from "../client/src/sessionKeys";

// Tijdelijke client-side blokkade op sessies met can_execute_advanced (zie
// EXECUTE_ADVANCED_SESSIONS_BLOCKED_MESSAGE in client/src/sessionKeys.ts).
// Pure client-logica, geen validator nodig. De stub-Connection gooit bij
// ELKE methode-aanroep - zo bewijzen de tests dat de blokkade optreedt vóór
// er ook maar één RPC-call (en dus vóór de passkey-ceremonie) plaatsvindt.

const RPC_CALLED = "RPC_CALLED";
const throwingConnection = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error(RPC_CALLED);
    },
  }
) as unknown as Connection;

async function buildWith(canExecuteAdvanced: boolean): Promise<unknown> {
  return buildAddSessionKeyTransaction(
    throwingConnection,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    1000n,
    true,
    false,
    canExecuteAdvanced,
    [],
    1n,
    1n,
    PublicKey.default,
    0n,
    0n,
    new Uint8Array(33),
    new Uint8Array(16),
    "localhost"
  );
}

describe("add_session_key: tijdelijke client-blokkade op execute_advanced-sessies", () => {
  it("showAddSessionKeyPreview geeft \"blocked\" bij canExecuteAdvanced=true, zonder RPC-call of kaart", async () => {
    const result = await showAddSessionKeyPreview({
      connection: throwingConnection,
      currentSlot: 0n,
      defaultDurationSlots: 300n,
      canExecute: false,
      canTransferToken: false,
      canExecuteAdvanced: true,
      sessionAllowedPrograms: [],
      tokenMint: PublicKey.default,
      defaultMaxLamportsPerTx: 0n,
      defaultMaxLamportsTotal: 0n,
      defaultMaxTokenAmountPerTx: 0n,
      defaultMaxTokenAmountTotal: 0n,
    });
    assert.strictEqual(result, "blocked");
  });

  it("buildAddSessionKeyTransaction gooit bij canExecuteAdvanced=true, vóór enige RPC-call", async () => {
    let error: unknown = null;
    try {
      await buildWith(true);
    } catch (err) {
      error = err;
    }
    assert.instanceOf(error, Error);
    assert.strictEqual((error as Error).message, EXECUTE_ADVANCED_SESSIONS_BLOCKED_MESSAGE);
  });

  it("controle: bij canExecuteAdvanced=false gaat buildAddSessionKeyTransaction wél door tot de eerste RPC-call", async () => {
    // Bewijst dat de fout hierboven van de blokkade komt en niet van iets
    // anders vóór de RPC-call - zonder de vlag bereikt dezelfde aanroep de
    // stub-Connection (readActionNonce).
    let error: unknown = null;
    try {
      await buildWith(false);
    } catch (err) {
      error = err;
    }
    assert.instanceOf(error, Error);
    assert.strictEqual((error as Error).message, RPC_CALLED);
  });
});
