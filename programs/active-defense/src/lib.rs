use anchor_lang::prelude::*;

mod errors;
mod instructions;
mod state;

use instructions::*;

declare_id!("9W3CGKhd7hgywf3xfP8snNmB2AgmzwQ3rdDFDV3hUurK");

#[program]
pub mod active_defense {
    use super::*;

    pub fn create_poison_token(
        ctx: Context<CreatePoisonToken>,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::create_poison_token(ctx, client_action_nonce, client_data_json)
    }

    pub fn add_poison_authorized(
        ctx: Context<AddPoisonAuthorized>,
        recipient: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::add_poison_authorized(ctx, recipient, client_action_nonce, client_data_json)
    }

    pub fn remove_poison_authorized(
        ctx: Context<RemovePoisonAuthorized>,
        recipient: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::remove_poison_authorized(ctx, recipient, client_action_nonce, client_data_json)
    }

    pub fn poison_transfer_hook(ctx: Context<PoisonTransferHook>) -> Result<()> {
        instructions::poison_transfer_hook(ctx)
    }

    pub fn mark_malicious(
        ctx: Context<MarkMalicious>,
        address: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::mark_malicious(ctx, address, client_action_nonce, client_data_json)
    }

    pub fn unmark_malicious(
        ctx: Context<UnmarkMalicious>,
        address: Pubkey,
        client_action_nonce: u64,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::unmark_malicious(ctx, address, client_action_nonce, client_data_json)
    }
}
