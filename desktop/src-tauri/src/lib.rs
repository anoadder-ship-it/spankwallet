mod challenge;
mod execute;
mod fee_payer;
mod passkey_ctap;
mod rpc;
mod secp256r1;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(fee_payer::FeePayerState::default())
        .invoke_handler(tauri::generate_handler![
            fee_payer::setup_fee_payer,
            fee_payer::unlock_fee_payer,
            fee_payer::fee_payer_exists,
            fee_payer::request_fee_payer_airdrop,
            execute::prepare_execute_challenge,
            execute::execute_action,
            passkey_ctap::register_passkey,
            passkey_ctap::sign_with_passkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
