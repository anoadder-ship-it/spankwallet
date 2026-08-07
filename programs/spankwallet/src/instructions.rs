use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Token, TokenAccount};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use solana_keccak_hasher::hashv;

use crate::errors::SpankWalletError;
use crate::state::*;

/// Officieel adres van het secp256r1-precompile-programma, sinds SIMD-0075.
pub const SECP256R1_PROGRAM_ID: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");

/// Hasht een 33-byte gecomprimeerde secp256r1-sleutel naar exact 32 bytes,
/// voor gebruik als PDA-seed. Solana's PDA-seeds hebben een harde limiet van
/// 32 bytes per los seed-component (MAX_SEED_LEN) — de ruwe 33-byte sleutel
/// zelf overschrijdt die limiet met 1 byte en kan dus NOOIT direct als seed
/// dienen. Ontdekt als kritieke bug bij de eerste TS-clienttest (zie README).
fn hash_seed_key(seed_key: &[u8; PASSKEY_PUBKEY_LEN]) -> [u8; 32] {
    let digest = solana_sha256_hasher::hash(seed_key.as_ref());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

// ---------------------------------------------------------------------------
// init_wallet
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(seed_key: [u8; PASSKEY_PUBKEY_LEN], wallet_seed_hash: [u8; 32])]
pub struct InitWallet<'info> {
    #[account(
        init,
        payer = payer,
        space = WalletAccount::LEN,
        // Bewust GEEN functie-aanroep hier (bv. hash_seed_key(&seed_key)) —
        // Anchor's aparte idl-build compilatiepas (voor TS-typegeneratie) kan
        // berekende seeds die instructie-argumenten gebruiken niet statisch
        // analyseren en verliest daarbij de scope van seed_key volledig
        // (E0425, ontdekt bij de eerste `anchor test`-run, zie README).
        // wallet_seed_hash is daarom een eigen, direct instructie-argument;
        // de handler-body verifieert on-chain dat hij echt bij seed_key hoort.
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

    /// Betaalt de account-creatie. In de extension is dit doorgaans hetzelfde
    /// keypair dat ook de eerste SOL-storting doet — geen relayer/paymaster
    /// nodig in fase 1 (zie ontwerpdocument §2, punt 1: geen hosted derde partij).
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
    // Consistentiecheck: de client berekent wallet_seed_hash zelf (nodig voor
    // de seeds-macro-beperking hierboven), maar het programma vertrouwt dat
    // niet blindelings — een verkeerde hash zou de gebruiker later zijn eigen
    // wallet niet meer laten terugvinden. Geen cross-user beveiligingsrisico
    // (iedereen kiest zijn eigen seed_key/hash-paar), maar wel gebruikersfout
    // die we hier hard afvangen.
    require!(
        wallet_seed_hash == hash_seed_key(&seed_key),
        SpankWalletError::InvalidWalletSeedHash
    );

    let wallet = &mut ctx.accounts.wallet;
    let clock = Clock::get()?;

    wallet.seed_key = seed_key;
    wallet.wallet_seed_hash = wallet_seed_hash;
    wallet.owner_passkey = seed_key; // bij aanmaak identiek; owner_passkey muteert later bij recovery, seed_key nooit
    wallet.bump = ctx.bumps.wallet;
    wallet.vault_bump = ctx.bumps.vault;
    wallet.created_at = clock.unix_timestamp;
    wallet.backup_authority = backup_authority;
    wallet.recovery_state = None;
    wallet.recovery_timelock_seconds =
        recovery_timelock_seconds.unwrap_or(DEFAULT_RECOVERY_TIMELOCK_SECONDS);
    wallet.deposit_authority = None; // fase 1: permissionless deposits, zie §3.3

    let vault = &mut ctx.accounts.vault;
    vault.wallet = wallet.key();
    vault.bump = ctx.bumps.vault;

    Ok(())
}

// ---------------------------------------------------------------------------
// secp256r1-precompile-parsing (SIMD-0075) + message-binding
// ---------------------------------------------------------------------------
//
// Wire-layout van de Secp256r1SigVerify-instructiedata (little-endian):
//   byte 0            : num_signatures (u8)
//   byte 1            : padding (u8)
//   per signature (14 bytes):
//     signature_offset             u16
//     signature_instruction_index  u16  (0xFFFF = huidige instructie)
//     public_key_offset            u16
//     public_key_instruction_index u16
//     message_data_offset          u16
//     message_data_size            u16
//     message_instruction_index    u16
//   daarna: signature (64B) / public key (33B) / message-bytes, doorgaans
//   inline in dezelfde instructie als de offsets-struct.
//
// Bron: solana-improvement-documents SIMD-0075, secp256r1-precompile.

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

    // Alleen de eerste handtekening in de instructie wordt ondersteund —
    // execute/cancel_recovery/etc. gebruiken telkens één passkey-handtekening
    // per aanroep. Meerdere signatures in één precompile-instructie zijn
    // buiten scope voor fase 1.
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

/// Haalt de data van de instructie op waar `index` naar wijst, met 0xFFFF
/// als conventie voor "deze instructie zelf" (zie Solana precompile-docs,
/// zelfde patroon als bij het ed25519-precompile).
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

/// Verifieert dat de instructie direct vóór de huidige (current_index - 1)
/// een geldige secp256r1-precompile-aanroep is, met:
///   1. het juiste programma-ID (Secp256r1SigVerify1111111111111111111111111)
///   2. public key exact gelijk aan `expected_pubkey`
///   3. het ondertekende bericht exact gelijk aan `expected_message` — dit is
///      de binding die in de vorige versie ontbrak: zonder deze check zou een
///      geldige handtekening op willekeurig welk bericht hergebruikt kunnen
///      worden voor elke instructie die dezelfde owner_passkey verwacht.
fn verify_passkey_signature(
    ix_sysvar: &AccountInfo<'_>,
    expected_pubkey: &[u8; PASSKEY_PUBKEY_LEN],
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(ix_sysvar)?;
    require!(current_index > 0, SpankWalletError::InvalidPasskeySignature);

    let precompile_ix = load_instruction_at_checked((current_index - 1) as usize, ix_sysvar)?;
    require!(
        precompile_ix.program_id == SECP256R1_PROGRAM_ID,
        SpankWalletError::InvalidPasskeySignature
    );

    let offsets = parse_offsets(&precompile_ix.data)?;

    // Publieke sleutel ophalen en vergelijken.
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

    // Bericht ophalen en vergelijken — dit is de binding aan de specifieke
    // instructie-aanroep (replay-bescherming over instructies heen).
    let message_source =
        resolve_instruction_data(ix_sysvar, offsets.message_instruction_index, &precompile_ix.data)?;
    let msg_start = offsets.message_data_offset as usize;
    let msg_end = msg_start + offsets.message_data_size as usize;
    let actual_message = message_source
        .get(msg_start..msg_end)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;
    require!(
        actual_message == expected_message,
        SpankWalletError::InvalidPasskeySignature
    );

    // Sanity-check dat er daadwerkelijk 64 bytes handtekening op de
    // opgegeven offset staan (de precompile zelf heeft de wiskundige
    // geldigheid al geverifieerd vóórdat deze instructie draait — dat is
    // exact het punt van een precompile: als de transactie deze instructie
    // bereikt, is de curve-wiskunde al gevalideerd door de validator, wij
    // hoeven alleen te controleren WELKE sleutel en WELK bericht).
    let sig_source =
        resolve_instruction_data(ix_sysvar, offsets.signature_instruction_index, &precompile_ix.data)?;
    let sig_start = offsets.signature_offset as usize;
    require!(
        sig_source.len() >= sig_start + SIGNATURE_LEN,
        SpankWalletError::InvalidPasskeySignature
    );

    Ok(())
}

/// Bindt een handtekening aan deze specifieke wallet + actie + payload, zodat
/// een geldige passkey-handtekening niet herbruikt kan worden voor een andere
/// instructie of een andere wallet. `domain` onderscheidt instructietypes
/// (bv. b"execute" vs b"cancel_recovery") zodat een handtekening voor de ene
/// actie niet voor de andere geldig is.
fn build_expected_message(wallet: &Pubkey, domain: &[u8], payload: &[u8]) -> Vec<u8> {
    hashv(&[crate::ID.as_ref(), wallet.as_ref(), domain, payload])
        .as_ref()
        .to_vec()
}

// ---------------------------------------------------------------------------
// execute — generieke "spending"-instructie
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        // recovery_state moet leeg zijn: tijdens een lopend herstelverzoek
        // wordt dagelijks spenden bevroren, zodat een aanvaller die het
        // recovery-tijdslot heeft gestart niet ondertussen ook nog kan
        // leegtrekken via de nog-actieve oude passkey.
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via
    /// een Anchor Signer-check — een passkey is geen Ed25519-keypair dat
    /// Solana's normale transactie-handtekeningen kan zetten.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// `cpi_instruction_data` bevat de door de client opgebouwde payload voor de
/// onderliggende actie (transfer, swap, etc.). De exacte CPI-routing (welk
/// extern programma, welke accounts) wordt in de implementatiefase verder
/// uitgewerkt — dit is bewust een dunne, generieke doorgeefinstructie zodat
/// het programma zelf klein en auditeerbaar blijft (zie §2, punt 3).
///
/// De client moet de passkey exact `build_expected_message(wallet, b"execute",
/// cpi_instruction_data)` laten ondertekenen — niet de ruwe payload zelf —
/// zodat een handtekening niet voor een andere wallet of ander domain herbruikt
/// kan worden.
pub fn execute(ctx: Context<Execute>, cpi_instruction_data: Vec<u8>) -> Result<()> {
    let expected_message = build_expected_message(
        &ctx.accounts.wallet.key(),
        b"execute",
        &cpi_instruction_data,
    );
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_message,
    )?;

    // TODO: bouw en verstuur de daadwerkelijke CPI via invoke_signed met
    // de vault-PDA-seeds als authority. Placeholder tot de eerste concrete
    // use-case (SOL-transfer) is uitgewerkt en getest.
    Ok(())
}

// ---------------------------------------------------------------------------
// hunt — burn + close van client-side geclassificeerde spam-accounts
// ---------------------------------------------------------------------------

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

    /// Het token-account dat de client als spam heeft geclassificeerd
    /// (v0.2 §4 — classificatielogica is client-side, deze instructie
    /// voert alleen de daadwerkelijke on-chain actie uit).
    #[account(mut)]
    pub target_token_account: Account<'info, TokenAccount>,

    /// CHECK: mint-account wordt alleen doorgegeven aan de SPL Token CPI
    /// (burn), die zelf valideert dat mint bij target_token_account hoort.
    pub token_mint: UncheckedAccount<'info>,

    /// SOL/rent uit gesloten accounts komt terug naar de vault, niet naar
    /// een willekeurige aanroeper — voorkomt dat "hunt" misbruikt wordt als
    /// manier om rent van andermans wallet te claimen.
    #[account(mut)]
    pub rent_destination: SystemAccount<'info>,

    /// CHECK: zie Execute — passkey-verificatie via precompile.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn hunt(ctx: Context<Hunt>) -> Result<()> {
    let expected_message = build_expected_message(
        &ctx.accounts.wallet.key(),
        b"hunt",
        ctx.accounts.target_token_account.key().as_ref(),
    );
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_message,
    )?;

    let vault_key = ctx.accounts.vault.key();
    let wallet_key = ctx.accounts.wallet.key();
    let seeds = &[b"vault".as_ref(), wallet_key.as_ref(), &[ctx.accounts.vault.bump]];
    let signer_seeds = &[&seeds[..]];

    let balance = ctx.accounts.target_token_account.amount;
    if balance > 0 {
        // Anchor 1.0-breaking-change: CpiContext::new(_with_signer) neemt sinds
        // v1.0.0 een Pubkey (het programma-ID) in plaats van de AccountInfo van
        // het programma — de oude redundante `program`-veldkopie is verwijderd.
        // Zie release notes 1.0.0.
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

    let _ = vault_key;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recovery-flow (v0.2 §3.1a)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitiateRecovery<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// De offline backup-authority moet dit als normale Ed25519 Signer
    /// ondertekenen (het is een gewoon keypair, geen passkey) — dus hier
    /// géén precompile-omweg nodig, gewone Anchor Signer-check volstaat.
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
    // TODO fase 1 §3.1b: emit! een event hier zodat het notificatie-endpoint
    // dit kan oppikken en de watcher-mail kan versturen. Vorm (polling vs.
    // webhook-relay) wordt in implementatiefase bepaald, zie ontwerpdocument.
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

    /// CHECK: veto door de HUIDIGE owner_passkey — via precompile, net als execute.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn cancel_recovery(ctx: Context<CancelRecovery>) -> Result<()> {
    // Bericht wordt gebonden aan de specifieke lopende RecoveryState
    // (initiated_at + new_owner_passkey), zodat een cancel-handtekening niet
    // per ongeluk een latere, andere recovery-poging zou kunnen annuleren
    // via een hergebruikte oude handtekening.
    let recovery = ctx
        .accounts
        .wallet
        .recovery_state
        .ok_or(SpankWalletError::NoRecoveryInProgress)?;
    let mut payload = Vec::with_capacity(8 + PASSKEY_PUBKEY_LEN);
    payload.extend_from_slice(&recovery.initiated_at.to_le_bytes());
    payload.extend_from_slice(&recovery.new_owner_passkey);

    let expected_message =
        build_expected_message(&ctx.accounts.wallet.key(), b"cancel_recovery", &payload);
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &expected_message,
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
    // Permissionless (v0.2 §3.1a — "wie dan ook" mag na afloop van het
    // tijdslot finaliseren): geen Signer-account nodig.
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
