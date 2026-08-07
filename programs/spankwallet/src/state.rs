use anchor_lang::prelude::*;

/// secp256r1 (P-256) publieke sleutel zoals gebruikt door WebAuthn/passkeys.
/// Gecomprimeerde puntrepresentatie: 1 byte prefix + 32 bytes X-coördinaat.
pub const PASSKEY_PUBKEY_LEN: usize = 33;

/// Ontwerpdocument v0.2 §3.1a — default 72 uur, door owner aanpasbaar.
pub const DEFAULT_RECOVERY_TIMELOCK_SECONDS: i64 = 259_200;

#[account]
pub struct WalletAccount {
    /// Onveranderlijke sleutel, uitsluitend gebruikt voor PDA-derivatie.
    /// Dit is de passkey waarmee de wallet ooit is aangemaakt — blijft
    /// hetzelfde over de hele levensduur, ook na een recovery. Zonder dit
    /// veld zou `finalize_recovery` de PDA-adressering breken, omdat
    /// `owner_passkey` daar juist muteert (kritieke fout ontdekt tijdens
    /// scaffolding, zie commit-notitie).
    pub seed_key: [u8; PASSKEY_PUBKEY_LEN],

    /// SHA-256-hash van `seed_key`, altijd exact 32 bytes. Solana's PDA-seeds
    /// hebben een harde limiet van 32 bytes per los seed-component
    /// (MAX_SEED_LEN) — de 33-byte gecomprimeerde secp256r1-sleutel zelf kan
    /// dus NOOIT rechtstreeks als seed dienen. Dit veld is de daadwerkelijke
    /// seed-waarde voor de "wallet"-PDA, apart bewaard zodat elke instructie
    /// na `init_wallet` het simpelweg uit het account kan lezen in plaats van
    /// steeds opnieuw te hashen (kritieke fout ontdekt bij de eerste
    /// TS-clienttest, zie README).
    pub wallet_seed_hash: [u8; 32],

    /// Huidige actieve passkey-authority. Enige sleutel die `execute` mag aanroepen.
    /// Muteert bij een succesvolle recovery.
    pub owner_passkey: [u8; PASSKEY_PUBKEY_LEN],

    /// PDA bump voor deze account.
    pub bump: u8,

    /// PDA bump voor de gekoppelde VaultAccount.
    pub vault_bump: u8,

    pub created_at: i64,

    /// Offline noodsleutel (Ed25519). Alleen de public key staat on-chain.
    /// Zie v0.2 §3.1a — nooit gebruikt voor dagelijks spenden, alleen recovery.
    pub backup_authority: Pubkey,

    /// Actief herstelverzoek, indien lopend. None = geen recovery bezig.
    pub recovery_state: Option<RecoveryState>,

    /// Duur van het recovery-tijdslot in seconden. Default 72u (zie constante hierboven).
    pub recovery_timelock_seconds: i64,

    /// v0.2 §3.3 — voorbereiding fase 2. In fase 1 altijd None (permissionless deposits,
    /// gedraagt zich als een normale wallet). Fase 2 activeert dit veld.
    pub deposit_authority: Option<Pubkey>,
}

impl WalletAccount {
    // discriminator (8) + seed_key (33) + wallet_seed_hash (32) + owner_passkey (33) + bump (1)
    // + vault_bump (1) + created_at (8) + backup_authority (32)
    // + recovery_state option (1 + RecoveryState::LEN) + recovery_timelock_seconds (8)
    // + deposit_authority option (1 + 32)
    pub const LEN: usize = 8
        + PASSKEY_PUBKEY_LEN
        + 32
        + PASSKEY_PUBKEY_LEN
        + 1
        + 1
        + 8
        + 32
        + (1 + RecoveryState::LEN)
        + 8
        + (1 + 32);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RecoveryState {
    pub initiated_at: i64,
    pub new_owner_passkey: [u8; PASSKEY_PUBKEY_LEN],
}

impl RecoveryState {
    pub const LEN: usize = 8 + PASSKEY_PUBKEY_LEN;
}

#[account]
pub struct VaultAccount {
    /// De WalletAccount die over deze vault mag signeren.
    pub wallet: Pubkey,
    pub bump: u8,
}

impl VaultAccount {
    pub const LEN: usize = 8 + 32 + 1;
}
