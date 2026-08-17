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

    /// C-1-fix (STATUS.md sectie 69, externe-audit-bevinding): monotoon
    /// verhogende teller, meegebonden in ELKE passkey-ondertekende challenge
    /// (behalve init_wallet zelf, dat al structureel replay-proof is via de
    /// `init`-constraint op dit account). Maakt een eenmaal geldige,
    /// ondertekende actie permanent onbruikbaar voor een latere, herhaalde
    /// aanroep - zonder deze teller was de challenge volledig deterministisch
    /// (enkel program_id/wallet/domain/payload), dus een publiek zichtbare,
    /// eenmaal geldige transactie bleef voor altijd letterlijk herhaalbaar.
    /// Bewust ACHTERAAN toegevoegd, nooit ertussenin, zelfde reden als de
    /// spend-limits-velden op SessionKeyAccount (sectie 53): Anchor/Borsh-
    /// deserialisatie is offset-strikt, dus een bestaand, kortere-layout-
    /// account (231 bytes, van vóór deze fix) faalt hierdoor SCHOON op
    /// deserialisatie (AccountDidNotDeserialize, fail-closed) i.p.v. met een
    /// giswaarde ingelezen te worden. Geen migratie-instructie gebouwd - zie
    /// STATUS.md sectie 69 voor de expliciete, empirisch onderbouwde afweging.
    pub action_nonce: u64,
}

impl WalletAccount {
    // discriminator (8) + seed_key (33) + wallet_seed_hash (32) + owner_passkey (33) + bump (1)
    // + vault_bump (1) + created_at (8) + backup_authority (32)
    // + recovery_state option (1 + RecoveryState::LEN) + recovery_timelock_seconds (8)
    // + deposit_authority option (1 + 32) + action_nonce (8)
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
        + (1 + 32)
        + 8;
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

/// Maximum aantal programma-ID's dat een enkele wallet tegelijk op zijn
/// allowlist mag hebben (STATUS.md sectie 27). Vast array i.p.v. een
/// dynamische Vec: een dynamische lijst zou bij elke add_allowed_program
/// een Anchor `realloc` vereisen (extra rent-topup, en op remove geeft een
/// Vec geen rent terug zonder aparte, foutgevoelige boekhouding). Voor een
/// persoonlijke wallet-allowlist (een handvol gecureerde + handmatig
/// toegevoegde programma's, geen honderden) is een vast aantal slots
/// simpelweg goedkoper EN eenvoudiger: 32 * 32 bytes is triviale,
/// eenmalige rent (~0.008 SOL), zonder enige realloc-complexiteit.
pub const MAX_ALLOWED_PROGRAMS: usize = 32;

#[account]
pub struct PolicyAccount {
    /// De WalletAccount waarbij deze allowlist hoort.
    pub wallet: Pubkey,
    pub bump: u8,
    /// Aantal actief gevulde slots in allowed_programs, altijd aaneengesloten
    /// vanaf index 0 (geen gaten) - remove_allowed_program gebruikt
    /// swap-remove om dit invariant te bewaren.
    pub count: u8,
    pub allowed_programs: [Pubkey; MAX_ALLOWED_PROGRAMS],
}

impl PolicyAccount {
    // discriminator (8) + wallet (32) + bump (1) + count (1) + allowed_programs (32 * MAX)
    pub const LEN: usize = 8 + 32 + 1 + 1 + (32 * MAX_ALLOWED_PROGRAMS);
}

/// Maximum aantal EXTRA passkeys (naast wallet.owner_passkey) dat een wallet
/// tegelijk mag registreren. Net als MAX_ALLOWED_PROGRAMS een vast array
/// i.p.v. een dynamische Vec - zelfde rent-/eenvoud-afweging (STATUS.md):
/// passkeys zijn fysieke apparaten die een persoon bezit (telefoon, laptop,
/// losse hardware-sleutel, back-up) - niemand registreert er honderden. 8
/// extra (9 in totaal met owner_passkey) is ruim voldoende.
pub const MAX_ADDITIONAL_PASSKEYS: usize = 8;

#[account]
pub struct PasskeysAccount {
    /// De WalletAccount waarbij deze extra-passkeys-set hoort.
    pub wallet: Pubkey,
    pub bump: u8,
    /// Of de OORSPRONKELIJKE passkey (wallet.owner_passkey) nog geldig is.
    /// Laat toe die passkey op enig moment in te trekken (bijv. het
    /// oorspronkelijke apparaat kwijtgeraakt/gestolen) zonder
    /// WalletAccount's layout ooit aan te raken - zie STATUS.md voor de
    /// volledige motivatie (geen migratie-instructie nodig).
    pub owner_passkey_revoked: bool,
    /// Aantal actief gevulde slots in additional_passkeys, altijd
    /// aaneengesloten vanaf index 0 (geen gaten) - remove_passkey gebruikt
    /// swap-remove om dit invariant te bewaren, zelfde patroon als
    /// PolicyAccount.
    pub count: u8,
    pub additional_passkeys: [[u8; PASSKEY_PUBKEY_LEN]; MAX_ADDITIONAL_PASSKEYS],
}

impl PasskeysAccount {
    // discriminator(8) + wallet(32) + bump(1) + owner_passkey_revoked(1) + count(1)
    // + additional_passkeys(33 * MAX_ADDITIONAL_PASSKEYS)
    pub const LEN: usize =
        8 + 32 + 1 + 1 + 1 + (PASSKEY_PUBKEY_LEN * MAX_ADDITIONAL_PASSKEYS);
}

/// Maximum aantal programma-ID's dat een sessiesleutel tegelijk in zijn
/// EIGEN sub-scope mag hebben. Bewust kleiner dan MAX_ALLOWED_PROGRAMS (32):
/// een sessie hoort smal te zijn (een specifiek dApp/game-doel), niet de
/// volledige wallet-brede allowlist te herhalen - zie STATUS.md, ontwerppunt 2.
pub const MAX_SESSION_PROGRAMS: usize = 8;

/// Eigen PDA per sessie (`[b"session", wallet, session_key]`), bewust NIET
/// een satellite-lijst zoals PasskeysAccount/PolicyAccount - zie STATUS.md,
/// ontwerppunt 1. Sessies zijn kortlevend en potentieel talrijk (elke
/// dApp/game-visit), het omgekeerde profiel van passkeys/allowlist-entries:
/// een eigen PDA geeft rent die daadwerkelijk teruggewonnen wordt bij sluiten
/// (close_session/close_expired_session), O(1)-lookup via de sessiesleutel
/// zelf, en geen vooraf vastgelegd maximum aantal gelijktijdige sessies.
#[account]
pub struct SessionKeyAccount {
    /// De WalletAccount waarbij deze sessie hoort.
    pub wallet: Pubkey,
    /// De Ed25519-publieke sleutel van de sessie zelf (zie ontwerppunt 5) -
    /// impliciet al onderdeel van de PDA-seeds, maar hier expliciet ook
    /// opgeslagen t.b.v. client-side auditeerbaarheid (getProgramAccounts +
    /// memcmp op `wallet` geeft de adressen, niet de seeds zelf terug - een
    /// PDA-adres is niet terug te rekenen naar zijn seed-input).
    pub session_key: Pubkey,
    pub bump: u8,
    /// Absolute slot-hoogte waarna deze sessie niet meer geldig is
    /// (LazorKit-geinspireerd, zie ontwerppunt 1/5) - bewust een slot-hoogte,
    /// niet een unix-timestamp zoals recovery_timelock_seconds elders: een
    /// sessie-expiry meet een MAXIMALE geldigheidsvenster gekoppeld aan
    /// daadwerkelijke chain-progressie, geen minimale wachttijd in wall-clock
    /// tijd - goedkoper te vergelijken (Clock::get()?.slot is direct
    /// beschikbaar, geen afgeleide rekensom) en ongevoelig voor
    /// validator-klokdrift.
    pub expiry_slot: u64,
    /// Instructiesoort-scope (ontwerppunt 3) - een sessie mag NOOIT
    /// add_passkey/remove_passkey/add_allowed_program/remove_allowed_program/
    /// initiate_recovery/cancel_recovery/hunt/add_session_key/
    /// remove_session_key ondertekenen, uitsluitend de drie "spend"-acties
    /// hieronder, en dan nog alleen de acties waarvoor de eigenaar dit
    /// specifieke vlag expliciet heeft aangezet bij add_session_key.
    pub can_execute: bool,
    pub can_transfer_token: bool,
    pub can_execute_advanced: bool,
    /// Aantal actief gevulde slots in allowed_programs, altijd aaneengesloten
    /// vanaf index 0 - alleen relevant/gevuld als can_execute_advanced true
    /// is (add_session_key eist een lege lijst als can_execute_advanced
    /// false is, zie instructions.rs).
    pub count: u8,
    /// Sub-scope voor execute_advanced_via_session (ontwerppunt 2) - moet bij
    /// aanmaak een subset zijn van de op dat moment geldende
    /// PolicyAccount.allowed_programs, EN wordt bij elk gebruik OPNIEUW
    /// herverifieerd tegen de dan geldende PolicyAccount (niet gecached) -
    /// een programma van de wallet-brede allowlist verwijderen moet
    /// onmiddellijk ook bestaande sessies raken.
    pub allowed_programs: [Pubkey; MAX_SESSION_PROGRAMS],

    // --- Spend-limits (STATUS.md, spend-limits-ontwerpdocument) ---
    // Bewust ACHTERAAN toegevoegd, nooit ertussenin: Anchor/Borsh-
    // deserialisatie is offset-strikt. Bestaande, kleinere accounts (oude
    // layout, 341 bytes) falen hierdoor SCHOON op deserialisatie (fail-
    // closed) i.p.v. dat elk veld na een tussenvoeging stilzwijgend uit de
    // verkeerde bytes zou worden gelezen. Geen enkel veld hier heeft een
    // impliciete default die "onbeperkt" betekent - 0 is altijd een
    // letterlijke waarde ("nul toegestaan"), nooit een sentinel.
    /// Maximum lamports die één enkele execute_via_session-aanroep mag
    /// verplaatsen. Verplicht ingesteld bij add_session_key, geen default.
    pub max_lamports_per_tx: u64,
    /// Maximum cumulatieve lamports die deze sessie in TOTAAL over haar
    /// hele levensduur mag verplaatsen via execute_via_session.
    pub max_lamports_total: u64,
    /// Reeds verplaatste lamports via execute_via_session, opgehoogd met
    /// checked_add binnen dezelfde instructie die de transfer uitvoert
    /// (atomisch, geen TOCTOU-gat - zie het ontwerpdocument).
    pub spent_lamports: u64,

    /// De ENIGE SPL-mint die deze sessie mag verplaatsen via
    /// transfer_token_via_session - Pubkey::default() tenzij
    /// can_transfer_token true is. Zonder deze pin zou een enkele
    /// mint-onafhankelijke teller betekenisloos zijn (verschillende mints
    /// hebben verschillende decimalen/waarde) - zie het ontwerpdocument.
    pub token_mint: Pubkey,
    /// Maximum tokens (in de kleinste eenheid van `token_mint`) die één
    /// enkele transfer_token_via_session-aanroep mag verplaatsen.
    pub max_token_amount_per_tx: u64,
    /// Maximum cumulatieve tokens die deze sessie in TOTAAL mag verplaatsen.
    pub max_token_amount_total: u64,
    /// Reeds verplaatste tokens via transfer_token_via_session, zelfde
    /// atomische checked_add-patroon als spent_lamports.
    pub spent_token_amount: u64,
}

impl SessionKeyAccount {
    // discriminator(8) + wallet(32) + session_key(32) + bump(1) + expiry_slot(8)
    // + can_execute(1) + can_transfer_token(1) + can_execute_advanced(1) + count(1)
    // + allowed_programs(32 * MAX_SESSION_PROGRAMS)
    // + max_lamports_per_tx(8) + max_lamports_total(8) + spent_lamports(8)
    // + token_mint(32) + max_token_amount_per_tx(8) + max_token_amount_total(8)
    // + spent_token_amount(8)
    pub const LEN: usize = 8
        + 32
        + 32
        + 1
        + 8
        + 1
        + 1
        + 1
        + 1
        + (32 * MAX_SESSION_PROGRAMS)
        + 8
        + 8
        + 8
        + 32
        + 8
        + 8
        + 8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    /// C-1-fix (STATUS.md sectie 69) - fail-closed migratieclaim, direct op
    /// Anchor/Borsh's eigen (de)serialisatie getest i.p.v. via een volledige
    /// on-chain-integratietest: een oude, 231-byte WalletAccount (van vóór
    /// action_nonce toegevoegd werd) moet SCHOON falen tegen de nieuwe,
    /// 239-byte structuurdefinitie - geen giswaarde voor action_nonce, een
    /// echte deserialisatiefout. Native `cargo test` volstaat hiervoor (geen
    /// SBF-target/live validator nodig, puur Borsh-lengte-/offsetlogica).
    #[test]
    fn old_231_byte_wallet_account_fails_closed_against_new_239_byte_layout() {
        // recovery_state/deposit_authority bewust Some(...), niet None: Borsh
        // codeert Option::None altijd als 1 byte ongeacht T, dus alleen de
        // Some-tak geeft de volledige, WalletAccount::LEN-brede serialisatie
        // die deze test nodig heeft om de oude-vs-nieuwe-layout-grens exact
        // op byte 231 te simuleren.
        let wallet = WalletAccount {
            seed_key: [2u8; PASSKEY_PUBKEY_LEN],
            wallet_seed_hash: [0u8; 32],
            owner_passkey: [2u8; PASSKEY_PUBKEY_LEN],
            bump: 255,
            vault_bump: 255,
            created_at: 0,
            backup_authority: Pubkey::default(),
            recovery_state: Some(RecoveryState {
                initiated_at: 0,
                new_owner_passkey: [2u8; PASSKEY_PUBKEY_LEN],
            }),
            recovery_timelock_seconds: DEFAULT_RECOVERY_TIMELOCK_SECONDS,
            deposit_authority: Some(Pubkey::default()),
            action_nonce: 0,
        };

        let mut current_layout_bytes = Vec::new();
        wallet.try_serialize(&mut current_layout_bytes).unwrap();
        assert_eq!(current_layout_bytes.len(), WalletAccount::LEN);

        // De oude layout is exact de nieuwe MINUS de 8 achteraan toegevoegde
        // action_nonce-bytes (nooit ertussenin, zie het veld-commentaar
        // hierboven) - dus gewoon de eerste (LEN - 8) bytes van een geldig,
        // huidig account simuleren een echt, bestaand vóór-de-fix account.
        let old_layout_bytes = &current_layout_bytes[..WalletAccount::LEN - 8];
        assert_eq!(old_layout_bytes.len(), 231);

        let mut slice: &[u8] = old_layout_bytes;
        let result = WalletAccount::try_deserialize(&mut slice);
        assert!(
            result.is_err(),
            "een oude 231-byte WalletAccount had schoon moeten falen (fail-closed) tegen de nieuwe 239-byte layout, niet stilzwijgend een giswaarde voor action_nonce moeten aannemen"
        );
    }
}
