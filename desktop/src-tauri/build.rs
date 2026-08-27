fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "setup_fee_payer",
            "unlock_fee_payer",
            "fee_payer_exists",
            "request_fee_payer_airdrop",
            "prepare_execute_challenge",
            "execute_action",
            "register_passkey",
            "sign_with_passkey",
        ])),
    )
    .expect("failed to run tauri-build");
}
