// Vervangt tauri-plugin-webauthn/mozilla-authenticator-rs als HID-backend
// van de passkey-ceremonie. Aanleiding (STATUS.md sectie 75, volledige
// onderzoekstrail): authenticator-rs (via het plugin, commit d997cb6) bleek
// structureel te hangen op deze machine binnen perform_register - bewezen
// met Rust-instrumentatie (eprintln! vlak vóór/na de manager-Mutex-lock en
// de perform_register-aanroep zelf: het proces hangt BINNEN
// perform_register, nooit terugkerend, geen paniek, geen timeout, ook niet
// als root). Twee onafhankelijke kanalen op DEZELFDE hardware (een rauwe
// hidraw open()+poll()-probe, en ctap-hid-fido2 - een volledig andere
// Rust-CTAP2-implementatie met een andere HID-backend dan authenticator-
// rs's eigen transport) toonden GEEN hang: schone, snelle, correcte
// CTAPHID_INIT-handshakes en betekenisvolle CTAP2-foutresponses.
//
// ctap-hid-fido2 is een eigen, from-scratch Rust-CTAP2-implementatie, GEEN
// libfido2-C-bindings-wrapper (geverifieerd tegen de crate's eigen
// Cargo.toml: hidapi met de linux-static-hidraw-feature, geen libfido2-
// sys/libusb). Provenance geverifieerd (STATUS.md sectie 75): crates.io
// sinds 2020-09-22, MIT-licentie, actief onderhouden, 58 GitHub-stars,
// `cargo audit` toont nul bekende RustSec-advisories over de volledige
// dependency-tree.
//
// KRITIEK DETAIL, expliciet vastgesteld tijdens onderzoek (STATUS.md sectie
// 75): deze crate bouwt zelf GEEN WebAuthn-clientDataJSON en biedt geen API
// om een kant-en-klare clientDataHash te injecteren - het hasht simpelweg
// wat je als "challenge" meegeeft (util::create_clientdata_hash). Daarom
// wordt hieronder de VOLLEDIGE clientDataJSON-byte-reeks als
// "challenge"-argument doorgegeven, niet de rauwe 32-byte-challenge - zodat
// de library exact SHA256(clientDataJSON) berekent, spec-conform en
// compatibel met execute.rs's onafhankelijke challenge-verificatie.
//
// PIN is altijd verplicht (nooit without_pin_and_uv()) - dit device
// ondersteunt geen ingebouwde UV (options.uv), alleen client-side
// PIN-verificatie via het pinUvAuthParam-mechanisme (empirisch bevestigd:
// CTAP2_ERR_UNSUPPORTED_OPTION bij uv:true, CTAP2_ERR_PIN_REQUIRED zonder
// pin) - dit is het CTAP2-equivalent van WebAuthn's userVerification:
// "required", nooit een stille fallback naar user-presence-only.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ctap_hid_fido2::{
    fidokey::{GetAssertionArgsBuilder, MakeCredentialArgsBuilder},
    public_key_credential_user_entity::PublicKeyCredentialUserEntity,
    Cfg, FidoKeyHid, FidoKeyHidFactory,
};
use rand::RngCore;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum PasskeyError {
    NoFidoKeyFound,
    DeviceError(String),
    Internal(String),
}

fn build_client_data_json(cred_type: &str, challenge_b64url: &str, origin: &str) -> Vec<u8> {
    // Veldnamen/-volgorde per WebAuthn L2 sectie 5.8.1 - execute.rs parseert
    // "challenge" generiek via serde_json::Value (veldvolgorde dus
    // functioneel niet kritiek), maar spec-conformiteit is bewust behouden.
    format!(
        "{{\"type\":\"{}\",\"challenge\":\"{}\",\"origin\":\"{}\",\"crossOrigin\":false}}",
        cred_type, challenge_b64url, origin
    )
    .into_bytes()
}

fn open_device() -> Result<FidoKeyHid, PasskeyError> {
    if ctap_hid_fido2::get_fidokey_devices().is_empty() {
        return Err(PasskeyError::NoFidoKeyFound);
    }
    let cfg = Cfg::init();
    FidoKeyHidFactory::create(&cfg).map_err(|e| PasskeyError::DeviceError(format!("{e}")))
}

fn compress_public_key(uncompressed_point: &[u8]) -> Result<[u8; 33], PasskeyError> {
    // ctap-hid-fido2's PublicKey.der is (ondanks de naam) voor EC2/P-256
    // geen echte X.509-DER, maar het rauwe SEC1-uncompressed-point:
    // 0x04 || X(32) || Y(32) = 65 bytes (encrypt/cose.rs::to_public_key_der,
    // geverifieerd in STATUS.md sectie 75). Zelfde compressie-logica als
    // client/src/passkey.ts en de vorige desktop/src/passkey.ts.
    if uncompressed_point.len() != 65 || uncompressed_point[0] != 0x04 {
        return Err(PasskeyError::Internal(format!(
            "onverwacht publieke-sleutelformaat: {} bytes, prefix 0x{:02x}",
            uncompressed_point.len(),
            uncompressed_point.first().copied().unwrap_or(0)
        )));
    }
    let x = &uncompressed_point[1..33];
    let y = &uncompressed_point[33..65];
    let y_is_odd = (y[31] & 1) == 1;
    let mut compressed = [0u8; 33];
    compressed[0] = if y_is_odd { 0x03 } else { 0x02 };
    compressed[1..].copy_from_slice(x);
    Ok(compressed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPasskeyResult {
    pub compressed_public_key_b64url: String,
    pub credential_id_b64url: String,
}

#[tauri::command]
pub fn register_passkey(
    rp_id: String,
    origin: String,
    user_name: String,
    pin: String,
) -> Result<RegisterPasskeyResult, PasskeyError> {
    let device = open_device()?;

    let mut challenge = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut challenge);
    let challenge_b64url = URL_SAFE_NO_PAD.encode(challenge);
    let client_data_json = build_client_data_json("webauthn.create", &challenge_b64url, &origin);

    let mut user_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut user_id);
    let user_entity =
        PublicKeyCredentialUserEntity::new(Some(&user_id), Some(&user_name), Some(&user_name));

    let make_credential_args = MakeCredentialArgsBuilder::new(&rp_id, &client_data_json)
        .pin(&pin)
        .user_entity(&user_entity)
        .build();

    let attestation = device
        .make_credential_with_args(&make_credential_args)
        .map_err(|e| PasskeyError::DeviceError(format!("{e}")))?;

    let compressed = compress_public_key(&attestation.credential_publickey.der)?;

    Ok(RegisterPasskeyResult {
        compressed_public_key_b64url: URL_SAFE_NO_PAD.encode(compressed),
        credential_id_b64url: URL_SAFE_NO_PAD.encode(&attestation.credential_descriptor.id),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignWithPasskeyResult {
    pub client_data_json_b64url: String,
    pub authenticator_data_b64url: String,
    pub signature_der_b64url: String,
}

#[tauri::command]
pub fn sign_with_passkey(
    rp_id: String,
    origin: String,
    credential_id_b64url: String,
    challenge_b64url: String,
    pin: String,
) -> Result<SignWithPasskeyResult, PasskeyError> {
    let device = open_device()?;

    let credential_id = URL_SAFE_NO_PAD
        .decode(&credential_id_b64url)
        .map_err(|e| PasskeyError::Internal(format!("credential_id base64url: {e}")))?;
    // challenge_b64url komt al kant-en-klaar van prepare_execute_challenge
    // (Rust-berekend, Keccak-256) - hier NIET opnieuw encoderen, exact
    // dezelfde string hergebruiken zodat execute_action's vergelijking
    // byte-voor-byte matcht.
    let client_data_json = build_client_data_json("webauthn.get", &challenge_b64url, &origin);

    let get_assertion_args = GetAssertionArgsBuilder::new(&rp_id, &client_data_json)
        .pin(&pin)
        .credential_id(&credential_id)
        .build();

    let assertion = device
        .get_assertion_with_args(&get_assertion_args)
        .map_err(|e| PasskeyError::DeviceError(format!("{e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| PasskeyError::Internal("geen assertion ontvangen".to_string()))?;

    Ok(SignWithPasskeyResult {
        client_data_json_b64url: URL_SAFE_NO_PAD.encode(&client_data_json),
        authenticator_data_b64url: URL_SAFE_NO_PAD.encode(&assertion.auth_data),
        signature_der_b64url: URL_SAFE_NO_PAD.encode(&assertion.signature),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compress_public_key_even_y() {
        let mut point = [0u8; 65];
        point[0] = 0x04;
        point[1] = 0xAB; // X[0]
        point[64] = 0x02; // Y laatste byte, even
        let compressed = compress_public_key(&point).unwrap();
        assert_eq!(compressed[0], 0x02);
        assert_eq!(compressed[1], 0xAB);
    }

    #[test]
    fn compress_public_key_odd_y() {
        let mut point = [0u8; 65];
        point[0] = 0x04;
        point[1] = 0xCD;
        point[64] = 0x03; // oneven
        let compressed = compress_public_key(&point).unwrap();
        assert_eq!(compressed[0], 0x03);
        assert_eq!(compressed[1], 0xCD);
    }

    #[test]
    fn compress_public_key_rejects_wrong_length() {
        let point = [0u8; 10];
        assert!(compress_public_key(&point).is_err());
    }

    #[test]
    fn client_data_json_contains_expected_fields() {
        let json_bytes = build_client_data_json("webauthn.get", "abc123", "http://localhost:1420");
        let value: serde_json::Value = serde_json::from_slice(&json_bytes).unwrap();
        assert_eq!(value["type"], "webauthn.get");
        assert_eq!(value["challenge"], "abc123");
        assert_eq!(value["origin"], "http://localhost:1420");
        assert_eq!(value["crossOrigin"], false);
    }
}
