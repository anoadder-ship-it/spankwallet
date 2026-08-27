// Gedeelde RPC-configuratie - zelfde devnet-endpoint als de bestaande
// browser-client (client/src/main.ts), voor consistentie tijdens fase-0-
// testen. Eigen, klein bestand i.p.v. de constante in execute.rs of
// fee_payer.rs te laten staan - beide hebben 'm nodig (execute.rs voor
// challenge-opbouw/tx-verzending, fee_payer.rs voor de airdrop-knop).
use solana_rpc_client::rpc_client::RpcClient;

pub const DEVNET_RPC_URL: &str = "https://devnet.helius-rpc.com/?api-key=f39fc413-6730-4848-a60f-a6685a6f04d3";

pub fn rpc_client() -> RpcClient {
    RpcClient::new(DEVNET_RPC_URL.to_string())
}
