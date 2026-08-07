use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod state;

use instructions::*;
use state::PASSKEY_PUBKEY_LEN;

// Placeholder — vervangen door de echte program-ID die `anchor keys list`
// genereert na de eerste lokale build. Ook bijwerken in Anchor.toml.
declare_id!("FGq7SbsLqjakC5W76mfPCXMiBYxkU7RLTbpackA34g3v");

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

    pub fn execute(ctx: Context<Execute>, cpi_instruction_data: Vec<u8>) -> Result<()> {
        instructions::execute(ctx, cpi_instruction_data)
    }

    pub fn hunt(ctx: Context<Hunt>) -> Result<()> {
        instructions::hunt(ctx)
    }

    pub fn initiate_recovery(
        ctx: Context<InitiateRecovery>,
        new_owner_passkey: [u8; PASSKEY_PUBKEY_LEN],
    ) -> Result<()> {
        instructions::initiate_recovery(ctx, new_owner_passkey)
    }

    pub fn cancel_recovery(ctx: Context<CancelRecovery>) -> Result<()> {
        instructions::cancel_recovery(ctx)
    }

    pub fn finalize_recovery(ctx: Context<FinalizeRecovery>) -> Result<()> {
        instructions::finalize_recovery(ctx)
    }
}
