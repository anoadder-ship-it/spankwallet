// Rust-poort van client/src/challenge.ts - de challenge-berekening verhuist
// hierheen (Tauri-migratie-ontwerp punt 1) zodat een gecompromitteerde
// webview-frontend het niet meer zelf kan bepalen. Gebruikt
// solana_sdk::keccak::hashv - dezelfde functiefamilie als
// programs/spankwallet/src/instructions.rs::build_expected_challenge()
// (regel 538-542) zelf gebruikt, geen losstaande Keccak-implementatie met
// het risico op een verkeerde variant (Keccak vs NIST-SHA3).

use solana_sdk::{keccak, pubkey::Pubkey};

pub const SPANKWALLET_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");

pub fn build_expected_challenge(wallet: &Pubkey, domain: &[u8], payload: &[u8]) -> [u8; 32] {
    keccak::hashv(&[SPANKWALLET_PROGRAM_ID.as_ref(), wallet.as_ref(), domain, payload]).0
}

pub fn action_nonce_le_bytes(nonce: u64) -> [u8; 8] {
    nonce.to_le_bytes()
}

// WalletAccount-layout (zie client/src/challenge.ts::readActionNonce): vaste
// prefix van 148 bytes (discriminator+seed_key+wallet_seed_hash+
// owner_passkey+bump+vault_bump+created_at+backup_authority), dan
// recovery_state: Option<RecoveryState> (tag + evt. 41 bytes),
// recovery_timelock_seconds: i64 (altijd 8 bytes, geen Option), dan
// deposit_authority: Option<Pubkey> (tag + evt. 32 bytes), dan pas
// action_nonce: u64. Borsh codeert Option::None als exact 1 tagbyte, dus
// een vast offset werkt niet - de tags moeten echt gelezen worden (zelfde
// valkuil als STATUS.md sectie 69 al vaststelde voor de TS-kant).
const OFFSET_RECOVERY_STATE_TAG: usize = 148;
const RECOVERY_STATE_LEN: usize = 41;

pub fn read_action_nonce(data: &[u8]) -> Result<u64, String> {
    let mut offset = OFFSET_RECOVERY_STATE_TAG;
    let recovery_state_tag = *data
        .get(offset)
        .ok_or_else(|| "WalletAccount-data te kort (recovery_state-tag)".to_string())?;
    offset += 1;
    if recovery_state_tag == 1 {
        offset += RECOVERY_STATE_LEN;
    }
    offset += 8; // recovery_timelock_seconds: i64, geen Option

    let deposit_authority_tag = *data
        .get(offset)
        .ok_or_else(|| "WalletAccount-data te kort (deposit_authority-tag)".to_string())?;
    offset += 1;
    if deposit_authority_tag == 1 {
        offset += 32;
    }

    let nonce_bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or_else(|| "WalletAccount-data te kort (action_nonce)".to_string())?
        .try_into()
        .unwrap();
    Ok(u64::from_le_bytes(nonce_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Testvector rechtstreeks gegenereerd met de bestaande, al-in-productie
    /// TS-implementatie (client/src/challenge.ts::buildExpectedChallenge),
    /// via node + @noble/hashes (dezelfde dependency die de browser-client
    /// al gebruikt) - geen aparte Rust-Keccak-implementatie vertrouwen op
    /// blind geloof, maar tegen de daadwerkelijke, al bewezen TS-uitvoer.
    #[test]
    fn matches_typescript_reference_implementation() {
        let wallet = Pubkey::new_from_array([0x11u8; 32]);
        let domain = b"execute";
        let action_nonce: u64 = 7;
        let recipient = Pubkey::new_from_array([0x22u8; 32]);
        let amount_lamports: u64 = 1_000_000_000;

        let mut payload = Vec::new();
        payload.extend_from_slice(&action_nonce_le_bytes(action_nonce));
        payload.extend_from_slice(recipient.as_ref());
        payload.extend_from_slice(&amount_lamports.to_le_bytes());

        let challenge = build_expected_challenge(&wallet, domain, &payload);

        // Gegenereerd met de daadwerkelijke, al-in-productie TS-code
        // (client/src/challenge.ts::buildExpectedChallenge via
        // @noble/hashes/sha3's keccak_256, dezelfde dependency als de
        // browser-client zelf gebruikt) tegen exact dezelfde wallet=0x11*32,
        // domain="execute", payload hieronder.
        let expected_hex = "0becf606d500dc0b3cf6aaf828e01f87240864eb4c035d0763137ba6e86f0270";
        assert_eq!(hex_encode(&challenge), expected_hex);
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn read_action_nonce_handles_all_option_combinations() {
        // recovery_state=None, deposit_authority=None (het gangbare geval)
        let mut data = vec![0u8; 148];
        data.push(0); // recovery_state tag = None
        data.extend_from_slice(&0i64.to_le_bytes()); // recovery_timelock_seconds
        data.push(0); // deposit_authority tag = None
        data.extend_from_slice(&42u64.to_le_bytes()); // action_nonce
        assert_eq!(read_action_nonce(&data).unwrap(), 42);

        // recovery_state=Some, deposit_authority=None
        let mut data2 = vec![0u8; 148];
        data2.push(1); // recovery_state tag = Some
        data2.extend_from_slice(&[0u8; 41]); // recovery_state-inhoud
        data2.extend_from_slice(&0i64.to_le_bytes());
        data2.push(0);
        data2.extend_from_slice(&99u64.to_le_bytes());
        assert_eq!(read_action_nonce(&data2).unwrap(), 99);

        // recovery_state=None, deposit_authority=Some
        let mut data3 = vec![0u8; 148];
        data3.push(0);
        data3.extend_from_slice(&0i64.to_le_bytes());
        data3.push(1); // deposit_authority tag = Some
        data3.extend_from_slice(&[0u8; 32]);
        data3.extend_from_slice(&123u64.to_le_bytes());
        assert_eq!(read_action_nonce(&data3).unwrap(), 123);
    }
}
