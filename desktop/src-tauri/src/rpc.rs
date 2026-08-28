// Gedeelde RPC-configuratie - zelfde devnet-endpoint als de bestaande
// browser-client (client/src/main.ts), voor consistentie tijdens fase-0-
// testen. Eigen, klein bestand i.p.v. de constante in execute.rs of
// fee_payer.rs te laten staan - beide hebben 'm nodig (execute.rs voor
// challenge-opbouw/tx-verzending, fee_payer.rs voor de airdrop-knop).
use solana_rpc_client::rpc_client::RpcClient;

// STATUS.md sectie 107/109: was hardcoded op drie plekken (hier,
// client/src/main.ts, admin/wallet-signer.html) - nu een build-time env
// var (`option_env!`, Rust's idiomatische equivalent van Vite's
// import.meta.env: compile-time-opgelost, geen runtime-bestandslezing
// nodig), uitsluitend zodat rotatie ooit één regel is i.p.v. drie
// bestanden. GEEN echte secret-hantering: dit is een gratis, devnet-only
// Helius-sleutel (bevestigd in sectie 107 punt 5) - de hardcoded waarde
// hieronder is bewust de terugvaloptie, niet een placeholder, zodat een
// verse kloon zonder enige configuratiestap blijft bouwen/werken. Eigen
// sleutel zetten: `HELIUS_API_KEY=<sleutel> cargo build` (of via
// `desktop/src-tauri/.cargo/config.toml`'s `[env]`-sectie voor een
// blijvende lokale override).
pub const HELIUS_API_KEY: &str = match option_env!("HELIUS_API_KEY") {
    Some(key) => key,
    None => "f39fc413-6730-4848-a60f-a6685a6f04d3",
};

pub fn devnet_rpc_url() -> String {
    format!("https://devnet.helius-rpc.com/?api-key={HELIUS_API_KEY}")
}

pub fn rpc_client() -> RpcClient {
    RpcClient::new(devnet_rpc_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Echte devnet-RPC-aanroep (STATUS.md sectie 107/109) - bewijst niet
    // alleen dat devnet_rpc_url() de terugvalsleutel correct opbouwt, maar
    // ook dat die sleutel daadwerkelijk nog geldig is tegen de echte
    // Helius-devnet-infrastructuur. Netwerkafhankelijk, bewust: dit project
    // vertrouwt consequent op echte devnet-aanroepen i.p.v. gemockte
    // clients (zie STATUS.md, meermaals).
    #[test]
    fn rpc_client_reaches_real_devnet() {
        let client = rpc_client();
        let slot = client.get_slot().expect("getSlot tegen echte devnet-RPC moet slagen");
        assert!(slot > 0, "een geldige devnet-slot moet positief zijn");
    }
}
