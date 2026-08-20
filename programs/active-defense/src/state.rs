use anchor_lang::prelude::*;

/// Maximum aantal geautoriseerde ontvangers per poison token.
pub const MAX_POISON_AUTHORIZED: usize = 16;

#[account]
pub struct PoisonTokenAccount {
    /// De spankwallet WalletAccount PDA waarbij deze poison token hoort.
    pub wallet: Pubkey,
    /// De Token-2022 mint van het poison token.
    pub mint: Pubkey,
    /// PDA bump voor deze account.
    pub bump: u8,
    /// Aantal actief gevulde slots in authorized_recipients.
    pub count: u8,
    /// Geautoriseerde ontvangers. Alleen transfers naar deze adressen zijn toegestaan.
    pub authorized_recipients: [Pubkey; MAX_POISON_AUTHORIZED],
    /// Of het poison token al is geactiveerd (onherroepelijk).
    pub triggered: bool,
    /// Timestamp van de activering (als triggered == true).
    pub triggered_at: i64,
}

impl PoisonTokenAccount {
    // discriminator(8) + wallet(32) + mint(32) + bump(1) + count(1)
    // + authorized_recipients(32 * 16) + triggered(1) + triggered_at(8)
    pub const LEN: usize = 8 + 32 + 32 + 1 + 1 + (32 * MAX_POISON_AUTHORIZED) + 1 + 8;
}

/// Maximum aantal malitieuse adressen per wallet.
pub const MAX_MALICIOUS_ADDRESSES: usize = 32;

#[account]
pub struct MaliciousAddressesAccount {
    /// De spankwallet WalletAccount PDA waarbij deze lijst hoort.
    pub wallet: Pubkey,
    /// PDA bump voor deze account.
    pub bump: u8,
    /// Aantal actief gevulde slots in addresses.
    pub count: u8,
    /// Malitieuse adressen.
    pub addresses: [Pubkey; MAX_MALICIOUS_ADDRESSES],
}

impl MaliciousAddressesAccount {
    // discriminator(8) + wallet(32) + bump(1) + count(1) + addresses(32 * 32)
    pub const LEN: usize = 8 + 32 + 1 + 1 + (32 * MAX_MALICIOUS_ADDRESSES);
}
