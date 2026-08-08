use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod state;

use instructions::*;
use state::PASSKEY_PUBKEY_LEN;

declare_id!("4mE8U2TFRpDDPR3681KdPCwgQMVr2xhaMebvBp9gKW58");

#[program]
pub mod spankwallet {
    use super::*;

    pub fn init_wallet(
        ctx: Context<InitWallet>,
        seed_key: [u8; PASSKEY_PUBKEY_LEN],
        wallet_seed_hash: [u8; 32],
        backup_authority: Pubkey,
        recovery_timelock_seconds: Option<i64>,
    ) -> Result<()> {
        instructions::init_wallet(
            ctx,
            seed_key,
            wallet_seed_hash,
            backup_authority,
            recovery_timelock_seconds,
        )
    }

    pub fn execute(
        ctx: Context<Execute>,
        cpi_instruction_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::execute(ctx, cpi_instruction_data, client_data_json)
    }

    pub fn hunt(ctx: Context<Hunt>, client_data_json: Vec<u8>) -> Result<()> {
        instructions::hunt(ctx, client_data_json)
    }

    pub fn initiate_recovery(
        ctx: Context<InitiateRecovery>,
        new_owner_passkey: [u8; PASSKEY_PUBKEY_LEN],
    ) -> Result<()> {
        instructions::initiate_recovery(ctx, new_owner_passkey)
    }

    pub fn cancel_recovery(
        ctx: Context<CancelRecovery>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::cancel_recovery(ctx, client_data_json)
    }

    pub fn finalize_recovery(ctx: Context<FinalizeRecovery>) -> Result<()> {
        instructions::finalize_recovery(ctx)
    }
}
