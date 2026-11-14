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

// STATUS.md sectie 195: een RPC-fout mag de sleutel nooit naar de UI of een
// log brengen. De HTTP-bibliotheek onder de Solana-RPC-client zet bij een
// netwerkfout, time-out of HTTP-foutstatus de volledige URL, mét
// `?api-key=...`, in de fouttekst, en de RPC-client geeft die ongewijzigd
// door. Elke plek die een RPC-fout tot tekst maakt, gaat daarom via
// rpc_error_text(). De bibliotheek kan de URL ook zelf uit de fout halen
// (`without_url`), maar daarvoor moet deze crate het fouttype kunnen noemen,
// en dat vraagt een extra afhankelijkheid in Cargo.toml; zolang die er niet is,
// gebeurt alles hier op de tekst.
//
// Volgorde: (1) van elke http(s)-URL valt de query weg, (2) de waarde van elke
// api-key-parameter (ook URL-gecodeerd) wordt vervangen, (3) de sleutel van
// deze build zelf, hoofdletterongevoelig, en (4) elke waarde in sleutelvorm
// (UUID, ook met `%2D` als streepje). De functie geeft nooit paniek: er wordt
// alleen op ASCII-posities gesneden, en zonder sleutel in de build vallen
// alleen stap (3) weg.
const VERBORGEN: &str = "[verborgen]";

pub fn rpc_error_text<E: std::fmt::Display>(error: &E) -> String {
    redact_rpc_error_text(&error.to_string())
}

pub fn redact_rpc_error_text(text: &str) -> String {
    redact_with_key(text, HELIUS_API_KEY)
}

// §196: de laatste grens. Elke tekst in een foutenum die naar de frontend gaat
// (FeePayerError, ExecuteError, PasskeyError) wordt bij het serialiseren door
// de filter gehaald, via `#[serde(serialize_with = ...)]` op het veld. Zo kan
// een nieuwe foutroute die rpc_error_text() vergeet (bijvoorbeeld een `?` op
// een RPC-resultaat via een algemene From-impl) de sleutel niet naar de UI
// brengen. De vorm van de JSON (`{kind, message}`) blijft gelijk; de filter is
// idempotent, dus al schoongemaakte tekst verandert niet.
pub fn serialize_redacted<S: serde::Serializer>(text: &str, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&redact_rpc_error_text(text))
}

// §196: Debug-weergave van een foutvariant met tekst, schoongemaakt. Gebruikt
// door de handgeschreven Debug-impls van de foutenums, zodat ook `{:?}` (een
// paniektekst, een toekomstige log-regel, de conversie in execute.rs) de
// sleutel niet toont. Zelfde vorm als een afgeleide Debug: `Naam("tekst")`.
pub fn debug_redacted(f: &mut std::fmt::Formatter<'_>, variant: &str, text: &str) -> std::fmt::Result {
    f.debug_tuple(variant).field(&redact_rpc_error_text(text)).finish()
}

fn redact_with_key(text: &str, key: Option<&str>) -> String {
    let text = strip_url_queries(text);
    let text = redact_api_key_params(&text);
    let text = match key.map(str::trim) {
        Some(k) if !k.is_empty() => replace_ignore_ascii_case(&text, k),
        _ => text,
    };
    redact_key_shaped(&text)
}

fn find_ignore_ascii_case(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

fn starts_with_ignore_ascii_case(hay: &[u8], at: usize, needle: &[u8]) -> bool {
    hay.get(at..at + needle.len()).is_some_and(|s| s.eq_ignore_ascii_case(needle))
}

// Eén http(s)-URL eindigt bij witruimte, een afsluitend leesteken dat in
// foutteksten om een URL staat, of een niet-ASCII-byte.
fn is_url_end(b: u8) -> bool {
    b.is_ascii_whitespace() || !b.is_ascii() || matches!(b, b')' | b'(' | b'"' | b'\'' | b'<' | b'>' | b'[' | b']' | b'`')
}

fn starts_url_scheme(bytes: &[u8], at: usize) -> bool {
    starts_with_ignore_ascii_case(bytes, at, b"http://") || starts_with_ignore_ascii_case(bytes, at, b"https://")
}

// Lineair (§196): één voorwaartse scan. Eerder werd bij elke URL opnieuw naar
// http:// én https:// gezocht vanaf de huidige positie; ontbrak een van beide,
// dan liep die zoektocht telkens tot het einde (kwadratisch bij veel URL's).
// Het eerste schema vanaf `pos` is hetzelfde als het minimum van beide
// zoektochten, dus de uitvoer is gelijk.
fn strip_url_queries(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while pos < bytes.len() {
        let Some(start) = (pos..bytes.len()).find(|&i| starts_url_scheme(bytes, i)) else { break };
        let mut end = (start..bytes.len()).find(|&i| is_url_end(bytes[i])).unwrap_or(bytes.len());
        match (start..end).find(|&i| bytes[i] == b'?') {
            Some(q) => {
                out.push_str(&text[pos..q]);
                out.push('?');
                out.push_str(VERBORGEN);
                // Idempotent (§196): een al schoongemaakte URL eindigt op
                // `?[verborgen]` (de `[` sluit de URL af); die markering wordt
                // niet nog eens toegevoegd. Nodig omdat een tekst nu twee keer
                // door de filter kan gaan: bij het maken van de fout en bij het
                // serialiseren naar de frontend.
                if q + 1 == end && text[end..].starts_with(VERBORGEN) {
                    end += VERBORGEN.len();
                }
            }
            None => out.push_str(&text[pos..end]),
        }
        pos = end;
    }
    out.push_str(&text[pos..]);
    out
}

fn is_param_value_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'%')
}

fn redact_api_key_params(text: &str) -> String {
    const NAMES: [&[u8]; 5] = [b"api-key", b"api_key", b"apikey", b"api%2dkey", b"api%5fkey"];
    const EQUALS: [&[u8]; 2] = [b"=", b"%3d"];
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let value_start = NAMES.iter().find_map(|name| {
            if !starts_with_ignore_ascii_case(bytes, i, name) {
                return None;
            }
            let after = i + name.len();
            EQUALS
                .iter()
                .find(|eq| starts_with_ignore_ascii_case(bytes, after, eq))
                .map(|eq| after + eq.len())
        });
        match value_start {
            Some(vs) => {
                let ve = (vs..bytes.len()).find(|&j| !is_param_value_byte(bytes[j])).unwrap_or(bytes.len());
                out.push_str(&text[copied..vs]);
                if ve > vs {
                    out.push_str(VERBORGEN);
                }
                copied = ve;
                i = ve.max(i + 1);
            }
            None => i += 1,
        }
    }
    // `copied` staat altijd op een ASCII-positie of op het einde.
    out.push_str(&text[copied..]);
    out
}

fn replace_ignore_ascii_case(text: &str, key: &str) -> String {
    if !key.is_ascii() {
        return text.replace(key, VERBORGEN);
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while let Some(start) = find_ignore_ascii_case(bytes, key.as_bytes(), pos) {
        out.push_str(&text[pos..start]);
        out.push_str(VERBORGEN);
        pos = start + key.len();
    }
    out.push_str(&text[pos..]);
    out
}

// Lengte van een waarde in sleutelvorm (8-4-4-4-12 hex, streepje als `-` of
// `%2D`) die op `at` begint, of None.
fn key_shaped_len(bytes: &[u8], at: usize) -> Option<usize> {
    let mut i = at;
    for (n, group) in [8usize, 4, 4, 4, 12].iter().enumerate() {
        if n > 0 {
            if bytes.get(i) == Some(&b'-') {
                i += 1;
            } else if starts_with_ignore_ascii_case(bytes, i, b"%2d") {
                i += 3;
            } else {
                return None;
            }
        }
        let digits = bytes.get(i..i + group)?;
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        i += group;
    }
    Some(i - at)
}

fn redact_key_shaped(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        match key_shaped_len(bytes, i) {
            Some(len) => {
                out.push_str(&text[copied..i]);
                out.push_str(VERBORGEN);
                i += len;
                copied = i;
            }
            None => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
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

    // §195: rpc_error_text / redact_with_key. De foutteksten hieronder bootsen
    // de vorm na die de HTTP-bibliotheek gebruikt ("... for url (<url>)").
    fn assert_hidden(out: &str, key: &str) {
        assert!(!out.contains(key), "sleutel staat nog in de tekst");
        assert!(!out.to_lowercase().contains(&key[..8].to_lowercase()), "beginstuk staat nog in de tekst");
    }

    #[test]
    fn redact_hides_key_in_url_and_keeps_text_readable() {
        let key = valid_key();
        let text = format!(
            "error sending request for url (https://devnet.helius-rpc.com/?api-key={key}): operation timed out"
        );
        for configured in [None, Some(key.as_str())] {
            let out = redact_with_key(&text, configured);
            assert_hidden(&out, &key);
            assert_eq!(
                out,
                "error sending request for url (https://devnet.helius-rpc.com/?[verborgen]): operation timed out"
            );
        }
        let status = format!(
            "HTTP status client error (401 Unauthorized) for url (https://devnet.helius-rpc.com/?api-key={key}&x=1)"
        );
        let out = redact_with_key(&status, None);
        assert_hidden(&out, &key);
        assert!(out.contains("401 Unauthorized"), "{out}");
        assert!(out.contains("https://devnet.helius-rpc.com/"), "{out}");
    }

    #[test]
    fn redact_handles_uppercase_and_url_encoded_keys() {
        let key = valid_key();
        let upper = key.to_uppercase();
        let out = redact_with_key(&format!("HTTPS://DEVNET.HELIUS-RPC.COM/?API-KEY={upper} faalde"), Some(&key));
        assert_hidden(&out, &key);
        assert!(out.ends_with(" faalde"), "{out}");
        // URL-gecodeerd, zonder herkenbaar schema: de parameter en de
        // sleutelvorm met %2D als streepje worden beide gevangen.
        let encoded_key = key.replace('-', "%2D");
        let encoded = format!("proxy: https%3A%2F%2Fdevnet.helius-rpc.com%2F%3Fapi-key%3D{encoded_key} weigerde");
        let out = redact_with_key(&encoded, None);
        assert_hidden(&out, &key);
        assert!(!out.contains(&encoded_key[..8]), "{out}");
        assert!(out.ends_with(" weigerde"), "{out}");
        let loose = format!("sleutel {} los", key.to_uppercase().replace('-', "%2d"));
        let out = redact_with_key(&loose, None);
        assert_hidden(&out, &key);
        assert_eq!(out, "sleutel [verborgen] los");
    }

    #[test]
    fn redact_hides_configured_key_in_any_form_and_position() {
        // Ook een geconfigureerde sleutel die geen UUID-vorm heeft, en een
        // sleutel zonder URL of parameter ervoor.
        let odd = ["abc", "DEF", "1234", "xyz"].concat();
        let out = redact_with_key(&format!("waarde {odd} en {} hier", odd.to_lowercase()), Some(&odd));
        assert_eq!(out, "waarde [verborgen] en [verborgen] hier");
        let key = valid_key();
        let out = redact_with_key(&format!("los: {key}"), None);
        assert_hidden(&out, &key);
    }

    #[test]
    fn redact_leaves_text_without_key_unchanged() {
        for text in [
            "",
            "RPC response error -32002: Transaction simulation failed: Blockhash not found",
            "error sending request for url (https://devnet.helius-rpc.com/): connection refused",
            "Devnet-airdrop: 429 Too Many Requests",
            "één fout met niet-ASCII: café",
        ] {
            assert_eq!(redact_with_key(text, None), text);
            assert_eq!(redact_rpc_error_text(text), text);
        }
    }

    #[test]
    fn redact_never_panics_on_odd_input() {
        let key = valid_key();
        let inputs = [
            "https://".to_string(),
            "http://?".to_string(),
            "?api-key=".to_string(),
            "api-key".to_string(),
            "api-key%3".to_string(),
            "api%2Dkey%3D".to_string(),
            format!("é https://x/?a=é ü api-key=ö {}", &key[..20]),
            format!("{}%2", &key[..23]),
            "ééé".repeat(50),
            format!("https://x/é?{key}"),
        ];
        for input in &inputs {
            let _ = redact_with_key(input, Some(&key));
            let _ = redact_with_key(input, Some("   "));
            let _ = redact_with_key(input, Some("é"));
            let _ = redact_with_key(input, None);
        }
        // Na een niet-ASCII-teken in de URL hoort de rest niet meer bij de URL,
        // maar de sleutelvorm wordt alsnog gevangen.
        assert_hidden(&redact_with_key(&format!("https://x/é?{key}"), None), &key);
    }

    // §196: tienduizenden URL's in één tekst. Bewust geen tijdsgrens (die kan op
    // een trage machine omvallen); de kwadratische versie deed hier in een
    // testbuild minuten over, de lineaire is direct klaar. Gecontroleerd wordt de
    // volledige uitvoer.
    #[test]
    fn redact_handles_tens_of_thousands_of_urls() {
        let key = valid_key();
        let n = 40_000;
        let mut input = String::new();
        let mut expected = String::new();
        for i in 0..n {
            match i % 4 {
                0 => {
                    input += &format!("https://devnet.helius-rpc.com/?api-key={key} ");
                    expected += "https://devnet.helius-rpc.com/?[verborgen] ";
                }
                1 => {
                    input += "https://a ";
                    expected += "https://a ";
                }
                2 => {
                    input += &format!("(HTTP://x/{i}?q={i}) ");
                    expected += &format!("(HTTP://x/{i}?[verborgen]) ");
                }
                _ => {
                    input += "tekst é ";
                    expected += "tekst é ";
                }
            }
        }
        let out = redact_with_key(&input, Some(&key));
        assert_hidden(&out, &key);
        assert_eq!(out, expected);
        assert_eq!(out.matches("[verborgen]").count(), n / 2);
    }

    // §196: de filter is idempotent, zodat dubbel filteren (bij het maken van de
    // fout én bij het serialiseren) geen dubbele markering geeft.
    #[test]
    fn redact_is_idempotent() {
        let key = valid_key();
        let once = redact_with_key(
            &format!("for url (https://devnet.helius-rpc.com/?api-key={key}): x https://a/? y"),
            None,
        );
        assert_eq!(once, "for url (https://devnet.helius-rpc.com/?[verborgen]): x https://a/?[verborgen] y");
        assert_eq!(redact_with_key(&once, None), once);
        assert_eq!(redact_with_key(&once, Some(&key)), once);

        // Willekeurige invoer uit stukken die de filter raken (xorshift, vaste
        // start, geen extra afhankelijkheid).
        let pieces = [
            "http://", "HTTPS://", "?", "&", "=", "%", "api-key=", "API_KEY%3D", "%2D", "-", "/", " ", ")",
            "(", "\"", "[", "]", "[verborgen]", "é", "😀", "a", "0f", "x=1", "devnet.helius-rpc.com",
        ];
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move |n: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % n as u64) as usize
        };
        for _ in 0..20_000 {
            let mut input = String::new();
            for _ in 0..next(30) {
                match next(6) {
                    0 => input += &key,
                    1 => input += &key.to_uppercase().replace('-', "%2d"),
                    _ => input += pieces[next(pieces.len())],
                }
            }
            for configured in [None, Some(key.as_str())] {
                let once = redact_with_key(&input, configured);
                assert_eq!(redact_with_key(&once, configured), once, "niet idempotent");
                assert_hidden(&once, &key);
            }
        }
    }

    // §196: elke route waarlangs een fouttekst naar de frontend gaat, geeft
    // een schone tekst, ook als de tekst er ongefilterd in is gezet.
    fn leaky_text(key: &str) -> String {
        format!("error sending request for url (https://devnet.helius-rpc.com/?api-key={key}): operation timed out")
    }
    const CLEAN_TEXT: &str =
        "error sending request for url (https://devnet.helius-rpc.com/?[verborgen]): operation timed out";

    fn json_message(value: &impl serde::Serialize) -> (String, String) {
        let json = serde_json::to_value(value).unwrap();
        let obj = json.as_object().expect("foutenum serialiseert als object");
        assert_eq!(obj.len(), 2, "vorm {{kind, message}}: {json}");
        (obj["kind"].as_str().unwrap().to_string(), obj["message"].as_str().unwrap().to_string())
    }

    #[test]
    fn fee_payer_error_routes_are_redacted() {
        use crate::fee_payer::FeePayerError;
        let key = valid_key();
        // De algemene From-impl (de `?`-operator) voor elk fouttype.
        let from_any: FeePayerError = std::io::Error::other(leaky_text(&key)).into();
        match &from_any {
            FeePayerError::Internal(text) => assert_eq!(text, CLEAN_TEXT),
            other => panic!("onverwachte variant {other:?}"),
        }
        // Serialisatie naar de frontend, ook bij een ongefilterd ingezette tekst.
        for (err, kind) in [
            (FeePayerError::Io(leaky_text(&key)), "Io"),
            (FeePayerError::Internal(leaky_text(&key)), "Internal"),
            (from_any, "Internal"),
        ] {
            let (k, message) = json_message(&err);
            assert_eq!((k.as_str(), message.as_str()), (kind, CLEAN_TEXT));
            let debug = format!("{err:?}");
            assert_hidden(&debug, &key);
            assert_eq!(debug, format!("{kind}({CLEAN_TEXT:?})"));
        }
        // Varianten zonder tekst: vorm ongewijzigd.
        assert_eq!(serde_json::to_string(&FeePayerError::NotSetUp).unwrap(), r#"{"kind":"NotSetUp"}"#);
        assert_eq!(format!("{:?}", FeePayerError::AlreadySetUp), "AlreadySetUp");
        // Gewone tekst blijft gewone tekst, ook met aanhalingstekens.
        let plain = FeePayerError::Io("pad \"x\" bestaat niet".to_string());
        assert_eq!(serde_json::to_string(&plain).unwrap(), r#"{"kind":"Io","message":"pad \"x\" bestaat niet"}"#);
        assert_eq!(format!("{plain:?}"), r#"Io("pad \"x\" bestaat niet")"#);
    }

    #[test]
    fn execute_error_routes_are_redacted() {
        use crate::execute::ExecuteError;
        use crate::fee_payer::FeePayerError;
        let key = valid_key();
        // De conversie van FeePayerError (Debug-vorm) in execute.rs.
        for (inner, variant) in [
            (FeePayerError::Io(leaky_text(&key)), "Io"),
            (FeePayerError::Internal(leaky_text(&key)), "Internal"),
        ] {
            let converted = ExecuteError::from(inner);
            match &converted {
                ExecuteError::Internal(text) => assert_eq!(text, &format!("{variant}({CLEAN_TEXT:?})")),
                other => panic!("onverwachte variant {other:?}"),
            }
            let (kind, message) = json_message(&converted);
            assert_eq!(kind, "Internal");
            assert_hidden(&message, &key);
        }
        assert!(matches!(ExecuteError::from(FeePayerError::NotSetUp), ExecuteError::FeePayerNotUnlocked));
        // Serialisatie en Debug van elke variant met tekst.
        for (err, kind) in [
            (ExecuteError::InvalidPubkey(leaky_text(&key)), "InvalidPubkey"),
            (ExecuteError::RpcError(leaky_text(&key)), "RpcError"),
            (ExecuteError::Internal(leaky_text(&key)), "Internal"),
        ] {
            let (k, message) = json_message(&err);
            assert_eq!((k.as_str(), message.as_str()), (kind, CLEAN_TEXT));
            assert_eq!(format!("{err:?}"), format!("{kind}({CLEAN_TEXT:?})"));
        }
        // Al schoongemaakte tekst (de bestaande route via rpc_error_text) krijgt
        // geen tweede markering.
        let already = ExecuteError::RpcError(rpc_error_text(&std::io::Error::other(leaky_text(&key))));
        assert_eq!(json_message(&already).1, CLEAN_TEXT);
        assert_eq!(serde_json::to_string(&ExecuteError::ChallengeMismatch).unwrap(), r#"{"kind":"ChallengeMismatch"}"#);
    }

    #[test]
    fn passkey_error_routes_are_redacted() {
        use crate::passkey_ctap::PasskeyError;
        let key = valid_key();
        for (err, kind) in [
            (PasskeyError::DeviceError(leaky_text(&key)), "DeviceError"),
            (PasskeyError::Internal(leaky_text(&key)), "Internal"),
        ] {
            let (k, message) = json_message(&err);
            assert_eq!((k.as_str(), message.as_str()), (kind, CLEAN_TEXT));
            assert_eq!(format!("{err:?}"), format!("{kind}({CLEAN_TEXT:?})"));
        }
        assert_eq!(serde_json::to_string(&PasskeyError::NoFidoKeyFound).unwrap(), r#"{"kind":"NoFidoKeyFound"}"#);
    }

    #[test]
    fn rpc_error_text_uses_display_and_redacts() {
        let key = valid_key();
        let err = std::io::Error::other(format!("for url (https://devnet.helius-rpc.com/?api-key={key})"));
        let out = rpc_error_text(&err);
        assert_hidden(&out, &key);
        assert_eq!(out, "for url (https://devnet.helius-rpc.com/?[verborgen])");
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
        // Niet `expect`: die toont de fout met Debug, en daarin staat de URL met
        // de sleutel (§195). De paniektekst gaat via rpc_error_text().
        let slot = client
            .get_slot()
            .unwrap_or_else(|e| panic!("getSlot tegen echte devnet-RPC moet slagen: {}", rpc_error_text(&e)));
        assert!(slot > 0, "een geldige devnet-slot moet positief zijn");
    }
}
