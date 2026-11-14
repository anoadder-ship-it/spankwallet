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

    // Testwaarden in sleutelvorm worden uit delen opgebouwd: de bron bevat
    // bewust geen UUID-literal (tests/unit/noHeliusKeyLiteral.ts, §194).
    fn key_shaped(parts: [&str; 5]) -> String {
        parts.join("-")
    }

    fn valid_key() -> String {
        key_shaped([
            &"a1".repeat(4),
            &"b2".repeat(2),
            &"c3".repeat(2),
            &"d4".repeat(2),
            &"e5f6".repeat(3),
        ])
    }

    #[test]
    fn key_format_accepts_uuid_shape_in_any_case() {
        let key = valid_key();
        assert_eq!(key.len(), 36);
        assert!(is_helius_key_format(&key));
        assert!(is_helius_key_format(&key.to_uppercase()));
        let mixed = key_shaped([&"9".repeat(8), &"A".repeat(4), &"f".repeat(4), &"0".repeat(4), &"Ab".repeat(6)]);
        assert!(is_helius_key_format(&mixed));
    }

    #[test]
    fn key_format_rejects_wrong_shapes() {
        let key = valid_key();
        assert!(!is_helius_key_format(""));
        assert!(!is_helius_key_format(&" ".repeat(36)));
        // Te kort en te lang.
        assert!(!is_helius_key_format(&key[..35]));
        assert!(!is_helius_key_format(&format!("{key}0")));
        // Verkeerde tekens: niet-hex, een spatie, een streepje op de verkeerde plek.
        assert!(!is_helius_key_format(&key.replacen('a', "g", 1)));
        assert!(!is_helius_key_format(&key.replacen('b', " ", 1)));
        let mut moved = key.clone().into_bytes();
        moved.swap(8, 9);
        assert!(!is_helius_key_format(&String::from_utf8(moved).unwrap()));
        // Spaties eromheen: is_helius_key_format trimt zelf niet.
        assert!(!is_helius_key_format(&format!(" {key}")));
        // Niet-ASCII van dezelfde bytelengte.
        assert!(!is_helius_key_format(&key.replacen("a1", "é", 1)));
    }

    #[test]
    fn rpc_url_contains_trimmed_key_only_in_query() {
        let key = valid_key();
        let expected = format!("https://devnet.helius-rpc.com/?api-key={key}");
        assert_eq!(devnet_rpc_url_for(Some(&key)).unwrap(), expected);
        assert_eq!(devnet_rpc_url_for(Some(&format!("  {key}\n"))).unwrap(), expected);
        let upper = key.to_uppercase();
        assert_eq!(
            devnet_rpc_url_for(Some(&upper)).unwrap(),
            format!("https://devnet.helius-rpc.com/?api-key={upper}")
        );
    }

    #[test]
    fn rpc_url_missing_or_empty_key_is_error() {
        for input in [None, Some(""), Some("   "), Some("\n\t")] {
            let err = devnet_rpc_url_for(input).unwrap_err();
            assert!(err.contains("HELIUS_API_KEY"), "{err}");
            assert!(err.contains("ontbreekt of is leeg"), "{err}");
        }
    }

    #[test]
    fn rpc_url_malformed_key_is_error_without_the_value() {
        let key = valid_key();
        let bad_values = [
            key[..35].to_string(),
            key.replacen('a', "g", 1),
            format!("{key}0"),
            key.replace('-', ""),
        ];
        for bad in &bad_values {
            let err = devnet_rpc_url_for(Some(bad)).unwrap_err();
            assert!(err.contains("niet de vorm van een Helius-sleutel"), "{err}");
            assert!(!err.contains(bad.as_str()), "de foutmelding mag de waarde niet bevatten");
            assert!(!err.contains(&bad[..8]), "de foutmelding mag geen deel van de waarde bevatten");
        }
    }

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
