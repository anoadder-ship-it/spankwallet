// execute_action: Rust-poort van client/src/execute.ts, samengevoegd met de
// fee-payer-Stronghold-integratie (fee_payer.rs) en de challenge-/secp256r1-
// modules. Tweestaps-invoke()-patroon (Tauri-migratie-ontwerp,
// Stronghold-deelplan punt 4): prepare_execute_challenge berekent het
// challenge dat de webview aan navigator.credentials.get() moet aanbieden;
// execute_action herberekent dat challenge ONAFHANKELIJK uit dezelfde
// meegestuurde parameters en verifieert de respons daartegen VOORDAT er een
// transactie gebouwd/verstuurd wordt - dit is precies de defense-in-depth
// die het hoofdplan (punt 1) beschrijft: een gecompromitteerde webview kan
// de kaart-tekst proberen te vervalsen, maar niet meer zelf bepalen welke
// transactie daadwerkelijk verstuurd wordt.

use crate::challenge::{action_nonce_le_bytes, build_expected_challenge, read_action_nonce, SPANKWALLET_PROGRAM_ID};
use crate::fee_payer::{fee_payer_pubkey, sign_with_fee_payer, FeePayerState};
use crate::rpc::rpc_client;
use crate::secp256r1::{build_secp256r1_instruction, der_signature_to_raw_low_s};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use solana_sdk::{
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::Signature,
    sysvar,
    transaction::Transaction,
};
use std::str::FromStr;
use tauri::State;

const EXECUTE_DISCRIMINATOR: [u8; 8] = [0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d];

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum ExecuteError {
    InvalidPubkey(String),
    ChallengeMismatch,
    FeePayerNotUnlocked,
    InsufficientFeePayerBalance,
    RpcError(String),
    Internal(String),
}

impl From<crate::fee_payer::FeePayerError> for ExecuteError {
    fn from(e: crate::fee_payer::FeePayerError) -> Self {
        match e {
            crate::fee_payer::FeePayerError::NotSetUp => ExecuteError::FeePayerNotUnlocked,
            other => ExecuteError::Internal(format!("{other:?}")),
        }
    }
}

fn derive_vault_pda(wallet_pda: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", wallet_pda.as_ref()], &SPANKWALLET_PROGRAM_ID).0
}

fn derive_passkeys_pda(wallet_pda: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"passkeys", wallet_pda.as_ref()], &SPANKWALLET_PROGRAM_ID).0
}

fn parse_pubkey(label: &str, value: &str) -> Result<Pubkey, ExecuteError> {
    Pubkey::from_str(value).map_err(|_| ExecuteError::InvalidPubkey(format!("{label}: '{value}' is geen geldig Solana-adres")))
}

fn build_execute_payload(action_nonce: u64, recipient: &Pubkey, amount_lamports: u64) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + 32 + 8);
    payload.extend_from_slice(&action_nonce_le_bytes(action_nonce));
    payload.extend_from_slice(recipient.as_ref());
    payload.extend_from_slice(&amount_lamports.to_le_bytes());
    payload
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareExecuteChallengeResult {
    pub challenge_b64url: String,
    pub action_nonce: u64,
}

#[tauri::command]
pub fn prepare_execute_challenge(
    wallet_pda: String,
    recipient: String,
    amount_lamports: u64,
) -> Result<PrepareExecuteChallengeResult, ExecuteError> {
    let wallet_pubkey = parse_pubkey("wallet_pda", &wallet_pda)?;
    let recipient_pubkey = parse_pubkey("recipient", &recipient)?;

    let rpc = rpc_client();
    let account = rpc
        .get_account(&wallet_pubkey)
        .map_err(|e| ExecuteError::RpcError(e.to_string()))?;
    let action_nonce = read_action_nonce(&account.data).map_err(ExecuteError::Internal)?;

    let payload = build_execute_payload(action_nonce, &recipient_pubkey, amount_lamports);
    let challenge = build_expected_challenge(&wallet_pubkey, b"execute", &payload);

    Ok(PrepareExecuteChallengeResult {
        challenge_b64url: URL_SAFE_NO_PAD.encode(challenge),
        action_nonce,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteActionInput {
    pub wallet_pda: String,
    pub recipient: String,
    pub amount_lamports: u64,
    pub action_nonce: u64,
    /// Base64url, exact zoals credential.response.clientDataJSON - raw bytes.
    pub client_data_json_b64url: String,
    pub authenticator_data_b64url: String,
    /// DER-gecodeerde ECDSA-handtekening, exact zoals credential.response.signature.
    pub signature_der_b64url: String,
    /// 33-byte gecomprimeerde secp256r1-publieke sleutel van de passkey die
    /// tekende (niet noodzakelijk de owner_passkey - kan elke geregistreerde
    /// additional_passkey zijn, zelfde als de browser-client).
    pub passkey_compressed_pubkey_b64url: String,
}

#[derive(Serialize)]
pub struct ExecuteActionResult {
    pub signature: String,
}

#[tauri::command]
pub fn execute_action(
    input: ExecuteActionInput,
    fee_payer_state: State<'_, FeePayerState>,
) -> Result<ExecuteActionResult, ExecuteError> {
    let wallet_pubkey = parse_pubkey("wallet_pda", &input.wallet_pda)?;
    let recipient_pubkey = parse_pubkey("recipient", &input.recipient)?;
    let vault_pubkey = derive_vault_pda(&wallet_pubkey);
    let passkeys_pubkey = derive_passkeys_pda(&wallet_pubkey);

    let client_data_json = URL_SAFE_NO_PAD
        .decode(&input.client_data_json_b64url)
        .map_err(|e| ExecuteError::Internal(format!("client_data_json base64url: {e}")))?;
    let authenticator_data = URL_SAFE_NO_PAD
        .decode(&input.authenticator_data_b64url)
        .map_err(|e| ExecuteError::Internal(format!("authenticator_data base64url: {e}")))?;
    let signature_der = URL_SAFE_NO_PAD
        .decode(&input.signature_der_b64url)
        .map_err(|e| ExecuteError::Internal(format!("signature base64url: {e}")))?;
    let passkey_compressed_pubkey: [u8; 33] = URL_SAFE_NO_PAD
        .decode(&input.passkey_compressed_pubkey_b64url)
        .map_err(|e| ExecuteError::Internal(format!("passkey pubkey base64url: {e}")))?
        .try_into()
        .map_err(|_| ExecuteError::Internal("passkey-publieke-sleutel moet 33 bytes zijn".to_string()))?;

    // --- Onafhankelijke challenge-herberekening: de kern van de
    // defense-in-depth-laag (hoofdplan punt 1). Gebruikt UITSLUITEND de
    // parameters die de webview meestuurt, nooit een door de webview zelf
    // "al geverifieerd" beweerde waarde. ---
    let payload = build_execute_payload(input.action_nonce, &recipient_pubkey, input.amount_lamports);
    let expected_challenge = build_expected_challenge(&wallet_pubkey, b"execute", &payload);

    let client_data: serde_json::Value = serde_json::from_slice(&client_data_json)
        .map_err(|e| ExecuteError::Internal(format!("clientDataJSON is geen geldige JSON: {e}")))?;
    let actual_challenge_b64url = client_data
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ExecuteError::Internal("clientDataJSON.challenge ontbreekt".to_string()))?;
    let expected_challenge_b64url = URL_SAFE_NO_PAD.encode(expected_challenge);
    if actual_challenge_b64url != expected_challenge_b64url {
        return Err(ExecuteError::ChallengeMismatch);
    }

    // --- signed_message = authenticatorData || SHA256(clientDataJSON) -
    // gewone SHA-256 (niet Keccak, zie challenge.rs's doc-comment voor het
    // onderscheid) - dit IS wat de secp256r1-precompile daadwerkelijk
    // verifieert. ---
    let client_data_hash = solana_sdk::hash::hashv(&[&client_data_json]);
    let mut signed_message = Vec::with_capacity(authenticator_data.len() + 32);
    signed_message.extend_from_slice(&authenticator_data);
    signed_message.extend_from_slice(client_data_hash.as_ref());

    let raw_signature = der_signature_to_raw_low_s(&signature_der).map_err(ExecuteError::Internal)?;
    let secp256r1_ix = build_secp256r1_instruction(&passkey_compressed_pubkey, &signed_message, &raw_signature);

    let mut execute_data = Vec::new();
    execute_data.extend_from_slice(&EXECUTE_DISCRIMINATOR);
    execute_data.extend_from_slice(&input.amount_lamports.to_le_bytes());
    execute_data.extend_from_slice(&action_nonce_le_bytes(input.action_nonce));
    execute_data.extend_from_slice(&(client_data_json.len() as u32).to_le_bytes());
    execute_data.extend_from_slice(&client_data_json);

    let execute_ix = Instruction {
        program_id: SPANKWALLET_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(wallet_pubkey, false),
            AccountMeta::new(vault_pubkey, false),
            AccountMeta::new(recipient_pubkey, false),
            AccountMeta::new_readonly(passkeys_pubkey, false),
            AccountMeta::new_readonly(sysvar::instructions::ID, false),
        ],
        data: execute_data,
    };

    let fee_payer_pubkey_str = fee_payer_pubkey(&fee_payer_state)?;
    let fee_payer_pubkey_parsed = parse_pubkey("fee_payer", &fee_payer_pubkey_str)?;

    let rpc = rpc_client();
    let fee_payer_balance = rpc
        .get_balance(&fee_payer_pubkey_parsed)
        .map_err(|e| ExecuteError::RpcError(e.to_string()))?;
    // 5000 lamports is de standaard basis-fee per handtekening - een grove,
    // vroege check vóór we een dure RPC-round-trip riskeren; de daadwerkelijke
    // fee wordt hierna nog een keer door de RPC zelf gevalideerd.
    if fee_payer_balance < 5000 {
        return Err(ExecuteError::InsufficientFeePayerBalance);
    }

    let recent_blockhash: Hash = rpc
        .get_latest_blockhash()
        .map_err(|e| ExecuteError::RpcError(e.to_string()))?;

    let message = Message::new_with_blockhash(
        &[secp256r1_ix, execute_ix],
        Some(&fee_payer_pubkey_parsed),
        &recent_blockhash,
    );
    let message_bytes = message.serialize();
    let fee_payer_signature_bytes = sign_with_fee_payer(&fee_payer_state, message_bytes)?;

    let mut transaction = Transaction::new_unsigned(message);
    transaction.signatures = vec![Signature::from(fee_payer_signature_bytes)];

    let signature = rpc
        .send_and_confirm_transaction(&transaction)
        .map_err(|e| ExecuteError::RpcError(e.to_string()))?;

    Ok(ExecuteActionResult {
        signature: signature.to_string(),
    })
}
