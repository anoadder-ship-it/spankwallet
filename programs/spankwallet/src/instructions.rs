use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Token, TokenAccount};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use solana_keccak_hasher::hashv;

use crate::errors::SpankWalletError;
use crate::state::*;

pub const SECP256R1_PROGRAM_ID: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");

fn hash_seed_key(seed_key: &[u8; PASSKEY_PUBKEY_LEN]) -> [u8; 32] {
    let digest = solana_sha256_hasher::hash(seed_key.as_ref());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn sha256_32(data: &[u8]) -> [u8; 32] {
    let digest = solana_sha256_hasher::hash(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn base64url_decode(input: &[u8]) -> Result<Vec<u8>> {
    fn val(c: u8) -> Result<u8> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'-' => Ok(62),
            b'_' => Ok(63),
            _ => Err(SpankWalletError::WebAuthnChallengeMismatch.into()),
        }
    }

    let mut out = Vec::with_capacity(input.len() * 3 / 4 + 3);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0usize;

    for &byte in input {
        chunk[chunk_len] = val(byte)?;
        chunk_len += 1;
        if chunk_len == 4 {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
            out.push((chunk[2] << 6) | chunk[3]);
            chunk_len = 0;
        }
    }

    match chunk_len {
        0 => {}
        2 => out.push((chunk[0] << 2) | (chunk[1] >> 4)),
        3 => {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        _ => return Err(SpankWalletError::WebAuthnChallengeMismatch.into()),
    }

    Ok(out)
}

fn extract_webauthn_challenge(client_data_json: &[u8]) -> Result<Vec<u8>> {
    const NEEDLE: &[u8] = b"\"challenge\":\"";

    let start = client_data_json
        .windows(NEEDLE.len())
        .position(|w| w == NEEDLE)
        .ok_or(SpankWalletError::MissingWebAuthnChallenge)?
        + NEEDLE.len();

    let end = client_data_json[start..]
        .iter()
        .position(|&b| b == b'"')
        .ok_or(SpankWalletError::MissingWebAuthnChallenge)?
        + start;

    base64url_decode(&client_data_json[start..end])
}

// init_wallet

#[derive(Accounts)]
#[instruction(seed_key: [u8; PASSKEY_PUBKEY_LEN], wallet_seed_hash: [u8; 32])]
pub struct InitWallet<'info> {
    #[account(
        init,
        payer = payer,
        space = WalletAccount::LEN,
        seeds = [b"wallet", wallet_seed_hash.as_ref()],
        bump
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        init,
        payer = payer,
        space = VaultAccount::LEN,
        seeds = [b"vault", wallet.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_wallet(
    ctx: Context<InitWallet>,
    seed_key: [u8; PASSKEY_PUBKEY_LEN],
    wallet_seed_hash: [u8; 32],
    backup_authority: Pubkey,
    recovery_timelock_seconds: Option<i64>,
) -> Result<()> {
    require!(
        wallet_seed_hash == hash_seed_key(&seed_key),
        SpankWalletError::InvalidWalletSeedHash
    );

    let wallet = &mut ctx.accounts.wallet;
    let clock = Clock::get()?;

    wallet.seed_key = seed_key;
    wallet.wallet_seed_hash = wallet_seed_hash;
    wallet.owner_passkey = seed_key;
    wallet.bump = ctx.bumps.wallet;
    wallet.vault_bump = ctx.bumps.vault;
    wallet.created_at = clock.unix_timestamp;
    wallet.backup_authority = backup_authority;
    wallet.recovery_state = None;
    wallet.recovery_timelock_seconds =
        recovery_timelock_seconds.unwrap_or(DEFAULT_RECOVERY_TIMELOCK_SECONDS);
    wallet.deposit_authority = None;

    let vault = &mut ctx.accounts.vault;
    vault.wallet = wallet.key();
    vault.bump = ctx.bumps.vault;

    Ok(())
}

// secp256r1-precompile-parsing

const SIGNATURE_LEN: usize = 64;
const OFFSETS_STRUCT_LEN: usize = 14;
const HEADER_LEN: usize = 2;
const NO_OWN_INSTRUCTION: u16 = u16::MAX;

struct ParsedOffsets {
    signature_offset: u16,
    signature_instruction_index: u16,
    public_key_offset: u16,
    public_key_instruction_index: u16,
    message_data_offset: u16,
    message_data_size: u16,
    message_instruction_index: u16,
}

fn read_u16_le(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn parse_offsets(precompile_data: &[u8]) -> Result<ParsedOffsets> {
    require!(
        precompile_data.len() >= HEADER_LEN + OFFSETS_STRUCT_LEN,
        SpankWalletError::InvalidPasskeySignature
    );

    let num_signatures = precompile_data[0];
    require!(num_signatures >= 1, SpankWalletError::InvalidPasskeySignature);

    let base = HEADER_LEN;
    Ok(ParsedOffsets {
        signature_offset: read_u16_le(precompile_data, base)?,
        signature_instruction_index: read_u16_le(precompile_data, base + 2)?,
        public_key_offset: read_u16_le(precompile_data, base + 4)?,
        public_key_instruction_index: read_u16_le(precompile_data, base + 6)?,
        message_data_offset: read_u16_le(precompile_data, base + 8)?,
        message_data_size: read_u16_le(precompile_data, base + 10)?,
        message_instruction_index: read_u16_le(precompile_data, base + 12)?,
    })
}

fn resolve_instruction_data<'a>(
    ix_sysvar: &AccountInfo<'_>,
    index: u16,
    own_data: &'a [u8],
) -> Result<Vec<u8>> {
    if index == NO_OWN_INSTRUCTION {
        Ok(own_data.to_vec())
    } else {
        let ix = load_instruction_at_checked(index as usize, ix_sysvar)?;
        Ok(ix.data)
    }
}

fn verify_passkey_signature(
    ix_sysvar: &AccountInfo<'_>,
    expected_pubkey: &[u8; PASSKEY_PUBKEY_LEN],
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(ix_sysvar)?;
    require!(current_index > 0, SpankWalletError::InvalidPasskeySignature);

    let precompile_ix = load_instruction_at_checked((current_index - 1) as usize, ix_sysvar)?;
    require!(
        precompile_ix.program_id == SECP256R1_PROGRAM_ID,
        SpankWalletError::InvalidPasskeySignature
    );

    let offsets = parse_offsets(&precompile_ix.data)?;

    let pubkey_source =
        resolve_instruction_data(ix_sysvar, offsets.public_key_instruction_index, &precompile_ix.data)?;
    let pk_start = offsets.public_key_offset as usize;
    let pk_end = pk_start + PASSKEY_PUBKEY_LEN;
    let actual_pubkey = pubkey_source
        .get(pk_start..pk_end)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;
    require!(
        actual_pubkey == expected_pubkey.as_ref(),
        SpankWalletError::InvalidPasskeySignature
    );

    let message_source =
        resolve_instruction_data(ix_sysvar, offsets.message_instruction_index, &precompile_ix.data)?;
    let msg_start = offsets.message_data_offset as usize;
    let msg_end = msg_start + offsets.message_data_size as usize;
    let actual_message = message_source
        .get(msg_start..msg_end)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;

    require!(
        actual_message.len() >= 32,
        SpankWalletError::WebAuthnMessageHashMismatch
    );
    let client_data_hash = sha256_32(client_data_json);
    let message_hash_tail = &actual_message[actual_message.len() - 32..];
    require!(
        message_hash_tail == client_data_hash.as_slice(),
        SpankWalletError::WebAuthnMessageHashMismatch
    );

    let actual_challenge = extract_webauthn_challenge(client_data_json)?;
    require!(
        actual_challenge == expected_challenge,
        SpankWalletError::WebAuthnChallengeMismatch
    );

    let sig_source =
        resolve_instruction_data(ix_sysvar, offsets.signature_instruction_index, &precompile_ix.data)?;
    let sig_start = offsets.signature_offset as usize;
    require!(
        sig_source.len() >= sig_start + SIGNATURE_LEN,
        SpankWalletError::InvalidPasskeySignature
    );

    Ok(())
}

fn build_expected_challenge(wallet: &Pubkey, domain: &[u8], payload: &[u8]) -> Vec<u8> {
    hashv(&[crate::ID.as_ref(), wallet.as_ref(), domain, payload])
        .as_ref()
        .to_vec()
}

// execute

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn execute(
    ctx: Context<Execute>,
    cpi_instruction_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"execute",
        &cpi_instruction_data,
    );
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_challenge,
        &client_data_json,
    )?;

    Ok(())
}

// hunt

#[derive(Accounts)]
pub struct Hunt<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub target_token_account: Account<'info, TokenAccount>,

    /// CHECK: mint-account wordt alleen doorgegeven aan de SPL Token CPI (burn).
    pub token_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub rent_destination: SystemAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: zie Execute - passkey-verificatie via precompile.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn hunt(ctx: Context<Hunt>, client_data_json: Vec<u8>) -> Result<()> {
    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"hunt",
        ctx.accounts.target_token_account.key().as_ref(),
    );
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_challenge,
        &client_data_json,
    )?;

    let wallet_key = ctx.accounts.wallet.key();
    let seeds = &[b"vault".as_ref(), wallet_key.as_ref(), &[ctx.accounts.vault.bump]];
    let signer_seeds = &[&seeds[..]];

    let balance = ctx.accounts.target_token_account.amount;
    if balance > 0 {
        let burn_ctx = CpiContext::new_with_signer(
            Token::id(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.target_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::burn(burn_ctx, balance)?;
    }

    let close_ctx = CpiContext::new_with_signer(
        Token::id(),
        CloseAccount {
            account: ctx.accounts.target_token_account.to_account_info(),
            destination: ctx.accounts.rent_destination.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::close_account(close_ctx)?;

    Ok(())
}

// recovery-flow

#[derive(Accounts)]
pub struct InitiateRecovery<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(address = wallet.backup_authority @ SpankWalletError::InvalidBackupAuthoritySignature)]
    pub backup_authority: Signer<'info>,
}

pub fn initiate_recovery(
    ctx: Context<InitiateRecovery>,
    new_owner_passkey: [u8; PASSKEY_PUBKEY_LEN],
) -> Result<()> {
    let clock = Clock::get()?;
    ctx.accounts.wallet.recovery_state = Some(RecoveryState {
        initiated_at: clock.unix_timestamp,
        new_owner_passkey,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelRecovery<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_some() @ SpankWalletError::NoRecoveryInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: veto door de HUIDIGE owner_passkey - via precompile, net als execute.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn cancel_recovery(ctx: Context<CancelRecovery>, client_data_json: Vec<u8>) -> Result<()> {
    let recovery = ctx
        .accounts
        .wallet
        .recovery_state
        .ok_or(SpankWalletError::NoRecoveryInProgress)?;
    let mut payload = Vec::with_capacity(8 + PASSKEY_PUBKEY_LEN);
    payload.extend_from_slice(&recovery.initiated_at.to_le_bytes());
    payload.extend_from_slice(&recovery.new_owner_passkey);

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"cancel_recovery", &payload);
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_challenge,
        &client_data_json,
    )?;
    ctx.accounts.wallet.recovery_state = None;
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeRecovery<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_some() @ SpankWalletError::NoRecoveryInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,
}

pub fn finalize_recovery(ctx: Context<FinalizeRecovery>) -> Result<()> {
    let wallet = &mut ctx.accounts.wallet;
    let recovery = wallet
        .recovery_state
        .ok_or(SpankWalletError::NoRecoveryInProgress)?;

    let clock = Clock::get()?;
    let elapsed = clock.unix_timestamp - recovery.initiated_at;
    require!(
        elapsed >= wallet.recovery_timelock_seconds,
        SpankWalletError::RecoveryTimelockNotElapsed
    );

    wallet.owner_passkey = recovery.new_owner_passkey;
    wallet.recovery_state = None;
    Ok(())
}
