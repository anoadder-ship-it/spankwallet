use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use solana_keccak_hasher::hashv;

use crate::errors::ActiveDefenseError;
use crate::state::*;

pub const SECP256R1_PROGRAM_ID: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");
pub const PASSKEY_PUBKEY_LEN: usize = 33;

// --- Helpers (zelfde patroon als spankwallet) ---

fn sha256_32(data: &[u8]) -> [u8; 32] {
    let digest = solana_sha256_hasher::hash(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

fn validate_passkey_prefix(passkey: &[u8; PASSKEY_PUBKEY_LEN]) -> Result<()> {
    require!(
        passkey[0] == 0x02 || passkey[0] == 0x03,
        ActiveDefenseError::InvalidPasskeyPrefix
    );
    Ok(())
}

fn base64url_decode(input: &[u8]) -> Result<Vec<u8>> {
    fn val(c: u8) -> Result<u8> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'-' => Ok(62),
            b'_' => Ok(63),
            _ => Err(ActiveDefenseError::WebAuthnChallengeMismatch.into()),
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
        _ => return Err(ActiveDefenseError::WebAuthnChallengeMismatch.into()),
    }

    Ok(out)
}

fn extract_webauthn_challenge(client_data_json: &[u8]) -> Result<Vec<u8>> {
    const NEEDLE: &[u8] = b"\"challenge\":\"";

    let start = client_data_json
        .windows(NEEDLE.len())
        .position(|w| w == NEEDLE)
        .ok_or(ActiveDefenseError::MissingWebAuthnChallenge)?
        + NEEDLE.len();

    let end = client_data_json[start..]
        .iter()
        .position(|&b| b == b'"')
        .ok_or(ActiveDefenseError::MissingWebAuthnChallenge)?
        + start;

    base64url_decode(&client_data_json[start..end])
}

fn verify_webauthn_type(client_data_json: &[u8]) -> Result<()> {
    const NEEDLE: &[u8] = b"\"type\":\"webauthn.get\"";
    let found = client_data_json.windows(NEEDLE.len()).any(|w| w == NEEDLE);
    require!(found, ActiveDefenseError::InvalidWebAuthnType);
    Ok(())
}

const SIGNATURE_LEN: usize = 64;
const OFFSETS_STRUCT_LEN: usize = 14;
const HEADER_LEN: usize = 2;
const NO_OWN_INSTRUCTION: u16 = u16::MAX;
const AUTHENTICATOR_DATA_MIN_LEN: usize = 37;
const AUTHENTICATOR_DATA_FLAGS_OFFSET: usize = 32;
const AUTHENTICATOR_DATA_UV_FLAG: u8 = 0x04;

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
    let bytes = data.get(at..at + 2).ok_or(ActiveDefenseError::InvalidPasskeySignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn parse_offsets(precompile_data: &[u8]) -> Result<ParsedOffsets> {
    require!(
        precompile_data.len() >= HEADER_LEN + OFFSETS_STRUCT_LEN,
        ActiveDefenseError::InvalidPasskeySignature
    );
    let num_signatures = precompile_data[0];
    require!(num_signatures >= 1, ActiveDefenseError::InvalidPasskeySignature);
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

fn verify_passkey_signature_core(
    ix_sysvar: &AccountInfo<'_>,
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<[u8; PASSKEY_PUBKEY_LEN]> {
    let current_index = load_current_index_checked(ix_sysvar)?;
    require!(current_index > 0, ActiveDefenseError::InvalidPasskeySignature);

    let precompile_ix = load_instruction_at_checked((current_index - 1) as usize, ix_sysvar)?;
    require!(
        precompile_ix.program_id == SECP256R1_PROGRAM_ID,
        ActiveDefenseError::InvalidPasskeySignature
    );

    let offsets = parse_offsets(&precompile_ix.data)?;

    let pubkey_source =
        resolve_instruction_data(ix_sysvar, offsets.public_key_instruction_index, &precompile_ix.data)?;
    let pk_start = offsets.public_key_offset as usize;
    let pk_end = pk_start + PASSKEY_PUBKEY_LEN;
    let actual_pubkey_slice = pubkey_source
        .get(pk_start..pk_end)
        .ok_or(ActiveDefenseError::InvalidPasskeySignature)?;
    let mut actual_pubkey = [0u8; PASSKEY_PUBKEY_LEN];
    actual_pubkey.copy_from_slice(actual_pubkey_slice);

    let message_source =
        resolve_instruction_data(ix_sysvar, offsets.message_data_instruction_index, &precompile_ix.data)?;
    let msg_start = offsets.message_data_offset as usize;
    let msg_end = msg_start + offsets.message_data_size as usize;
    let actual_message = message_source
        .get(msg_start..msg_end)
        .ok_or(ActiveDefenseError::InvalidPasskeySignature)?;

    require!(
        actual_message.len() >= AUTHENTICATOR_DATA_MIN_LEN + 32,
        ActiveDefenseError::InvalidPasskeySignature
    );
    let client_data_hash = sha256_32(client_data_json);
    let message_hash_tail = &actual_message[actual_message.len() - 32..];
    require!(
        message_hash_tail == client_data_hash.as_slice(),
        ActiveDefenseError::WebAuthnChallengeMismatch
    );

    let flags = actual_message[AUTHENTICATOR_DATA_FLAGS_OFFSET];
    require!(
        flags & AUTHENTICATOR_DATA_UV_FLAG != 0,
        ActiveDefenseError::UserVerificationRequired
    );

    verify_webauthn_type(client_data_json)?;

    let actual_challenge = extract_webauthn_challenge(client_data_json)?;
    require!(
        actual_challenge == expected_challenge,
        ActiveDefenseError::WebAuthnChallengeMismatch
    );

    let sig_source =
        resolve_instruction_data(ix_sysvar, offsets.signature_instruction_index, &precompile_ix.data)?;
    let sig_start = offsets.signature_offset as usize;
    require!(
        sig_source.len() >= sig_start + SIGNATURE_LEN,
        ActiveDefenseError::InvalidPasskeySignature
    );

    Ok(actual_pubkey)
}

fn build_expected_challenge(wallet: &Pubkey, domain: &[u8], payload: &[u8]) -> Vec<u8> {
    hashv(&[crate::ID.as_ref(), wallet.as_ref(), domain, payload])
        .as_ref()
        .to_vec()
}

/// Verifieert een passkey-handtekening tegen de owner_passkey van de spankwallet.
/// Leest de owner_passkey uit het spankwallet WalletAccount (read-only).
fn verify_passkey_for_wallet(
    ix_sysvar: &AccountInfo<'_>,
    wallet_account_info: &AccountInfo<'_>,
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<()> {
    // Lees owner_passkey uit het spankwallet WalletAccount.
    // Layout: discriminator(8) + seed_key(33) + wallet_seed_hash(32) + owner_passkey(33) + ...
    let data = wallet_account_info.try_borrow_data()?;
    require!(data.len() >= 8 + 33 + 32 + 33, ActiveDefenseError::InvalidPasskeySignature);
    let mut owner_passkey = [0u8; PASSKEY_PUBKEY_LEN];
    owner_passkey.copy_from_slice(&data[8 + 33 + 32..8 + 33 + 32 + 33]);
    validate_passkey_prefix(&owner_passkey)?;

    let actual_pubkey = verify_passkey_signature_core(ix_sysvar, expected_challenge, client_data_json)?;
    require!(
        &actual_pubkey == &owner_passkey,
        ActiveDefenseError::InvalidPasskeySignature
    );
    Ok(())
}

// --- create_poison_token ---

#[derive(Accounts)]
pub struct CreatePoisonToken<'info> {
    /// CHECK: spankwallet WalletAccount PDA (read-only, we lezen owner_passkey).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = PoisonTokenAccount::LEN,
        seeds = [b"poison_token", wallet.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub poison_token: Account<'info, PoisonTokenAccount>,

    /// CHECK: de Token-2022 mint van het poison token.
    pub token_mint: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_poison_token(
    ctx: Context<CreatePoisonToken>,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&client_action_nonce.to_le_bytes());
    payload.extend_from_slice(ctx.accounts.token_mint.key().as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"create_poison_token", &payload);
    verify_passkey_for_wallet(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let pt = &mut ctx.accounts.poison_token;
    pt.wallet = ctx.accounts.wallet.key();
    pt.mint = ctx.accounts.token_mint.key();
    pt.bump = ctx.bumps.poison_token;
    pt.count = 0;
    pt.authorized_recipients = [Pubkey::default(); MAX_POISON_AUTHORIZED];
    pt.triggered = false;
    pt.triggered_at = 0;

    Ok(())
}

// --- add_poison_authorized ---

#[derive(Accounts)]
pub struct AddPoisonAuthorized<'info> {
    /// CHECK: spankwallet WalletAccount PDA (read-only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"poison_token", wallet.key().as_ref(), poison_token.mint.as_ref()],
        bump = poison_token.bump,
        constraint = !poison_token.triggered @ ActiveDefenseError::PoisonTokenAlreadyTriggered
    )]
    pub poison_token: Account<'info, PoisonTokenAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn add_poison_authorized(
    ctx: Context<AddPoisonAuthorized>,
    recipient: Pubkey,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&client_action_nonce.to_le_bytes());
    payload.extend_from_slice(recipient.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"add_poison_authorized", &payload);
    verify_passkey_for_wallet(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let pt = &mut ctx.accounts.poison_token;
    let already_present = pt.authorized_recipients[..pt.count as usize]
        .iter()
        .any(|r| *r == recipient);
    require!(!already_present, ActiveDefenseError::PoisonTokenRecipientAlreadyAuthorized);
    require!(
        (pt.count as usize) < MAX_POISON_AUTHORIZED,
        ActiveDefenseError::PoisonTokenAuthorizedListFull
    );

    let index = pt.count as usize;
    pt.authorized_recipients[index] = recipient;
    pt.count += 1;

    Ok(())
}

// --- remove_poison_authorized ---

#[derive(Accounts)]
pub struct RemovePoisonAuthorized<'info> {
    /// CHECK: spankwallet WalletAccount PDA (read-only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"poison_token", wallet.key().as_ref(), poison_token.mint.as_ref()],
        bump = poison_token.bump,
        constraint = !poison_token.triggered @ ActiveDefenseError::PoisonTokenAlreadyTriggered
    )]
    pub poison_token: Account<'info, PoisonTokenAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn remove_poison_authorized(
    ctx: Context<RemovePoisonAuthorized>,
    recipient: Pubkey,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&client_action_nonce.to_le_bytes());
    payload.extend_from_slice(recipient.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"remove_poison_authorized", &payload);
    verify_passkey_for_wallet(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let pt = &mut ctx.accounts.poison_token;
    let count = pt.count as usize;
    let index = pt.authorized_recipients[..count]
        .iter()
        .position(|r| *r == recipient)
        .ok_or(ActiveDefenseError::PoisonTokenRecipientNotAuthorized)?;

    let last = count - 1;
    pt.authorized_recipients[index] = pt.authorized_recipients[last];
    pt.authorized_recipients[last] = Pubkey::default();
    pt.count -= 1;

    Ok(())
}

// --- poison_transfer_hook (Token-2022 transfer hook) ---

#[derive(Accounts)]
pub struct PoisonTransferHook<'info> {
    #[account(
        mut,
        seeds = [b"poison_token", wallet.key().as_ref(), token_mint.key().as_ref()],
        bump = poison_token.bump,
    )]
    pub poison_token: Account<'info, PoisonTokenAccount>,

    /// CHECK: spankwallet WalletAccount PDA (read-only).
    pub wallet: UncheckedAccount<'info>,

    /// CHECK: de Token-2022 mint.
    pub token_mint: UncheckedAccount<'info>,

    /// CHECK: de destination token account (we lezen de owner).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

pub fn poison_transfer_hook(ctx: Context<PoisonTransferHook>) -> Result<()> {
    let pt = &mut ctx.accounts.poison_token;

    require!(!pt.triggered, ActiveDefenseError::PoisonTokenAlreadyTriggered);

    let dest_owner = ctx.accounts.destination.owner;

    let is_authorized = pt.authorized_recipients[..pt.count as usize]
        .iter()
        .any(|r| *r == dest_owner);

    if !is_authorized {
        let clock = Clock::get()?;
        pt.triggered = true;
        pt.triggered_at = clock.unix_timestamp;

        msg!("POISON_TOKEN_TRIGGERED: unauthorized transfer detected, token activated");
        return err!(ActiveDefenseError::PoisonTokenUnauthorizedRecipient);
    }

    Ok(())
}

// --- mark_malicious ---

#[derive(Accounts)]
pub struct MarkMalicious<'info> {
    /// CHECK: spankwallet WalletAccount PDA (read-only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = MaliciousAddressesAccount::LEN,
        seeds = [b"malicious", wallet.key().as_ref()],
        bump
    )]
    pub malicious: Account<'info, MaliciousAddressesAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn mark_malicious(
    ctx: Context<MarkMalicious>,
    address: Pubkey,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&client_action_nonce.to_le_bytes());
    payload.extend_from_slice(address.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"mark_malicious", &payload);
    verify_passkey_for_wallet(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let mal = &mut ctx.accounts.malicious;

    if mal.wallet == Pubkey::default() {
        mal.wallet = ctx.accounts.wallet.key();
        mal.bump = ctx.bumps.malicious;
        mal.count = 0;
        mal.addresses = [Pubkey::default(); MAX_MALICIOUS_ADDRESSES];
    }

    let already_present = mal.addresses[..mal.count as usize]
        .iter()
        .any(|a| *a == address);
    require!(!already_present, ActiveDefenseError::AddressAlreadyMalicious);
    require!(
        (mal.count as usize) < MAX_MALICIOUS_ADDRESSES,
        ActiveDefenseError::MaliciousListFull
    );

    let index = mal.count as usize;
    mal.addresses[index] = address;
    mal.count += 1;

    Ok(())
}

// --- unmark_malicious ---

#[derive(Accounts)]
pub struct UnmarkMalicious<'info> {
    /// CHECK: spankwallet WalletAccount PDA (read-only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"malicious", wallet.key().as_ref()],
        bump = malicious.bump,
    )]
    pub malicious: Account<'info, MaliciousAddressesAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn unmark_malicious(
    ctx: Context<UnmarkMalicious>,
    address: Pubkey,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&client_action_nonce.to_le_bytes());
    payload.extend_from_slice(address.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"unmark_malicious", &payload);
    verify_passkey_for_wallet(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let mal = &mut ctx.accounts.malicious;
    let count = mal.count as usize;
    let index = mal.addresses[..count]
        .iter()
        .position(|a| *a == address)
        .ok_or(ActiveDefenseError::AddressNotMalicious)?;

    let last = count - 1;
    mal.addresses[index] = mal.addresses[last];
    mal.addresses[last] = Pubkey::default();
    mal.count -= 1;

    Ok(())
}
