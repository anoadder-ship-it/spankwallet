// Gedeelde RPC-configuratie - zelfde devnet-endpoint als de bestaande
// browser-client (client/src/main.ts), voor consistentie tijdens fase-0-
// testen. Eigen, klein bestand i.p.v. de constante in execute.rs of
// fee_payer.rs te laten staan - beide hebben 'm nodig (execute.rs voor
// challenge-opbouw/tx-verzending, fee_payer.rs voor de airdrop-knop).
use solana_rpc_client::rpc_client::RpcClient;

// Helius-devnet-sleutel (STATUS.md sectie 194). De sleutel is een geheim en
// staat niet in git; het besluit uit secties 107/109 ("geen echte secret",
// een vaste terugvalwaarde in de broncode) is vervangen (§180, §188, §192,
// §194). Hij wordt bij het bouwen meegegeven via `option_env!`:
// `HELIUS_API_KEY=<sleutel> cargo build`, of blijvend lokaal via de
// `[env]`-sectie van `desktop/src-tauri/.cargo/config.toml` (genegeerd door
// .gitignore). Let op: `option_env!` zet de waarde letterlijk in het binary;
// een binary met een geldige sleutel deel je niet. Zonder sleutel bouwt de app
// gewoon (bewust geen compileerfout, §193), maar geeft rpc_client() een fout en
// vertrekt er geen RPC-verzoek. Het lezen van de sleutel uit een bestand bij het
// starten is een apart, nog open punt (§193).
const HELIUS_API_KEY: Option<&str> = option_env!("HELIUS_API_KEY");

// Helius-sleutels hebben de vorm van een UUID (8-4-4-4-12 hexadecimale tekens).
fn is_helius_key_format(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

// De foutmelding noemt de variabele en waar hij gezet wordt, nooit de waarde.
fn devnet_rpc_url_for(key: Option<&str>) -> Result<String, String> {
    let key = key.map(str::trim).unwrap_or("");
    let reason = if key.is_empty() {
        "ontbreekt of is leeg in deze build"
    } else if !is_helius_key_format(key) {
        "heeft in deze build niet de vorm van een Helius-sleutel (UUID)"
    } else {
        return Ok(format!("https://devnet.helius-rpc.com/?api-key={key}"));
    };
    Err(format!(
        "HELIUS_API_KEY {reason}. Bouw de app opnieuw met HELIUS_API_KEY=<sleutel> in de omgeving, \
         of zet hem in de [env]-sectie van desktop/src-tauri/.cargo/config.toml. \
         Er is geen verbinding met devnet gemaakt."
    ))
}

pub fn devnet_rpc_url() -> Result<String, String> {
    devnet_rpc_url_for(HELIUS_API_KEY)
}

pub fn rpc_client() -> Result<RpcClient, String> {
    devnet_rpc_url().map(RpcClient::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Echte devnet-RPC-aanroep (STATUS.md sectie 107/109/194), alleen als de
    // build een sleutel meekreeg (HELIUS_API_KEY bij het bouwen). Zonder sleutel
    // controleert hij alleen dat rpc_client() een fout geeft, zonder netwerk, en
    // slaat hij de echte aanroep over; zo raakt de standaardrun het netwerk niet.
    // Netwerkafhankelijk als er wel een sleutel is, bewust: dit project vertrouwt
    // op echte devnet-aanroepen in plaats van gemockte clients.
    #[test]
    fn rpc_client_reaches_real_devnet() {
        if HELIUS_API_KEY.map(str::trim).unwrap_or("").is_empty() {
            assert!(rpc_client().is_err(), "zonder sleutel hoort rpc_client() een fout te geven");
            eprintln!("rpc_client_reaches_real_devnet overgeslagen: geen HELIUS_API_KEY in deze build");
            return;
        }
        let client = rpc_client().expect("HELIUS_API_KEY in deze build hoort een geldige sleutel te zijn");
        let slot = client.get_slot().expect("getSlot tegen echte devnet-RPC moet slagen");
        assert!(slot > 0, "een geldige devnet-slot moet positief zijn");
    }
}
