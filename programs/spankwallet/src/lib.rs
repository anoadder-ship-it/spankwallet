use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod state;

use instructions::*;
use state::PASSKEY_PUBKEY_LEN;

// Upgrade-authority sinds STATUS.md sectie 42: een 2-of-3 Squads V4-multisig
// met 72u-timelock, niet meer een enkele sleutel - zie README.md's
// "Deployen naar devnet"-sectie voor het huidige upgradeproces.
declare_id!("9ma6vQVA71yUD6jqvyMuYXnMBYGoE7u9bTUbBYEMGBK9");

#[program]
pub mod spankwallet {
    use super::*;

    pub fn init_wallet(
        ctx: Context<InitWallet>,
        seed_key: [u8; PASSKEY_PUBKEY_LEN],
        wallet_seed_hash: [u8; 32],
        backup_authority: Pubkey,
        recovery_timelock_seconds: Option<i64>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::init_wallet(
            ctx,
            seed_key,
            wallet_seed_hash,
            backup_authority,
            recovery_timelock_seconds,
            client_data_json,
        )
    }

    pub fn execute(
        ctx: Context<Execute>,
        amount: u64,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::execute(ctx, amount, client_action_nonce, client_data_json)
    }

    pub fn transfer_token(
        ctx: Context<TransferToken>,
        amount: u64,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::transfer_token(ctx, amount, client_action_nonce, client_data_json)
    }

    pub fn add_allowed_program(
        ctx: Context<AddAllowedProgram>,
        program_id: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::add_allowed_program(ctx, program_id, client_action_nonce, client_data_json)
    }

    pub fn remove_allowed_program(
        ctx: Context<RemoveAllowedProgram>,
        program_id: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::remove_allowed_program(ctx, program_id, client_action_nonce, client_data_json)
    }

    pub fn execute_advanced<'info>(
        ctx: Context<'info, ExecuteAdvanced<'info>>,
        cpi_instruction_data: Vec<u8>,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_advanced(ctx, cpi_instruction_data, client_action_nonce, client_data_json)
    }

    pub fn hunt(
        ctx: Context<Hunt>,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::hunt(ctx, client_action_nonce, client_data_json)
    }

    pub fn add_passkey(
        ctx: Context<AddPasskey>,
        new_passkey: [u8; PASSKEY_PUBKEY_LEN],
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::add_passkey(ctx, new_passkey, client_action_nonce, client_data_json)
    }

    pub fn remove_passkey(
        ctx: Context<RemovePasskey>,
        target_passkey: [u8; PASSKEY_PUBKEY_LEN],
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::remove_passkey(ctx, target_passkey, client_action_nonce, client_data_json)
    }

    pub fn initiate_recovery(
        ctx: Context<InitiateRecovery>,
        new_owner_passkey: [u8; PASSKEY_PUBKEY_LEN],
    ) -> Result<()> {
        instructions::initiate_recovery(ctx, new_owner_passkey)
    }

    pub fn cancel_recovery(
        ctx: Context<CancelRecovery>,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::cancel_recovery(ctx, client_action_nonce, client_data_json)
    }

    pub fn finalize_recovery(ctx: Context<FinalizeRecovery>) -> Result<()> {
        instructions::finalize_recovery(ctx)
    }

    pub fn add_session_key(
        ctx: Context<AddSessionKey>,
        session_key: Pubkey,
        expiry_slot: u64,
        can_execute: bool,
        can_transfer_token: bool,
        can_execute_advanced: bool,
        session_allowed_programs: Vec<Pubkey>,
        max_lamports_per_tx: u64,
        max_lamports_total: u64,
        token_mint: Pubkey,
        max_token_amount_per_tx: u64,
        max_token_amount_total: u64,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::add_session_key(
            ctx,
            session_key,
            expiry_slot,
            can_execute,
            can_transfer_token,
            can_execute_advanced,
            session_allowed_programs,
            max_lamports_per_tx,
            max_lamports_total,
            token_mint,
            max_token_amount_per_tx,
            max_token_amount_total,
            client_action_nonce,
            client_data_json,
        )
    }

    pub fn remove_session_key(
        ctx: Context<RemoveSessionKey>,
        session_key: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::remove_session_key(ctx, session_key, client_action_nonce, client_data_json)
    }

    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> {
        instructions::close_session(ctx)
    }

    pub fn close_expired_session(
        ctx: Context<CloseExpiredSession>,
        session_key: Pubkey,
    ) -> Result<()> {
        instructions::close_expired_session(ctx, session_key)
    }

    pub fn execute_via_session(ctx: Context<ExecuteViaSession>, amount: u64) -> Result<()> {
        instructions::execute_via_session(ctx, amount)
    }

    pub fn transfer_token_via_session(
        ctx: Context<TransferTokenViaSession>,
        amount: u64,
    ) -> Result<()> {
        instructions::transfer_token_via_session(ctx, amount)
    }

    pub fn execute_advanced_via_session<'info>(
        ctx: Context<'info, ExecuteAdvancedViaSession<'info>>,
        cpi_instruction_data: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_advanced_via_session(ctx, cpi_instruction_data)
    }
}
