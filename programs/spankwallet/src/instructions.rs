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
    // C-1-fix (STATUS.md sectie 69): geen client_action_nonce-argument nodig
    // hier - init_wallet is al structureel replay-proof (de `init`-constraint
    // op wallet hierboven faalt sowieso op een tweede aanroep met dezelfde
    // seed_key, het account bestaat dan al). Nonce start gewoon op 0.
    wallet.action_nonce = 0;
    // B2 (STATUS.md sectie 76): start op 0, zelfde reden als action_nonce.
    wallet.session_epoch = 0;

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

/// Leest PolicyAccount ALS het al bestaat, geeft None terug als het nog nooit
/// is aangemaakt - zelfde tolerante patroon als read_passkeys_account.
/// Gebruikt door add_session_key om de gevraagde execute_advanced-sub-scope
/// bij aanmaak te valideren tegen de op dat moment geldende, wallet-brede
/// allowlist (ontwerppunt 2): een wallet zonder PolicyAccount heeft een lege
/// allowlist, dus elke aanvraag met >0 programma's hoort te falen, niet als
/// fout maar simpelweg omdat er niets toegestaan is.
fn read_policy_account(account_info: &AccountInfo) -> Option<PolicyAccount> {
    if account_info.owner != &crate::ID {
        return None;
    }
    let data = account_info.try_borrow_data().ok()?;
    PolicyAccount::try_deserialize(&mut &data[..]).ok()
}

/// Verplichte (niet-tolerante) load van SessionKeyAccount - gebruikt door
/// execute_advanced_via_session EN (STATUS.md sectie 119, stap-2-
/// regressie-fix) transfer_token_via_session, beide waar `session` als
/// UncheckedAccount gedeclareerd is (BPF-stacklimiet, zie de veldcommentaren
/// bij ExecuteAdvancedViaSession/TransferTokenViaSession hieronder). In
/// tegenstelling tot read_passkeys_account/read_policy_account is er hier
/// geen geldig "bestaat nog niet"-scenario - een sessie MOET al bestaan
/// (aangemaakt via add_session_key) - dus faalt dit gewoon door als het
/// account niet deserialiseert, i.p.v. None terug te geven.
fn load_session_account(account_info: &AccountInfo) -> Result<SessionKeyAccount> {
    let data = account_info.try_borrow_data()?;
    SessionKeyAccount::try_deserialize(&mut &data[..])
}

/// STATUS.md sectie 119 (stap-2-regressie-fix): het schrijvende tegenhanger
/// van load_session_account hierboven - voor een instructie die `session`
/// bewust als UncheckedAccount declareert (BPF-stacklimiet) maar tóch een
/// veld moet bijwerken (bijv. spent_lamports/spent_token_amount). Zelfde
/// try_borrow_mut_data + try_serialize-patroon als finalize_recovery al
/// gebruikt voor PasskeysAccount - hier als herbruikbare helper i.p.v.
/// opnieuw inline uitgeschreven.
fn write_session_account(account_info: &AccountInfo, session: &SessionKeyAccount) -> Result<()> {
    let mut data = account_info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    session.try_serialize(&mut writer)
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
    verify_passkey_signature_multi_get_pubkey(
        ix_sysvar,
        owner_passkey,
        passkeys_account_info,
        expected_challenge,
        client_data_json,
    )
    .map(|_| ())
}

/// STATUS.md sectie 115/118: zelfde verificatie als verify_passkey_signature_multi
/// hierboven, maar geeft ook de daadwerkelijk herleide passkey-publieke-sleutel
/// terug - nodig voor het spend-cap-mechanisme (initiate_withdrawal moet
/// vastleggen WELKE passkey initieerde, finalize_withdrawal moet controleren
/// dat een eventuele tweede handtekening van een AFWIJKENDE passkey komt,
/// SecondPasskeyMustDifferFromInitiator). verify_passkey_signature_multi
/// hierboven is nu een dunne wrapper hierop, geen gedupliceerde logica.
fn verify_passkey_signature_multi_get_pubkey(
    ix_sysvar: &AccountInfo<'_>,
    owner_passkey: &[u8; PASSKEY_PUBKEY_LEN],
    passkeys_account_info: &AccountInfo<'_>,
    expected_challenge: &[u8],
    client_data_json: &[u8],
) -> Result<[u8; PASSKEY_PUBKEY_LEN]> {
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

    Ok(actual_pubkey)
}

/// STATUS.md sectie 115/aanvulling punt B: aantal huidige geldige passkeys -
/// owner_passkey (tenzij ingetrokken) plus eventuele extra geregistreerde
/// sleutels. Gebruikt door initiate_* om te bepalen of 2-of-2 bij finalize
/// relevant kan zijn: bij <2 is een tweede, onafhankelijke bevestiging
/// sowieso onmogelijk (single-passkey-degradatie, PendingAction.confirmed
/// start dan al op true).
fn count_valid_passkeys(passkeys_account_info: &AccountInfo) -> u8 {
    let passkeys = read_passkeys_account(passkeys_account_info);
    let owner_active = passkeys
        .as_ref()
        .map(|p| !p.owner_passkey_revoked)
        .unwrap_or(true);
    let additional_count = passkeys.as_ref().map(|p| p.count).unwrap_or(0);
    (owner_active as u8).saturating_add(additional_count)
}

fn build_expected_challenge(wallet: &Pubkey, domain: &[u8], payload: &[u8]) -> Vec<u8> {
    hashv(&[crate::ID.as_ref(), wallet.as_ref(), domain, payload])
        .as_ref()
        .to_vec()
}

/// C-1-fix (STATUS.md sectie 69): controleert dat de client dezelfde
/// action_nonce noemt als de autoritatieve, on-chain waarde - geeft een
/// duidelijke, aparte foutmelding (StaleActionNonce) i.p.v. de generieke
/// WebAuthnChallengeMismatch die zonder deze check zou optreden zodra de
/// handtekening met een verouderde nonce ondertekend blijkt. Puur een
/// UX-verbetering, GEEN veiligheidsmechanisme op zich: de daadwerkelijke
/// bescherming komt van het feit dat de challenge hieronder in elke
/// aanroepende instructie ALTIJD met deze autoritatieve wallet.action_nonce
/// wordt opgebouwd, nooit met de client-waarde zelf - een client kan dus
/// nooit met een verzonnen nonce een geldige handtekening produceren.
fn check_current_action_nonce(wallet: &WalletAccount, client_action_nonce: u64) -> Result<u64> {
    require!(
        client_action_nonce == wallet.action_nonce,
        SpankWalletError::StaleActionNonce
    );
    Ok(wallet.action_nonce)
}

/// Verhoogt action_nonce na een geslaagde handtekeningverificatie - maakt de
/// zojuist gebruikte handtekening blijvend onbruikbaar voor een latere
/// aanroep (het eigenlijke C-1-lek: replay van een eenmaal geldige,
/// ondertekende actie). Atomair met de rest van de instructie: een latere
/// require!-fout verderop in dezelfde instructie rolt deze verhoging vanzelf
/// mee terug, Solana-transacties zijn all-or-nothing - geen nonce raakt ooit
/// "verbrand" door een instructie die uiteindelijk faalt.
fn consume_action_nonce(wallet: &mut WalletAccount) -> Result<()> {
    wallet.action_nonce = wallet
        .action_nonce
        .checked_add(1)
        .ok_or(SpankWalletError::ActionNonceOverflow)?;
    Ok(())
}

// execute

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    let mut payload = Vec::with_capacity(8 + 32 + 8);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
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
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    // B6 (STATUS.md sectie 76, statische-audit-bevinding): vault_token_account
    // was voorheen NIET gebonden - alleen owner==vault en mint==token_mint
    // waren afgedwongen (zie de constraints op TransferToken hierboven), dus
    // bij meerdere vault-eigen token-accounts van dezelfde mint was de bron
    // niet volledig door de handtekening bepaald. Geen diefstalpad (alles is
    // al van de eigenaar), maar wel een afwijking van "één handtekening
    // autoriseert precies één volledig gespecificeerde actie". Voor de
    // sessievariant (transfer_token_via_session) verandert niets - die heeft
    // sowieso geen challenge, zie STATUS.md sectie 76 voor die afweging.
    let mut payload = Vec::with_capacity(8 + 32 + 32 + 8 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(ctx.accounts.recipient_token_account.key().as_ref());
    payload.extend_from_slice(ctx.accounts.token_mint.key().as_ref());
    payload.extend_from_slice(&amount.to_le_bytes());
    payload.extend_from_slice(ctx.accounts.vault_token_account.key().as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"transfer_token", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(program_id.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"add_allowed_program", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(program_id.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"remove_allowed_program", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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

    /// CHECK: alleen gelezen (read_policy_account, tolerant), bewust
    /// UncheckedAccount i.p.v. Account<PolicyAccount> - de BPF-stack heeft
    /// een harde 4096-byte-limiet per frame, en PolicyAccount (1066 bytes,
    /// allowed_programs) samen met WalletAccount in deze al-drukke struct
    /// overschreed die limiet met exact de 8 bytes die action_nonce net
    /// toevoegde (STATUS.md sectie 69, C-1-fix) - empirisch gevonden bij het
    /// bouwen van die fix ("Stack offset ... exceeded max offset of 4096").
    /// Zelfde patroon en reden als session in ExecuteAdvancedViaSession
    /// hieronder. Functioneel gelijkwaardig aan de vorige typed variant - een
    /// (in de praktijk nooit voorkomend, want add_allowed_program is altijd
    /// een vereiste eerdere stap) ontbrekend PolicyAccount geeft nu netjes
    /// ProgramNotAllowed i.p.v. AccountNotInitialized.
    #[account(
        seeds = [b"policy", wallet.key().as_ref()],
        bump,
    )]
    pub policy: UncheckedAccount<'info>,

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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;
    let cpi_program_id = ctx.accounts.cpi_program.key();

    require!(
        cpi_program_id != crate::ID,
        SpankWalletError::SelfCpiNotAllowed
    );
    require!(
        ctx.accounts.cpi_program.executable,
        SpankWalletError::CpiTargetNotExecutable
    );

    let policy = read_policy_account(&ctx.accounts.policy.to_account_info());
    let is_allowed = policy
        .as_ref()
        .map(|p| p.allowed_programs[..p.count as usize].iter().any(|prog| *prog == cpi_program_id))
        .unwrap_or(false);
    require!(is_allowed, SpankWalletError::ProgramNotAllowed);

    let vault_key = ctx.accounts.vault.key();

    let mut payload = Vec::with_capacity(
        8 + 32 + 2 + ctx.remaining_accounts.len() * 34 + 4 + cpi_instruction_data.len(),
    );
    payload.extend_from_slice(&current_nonce.to_le_bytes());
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
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
    // B4 (STATUS.md sectie 76, statische-audit-bevinding A4): hunt was de
    // ENIGE passkey-gated instructie zonder deze constraint - elke andere
    // (Execute, TransferToken, AddAllowedProgram, RemoveAllowedProgram,
    // ExecuteAdvanced, AddPasskey, AddSessionKey, RemoveSessionKey) heeft
    // 'm al. hunt is bovendien de meest onomkeerbare instructie in het
    // programma (verbrandt de VOLLEDIGE balans van een token-account, geen
    // on-chain spam-criterium) - juist die instructie hoorde het niet te
    // missen tijdens een lopend herstelverzoek.
    #[account(
        mut,
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
pub fn hunt(
    ctx: Context<Hunt>,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    // B5 (STATUS.md sectie 76, statische-audit-bevinding): rent_destination
    // was voorheen NIET gebonden - de payload bevatte alleen nonce +
    // target_token_account, dus wie de transactie samenstelde kon vrij
    // kiezen waar de helft van de teruggewonnen rent heen ging, terwijl de
    // bevestigingskaart de split wel expliciet toont. client/src/hunt.ts
    // moet in lockstep dezelfde payload opbouwen (nonce || target ||
    // rent_destination) - anders faalt de handtekeningverificatie
    // structureel (WebAuthnChallengeMismatch).
    let mut payload = Vec::with_capacity(8 + 32 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(ctx.accounts.target_token_account.key().as_ref());
    payload.extend_from_slice(ctx.accounts.rent_destination.key().as_ref());

    let expected_challenge = build_expected_challenge(&ctx.accounts.wallet.key(), b"hunt", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;
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

// spend-cap-mechanisme: PendingAction (initiate_withdrawal / finalize_withdrawal / cancel_action)
//
// STATUS.md sectie 115 (ontwerpdocument, goedgekeurd) / sectie 118
// (implementatiestap 4). Eerste van vier kind-varianten (SolWithdrawal) -
// zet het PendingAction-patroon één keer goed neer; de drie andere
// (TokenTransfer, AdvancedAction, ThresholdChange) hergebruiken dezelfde
// structuur in latere stappen.
//
// Vereenvoudiging t.o.v. sectie 115's oorspronkelijke tweetraps-ontwerp
// (een aparte confirm_withdrawal + een permissionless finalize_withdrawal
// zonder eigen ceremonie): hier draagt finalize_withdrawal ZELF de
// (eventueel) tweede passkey-ceremonie, geen apart confirm-instructie
// nodig. Functioneel gelijkwaardig - dezelfde 2-of-2-garantie, dezelfde
// single-passkey-degradatie (sectie 115/aanvulling punt B) - één
// instructie minder.
//
// Replay-bescherming: net als elke andere passkey-gated instructie in dit
// bestand gebruiken alle drie de wallet-brede action_nonce (consistent met
// de overige 12 aanroepplekken) - ook al zou de eenmalige existentie van
// PendingAction zelf (via `init`/`close`) een vorm van replay-bescherming
// op zichzelf al bieden, is er bewust geen uitzondering gemaakt op het
// bestaande, uniforme patroon: dezelfde duidelijke StaleActionNonce-fout
// i.p.v. een generieke Anchor-accountfout bij een verouderde/dubbele
// aanroep, zelfde UX-reden als bij elke andere instructie hier.

const PENDING_ACTION_KIND_SOL_WITHDRAWAL: u8 = 0;

/// Sectie 115 punt 5: vaste programmaconstante voor een eerste versie,
/// niet per-wallet instelbaar - zelfde bewuste vereenvoudiging als
/// arm_wallet's duur in sectie 99 ("een vaste constante volstaat voor een
/// eerste versie... per-wallet instelbare duur kost extra bytes,
/// uitgesteld").
const PENDING_ACTION_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;

/// Sectie 115 punt 2b: de commitment bevat BEWUST geen nonce (die
/// beschermt uitsluitend de initiate-handtekening zelf, al voltooid zodra
/// dit account bestaat) - finalize herberekent 'm uit de dan aangeleverde
/// waarden en eist een exacte match, geen nieuwe autorisatie-inhoud nodig
/// buiten wat hier al vastligt.
fn compute_withdrawal_commitment(wallet: &Pubkey, recipient: &Pubkey, amount: u64) -> [u8; 32] {
    let digest = hashv(&[
        wallet.as_ref(),
        b"pending_withdrawal",
        recipient.as_ref(),
        &amount.to_le_bytes(),
    ]);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

#[derive(Accounts)]
pub struct InitiateWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress,
        constraint = !wallet.disarmed @ SpankWalletError::WalletDisarmed,
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// Singleton-PDA (sectie 115 punt 2b) - `init` faalt vanzelf als er al
    /// een pending action voor deze wallet bestaat, wat "maximaal één
    /// openstaande grote actie tegelijk" afdwingt zonder een aparte
    /// teller/vlag.
    #[account(
        init,
        payer = payer,
        space = PendingAction::LEN,
        seeds = [b"pending_action", wallet.key().as_ref()],
        bump,
    )]
    pub pending_action: Account<'info, PendingAction>,

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

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Geen `vault`-account nodig - er wordt hier nog niets verplaatst, alleen
/// vastgelegd wat later, ná de timelock, geautoriseerd zal zijn (sectie 115
/// punt 2c).
pub fn initiate_withdrawal(
    ctx: Context<InitiateWithdrawal>,
    recipient: Pubkey,
    amount: u64,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    // Sectie 115 punt 1: dit pad is uitsluitend voor bedragen die de
    // instant-drempel daadwerkelijk overschrijden - een bedrag dat ook via
    // `execute` had gemogen, hoort niet nodeloos een 24u-wachttijd te
    // krijgen.
    require!(
        amount > ctx.accounts.wallet.spend_threshold_lamports,
        SpankWalletError::AmountEligibleForInstantExecute
    );

    let mut payload = Vec::with_capacity(8 + 32 + 8);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(recipient.as_ref());
    payload.extend_from_slice(&amount.to_le_bytes());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"initiate_withdrawal", &payload);
    let initiator_passkey = verify_passkey_signature_multi_get_pubkey(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

    // Sectie 115/aanvulling punt B: bij <2 huidige geldige passkeys is een
    // onafhankelijke tweede bevestiging sowieso onmogelijk - confirmed
    // start dan al op true (single-passkey-degradatie, timelock-only-
    // bescherming), anders op false (finalize moet dan een AFWIJKENDE
    // passkey zien dan initiator_passkey hieronder).
    let valid_passkey_count = count_valid_passkeys(&ctx.accounts.passkeys.to_account_info());
    let wallet_key = ctx.accounts.wallet.key();
    let epoch = ctx.accounts.wallet.session_epoch;
    let action_commitment = compute_withdrawal_commitment(&wallet_key, &recipient, amount);
    let clock = Clock::get()?;

    let pending = &mut ctx.accounts.pending_action;
    pending.wallet = wallet_key;
    pending.bump = ctx.bumps.pending_action;
    pending.kind = PENDING_ACTION_KIND_SOL_WITHDRAWAL;
    pending.initiated_at = clock.unix_timestamp;
    pending.epoch = epoch;
    pending.action_commitment = action_commitment;
    pending.initiator_passkey = initiator_passkey;
    pending.confirmed = valid_passkey_count < 2;

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeWithdrawal<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress,
        constraint = !wallet.disarmed @ SpankWalletError::WalletDisarmed,
    )]
    pub wallet: Account<'info, WalletAccount>,

    #[account(
        mut,
        seeds = [b"vault", wallet.key().as_ref()],
        bump = wallet.vault_bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Sluit na een geslaagde finalize (rent naar `closer`, zie
    /// hieronder) - de eenmalige existentie van dit account is zelf ook de
    /// reden dat een dubbele/verouderde finalize-poging niet twee keer kan
    /// slagen, los van de action_nonce-check hierboven.
    #[account(
        mut,
        close = closer,
        seeds = [b"pending_action", wallet.key().as_ref()],
        bump = pending_action.bump,
    )]
    pub pending_action: Account<'info, PendingAction>,

    /// CHECK: willekeurige ontvanger - zelfde principe als execute (sectie 25).
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

    /// Betaalt de transactiekosten, claimt de rent van de gesloten
    /// PendingAction - zelfde "closer"-patroon als close_expired_session.
    /// Losstaand van de passkey-ceremonie hieronder (een gewone
    /// Solana-sleutel, geen secp256r1/WebAuthn) - wie de rent claimt hoeft
    /// niet de eigenaar te zijn, wie tekent (owner_passkey/additional_
    /// passkeys) bepaalt de autorisatie, niet wie betaalt.
    #[account(mut)]
    pub closer: Signer<'info>,
}

/// Sectie 115 punt 2c/aanvulling punt B, met zoveel woorden: als er bij
/// `initiate_withdrawal` minder dan twee geldige passkeys bestonden, is
/// `pending_action.confirmed` al `true` en mag DEZELFDE passkey die
/// initieerde ook hier finalizen - timelock-only-bescherming (vertraging +
/// zichtbaarheid), geen onafhankelijke-credential-eis, voor de
/// vermoedelijke meerderheid van single-device-eigenaars. Bestonden er
/// wél al twee of meer passkeys, dan is `confirmed` `false` en moet de
/// hier herleide sleutel AFWIJKEN van `initiator_passkey`
/// (SecondPasskeyMustDifferFromInitiator) - de 2-of-2-eis werkt dan alleen
/// écht als die tweede passkey van een genuinely gescheiden apparaat komt,
/// iets wat dit protocol niet kan afdwingen (sectie 115/aanvulling punt B).
pub fn finalize_withdrawal(
    ctx: Context<FinalizeWithdrawal>,
    amount: u64,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    require!(
        ctx.accounts.pending_action.epoch == ctx.accounts.wallet.session_epoch,
        SpankWalletError::PendingActionStaleEpoch
    );

    let clock = Clock::get()?;
    let elapsed = clock
        .unix_timestamp
        .checked_sub(ctx.accounts.pending_action.initiated_at)
        .ok_or(SpankWalletError::TimestampOverflow)?;
    require!(
        elapsed >= PENDING_ACTION_TIMELOCK_SECONDS,
        SpankWalletError::PendingActionTimelockNotElapsed
    );

    // Geen apart `kind`-check nodig: de commitment hieronder is per kind
    // domain-gescheiden (b"pending_withdrawal" hier, andere domains voor
    // de latere TokenTransfer/AdvancedAction/ThresholdChange-varianten) -
    // een verkeerd-getypeerde pending action kan hier structureel nooit
    // een match opleveren. `kind` zelf blijft puur informatief/voor
    // client-side indexering (zodat een UI kan tonen WAT er openstaat
    // zonder alle vier domains te hoeven proberen).
    let wallet_key = ctx.accounts.wallet.key();
    let recipient_key = ctx.accounts.recipient.key();
    let commitment = compute_withdrawal_commitment(&wallet_key, &recipient_key, amount);
    require!(
        commitment == ctx.accounts.pending_action.action_commitment,
        SpankWalletError::PendingActionCommitmentMismatch
    );

    // Blokkerend gat gecorrigeerd (STATUS.md sectie 118, vervolgvraag): de
    // challenge bond zich hier voorheen alleen aan pending_action.key()
    // (het PDA-adres, wallet-breed en inhoudsonafhankelijk) - niet aan
    // BEDRAG/BESTEMMING zelf. Dat opende geen fondsen-omleidingsgat (de
    // commitment-check hierboven dwingt dat al onafhankelijk af, en
    // PendingAction is een singleton - er is nooit een TWEEDE pending
    // action om mee te verwarren), maar de handtekening zelf legde niet
    // vast WAT er precies bevestigd werd - alleen "wat er ook in deze slot
    // staat". `commitment` is op dit punt al bewezen gelijk aan
    // `pending_action.action_commitment` (de require! hierboven) - 'm nu
    // ook in de payload opnemen bindt de handtekening zelf aan het exacte
    // bedrag/bestemming, consistent met elke andere passkey-gated
    // instructie in dit bestand (execute/initiate_withdrawal/
    // cancel_recovery binden allemaal al volledig).
    let pending_action_key = ctx.accounts.pending_action.key();
    let mut payload = Vec::with_capacity(8 + 32 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(pending_action_key.as_ref());
    payload.extend_from_slice(&commitment);

    let expected_challenge =
        build_expected_challenge(&wallet_key, b"finalize_withdrawal", &payload);
    let actual_pubkey = verify_passkey_signature_multi_get_pubkey(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;

    if !ctx.accounts.pending_action.confirmed {
        require!(
            actual_pubkey != ctx.accounts.pending_action.initiator_passkey,
            SpankWalletError::SecondPasskeyMustDifferFromInitiator
        );
    }

    consume_action_nonce(&mut ctx.accounts.wallet)?;

    // Zelfde lamport-verplaatsing als execute (sectie 25) - directe
    // manipulatie i.p.v. een System-Program-CPI, de vault is eigendom van
    // ONS programma.
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

#[derive(Accounts)]
pub struct CancelAction<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// Kind-agnostisch: sluit ongeacht `kind`, staat, of timelock - sectie
    /// 115 punt 2d: annuleren is altijd veiliger dan doorzetten, mag nooit
    /// geblokkeerd worden door recovery_state/disarmed (bewust GEEN van
    /// beide constraints op `wallet` hierboven, in tegenstelling tot
    /// initiate_withdrawal/finalize_withdrawal).
    #[account(
        mut,
        close = payer,
        seeds = [b"pending_action", wallet.key().as_ref()],
        bump = pending_action.bump,
    )]
    pub pending_action: Account<'info, PendingAction>,

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

    /// Elke huidige geldige passkey mag annuleren (geen 2-of-2-eis, geen
    /// "moet dezelfde/andere zijn dan de initiator") - zelfde "veto door
    /// een van de huidige geldige passkeys"-principe als cancel_recovery.
    /// Ontvangt ook de rent van de gesloten PendingAction.
    #[account(mut)]
    pub payer: Signer<'info>,
}

pub fn cancel_action(
    ctx: Context<CancelAction>,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;
    let wallet_key = ctx.accounts.wallet.key();
    let pending_action_key = ctx.accounts.pending_action.key();

    let mut payload = Vec::with_capacity(8 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(pending_action_key.as_ref());

    let expected_challenge = build_expected_challenge(&wallet_key, b"cancel_action", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    validate_passkey_prefix(&new_passkey)?;
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    let mut payload = Vec::with_capacity(8 + PASSKEY_PUBKEY_LEN);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(new_passkey.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"add_passkey", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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
        mut,
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
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    let mut payload = Vec::with_capacity(8 + PASSKEY_PUBKEY_LEN);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(target_passkey.as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"remove_passkey", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

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

pub fn cancel_recovery(
    ctx: Context<CancelRecovery>,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;
    let recovery = ctx
        .accounts
        .wallet
        .recovery_state
        .ok_or(SpankWalletError::NoRecoveryInProgress)?;
    let mut payload = Vec::with_capacity(8 + 8 + PASSKEY_PUBKEY_LEN);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
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
    consume_action_nonce(&mut ctx.accounts.wallet)?;
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

    /// CHECK: VERPLICHT, geen Option meer (STATUS.md sectie 76, B1 - fix
    /// voor een statische-audit-bevinding, FASE A1 empirisch bevestigd).
    /// Het vorige `Option<Account<'info, PasskeysAccount>>`-patroon liet de
    /// AANROEPER beslissen of er iets te wissen viel: finalize_recovery is
    /// permissionless, dus wie dan ook kon de wipe overslaan door bewust de
    /// Anchor-sentinel (het programma-ID zelf) mee te geven terwijl er wél
    /// een bestaand PasskeysAccount was. Door dit een verplicht
    /// UncheckedAccount te maken, met dezelfde deterministische
    /// seeds/bump-constraint als elders in dit bestand, beslist de KETEN of
    /// er iets te wissen valt - het account moet nu altijd exact het
    /// PasskeysAccount van DEZE wallet zijn, ongeacht of het al bestaat. Een
    /// niet-bestaand account op dit adres meegeven blijft een volkomen
    /// normale, geldige staat (een wallet die nooit add_passkey aanriep) -
    /// opgevangen door de expliciete bestaanstest in de body hieronder
    /// (owner == crate::ID && niet data_is_empty), niet door de Option weg
    /// te laten. Bestaande call sites die voorheen bewust de sentinel
    /// gebruikten (een wallet zonder PasskeysAccount) geven nu het AFGELEIDE
    /// adres mee - dat is nog steeds correct, want het account hoeft niet te
    /// bestaan om het juiste adres te zijn.
    #[account(
        mut,
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,
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
    // B2 (STATUS.md sectie 76): elke bestaande sessiesleutel wordt hier in
    // één klap ongeldig - zie execute_via_session/transfer_token_via_session/
    // execute_advanced_via_session voor de bijbehorende epoch-check.
    wallet.session_epoch = wallet
        .session_epoch
        .checked_add(1)
        .ok_or(SpankWalletError::SessionEpochOverflow)?;

    // Expliciete bestaanstest i.p.v. Anchors Option<Account<T>>-patroon (zie
    // de CHECK-comment hierboven): owner == crate::ID is alleen waar voor
    // een al geinitialiseerd account van dit programma - een nog nooit
    // aangemaakt PDA-adres heeft owner == System Program (default) en
    // data_is_empty() == true.
    let passkeys_info = ctx.accounts.passkeys.to_account_info();
    let exists = passkeys_info.owner == &crate::ID && !passkeys_info.data_is_empty();
    if exists {
        let mut passkeys: PasskeysAccount = {
            let data = passkeys_info.try_borrow_data()?;
            PasskeysAccount::try_deserialize(&mut &data[..])?
        };
        passkeys.owner_passkey_revoked = false;
        passkeys.count = 0;
        passkeys.additional_passkeys = [[0u8; PASSKEY_PUBKEY_LEN]; MAX_ADDITIONAL_PASSKEYS];

        let mut data = passkeys_info.try_borrow_mut_data()?;
        let mut writer: &mut [u8] = &mut data;
        passkeys.try_serialize(&mut writer)?;
    }

    Ok(())
}

// session keys (LazorKit-geinspireerd, slot-gebonden expiry, zie STATUS.md)
//
// Puur additief t.o.v. execute/transfer_token/execute_advanced hierboven:
// GEEN van de drie bestaande instructies is voor dit traject gewijzigd (zie
// STATUS.md, ontwerppunt 6). In plaats daarvan een parallelle set
// "_via_session"-instructies met een eigen, structureel ander
// autorisatiemechanisme: een sessiesleutel is een gewone Solana Ed25519
// Signer (ontwerppunt 5), geen secp256r1/WebAuthn-passkey - Solana's eigen
// transactie-ondertekening bindt de sessiesleutel al aan exact deze
// instructie (programma-ID + accounts + data), dus is er GEEN
// challenge/clientDataJSON/precompile-machinerie nodig zoals bij de
// passkey-gated varianten. De kernlogica (lamport-verplaatsing,
// SPL-transfer, CPI-dispatch) is bewust gedupliceerd i.p.v. gedeeld met
// execute/transfer_token/execute_advanced - dat houdt de reeds live,
// fondsen-rakende instructies volledig onaangeraakt (zie de expliciete
// belofte in het goedgekeurde ontwerp), tegen de kosten van een kleine
// hoeveelheid duplicatie.

#[derive(Accounts)]
#[instruction(session_key: Pubkey)]
pub struct AddSessionKey<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// session_key is altijd een vers, door de client gegenereerd Ed25519-
    /// keypair - bewust `init` (niet init_if_needed): een geldige aanroep
    /// creeert altijd een NIEUWE sessie, hergebruik van een bestaande
    /// session_key zou een bestaande sessie's scope/expiry stilzwijgend
    /// overschrijven en hoort daarom hard te falen.
    #[account(
        init,
        payer = payer,
        space = SessionKeyAccount::LEN,
        seeds = [b"session", wallet.key().as_ref(), session_key.as_ref()],
        bump
    )]
    pub session: Account<'info, SessionKeyAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: alleen gelezen (read_policy_account, tolerant) om de gevraagde
    /// execute_advanced-sub-scope te valideren tegen de LIVE wallet-brede
    /// allowlist. Hoeft niet te bestaan - zie read_policy_account hierboven.
    pub policy: UncheckedAccount<'info>,

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

/// add_session_key: elke op dat moment geldige passkey (owner of extra) mag
/// een nieuwe sessie aanmaken, met een verse, challenge-gebonden handtekening
/// die de VOLLEDIGE scope bindt (session_key, expiry_slot, de drie
/// instructie-vlaggen, en de sub-allowlist) - een onderschepte handtekening
/// voor "sta scope X toe" kan nooit hergebruikt worden voor een andere,
/// bredere scope. Geen zelf-verlenging mogelijk: er is bewust geen aparte
/// "extend"-instructie - elke verlenging is simpelweg een nieuwe
/// add_session_key-aanroep, die net als de eerste keer een echte
/// passkey-handtekening vereist (ontwerppunt 4).
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
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    require!(
        session_allowed_programs.len() <= MAX_SESSION_PROGRAMS,
        SpankWalletError::SessionAllowlistFull
    );

    let current_slot = Clock::get()?.slot;
    require!(
        expiry_slot > current_slot,
        SpankWalletError::SessionExpirySlotNotInFuture
    );
    // B3 (STATUS.md sectie 76, statische-audit-bevinding A3): bovengrens
    // naast de al bestaande ondergrens hierboven - checked_add zodat een
    // absurd hoge expiry_slot niet om de grens heen kan overflowen.
    let max_expiry_slot = current_slot
        .checked_add(MAX_SESSION_DURATION_SLOTS)
        .ok_or(SpankWalletError::SessionDurationTooLong)?;
    require!(
        expiry_slot <= max_expiry_slot,
        SpankWalletError::SessionDurationTooLong
    );

    // Spend-limits-ontwerpdocument §3: token_mint is verplicht zodra
    // can_transfer_token true is - zonder vastgepinde mint zou
    // max_token_amount_* betekenisloos zijn (verschillende mints hebben
    // verschillende decimalen/waarde). Geen check dat max_*_per_tx/_total
    // > 0 is: 0 is een geldige, letterlijke "nul toegestaan"-keuze, geen
    // foutcase (zie ontwerpdocument §3, expliciet geen "0 = onbeperkt").
    if can_transfer_token {
        require!(
            token_mint != Pubkey::default(),
            SpankWalletError::SessionTokenMintRequired
        );
    }

    if can_execute_advanced {
        let policy = read_policy_account(&ctx.accounts.policy.to_account_info());
        for program_id in session_allowed_programs.iter() {
            let allowed = policy
                .as_ref()
                .map(|p| {
                    p.allowed_programs[..p.count as usize]
                        .iter()
                        .any(|a| a == program_id)
                })
                .unwrap_or(false);
            require!(allowed, SpankWalletError::SessionProgramNotAllowed);
        }
    } else {
        // Geen zinloze state opslaan: zonder can_execute_advanced is een
        // sub-allowlist sowieso nooit bruikbaar (execute_advanced_via_session
        // weigert al op de instructie-vlag zelf), dus wordt een niet-lege
        // lijst hier al bij aanmaak geweigerd i.p.v. stilzwijgend genegeerd.
        require!(
            session_allowed_programs.is_empty(),
            SpankWalletError::SessionInstructionNotAllowed
        );
    }

    // Spend-limits-ontwerpdocument §3: alle vijf nieuwe parameters worden
    // mee ondertekend, exact zoals elk ander sessieveld - zonder dit zou een
    // sessie's spend-limiet niet cryptografisch gebonden zijn aan wat de
    // eigenaar daadwerkelijk goedkeurde.
    let mut payload = Vec::with_capacity(
        8 + 32 + 8 + 3 + 4 + session_allowed_programs.len() * 32 + 8 + 8 + 32 + 8 + 8,
    );
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(session_key.as_ref());
    payload.extend_from_slice(&expiry_slot.to_le_bytes());
    payload.push(can_execute as u8);
    payload.push(can_transfer_token as u8);
    payload.push(can_execute_advanced as u8);
    payload.extend_from_slice(&(session_allowed_programs.len() as u32).to_le_bytes());
    for program_id in session_allowed_programs.iter() {
        payload.extend_from_slice(program_id.as_ref());
    }
    payload.extend_from_slice(&max_lamports_per_tx.to_le_bytes());
    payload.extend_from_slice(&max_lamports_total.to_le_bytes());
    payload.extend_from_slice(token_mint.as_ref());
    payload.extend_from_slice(&max_token_amount_per_tx.to_le_bytes());
    payload.extend_from_slice(&max_token_amount_total.to_le_bytes());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"add_session_key", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

    let session = &mut ctx.accounts.session;
    session.wallet = ctx.accounts.wallet.key();
    // B2 (STATUS.md sectie 76): stempelt de HUIDIGE wallet-epoch - komt van
    // de keten zelf, niet van de client, dus geen challenge-binding nodig
    // (zie het veldcommentaar in state.rs).
    session.epoch = ctx.accounts.wallet.session_epoch;
    session.session_key = session_key;
    session.bump = ctx.bumps.session;
    session.expiry_slot = expiry_slot;
    session.can_execute = can_execute;
    session.can_transfer_token = can_transfer_token;
    session.can_execute_advanced = can_execute_advanced;
    session.count = session_allowed_programs.len() as u8;
    session.allowed_programs = [Pubkey::default(); MAX_SESSION_PROGRAMS];
    session.allowed_programs[..session_allowed_programs.len()]
        .copy_from_slice(&session_allowed_programs);
    session.max_lamports_per_tx = max_lamports_per_tx;
    session.max_lamports_total = max_lamports_total;
    session.spent_lamports = 0;
    session.token_mint = token_mint;
    session.max_token_amount_per_tx = max_token_amount_per_tx;
    session.max_token_amount_total = max_token_amount_total;
    session.spent_token_amount = 0;

    Ok(())
}

#[derive(Accounts)]
#[instruction(session_key: Pubkey)]
pub struct RemoveSessionKey<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.wallet_seed_hash.as_ref()],
        bump = wallet.bump,
        constraint = wallet.recovery_state.is_none() @ SpankWalletError::RecoveryAlreadyInProgress
    )]
    pub wallet: Account<'info, WalletAccount>,

    /// seeds/bump garanderen al dat dit EXACT de sessie van deze wallet +
    /// deze session_key is - geen extra constraint nodig.
    #[account(
        mut,
        close = payer,
        seeds = [b"session", wallet.key().as_ref(), session_key.as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionKeyAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: multi-passkey-set, zelfde patroon als overal elders.
    #[account(
        seeds = [b"passkeys", wallet.key().as_ref()],
        bump,
    )]
    pub passkeys: UncheckedAccount<'info>,

    #[account(address = IX_SYSVAR_ID)]
    /// CHECK: geverifieerd via de secp256r1-precompile-instructie, niet via een Anchor Signer-check.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// remove_session_key: vroegtijdige intrekking door een geldige passkey -
/// nodig omdat een gecompromitteerde/kwaadwillende sessiesleutel zelf nooit
/// vrijwillig close_session zal aanroepen. Onafhankelijk van
/// close_session/close_expired_session hieronder.
pub fn remove_session_key(
    ctx: Context<RemoveSessionKey>,
    session_key: Pubkey,
    client_action_nonce: u64,
    client_data_json: Vec<u8>,
) -> Result<()> {
    let current_nonce = check_current_action_nonce(&ctx.accounts.wallet, client_action_nonce)?;

    // B7 (STATUS.md sectie 76/77, uitgeschreven vóór besluit): payer
    // (ontvanger van de teruggewonnen session-rent via `close = payer`) was
    // niet gebonden. payer moet al mede-ondertekenen (geen vrije keuze voor
    // een niet-consenterende derde), maar bindt "ik keur remove_session_key
    // goed" niet aan "en deze specifieke rekening krijgt de rent" - dezelfde
    // categorie afwijking van "één handtekening = één volledig
    // gespecificeerde actie" als B5/B6. Kosten van binden bleken bij nader
    // uitschrijven laag: de enige bestaande client (client/src/sessionKeys.ts)
    // gebruikt payer altijd óók als feePayer - geen sponsor-/relay-patroon
    // bestaat vandaag, en een toekomstig sponsor-patroon zou zijn eigen
    // adres sowieso al moeten kennen vóór de handtekening gevraagd wordt, dus
    // binden blokkeert dat niet. Conclusie omgeslagen van "bewust
    // geaccepteerd" naar "alsnog gebonden".
    let mut payload = Vec::with_capacity(8 + 32 + 32);
    payload.extend_from_slice(&current_nonce.to_le_bytes());
    payload.extend_from_slice(session_key.as_ref());
    payload.extend_from_slice(ctx.accounts.payer.key().as_ref());

    let expected_challenge =
        build_expected_challenge(&ctx.accounts.wallet.key(), b"remove_session_key", &payload);
    verify_passkey_signature_multi(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.wallet.owner_passkey,
        &ctx.accounts.passkeys.to_account_info(),
        &expected_challenge,
        &client_data_json,
    )?;
    consume_action_nonce(&mut ctx.accounts.wallet)?;

    Ok(())
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    /// CHECK: alleen gebruikt om de PDA-seeds van `session` af te leiden -
    /// geen eigen inhoudscontrole nodig, seeds+bump garanderen al dat
    /// `session` EXACT bij deze wallet + deze session_key hoort. Geen
    /// recovery_state-check hier (in tegenstelling tot elke ADD-actie in dit
    /// programma): een sessie zelf sluiten VERSMALT bevoegdheid, verbreedt
    /// nooit - er is geen scenario waarin dat tijdens een lopende recovery
    /// gevaarlijker zou zijn dan daarbuiten.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = session_key,
        seeds = [b"session", wallet.key().as_ref(), session_key.key().as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionKeyAccount>,

    /// De sessiesleutel zelf ondertekent haar eigen sluiting - het enige dat
    /// een sessiesleutel zelfstandig, zonder passkey, mag doen (ontwerppunt
    /// 4): eigen bevoegdheid intrekken is per definitie veilig, ongeacht wie
    /// erom vraagt, omdat het nooit meer toegang geeft, alleen minder.
    /// `mut` is vereist: de `close`-constraint hierboven crediteert de
    /// teruggewonnen rent naar dit account, Anchor weigert een balanswijziging
    /// op een niet-mut account ("instruction changed the balance of a
    /// read-only account").
    #[account(mut)]
    pub session_key: Signer<'info>,
}

pub fn close_session(_ctx: Context<CloseSession>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
#[instruction(session_key: Pubkey)]
pub struct CloseExpiredSession<'info> {
    /// CHECK: alleen gebruikt voor PDA-seeds-afleiding, zie CloseSession.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = closer,
        seeds = [b"session", wallet.key().as_ref(), session_key.as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionKeyAccount>,

    /// Permissionless: wie dan ook mag een verlopen sessie opruimen en de
    /// rent claimen - een opruim-prikkel, anders blijven verlopen
    /// sessie-accounts voor altijd als dode rent staan (ontwerppunt 4).
    #[account(mut)]
    pub closer: Signer<'info>,
}

pub fn close_expired_session(
    ctx: Context<CloseExpiredSession>,
    _session_key: Pubkey,
) -> Result<()> {
    let current_slot = Clock::get()?.slot;
    require!(
        current_slot > ctx.accounts.session.expiry_slot,
        SpankWalletError::SessionNotYetExpired
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteViaSession<'info> {
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

    /// CHECK: willekeurige ontvanger, zelfde principe als execute.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    // mut: spend-limits-ontwerpdocument §4 - spent_lamports wordt atomisch
    // opgehoogd binnen dezelfde instructie die de transfer uitvoert.
    #[account(
        mut,
        seeds = [b"session", wallet.key().as_ref(), session_key.key().as_ref()],
        bump = session.bump,
    )]
    pub session: Account<'info, SessionKeyAccount>,

    /// De sessiesleutel ondertekent de Solana-transactie rechtstreeks (native
    /// Ed25519-signer, ontwerppunt 5) - geen WebAuthn-challenge/precompile-
    /// machinerie nodig: Solana's eigen transactie-ondertekening bindt de
    /// sessiesleutel al aan exact deze instructie (programma-ID + accounts +
    /// data), net zoals bij elke gewone walletsleutel.
    pub session_key: Signer<'info>,
}

pub fn execute_via_session(ctx: Context<ExecuteViaSession>, amount: u64) -> Result<()> {
    // B2 (STATUS.md sectie 76): wallet-epoch EERST in een lokale variabele
    // lezen, vóór de mutable borrow van ctx.accounts.session hieronder.
    let wallet_session_epoch = ctx.accounts.wallet.session_epoch;
    let session = &mut ctx.accounts.session;
    let current_slot = Clock::get()?.slot;
    require!(
        current_slot <= session.expiry_slot,
        SpankWalletError::SessionExpired
    );
    require!(
        session.epoch == wallet_session_epoch,
        SpankWalletError::SessionRevokedByRecovery
    );
    require!(
        session.can_execute,
        SpankWalletError::SessionInstructionNotAllowed
    );

    // Spend-limits-ontwerpdocument §1/§4: check-en-optellen gebeurt VOOR de
    // daadwerkelijke lamportbeweging (zelfde check-voor-mutatie-patroon als
    // de rent-exempt-floor-check hieronder). Solana's write-lock op dit
    // session-PDA serialiseert elke transactie die het schrijvend aanraakt -
    // er is geen TOCTOU-gat waarin twee parallelle aanroepen dezelfde,
    // verouderde spent_lamports-waarde zouden kunnen zien.
    require!(
        amount <= session.max_lamports_per_tx,
        SpankWalletError::SessionSpendPerTxExceeded
    );
    let new_spent = session
        .spent_lamports
        .checked_add(amount)
        .ok_or(SpankWalletError::SessionSpendOverflow)?;
    require!(
        new_spent <= session.max_lamports_total,
        SpankWalletError::SessionSpendTotalExceeded
    );
    session.spent_lamports = new_spent;

    // Zelfde lamport-verplaatsing als execute() - bewust gedupliceerd, zie
    // de toelichting bovenaan dit blok.
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

#[derive(Accounts)]
pub struct TransferTokenViaSession<'info> {
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

    /// CHECK: willekeurige ontvanger-token-account, zelfde principe als transfer_token.
    #[account(
        mut,
        constraint = recipient_token_account.mint == token_mint.key() @ SpankWalletError::InvalidRecipientTokenAccount,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// CHECK: alleen doorgegeven aan de SPL Token-CPI en gebruikt in de
    /// eigendoms-/mint-constraints hierboven, zelfde patroon als transfer_token.
    pub token_mint: UncheckedAccount<'info>,

    /// CHECK: bewust UncheckedAccount i.p.v. Account<SessionKeyAccount>.
    /// STATUS.md sectie 119 (stap-2-regressie-fix, ontdekt tijdens sectie
    /// 118's stap 4): WalletAccount's groei (247->256 bytes,
    /// spend_threshold_lamports/disarmed) duwde deze Accounts-struct - die
    /// al een typed WalletAccount, VaultAccount en TWEE TokenAccounts
    /// droeg naast deze SessionKeyAccount (429 bytes) - over de BPF-stack-
    /// limiet (empirisch: "Stack offset of 4104 exceeded max offset of
    /// 4096 by 8 bytes" bij `anchor build`, niet zichtbaar in `cargo
    /// check`/`cargo test`). Exact hetzelfde patroon en dezelfde reden als
    /// `session` in ExecuteAdvancedViaSession hierboven (waar action_nonce
    /// destijds dezelfde limiet raakte via PolicyAccount) - seeds/bump
    /// garanderen nog steeds dat dit EXACT de sessie van deze wallet + deze
    /// session_key is; de inhoud wordt hieronder handmatig gelezen
    /// (load_session_account) EN, in tegenstelling tot die eerdere fix,
    /// ook teruggeschreven (write_session_account) omdat
    /// spent_token_amount hier - anders dan bij execute_advanced_via_session
    /// - wel degelijk atomisch bijgewerkt moet worden.
    #[account(
        mut,
        seeds = [b"session", wallet.key().as_ref(), session_key.key().as_ref()],
        bump,
    )]
    pub session: UncheckedAccount<'info>,

    pub session_key: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn transfer_token_via_session(ctx: Context<TransferTokenViaSession>, amount: u64) -> Result<()> {
    // B2 (STATUS.md sectie 76): zelfde borrow-volgorde-reden als
    // execute_via_session hierboven. Sectie 119: `session` is nu een
    // handmatig geladen eigen waarde (UncheckedAccount, BPF-stacklimiet),
    // geen &mut meer rechtstreeks op ctx.accounts - zelfde gedrag,
    // expliciet teruggeschreven aan het eind i.p.v. door Anchors macro.
    let wallet_session_epoch = ctx.accounts.wallet.session_epoch;
    let mut session = load_session_account(&ctx.accounts.session.to_account_info())?;
    let current_slot = Clock::get()?.slot;
    require!(
        current_slot <= session.expiry_slot,
        SpankWalletError::SessionExpired
    );
    require!(
        session.epoch == wallet_session_epoch,
        SpankWalletError::SessionRevokedByRecovery
    );
    require!(
        session.can_transfer_token,
        SpankWalletError::SessionInstructionNotAllowed
    );

    // Spend-limits-ontwerpdocument §5: deze sessie is bij add_session_key
    // vastgepind op precies één mint - een enkele, mint-onafhankelijke
    // teller zou betekenisloos zijn (verschillende mints hebben
    // verschillende decimalen/waarde).
    require!(
        ctx.accounts.token_mint.key() == session.token_mint,
        SpankWalletError::SessionTokenMintNotAllowed
    );
    require!(
        amount <= session.max_token_amount_per_tx,
        SpankWalletError::SessionSpendPerTxExceeded
    );
    let new_spent = session
        .spent_token_amount
        .checked_add(amount)
        .ok_or(SpankWalletError::SessionSpendOverflow)?;
    require!(
        new_spent <= session.max_token_amount_total,
        SpankWalletError::SessionSpendTotalExceeded
    );
    session.spent_token_amount = new_spent;
    write_session_account(&ctx.accounts.session.to_account_info(), &session)?;

    // Zelfde SPL-CPI als transfer_token() - bewust gedupliceerd, zie de
    // toelichting bovenaan dit blok.
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

#[derive(Accounts)]
pub struct ExecuteAdvancedViaSession<'info> {
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

    /// CHECK: bewust UncheckedAccount i.p.v. Account<PolicyAccount>. Anchors
    /// macro deserialiseert elk typed Account<T>-veld ALTIJD als onderdeel
    /// van try_accounts(), voordat de instructie-body ooit draait - een
    /// require!() eerder in de body-tekst plaatsen verandert daar niets aan
    /// (empirisch bevestigd op devnet: een sessie zonder can_execute_advanced
    /// gaf AccountNotInitialized i.p.v. het bedoelde
    /// SessionInstructionNotAllowed, puur omdat PolicyAccount nog niet
    /// bestond - de autorisatie-check kwam nooit aan bod). Door dit
    /// UncheckedAccount te maken en hieronder tolerant te lezen
    /// (read_policy_account, "bestaat niet" = lege allowlist, geen foutcase)
    /// draaien de autorisatie-checks in de body ALTIJD eerst, ongeacht of er
    /// uberhaupt een PolicyAccount bestaat.
    #[account(
        seeds = [b"policy", wallet.key().as_ref()],
        bump,
    )]
    pub policy: UncheckedAccount<'info>,

    /// CHECK: het CPI-doelprogramma, zelfde principe als execute_advanced -
    /// moet expliciet op ZOWEL de sessie's eigen sub-scope ALS de live
    /// policy staan EN executable zijn.
    pub cpi_program: UncheckedAccount<'info>,

    /// CHECK: bewust UncheckedAccount i.p.v. Account<SessionKeyAccount> - de
    /// BPF-stack heeft een harde 4096-byte-limiet per frame, en deze
    /// Accounts-struct bevat al een grote PolicyAccount (1024+ bytes voor
    /// allowed_programs). Een typed SessionKeyAccount ERBOVENOP overschreed
    /// die limiet (empirisch gevonden: "Access violation in stack frame"
    /// tijdens try_accounts). seeds/bump garanderen nog steeds dat dit EXACT
    /// de sessie van deze wallet + deze session_key is; de inhoud wordt
    /// hieronder handmatig, verplicht gedeserialiseerd (load_session_account)
    /// i.p.v. door Anchors macro - zelfde reden als waarom `passkeys` overal
    /// elders ook al UncheckedAccount is, niet Account<PasskeysAccount>.
    #[account(
        seeds = [b"session", wallet.key().as_ref(), session_key.key().as_ref()],
        bump,
    )]
    pub session: UncheckedAccount<'info>,

    pub session_key: Signer<'info>,
}

pub fn execute_advanced_via_session<'info>(
    ctx: Context<'info, ExecuteAdvancedViaSession<'info>>,
    cpi_instruction_data: Vec<u8>,
) -> Result<()> {
    let session = load_session_account(&ctx.accounts.session.to_account_info())?;
    let cpi_program_id = ctx.accounts.cpi_program.key();

    require!(cpi_program_id != crate::ID, SpankWalletError::SelfCpiNotAllowed);
    require!(
        ctx.accounts.cpi_program.executable,
        SpankWalletError::CpiTargetNotExecutable
    );

    let current_slot = Clock::get()?.slot;
    require!(
        current_slot <= session.expiry_slot,
        SpankWalletError::SessionExpired
    );
    // B2 (STATUS.md sectie 76): dezelfde epoch-check als execute_via_session/
    // transfer_token_via_session - hier expliciet apart genoemd omdat
    // `session` hier handmatig via load_session_account wordt ingelezen
    // i.p.v. door Anchors macro, precies het soort plek waar zo'n check per
    // ongeluk overgeslagen wordt als hij niet los benoemd staat.
    require!(
        session.epoch == ctx.accounts.wallet.session_epoch,
        SpankWalletError::SessionRevokedByRecovery
    );
    require!(
        session.can_execute_advanced,
        SpankWalletError::SessionInstructionNotAllowed
    );

    // Ontwerppunt 2: BEIDE lijsten opnieuw gecontroleerd bij elk gebruik, niet
    // gecached sinds add_session_key - de sessie's eigen sub-scope EN de
    // live, wallet-brede PolicyAccount moeten allebei het doelprogramma
    // toestaan.
    let session_allows = session.allowed_programs[..session.count as usize]
        .iter()
        .any(|p| *p == cpi_program_id);
    require!(session_allows, SpankWalletError::SessionProgramNotAllowed);

    // Tolerant: geen PolicyAccount = een lege allowlist, geen foutcase - de
    // autorisatie-checks hierboven zijn nu altijd al gepasseerd voordat dit
    // ooit bereikt wordt (zie de toelichting bij het policy-veld hierboven).
    let policy = read_policy_account(&ctx.accounts.policy.to_account_info());
    let policy_allows = policy
        .as_ref()
        .map(|p| {
            p.allowed_programs[..p.count as usize]
                .iter()
                .any(|a| *a == cpi_program_id)
        })
        .unwrap_or(false);
    require!(policy_allows, SpankWalletError::ProgramNotAllowed);

    let vault_key = ctx.accounts.vault.key();

    let mut account_metas = Vec::with_capacity(ctx.remaining_accounts.len());
    let mut account_infos = Vec::with_capacity(ctx.remaining_accounts.len() + 1);

    for account_info in ctx.remaining_accounts.iter() {
        let is_vault = *account_info.key == vault_key;
        let is_signer = is_vault || account_info.is_signer;
        let is_writable = account_info.is_writable;

        account_metas.push(AccountMeta {
            pubkey: *account_info.key,
            is_signer,
            is_writable,
        });
        account_infos.push(account_info.clone());
    }

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
