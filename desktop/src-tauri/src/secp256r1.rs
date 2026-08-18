// Rust-poort van client/src/secp256r1.ts. Anders dan de TS-kant (zelfgeschreven
// DER-parsing + precompile-byte-layout, want er was destijds geen geschikte
// library) gebruiken we hier de OFFICIËLE `solana-secp256r1-program`-crate
// voor de instructie-opbouw (identieke byte-semantiek, alleen een andere
// interne veldvolgorde - de precompile leest via de offsets-struct, niet via
// een aangenomen vaste volgorde, dus dat maakt geen verschil) en `p256`'s
// gevestigde DER-parsing/low-S-normalisatie i.p.v. een handmatige
// implementatie.

use p256::ecdsa::Signature as P256Signature;
use solana_sdk::instruction::Instruction;

/// WebAuthn/CTAP2-authenticators leveren een DER-gecodeerde ECDSA-
/// handtekening; Solana's secp256r1-precompile eist raw r||s (64 bytes) MET
/// low-S (s <= curve_order/2, ter voorkoming van signature malleability -
/// zie de crate's eigen doc-comment).
pub fn der_signature_to_raw_low_s(der: &[u8]) -> Result<[u8; 64], String> {
    let sig = P256Signature::from_der(der).map_err(|e| format!("ongeldige DER-handtekening: {e}"))?;
    let normalized = sig.normalize_s().unwrap_or(sig);
    let bytes = normalized.to_bytes();
    let arr: [u8; 64] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "onverwachte handtekening-lengte na normalisatie".to_string())?;
    Ok(arr)
}

pub fn build_secp256r1_instruction(
    compressed_pubkey: &[u8; 33],
    message: &[u8],
    raw_signature: &[u8; 64],
) -> Instruction {
    solana_secp256r1_program::new_secp256r1_instruction_with_signature(
        message,
        raw_signature,
        compressed_pubkey,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};
    use p256::ecdsa::signature::Verifier;

    #[test]
    fn der_to_raw_low_s_roundtrip_and_precompile_layout() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
        let verifying_key = *signing_key.verifying_key();
        let message = b"execute: test-bericht voor secp256r1-instructie-opbouw";

        let der_sig: P256Signature = signing_key.sign(message);
        let der_bytes = der_sig.to_der().as_bytes().to_vec();

        let raw = der_signature_to_raw_low_s(&der_bytes).unwrap();

        // De raw, low-S-genormaliseerde handtekening moet nog steeds
        // cryptografisch geldig zijn voor dezelfde publieke sleutel/bericht.
        let reconstructed = P256Signature::from_bytes((&raw).into()).unwrap();
        assert!(verifying_key.verify(message, &reconstructed).is_ok());

        // s moet daadwerkelijk <= curve_order/2 zijn na normalisatie.
        let s_bytes = &raw[32..64];
        let normalized_again = reconstructed.normalize_s();
        assert!(
            normalized_again.is_none(),
            "een reeds-genormaliseerde s zou niet nogmaals genormaliseerd moeten worden (was al low-S)"
        );
        let _ = s_bytes;

        let compressed_pubkey: [u8; 33] = verifying_key
            .to_encoded_point(true)
            .as_bytes()
            .try_into()
            .unwrap();

        let ix = build_secp256r1_instruction(&compressed_pubkey, message, &raw);
        assert_eq!(ix.program_id, solana_secp256r1_program::ID);
        assert!(ix.accounts.is_empty());
        // header(2) + offsets-struct(14) + pubkey(33) + signature(64) + message
        assert_eq!(ix.data.len(), 2 + 14 + 33 + 64 + message.len());
    }
}
