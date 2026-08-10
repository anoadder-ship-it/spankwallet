use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Burn, CloseAccount, Token, TokenAccount, Transfer};
use solana_instructions_sysvar::{
    load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
};
use solana_keccak_hasher::hashv;

use crate::errors::SpankWalletError;
use crate::state::*;

/// De ECDSA-verificatie zelf (inclusief r/s-rangecontrole) gebeurt volledig
/// IN dit precompile-programma, voordat onze instructie ooit draait - zie
/// verify_passkey_signature hieronder voor wat WIJ daarna nog controleren
/// (dat de aanroep daadwerkelijk gebeurd is, met de juiste sleutel/bericht).
/// Van belang: Solana's secp256r1-precompile weigert ZELF elke handtekening
/// met een hoge S-waarde (s > curve_order/2) - de klassieke
/// signature-malleability-vector (dezelfde geldige handtekening in twee
/// vormen, s en n-s) bestaat hier dus structureel niet, afgedwongen door de
/// Solana-runtime zelf, niet door onze code. Geverifieerd in de daadwerkelijke
/// precompile-broncode (agave/precompiles/src/secp256r1.rs: `s_bignum <=
/// half_order` als harde eis, met een dedicated test `test_secp256r1_high_s`
/// die een hoge-S-handtekening laat falen met InvalidSignature). Dit geldt
/// voor ELKE transactie die deze precompile gebruikt, ongeacht clientgedrag -
/// client/src/secp256r1.ts's normalizeS() is daarom GEEN beveiligingsmaatregel
/// maar een functionele noodzaak (WebAuthn-assertions zijn niet gegarandeerd
/// laag-S, en zonder normalisatie zou ~50% van overigens geldige
/// handtekeningen simpelweg geweigerd worden door de precompile).
pub const SECP256R1_PROGRAM_ID: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");

/// Solana's algemeen erkende "dead address" - off-curve, geen bekende
/// private key, gebruikt in het hele ecosysteem om SOL permanent uit
/// omloop te halen. De helft van de door hunt teruggewonnen rent gaat
/// hierheen (deflatoir, komt alle SOL-houders ten goede) i.p.v. volledig
/// naar de hunter - maakt spammen kostbaar zonder een specifieke,
/// gecentraliseerde begunstigde te kiezen. Zie STATUS.md voor de motivatie.
pub const INCINERATOR: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

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

/// Valideert dat een secp256r1-publieke-sleutel-byte-array met een geldig
/// gecomprimeerd-punt-prefix begint (0x02 = even Y, 0x03 = oneven Y - de
/// twee enige geldige waarden per SEC1). Voorkomt dat een misvormde waarde
/// permanent vastgelegd wordt: bij init_wallet is dat vooral verspilde
/// rent, maar bij initiate_recoverys new_owner_passkey zou een ongeldige
/// waarde de wallet na finalize_recovery ONHERSTELBAAR vastzetten - geen
/// enkele handtekening kan ooit tegen ongeldige sleutelbytes valideren.
fn validate_passkey_prefix(passkey: &[u8; PASSKEY_PUBKEY_LEN]) -> Result<()> {
    require!(
        passkey[0] == 0x02 || passkey[0] == 0x03,
        SpankWalletError::InvalidPasskeyPrefix
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

/// Verifieert dat clientDataJSON "type":"webauthn.get" bevat (WebAuthn spec
/// §7.2, stap 3 van de assertion-verificatieprocedure) - voorkomt
/// cross-ceremony-typeverwarring, bijv. het (theoretisch) hergebruiken van
/// een attestation-ceremony-artefact ("webauthn.create") als assertie.
///
/// Zelfde substring-techniek en veiligheidsargument als
/// extract_webauthn_challenge hierboven, niet toevallig maar bewust: geen
/// volledige JSON-parser nodig, want client_data_json is al cryptografisch
/// gebonden aan wat de secp256r1-precompile daadwerkelijk ondertekende
/// (SHA-256-preimage-weerstand - zie verify_passkey_signature). "type" en
/// "origin" zijn bovendien nooit developer-controleerbaar (door de browser
/// zelf gezet, niet door de aanroepende pagina), en een correct
/// geserialiseerde JSON-string kan nooit een on-escaped aanhalingsteken
/// bevatten - er is dus geen manier om een vervalste "type":"..."-substring
/// te smokkelen via een andere veldwaarde in een legitiem geproduceerde
/// clientDataJSON. Zie STATUS.md voor de volledige analyse.
fn verify_webauthn_type(client_data_json: &[u8]) -> Result<()> {
    const NEEDLE: &[u8] = b"\"type\":\"webauthn.get\"";

    let found = client_data_json.windows(NEEDLE.len()).any(|w| w == NEEDLE);
    require!(found, SpankWalletError::InvalidWebAuthnType);

    Ok(())
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

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: passkey-verificatie via secp256r1-precompile, zie Execute.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Codeert Option<i64> als vaste 9 bytes (1 tag-byte + 8 waarde-bytes LE,
/// nul-gevuld bij None) - voor gebruik in de challenge-payload van
/// init_wallet. Vaste breedte i.p.v. Borsh-Vec-stijl-encodering omdat dit
/// puur voor challenge-binding dient, niet voor account-opslag.
fn encode_optional_i64(value: Option<i64>) -> [u8; 9] {
    let mut out = [0u8; 9];
    if let Some(v) = value {
        out[0] = 1;
        out[1..9].copy_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn init_wallet(
    ctx: Context<InitWallet>,
    seed_key: [u8; PASSKEY_PUBKEY_LEN],
    wallet_seed_hash: [u8; 32],
    backup_authority: Pubkey,
    recovery_timelock_seconds: Option<i64>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    require!(
        wallet_seed_hash == hash_seed_key(&seed_key),
        SpankWalletError::InvalidWalletSeedHash
    );
    validate_passkey_prefix(&seed_key)?;

    // Bewijs van bezit: voorkomt dat een aanvaller een onderschepte publieke
    // sleutel front-runt door zelf een init_wallet met EIGEN backup_authority
    // in te dienen voordat de rechtmatige eigenaar dat doet (STATUS.md sectie
    // 21, Bevinding C). De challenge bindt backup_authority en
    // recovery_timelock_seconds mee - zonder die binding zou een onderschepte
    // handtekening herbruikbaar zijn met een ANDERE backup_authority, wat
    // dezelfde overname-aanval in een net iets andere vorm terug zou brengen.
    let mut payload = Vec::with_capacity(32 + 9);
    payload.extend_from_slice(backup_authority.as_ref());
    payload.extend_from_slice(&encode_optional_i64(recovery_timelock_seconds));

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"init_wallet", &payload);
    verify_passkey_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &seed_key,
        &expected_challenge,
        &client_data_json,
    )?;

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

/// WebAuthn authenticatorData-layout (spec §6.1): rpIdHash(32) + flags(1) +
/// signCount(4) + [attestedCredentialData] + [extensions]. Voor een .get()-
/// assertie (geen attestedCredentialData/extensions) is dit de minimale
/// lengte - te kort betekent een misvormd of vervalst bericht, nooit een
/// echte assertie.
const AUTHENTICATOR_DATA_MIN_LEN: usize = 37;
/// Offset van de flags-byte binnen authenticatorData (direct na rpIdHash).
const AUTHENTICATOR_DATA_FLAGS_OFFSET: usize = 32;
/// User Verified-bit binnen de flags-byte (spec §6.1) - gezet zodra de
/// authenticator daadwerkelijk biometrie/PIN heeft geverifieerd, niet
/// slechts "aanwezigheid" (UP, bit 0x01).
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

/// Kernverificatie van de secp256r1-precompile-aanroep, ONAFHANKELIJK van
/// welke specifieke sleutel(s) toegestaan zijn - controleert uitsluitend dat
/// de precompile daadwerkelijk is aangeroepen, met een bericht dat
/// authenticatorData || SHA-256(clientDataJSON) is, met de juiste UV-vlag,
/// het juiste WebAuthn-type en de juiste challenge. Retourneert de
/// daadwerkelijk ondertekenende publieke sleutel zodat de aanroeper zelf
/// bepaalt of die geautoriseerd is: verify_passkey_signature hieronder doet
/// dat via een exacte match (init_wallet, waar nog geen WalletAccount/
/// PasskeysAccount bestaat), verify_passkey_signature_multi via de
/// meervoudige-sleutel-set (elke andere instructie, zie STATUS.md).
fn verify_passkey_signature_core(
    ix_sysvar: &AccountInfo<'_>,
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<[u8; PASSKEY_PUBKEY_LEN]> {
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
    let actual_pubkey_slice = pubkey_source
        .get(pk_start..pk_end)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;
    let mut actual_pubkey = [0u8; PASSKEY_PUBKEY_LEN];
    actual_pubkey.copy_from_slice(actual_pubkey_slice);

    let message_source =
        resolve_instruction_data(ix_sysvar, offsets.message_instruction_index, &precompile_ix.data)?;
    let msg_start = offsets.message_data_offset as usize;
    let msg_end = msg_start + offsets.message_data_size as usize;
    let actual_message = message_source
        .get(msg_start..msg_end)
        .ok_or(SpankWalletError::InvalidPasskeySignature)?;

    // Ondertekend bericht = authenticatorData || SHA-256(clientDataJSON)
    // (WebAuthn §6.3.3, hetzelfde als client/src/webauthnSign.ts opbouwt).
    // authenticatorData is minimaal AUTHENTICATOR_DATA_MIN_LEN (37) bytes bij
    // een .get()-assertie, dus het volledige bericht minimaal 37 + 32 = 69.
    // De oude grens (enkel >= 32) liet in theorie een LEGE authenticatorData
    // toe zolang er nog 32 bytes voor de hash overbleven - te zwak om
    // hieronder veilig de flags-byte op offset 32 uit te lezen.
    require!(
        actual_message.len() >= AUTHENTICATOR_DATA_MIN_LEN + 32,
        SpankWalletError::WebAuthnMessageHashMismatch
    );
    let client_data_hash = sha256_32(client_data_json);
    let message_hash_tail = &actual_message[actual_message.len() - 32..];
    require!(
        message_hash_tail == client_data_hash.as_slice(),
        SpankWalletError::WebAuthnMessageHashMismatch
    );

    // User Verification (UV) afdwingen op de authenticatorData-flags-byte.
    // Zonder deze check zou een authenticator die geen echte biometrie-/
    // PIN-bevestiging afdwingt alsnog een geldige handtekening kunnen
    // leveren voor elke spend- of policy-wijzigende actie - de client vraagt
    // userVerification: "required" aan (webauthnSign.ts), maar dat is een
    // client-side hint die dit programma zelf nooit kan vertrouwen; de
    // daadwerkelijke garantie moet hier, on-chain, uit het ondertekende
    // bericht zelf komen.
    let flags = actual_message[AUTHENTICATOR_DATA_FLAGS_OFFSET];
    require!(
        flags & AUTHENTICATOR_DATA_UV_FLAG != 0,
        SpankWalletError::UserVerificationRequired
    );

    // "type":"webauthn.get" afdwingen - voorkomt cross-ceremony-
    // typeverwarring (WebAuthn spec §7.2 stap 3). Zie verify_webauthn_type
    // hierboven voor de volledige toelichting waarom de substring-techniek
    // hier veilig is.
    verify_webauthn_type(client_data_json)?;

    let actual_challenge = extract_webauthn_challenge(client_data_json)?;
    require!(
        actual_challenge == expected_challenge,
        SpankWalletError::WebAuthnChallengeMismatch
    );

    // De daadwerkelijke ECDSA-r/s-verificatie (inclusief de laag-S-eis, zie
    // de toelichting bij SECP256R1_PROGRAM_ID hierboven) gebeurt volledig in
    // de precompile zelf, niet hier - deze check bevestigt uitsluitend dat
    // er genoeg bytes op de opgegeven offset staan voor de ruwe 64-byte
    // signature, geen herverificatie van de signature-waarden zelf nodig.
    let sig_source =
        resolve_instruction_data(ix_sysvar, offsets.signature_instruction_index, &precompile_ix.data)?;
    let sig_start = offsets.signature_offset as usize;
    require!(
        sig_source.len() >= sig_start + SIGNATURE_LEN,
        SpankWalletError::InvalidPasskeySignature
    );

    Ok(actual_pubkey)
}

/// Enkelvoudige-sleutel-variant - uitsluitend gebruikt door init_wallet,
/// waar per definitie nog geen WalletAccount (en dus geen PasskeysAccount)
/// bestaat om tegen te verifieren: de enige mogelijke geldige sleutel is de
/// seed_key waarmee de wallet wordt aangemaakt. Elke andere instructie
/// gebruikt verify_passkey_signature_multi hieronder.
fn verify_passkey_signature(
    ix_sysvar: &AccountInfo<'_>,
    expected_pubkey: &[u8; PASSKEY_PUBKEY_LEN],
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<()> {
    let actual_pubkey = verify_passkey_signature_core(ix_sysvar, expected_challenge, client_data_json)?;
    require!(
        &actual_pubkey == expected_pubkey,
        SpankWalletError::InvalidPasskeySignature
    );
    Ok(())
}

/// Leest PasskeysAccount ALS het al bestaat, geeft None terug als het nog
/// nooit is aangemaakt (owner != ons programma-ID, of een discriminator-
/// mismatch) i.p.v. te falen. Elke wallet begint zonder PasskeysAccount (lui
/// aangemaakt via add_passkey, zie STATUS.md) - alle instructies die een
/// passkey-handtekening verifieren moeten dus overweg kunnen met "bestaat
/// nog niet" als een volkomen normale, geldige staat (= alleen
/// owner_passkey is geldig), niet als een fout.
fn read_passkeys_account(account_info: &AccountInfo) -> Option<PasskeysAccount> {
    if account_info.owner != &crate::ID {
        return None;
    }
    let data = account_info.try_borrow_data().ok()?;
    PasskeysAccount::try_deserialize(&mut &data[..]).ok()
}

/// Meervoudige-sleutel-variant - gebruikt door elke instructie NA
/// init_wallet die een passkey-handtekening verifieert. Accepteert een
/// geldige handtekening van OFWEL wallet.owner_passkey (tenzij ingetrokken
/// via PasskeysAccount.owner_passkey_revoked) OFWEL een van de extra
/// geregistreerde sleutels in PasskeysAccount.additional_passkeys. Het
/// `passkeys`-account hoeft niet te bestaan (zie read_passkeys_account) -
/// een wallet die nooit add_passkey heeft aangeroepen gedraagt zich exact
/// als voorheen (alleen owner_passkey geldig, zero-migratie).
fn verify_passkey_signature_multi(
    ix_sysvar: &AccountInfo<'_>,
    owner_passkey: &[u8; PASSKEY_PUBKEY_LEN],
    passkeys_account_info: &AccountInfo<'_>,
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<()> {
    let actual_pubkey = verify_passkey_signature_core(ix_sysvar, expected_challenge, client_data_json)?;

    let passkeys = read_passkeys_account(passkeys_account_info);

    let owner_active = passkeys
        .as_ref()
        .map(|p| !p.owner_passkey_revoked)
        .unwrap_or(true);
    let is_owner = owner_active && &actual_pubkey == owner_passkey;

    let is_additional = passkeys
        .as_ref()
        .map(|p| {
            p.additional_passkeys[..p.count as usize]
                .iter()
                .any(|k| *k == actual_pubkey)
        })
        .unwrap_or(false);

    require!(
        is_owner || is_additional,
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
        mut,
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// CHECK: willekeurige ontvanger - geen eigendomsbeperking nodig, crediteren
    /// van lamports naar een willekeurig account is altijd toegestaan (zelfde
    /// Solana-runtime-regel als gebruikt in hunt, zie STATUS.md sectie 17).
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// execute is BEWUST GEEN generieke CPI-doorgeefluik (geen rauwe
/// instructie-bytes die de client aanlevert en het programma blind
/// ondertekent). Dat patroon staat bekend als "Arbitrary CPI" - een erkende
/// kwetsbaarheidsklasse: wie een geldige handtekening kan produceren zou
/// daarmee de vault kunnen laten interacteren met ELK programma, ELKE
/// instructie. In plaats daarvan is dit een GESLOTEN, GETYPEERDE actie
/// (transfer_sol: alleen recipient + amount, geen vrije-vorm-data) - de
/// enige mogelijke actie is precies wat de handtekening expliciet toestaat,
/// er is structureel niets anders om te misbruiken. Toekomstige acties
/// (transfer_token, etc.) horen volgens hetzelfde patroon te worden
/// toegevoegd: eigen, apart getypeerde instructies met een eigen
/// challenge-domain, NOOIT als generieke CPI-doorgeefluik. Zie STATUS.md
/// voor de volledige afweging en de geplande roadmap (program-allowlists,
/// spend limits, gelaagde privileges) voor wie ooit wel bredere
/// programmatische controle wil.
pub fn execute(
    ctx: Context<Execute>,
    amount: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(32 + 8);
    payload.extend_from_slice(ctx.accounts.recipient.key().as_ref());
    payload.extend_from_slice(&amount.to_le_bytes());

    let expected_challenge = build_expected_challenge(&ctx.accounts.wallet.key(), b"execute", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    // Directe lamport-manipulatie i.p.v. een System-Program-CPI: de vault is
    // eigendom van ONS programma, niet van System Program (zelfde situatie
    // als in hunt, zie STATUS.md sectie 17) - System::transfer zou hier
    // sowieso falen. Debiteren mag alleen de eigenaar van een account,
    // crediteren mag altijd, ongeacht wie het doelaccount bezit.
    let rent = Rent::get()?;
    let min_vault_balance = rent.minimum_balance(VaultAccount::LEN);

    let vault_ai = ctx.accounts.vault.to_account_info();
    let new_vault_balance = vault_ai
        .lamports()
        .checked_sub(amount)
        .ok_or(SpankWalletError::ExecuteTransferOverflow)?;
    require!(
        new_vault_balance >= min_vault_balance,
        SpankWalletError::VaultWouldFallBelowRentExempt
    );
    **vault_ai.try_borrow_mut_lamports()? = new_vault_balance;

    let recipient_ai = ctx.accounts.recipient.to_account_info();
    let new_recipient_balance = recipient_ai
        .lamports()
        .checked_add(amount)
        .ok_or(SpankWalletError::ExecuteTransferOverflow)?;
    **recipient_ai.try_borrow_mut_lamports()? = new_recipient_balance;

    Ok(())
}


// transfer_token

#[derive(Accounts)]
pub struct TransferToken<'info> {
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

    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key() @ SpankWalletError::InvalidVaultTokenAccount,
        constraint = vault_token_account.mint == token_mint.key() @ SpankWalletError::InvalidVaultTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: willekeurige ontvanger-token-account - geen eigendomsbeperking
    /// nodig (zelfde principe als recipient in execute, sectie 25), maar WEL
    /// een mint-check zodat de overdracht niet per ongeluk naar een
    /// token-account van een andere mint kan gaan.
    #[account(
        mut,
        constraint = recipient_token_account.mint == token_mint.key() @ SpankWalletError::InvalidRecipientTokenAccount,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: alleen doorgegeven aan de SPL Token-CPI en gebruikt in de
    /// eigendoms-/mint-constraints hierboven, zelfde patroon als hunt.
    pub token_mint: UncheckedAccount<'info>,

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// transfer_token: tweede getypeerde actie na transfer_sol (sectie 25),
/// zelfde ontwerpprincipe - gesloten, expliciet, geen generieke CPI. Dekt
/// automatisch elke SPL-token (zBTC, BTCSOL, USDC, etc.) zonder per-munt-
/// configuratie, zie STATUS.md sectie 27.
pub fn transfer_token(
    ctx: Context<TransferToken>,
    amount: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let mut payload = Vec::with_capacity(32 + 32 + 8);
    payload.extend_from_slice(ctx.accounts.recipient_token_account.key().as_ref());
    payload.extend_from_slice(ctx.accounts.token_mint.key().as_ref());
    payload.extend_from_slice(&amount.to_le_bytes());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"transfer_token", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let wallet_key = ctx.accounts.wallet.key();
    let seeds = &[b"vault".as_ref(), wallet_key.as_ref(), &[ctx.accounts.vault.bump]];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        Token::id(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)?;

    Ok(())
}

// program-allowlist (add_allowed_program / remove_allowed_program) + execute_advanced
//
// Samen implementeren deze drie de programma-allowlist-architectuur uit
// STATUS.md sectie 26/27: een klein, WalletAccount-gebonden PolicyAccount
// met een door de gebruiker zelf beheerde lijst toegestane programma-ID's,
// en een getypeerde execute_advanced-instructie die WEL een CPI naar een
// extern programma mag doen maar UITSLUITEND naar een programma dat op die
// eigen lijst staat. Bewust GEEN on-chain onderscheid tussen "aanbevolen"
// en "handmatig toegevoegd" - dat verschil is puur clientside UI (sectie
// 27); on-chain wordt elk toegevoegd programma-ID identiek behandeld, geen
// enkele bevoorrechte partij (ook niet de ontwikkelaars) kan hier iets aan
// toevoegen of van verwijderen namens de gebruiker.
//
// Bewust GEEN timelock op add_allowed_program/remove_allowed_program
// (besproken en expliciet zo gekozen, zie STATUS.md): beide vereisen
// sowieso elke keer een eigen, verse, domain-gebonden live
// passkey-handtekening - er is geen "gestolen sessie" in dit ontwerp zoals
// bij bijv. OAuth-sessies of browserextensie-permissies die hier gestolen
// zou kunnen worden. Het risico "toevoegen + direct misbruiken" gebeurt
// hoe dan ook atomair BINNEN dezelfde transactie als de add (blind-signing
// via een gecompromitteerde/misleidende client, zie sectie 25) - een
// timelock op remove verandert daar niets aan, de schade is al gebeurd
// voordat remove ooit relevant wordt. De precies gerichte mitigatie (een
// activatievertraging voordat een NIEUW toegevoegd programma door
// execute_advanced gebruikt mag worden) hoort thuis in de al geplande
// "gelaagde privileges"-roadmap (sectie 26), niet als blanket-timelock hier.

#[derive(Accounts)]
pub struct AddAllowedProgram<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// init_if_needed is hier veilig: policy is een PDA die deterministisch
    /// en uitsluitend van wallet.key() afhangt, dus er kan nooit een ANDER
    /// accounttype op dat adres bestaan om per ongeluk te "hergebruiken" -
    /// het is ofwel nog nooit aangemaakt, ofwel altijd al precies deze
    /// PolicyAccount-structuur. Dat is exact het scenario waarin Anchors
    /// eigen documentatie init_if_needed als veilig aanmerkt, in
    /// tegenstelling tot het bekende risico bij accounts die ook een ANDER
    /// type/eigenaar zouden kunnen hebben.
    #[account(
        init_if_needed,
        payer = payer,
        space = PolicyAccount::LEN,
        seeds = [b"policy", wallet.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, PolicyAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn add_allowed_program(
    ctx: Context<AddAllowedProgram>,
    program_id: Pubkey,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"add_allowed_program",
        program_id.as_ref(),
    );
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    require!(program_id != crate::ID, SpankWalletError::SelfCpiNotAllowed);

    let policy = &mut ctx.accounts.policy;

    // policy.wallet == Pubkey::default() is uitsluitend waar direct na een
    // net door init_if_needed aangemaakt account (een echte WalletAccount-
    // PDA is nooit gelijk aan Pubkey::default()) - eerste-gebruik-init.
    if policy.wallet == Pubkey::default() {
        policy.wallet = ctx.accounts.wallet.key();
        policy.bump = ctx.bumps.policy;
        policy.count = 0;
        policy.allowed_programs = [Pubkey::default(); MAX_ALLOWED_PROGRAMS];
    }

    let already_present = policy.allowed_programs[..policy.count as usize]
        .iter()
        .any(|p| *p == program_id);
    require!(!already_present, SpankWalletError::ProgramAlreadyAllowed);
    require!(
        (policy.count as usize) < MAX_ALLOWED_PROGRAMS,
        SpankWalletError::AllowlistFull
    );

    let index = policy.count as usize;
    policy.allowed_programs[index] = program_id;
    policy.count += 1;

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveAllowedProgram<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        mut,
        seeds = [b"policy", wallet.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyAccount>,

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn remove_allowed_program(
    ctx: Context<RemoveAllowedProgram>,
    program_id: Pubkey,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"remove_allowed_program",
        program_id.as_ref(),
    );
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let policy = &mut ctx.accounts.policy;
    let count = policy.count as usize;
    let index = policy.allowed_programs[..count]
        .iter()
        .position(|p| *p == program_id)
        .ok_or(SpankWalletError::ProgramNotAllowed)?;

    // Swap-remove: de lijst is een ongeordende set, geen geordende
    // geschiedenis - de laatste actieve entry naar het gat verplaatsen is
    // O(1) en houdt de actieve slots aaneengesloten vanaf index 0 (nodig
    // omdat add_allowed_program/execute_advanced simpelweg
    // allowed_programs[..count] doorzoeken).
    let last = count - 1;
    policy.allowed_programs[index] = policy.allowed_programs[last];
    policy.allowed_programs[last] = Pubkey::default();
    policy.count -= 1;

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteAdvanced<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        mut,
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"policy", wallet.key().as_ref()],
        bump = policy.bump,
    )]
    pub policy: Account<'info, PolicyAccount>,

    /// CHECK: het CPI-doelprogramma - moet expliciet op policy.allowed_programs
    /// staan EN executable zijn (beide gecontroleerd in execute_advanced hieronder).
    pub cpi_program: UncheckedAccount<'info>,

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// execute_advanced is de bewust apart gehouden mogelijkheid uit STATUS.md
/// sectie 26/27 om wél een CPI naar een extern programma te doen (in
/// tegenstelling tot execute/transfer_token, die structureel GEEN CPI naar
/// willekeurige programma's toestaan, zie sectie 25) - maar UITSLUITEND
/// naar een programma-ID dat de gebruiker zelf, met zijn eigen passkey,
/// vooraf via add_allowed_program op zijn eigen PolicyAccount heeft gezet.
/// De vault (PDA, eigendom van dit programma) mag als CPI-autoriteit
/// optreden: elke account in remaining_accounts wiens sleutel overeenkomt
/// met de vault wordt via invoke_signed als signer doorgegeven, verder
/// ongewijzigd t.o.v. wat de aanroeper aanlevert - zelfde mechanisme als in
/// transfer_token/hunt, nu voor een willekeurig toegestaan programma i.p.v.
/// uitsluitend het SPL Token-programma.
///
/// De challenge bindt het VOLLEDIGE CPI-target: het programma-ID, elke
/// meegegeven account (sleutel + schrijf-/signer-vlag) EN de instructiedata
/// zelf - zelfde principe als transfer_sol/transfer_token (sectie 25/32):
/// een onderschepte handtekening is uitsluitend geldig voor precies deze
/// ene, volledig gespecificeerde CPI-aanroep, niet voor iets anders tegen
/// hetzelfde toegestane programma.
pub fn execute_advanced<'info>(
    ctx: Context<'info, ExecuteAdvanced<'info>>,
    cpi_instruction_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let cpi_program_id = ctx.accounts.cpi_program.key();

    require!(
        cpi_program_id != crate::ID,
        SpankWalletError::SelfCpiNotAllowed
    );
    require!(
        ctx.accounts.cpi_program.executable,
        SpankWalletError::CpiTargetNotExecutable
    );

    let policy = &ctx.accounts.policy;
    let is_allowed = policy.allowed_programs[..policy.count as usize]
        .iter()
        .any(|p| *p == cpi_program_id);
    require!(is_allowed, SpankWalletError::ProgramNotAllowed);

    let vault_key = ctx.accounts.vault.key();

    let mut payload = Vec::with_capacity(
        32 + 2 + ctx.remaining_accounts.len() * 34 + 4 + cpi_instruction_data.len(),
    );
    payload.extend_from_slice(cpi_program_id.as_ref());
    payload.extend_from_slice(&(ctx.remaining_accounts.len() as u16).to_le_bytes());

    let mut account_metas = Vec::with_capacity(ctx.remaining_accounts.len());
    let mut account_infos = Vec::with_capacity(ctx.remaining_accounts.len() + 1);

    for account_info in ctx.remaining_accounts.iter() {
        let is_vault = *account_info.key == vault_key;
        let is_signer = is_vault || account_info.is_signer;
        let is_writable = account_info.is_writable;

        payload.extend_from_slice(account_info.key.as_ref());
        payload.push(is_writable as u8);
        payload.push(is_signer as u8);

        account_metas.push(AccountMeta {
            pubkey: *account_info.key,
            is_signer,
            is_writable,
        });
        account_infos.push(account_info.clone());
    }

    payload.extend_from_slice(&(cpi_instruction_data.len() as u32).to_le_bytes());
    payload.extend_from_slice(&cpi_instruction_data);

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"execute_advanced", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    account_infos.push(ctx.accounts.cpi_program.to_account_info());

    let instruction = Instruction {
        program_id: cpi_program_id,
        accounts: account_metas,
        data: cpi_instruction_data,
    };

    let wallet_key = ctx.accounts.wallet.key();
    let seeds = &[
        b"vault".as_ref(),
        wallet_key.as_ref(),
        &[ctx.accounts.vault.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    invoke_signed(&instruction, &account_infos, signer_seeds)?;

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
        mut,
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        mut,
        constraint = target_token_account.owner == vault.key() @ SpankWalletError::InvalidTargetTokenAccount,
        constraint = target_token_account.mint == token_mint.key() @ SpankWalletError::InvalidTargetTokenAccount,
    )]
    pub target_token_account: Account<'info, TokenAccount>,
    /// CHECK: mint-account wordt alleen doorgegeven aan de SPL Token CPI (burn).
    pub token_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub rent_destination: SystemAccount<'info>,
    /// CHECK: adres-constraint hieronder garandeert dat dit exact het vaste,
    /// algemeen erkende Solana-"dead address" is (geen bekende private key) -
    /// zie de toelichting bij de INCINERATOR-constante bovenaan dit bestand.
    #[account(mut, address = INCINERATOR @ SpankWalletError::InvalidIncineratorAccount)]
    pub incinerator: UncheckedAccount<'info>,
    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,
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
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
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

    // Sluit het spam-token-account, maar NIET rechtstreeks naar
    // rent_destination - de vrijgekomen rent landt eerst bij de vault zelf,
    // zodat we het exacte, daadwerkelijk teruggewonnen bedrag kunnen meten
    // (vault_lamports_after - vault_lamports_before) voordat we het
    // splitsen. Rechtstreeks naar rent_destination sluiten zou geen manier
    // geven om te weten hoeveel er precies is teruggewonnen zonder
    // aannames te doen over de rent-exempt-drempel.
    let vault_ai = ctx.accounts.vault.to_account_info();
    let vault_lamports_before = vault_ai.lamports();

    let close_ctx = CpiContext::new_with_signer(
        Token::id(),
        CloseAccount {
            account: ctx.accounts.target_token_account.to_account_info(),
            destination: vault_ai.clone(),
            authority: vault_ai.clone(),
        },
        signer_seeds,
    );
    token::close_account(close_ctx)?;

    let vault_lamports_after = vault_ai.lamports();
    let reclaimed = vault_lamports_after
        .checked_sub(vault_lamports_before)
        .ok_or(SpankWalletError::RentAccountingOverflow)?;

    // Helft naar de incinerator (permanent uit omloop, komt alle
    // SOL-houders ten goede - zie STATUS.md voor de motivatie), de rest
    // (bij een oneven bedrag: de ene lamport extra) naar de hunter zelf.
    let to_incinerator = reclaimed / 2;
    let to_user = reclaimed
        .checked_sub(to_incinerator)
        .ok_or(SpankWalletError::RentAccountingOverflow)?;

    // Directe lamport-herverdeling, geen System-Program-CPI: de vault is
    // eigendom van ONS programma (niet van System Program), en alleen de
    // eigenaar van een account mag er lamports uit debiteren. Crediteren
    // van willekeurige accounts (rent_destination, incinerator) mag altijd,
    // ongeacht wie ze bezit - dat is de Solana-runtime-regel die dit
    // toestaat.
    let new_vault_balance = vault_ai
        .lamports()
        .checked_sub(reclaimed)
        .ok_or(SpankWalletError::RentAccountingOverflow)?;
    **vault_ai.try_borrow_mut_lamports()? = new_vault_balance;

    let rent_dest_ai = ctx.accounts.rent_destination.to_account_info();
    let new_rent_dest_balance = rent_dest_ai
        .lamports()
        .checked_add(to_user)
        .ok_or(SpankWalletError::RentAccountingOverflow)?;
    **rent_dest_ai.try_borrow_mut_lamports()? = new_rent_dest_balance;

    let incinerator_ai = ctx.accounts.incinerator.to_account_info();
    let new_incinerator_balance = incinerator_ai
        .lamports()
        .checked_add(to_incinerator)
        .ok_or(SpankWalletError::RentAccountingOverflow)?;
    **incinerator_ai.try_borrow_mut_lamports()? = new_incinerator_balance;

    Ok(())
}

// multi-passkey (add_passkey / remove_passkey)
//
// LazorKit-geinspireerd (eigen PDA per geautoriseerde sleutel, met rollen),
// maar bewust een andere account-layout: een satellite-list-account
// (PasskeysAccount, zie state.rs) i.p.v. LazorKits per-sleutel-PDA, en
// bewust GEEN rollen - elke geregistreerde passkey heeft gelijke, volledige
// zeggenschap, exact zoals wallet.owner_passkey dat vandaag al heeft. Zie
// STATUS.md voor de volledige afweging (rent/eenvoud t.o.v. per-sleutel-
// PDA's, en waarom rollen bewust wachten op de gelaagde-privileges-roadmap
// uit sectie 26 i.p.v. hier meegenomen te worden).
//
// Zero-migratie: wallet.owner_passkey blijft ongewijzigd de "oorspronkelijke"
// sleutel (WalletAccount's layout wordt nooit aangeraakt). PasskeysAccount
// is puur additief en lui aangemaakt (init_if_needed, zelfde patroon als
// PolicyAccount) - bestaande wallets werken ongewijzigd door totdat hun
// eigenaar zelf voor het eerst add_passkey aanroept.
//
// Relatie met recovery: add_passkey/remove_passkey is de EERSTE
// verdedigingslinie (één apparaat kwijt, andere werken nog) - de bestaande
// backup_authority-recovery-flow (initiate/cancel/finalize hieronder) blijft
// het LAATSTE redmiddel (alle passkeys tegelijk kwijt). finalize_recovery is
// daarom aangepast om bij een geslaagde recovery de VOLLEDIGE passkey-set te
// wissen (alle extra sleutels weg, owner_passkey_revoked terug naar false) -
// geen stale, mogelijk-gecompromitteerde extra sleutels overleven een
// recovery, zelfde principe als de bestaande volledige owner_passkey-
// vervanging.

#[derive(Accounts)]
pub struct AddPasskey<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// init_if_needed is hier veilig: passkeys is een PDA die deterministisch
    /// en uitsluitend van wallet.key() afhangt, dus er kan nooit een ANDER
    /// accounttype op dat adres bestaan - zelfde argument als bij
    /// PolicyAccount (zie AddAllowedProgram hierboven).
    #[account(
        init_if_needed,
        payer = payer,
        space = PasskeysAccount::LEN,
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump
    )]
    pub passkeys: Account<'info, PasskeysAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn add_passkey(
    ctx: Context<AddPasskey>,
    new_passkey: [u8; PASSKEY_PUBKEY_LEN],
    client_data_json: Vec<u8>,
) -> Result<()> {
    validate_passkey_prefix(&new_passkey)?;

    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"add_passkey",
        new_passkey.as_ref(),
    );
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let passkeys = &mut ctx.accounts.passkeys;

    // Zelfde eerste-gebruik-sentinel als PolicyAccount: een net door
    // init_if_needed aangemaakt account heeft wallet == default(), wat een
    // echte WalletAccount-PDA nooit is.
    if passkeys.wallet == Pubkey::default() {
        passkeys.wallet = ctx.accounts.wallet.key();
        passkeys.bump = ctx.bumps.passkeys;
        passkeys.owner_passkey_revoked = false;
        passkeys.count = 0;
        passkeys.additional_passkeys = [[0u8; PASSKEY_PUBKEY_LEN]; MAX_ADDITIONAL_PASSKEYS];
    }

    require!(
        new_passkey != ctx.accounts.wallet.owner_passkey,
        SpankWalletError::PasskeyAlreadyRegistered
    );
    let already_present = passkeys.additional_passkeys[..passkeys.count as usize]
        .iter()
        .any(|p| *p == new_passkey);
    require!(!already_present, SpankWalletError::PasskeyAlreadyRegistered);
    require!(
        (passkeys.count as usize) < MAX_ADDITIONAL_PASSKEYS,
        SpankWalletError::AdditionalPasskeysFull
    );

    let index = passkeys.count as usize;
    passkeys.additional_passkeys[index] = new_passkey;
    passkeys.count += 1;

    Ok(())
}

#[derive(Accounts)]
pub struct RemovePasskey<'info> {
    #[account(
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// Bewust GEEN init_if_needed: een geldige remove_passkey-aanroep is
    /// altijd voorafgegaan door minstens één add_passkey (de lockout-
    /// bescherming hieronder verbiedt sowieso ooit de allerlaatste geldige
    /// sleutel te verwijderen, dus "verwijderen terwijl er nog nooit iets
    /// is toegevoegd" kan nooit een geldige aanroep zijn) - zelfde patroon
    /// als RemoveAllowedProgram.
    #[account(
        mut,
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump = passkeys.bump,
    )]
    pub passkeys: Account<'info, PasskeysAccount>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn remove_passkey(
    ctx: Context<RemovePasskey>,
    target_passkey: [u8; PASSKEY_PUBKEY_LEN],
    client_data_json: Vec<u8>,
) -> Result<()> {
    let expected_challenge = build_expected_challenge(
        &ctx.accounts.wallet.key(),
        b"remove_passkey",
        target_passkey.as_ref(),
    );
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    let owner_passkey = ctx.accounts.wallet.owner_passkey;
    let passkeys = &mut ctx.accounts.passkeys;

    // Lockout-bescherming: het totaal aantal geldige sleutels NA deze
    // verwijdering moet minstens 1 blijven - anders zou geen enkele
    // handtekening verify_passkey_signature_multi ooit nog accepteren en is
    // de wallet permanent onbereikbaar (behalve via de 72u-recovery-flow).
    let owner_active_now = !passkeys.owner_passkey_revoked;
    let total_before = (owner_active_now as u8) + passkeys.count;

    if target_passkey == owner_passkey {
        require!(owner_active_now, SpankWalletError::PasskeyNotRegistered);
        require!(total_before > 1, SpankWalletError::CannotRemoveLastPasskey);
        passkeys.owner_passkey_revoked = true;
    } else {
        let count = passkeys.count as usize;
        let index = passkeys.additional_passkeys[..count]
            .iter()
            .position(|p| *p == target_passkey)
            .ok_or(SpankWalletError::PasskeyNotRegistered)?;
        require!(total_before > 1, SpankWalletError::CannotRemoveLastPasskey);

        // Swap-remove, zelfde patroon als RemoveAllowedProgram.
        let last = count - 1;
        passkeys.additional_passkeys[index] = passkeys.additional_passkeys[last];
        passkeys.additional_passkeys[last] = [0u8; PASSKEY_PUBKEY_LEN];
        passkeys.count -= 1;
    }

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
    validate_passkey_prefix(&new_owner_passkey)?;
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

    /// CHECK: multi-passkey-set - hoeft niet te bestaan (zie
    /// read_passkeys_account), seeds/bump garanderen dat dit altijd EXACT
    /// het PasskeysAccount van DEZE wallet is, nooit een ander account.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: veto door een van de HUIDIGE geldige passkeys - via precompile, net als execute.
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
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
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

    /// Optioneel: PasskeysAccount van deze wallet, ALLEEN meegeven als het
    /// al bestaat (anders het programma-ID zelf als sentinel meegeven -
    /// Anchors ingebouwde optionele-account-patroon). Een geslaagde recovery
    /// is een volledige reset: als dit account bestaat, wordt het hier
    /// volledig gewist (alle extra sleutels weg, owner_passkey_revoked terug
    /// naar false) zodat de nieuwe owner_passkey na recovery de ENIGE
    /// geldige sleutel is - geen stale, mogelijk-gecompromitteerde extra
    /// sleutels overleven een recovery. Zie STATUS.md voor de motivatie.
    #[account(
        mut,
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: Option<Account<'info, PasskeysAccount>>,
}

pub fn finalize_recovery(ctx: Context<FinalizeRecovery>) -> Result<()> {
    let wallet = &mut ctx.accounts.wallet;
    let recovery = wallet
        .recovery_state
        .ok_or(SpankWalletError::NoRecoveryInProgress)?;

    let clock = Clock::get()?;
    let elapsed = clock
        .unix_timestamp
        .checked_sub(recovery.initiated_at)
        .ok_or(SpankWalletError::TimestampOverflow)?;
    require!(
        elapsed >= wallet.recovery_timelock_seconds,
        SpankWalletError::RecoveryTimelockNotElapsed
    );

    wallet.owner_passkey = recovery.new_owner_passkey;
    wallet.recovery_state = None;

    if let Some(passkeys) = ctx.accounts.passkeys.as_mut() {
        passkeys.owner_passkey_revoked = false;
        passkeys.count = 0;
        passkeys.additional_passkeys = [[0u8; PASSKEY_PUBKEY_LEN]; MAX_ADDITIONAL_PASSKEYS];
    }

    Ok(())
}
