import * as http from "http";
import type { AddressInfo } from "net";

/**
 * STATUS.md sectie 167: minimale JSON-RPC-server voor de pre-flight-scripts,
 * zonder validator. Beantwoordt precies de aanroepen die
 * scripts/checkRecoveryQueueInvariant.ts en scripts/checkProposalTimelock.ts
 * doen, met een staat die de test zelf kiest (een andere cluster, een
 * achterlopende node, een ander voorstel). Geen enkele aanroep verlaat de
 * machine. Sectie 168: ook getMultipleAccounts (de voorstelscan uit
 * admin/upgradeProposalCheck.mjs).
 */

export interface FakeAccount {
  owner: string;
  data: Buffer;
  executable?: boolean;
}

export interface FakeSignatureStatus {
  slot: number;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

export interface FakeRpcState {
  genesisHash: string;
  /** context.slot van elk antwoord: de slot waarop deze node "staat". */
  slot: number;
  /**
   * false = een node die minContextSlot negeert (bug of kwaadwillig), om de
   * eigen context.slot-controle van het script los te testen.
   */
  honorMinContextSlot: boolean;
  accounts: Map<string, FakeAccount>;
  signatureStatuses: Map<string, FakeSignatureStatus>;
}

export interface FakeRpc {
  url: string;
  close(): Promise<void>;
}

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function accountJson(a: FakeAccount, slice?: { offset: number; length: number }) {
  const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
  return {
    data: [data.toString("base64"), "base64"],
    executable: a.executable ?? false,
    lamports: 1_000_000,
    owner: a.owner,
    rentEpoch: 0,
    space: a.data.length,
  };
}

function checkMinContextSlot(state: FakeRpcState, config: { minContextSlot?: number } | undefined) {
  if (state.honorMinContextSlot && config?.minContextSlot !== undefined && state.slot < config.minContextSlot) {
    throw new RpcError(-32016, `Minimum context slot has not been reached (${state.slot} < ${config.minContextSlot})`);
  }
}

function matchesFilters(data: Buffer, filters: any[] | undefined): boolean {
  for (const f of filters ?? []) {
    if (f.dataSize !== undefined && data.length !== f.dataSize) return false;
    if (f.memcmp) {
      // De scripts filteren met base64; iets anders is hier een fout in de test.
      if (f.memcmp.encoding !== "base64") throw new RpcError(-32602, "nep-RPC ondersteunt alleen base64-memcmp");
      const bytes = Buffer.from(f.memcmp.bytes, "base64");
      if (!data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes)) return false;
    }
  }
  return true;
}

function handle(state: FakeRpcState, method: string, params: any[]): unknown {
  const context = { slot: state.slot, apiVersion: "2.3.0" };
  switch (method) {
    case "getGenesisHash":
      return state.genesisHash;
    case "getAccountInfo": {
      checkMinContextSlot(state, params[1]);
      const a = state.accounts.get(params[0]);
      return { context, value: a ? accountJson(a, params[1]?.dataSlice) : null };
    }
    case "getMultipleAccounts": {
      checkMinContextSlot(state, params[1]);
      const value = (params[0] as string[]).map((address) => {
        const a = state.accounts.get(address);
        return a ? accountJson(a) : null;
      });
      return { context, value };
    }
    case "getProgramAccounts": {
      const [programId, config] = params;
      checkMinContextSlot(state, config);
      const value = [...state.accounts.entries()]
        .filter(([, a]) => a.owner === programId && matchesFilters(a.data, config?.filters))
        .map(([pubkey, a]) => ({ pubkey, account: accountJson(a) }));
      return config?.withContext ? { context, value } : value;
    }
    case "getSignatureStatuses": {
      const value = (params[0] as string[]).map((sig) => {
        const s = state.signatureStatuses.get(sig);
        return s ? { slot: s.slot, confirmations: null, err: s.err, status: s.err ? { Err: s.err } : { Ok: null }, confirmationStatus: s.confirmationStatus } : null;
      });
      return { context, value };
    }
    default:
      throw new RpcError(-32601, `nep-RPC kent ${method} niet`);
  }
}

export async function startFakeRpc(state: FakeRpcState): Promise<FakeRpc> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      let reply: object;
      try {
        reply = { jsonrpc: "2.0", id: request.id, result: handle(state, request.method, request.params ?? []) };
      } catch (e) {
        const code = e instanceof RpcError ? e.code : -32603;
        reply = { jsonrpc: "2.0", id: request.id, error: { code, message: (e as Error).message } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
