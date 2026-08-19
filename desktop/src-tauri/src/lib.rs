mod challenge;
mod execute;
mod fee_payer;
mod rpc;
mod secp256r1;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_webauthn::init())
        .manage(fee_payer::FeePayerState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            fee_payer::setup_fee_payer,
            fee_payer::unlock_fee_payer,
            fee_payer::fee_payer_exists,
            fee_payer::request_fee_payer_airdrop,
            execute::prepare_execute_challenge,
            execute::execute_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
