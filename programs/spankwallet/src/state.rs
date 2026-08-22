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
    /// deserialisatie is offset-strikt. LET OP - GECORRIGEERD (STATUS.md
    /// sectie 85, na sectie 80/84's empirische controle): dit is GEEN
    /// fail-closed garantie voor een echt (`None`/`None`) account, zoals
    /// hier aanvankelijk stond. `WalletAccount::LEN`/`INIT_SPACE` is een
    /// compile-time worst-case (beide Options `Some` verondersteld), dus een
    /// gewoon `None`/`None`-account had al vóór deze fix nooit-beschreven
    /// nul-padding achterin zijn toegekende ruimte zitten - dit veld leest
    /// daar gewoon in en krijgt stilzwijgend `0` (fail-OPEN, geen fout).
    /// Alleen de synthetische Some/Some-unittest (`old_231_byte_...`) raakt
    /// écht de fysieke grens. Zie sectie 85 voor waarom dit desondanks geen
    /// replay-gat opende (nonce zit in de gesigneerde payload zelf) en voor
    /// de worst-case-analyse die wél bepaalt of dit structureel houdbaar is.
    pub action_nonce: u64,

    /// B2 (STATUS.md sectie 76, statische-audit-bevinding A2): monotoon
    /// verhogende teller, opgehoogd door finalize_recovery bij elke
    /// geslaagde recovery. Elke SessionKeyAccount draagt de epoch-waarde
    /// die gold op het moment van add_session_key - de _via_session-
    /// instructies eisen dat die nog exact gelijk is aan de HUIDIGE
    /// wallet.session_epoch, dus een recovery maakt in één klap ELKE
    /// bestaande sessiesleutel ongeldig (SessionRevokedByRecovery), zonder
    /// dat elke sessie individueel opgezocht/ingetrokken hoeft te worden.
    /// Bewust ACHTERAAN toegevoegd, nooit ertussenin. LET OP - GECORRIGEERD
    /// (STATUS.md sectie 85): dit is, net als action_nonce hierboven, GEEN
    /// fail-closed garantie voor een echt account - zelfde Option-padding-
    /// redenering, zelfde fail-open-uitkomst. (Oorspronkelijke, onjuiste
    /// tekst noemde hier ook nog het verkeerde bytegetal - 247 is de lengte
    /// MET dit veld, niet "van vóór deze fix"; dat was 239.) Zie sectie 85
    /// voor de volledige, per-account worst-case-analyse van zowel
    /// WalletAccount als SessionKeyAccount (die laatste heeft geen Option-
    /// velden en faalt hierop wél echt fail-closed).
    pub session_epoch: u64,
}

impl WalletAccount {
    // discriminator (8) + seed_key (33) + wallet_seed_hash (32) + owner_passkey (33) + bump (1)
    // + vault_bump (1) + created_at (8) + backup_authority (32)
    // + recovery_state option (1 + RecoveryState::LEN) + recovery_timelock_seconds (8)
    // + deposit_authority option (1 + 32) + action_nonce (8) + session_epoch (8)
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
        + 8
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

    /// B2 (STATUS.md sectie 76): stempel van wallet.session_epoch op het
    /// moment van add_session_key. De drie _via_session-instructies eisen
    /// dat dit nog exact gelijk is aan de HUIDIGE wallet.session_epoch -
    /// finalize_recovery hoogt die op, dus elke sessie die vóór een
    /// recovery is aangemaakt wordt daardoor in één klap ongeldig
    /// (SessionRevokedByRecovery), zonder individuele intrekking. Hoort NIET
    /// in de challenge-payload: de waarde komt van de keten zelf (de op dat
    /// moment geldende wallet.session_epoch), niet van de client, dus
    /// cryptografisch binden voegt niets toe. Bewust ACHTERAAN toegevoegd,
    /// nooit ertussenin - zelfde offset-strikte fail-closed-argument als
    /// elders in dit bestand: een bestaand, kortere-layout-account (421
    /// bytes, van vóór deze fix) faalt hierdoor SCHOON op deserialisatie
    /// i.p.v. een giswaarde voor epoch aan te nemen.
    pub epoch: u64,
}

impl SessionKeyAccount {
    // discriminator(8) + wallet(32) + session_key(32) + bump(1) + expiry_slot(8)
    // + can_execute(1) + can_transfer_token(1) + can_execute_advanced(1) + count(1)
    // + allowed_programs(32 * MAX_SESSION_PROGRAMS)
    // + max_lamports_per_tx(8) + max_lamports_total(8) + spent_lamports(8)
    // + token_mint(32) + max_token_amount_per_tx(8) + max_token_amount_total(8)
    // + spent_token_amount(8) + epoch(8)
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
        + 8
        + 8;
}

/// B3 (STATUS.md sectie 76, statische-audit-bevinding A3): maximale duur
/// (in slots) tussen `add_session_key`'s huidige slot en de gevraagde
/// expiry_slot. ~7 dagen bij Solana's nominale 400ms-slottijd
/// (1_512_000 * 0.4s = 604_800s = 7 dagen). Zonder deze grens zou B2's
/// epoch-mechanisme het enige verschil zijn tussen "een gecompromitteerde
/// sessiesleutel is achteraf intrekbaar" (via finalize_recovery of
/// remove_session_key) en "een sessiesleutel kan structureel niet meer
/// worden dichtgeplant" (een sessie die tientallen jaren geldig blijft,
/// buiten elk redelijk hersteltraject om, als de eigenaar de recovery-
/// route nooit gebruikt of pas laat ontdekt dat er een gecompromitteerde
/// sessie actief is). Een harde bovengrens dwingt af dat elke sessie
/// vroeg of laat vanzelf verloopt, ongeacht of iemand ooit ingrijpt.
pub const MAX_SESSION_DURATION_SLOTS: u64 = 1_512_000;

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AccountDeserialize, AccountSerialize};

    fn sample_wallet_for_layout_tests() -> WalletAccount {
        // recovery_state/deposit_authority bewust Some(...), niet None: Borsh
        // codeert Option::None altijd als 1 byte ongeacht T, dus alleen de
        // Some-tak geeft de volledige, WalletAccount::LEN-brede serialisatie
        // die deze tests nodig hebben om de layout-grenzen exact te simuleren.
        //
        // LET OP (STATUS.md sectie 85, na sectie 80/84's empirische controle
        // tegen echte devnet-accounts): precies DAAROM bewijzen de twee
        // tests hieronder GEEN fail-closed-garantie voor een echt account -
        // vrijwel elke echte WalletAccount is None/None (deposit_authority
        // kan in de huidige broncode zelfs nooit iets anders zijn dan None,
        // geen enkele instructie zet 'm op Some), en een None/None-account
        // leest een nieuw achteraan-veld gewoon uit nooit-beschreven
        // nul-padding - stilzwijgend een 0, geen deserialisatiefout. Deze
        // tests testen uitsluitend de theoretische Some/Some-grens (relevant
        // zodra/als Fase 2 deposit_authority ooit op Some zet), niet wat een
        // upgrade vandaag met een echt account doet.
        WalletAccount {
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
            session_epoch: 0,
        }
    }

    /// C-1-fix (STATUS.md sectie 69) - fail-closed migratieclaim, direct op
    /// Anchor/Borsh's eigen (de)serialisatie getest i.p.v. via een volledige
    /// on-chain-integratietest: een oude, 231-byte WalletAccount (van vóór
    /// zowel action_nonce als session_epoch toegevoegd werden) moet SCHOON
    /// falen tegen de HUIDIGE structuurdefinitie - geen giswaarde voor die
    /// velden, een echte deserialisatiefout. Native `cargo test` volstaat
    /// hiervoor (geen SBF-target/live validator nodig, puur Borsh-lengte-/
    /// offsetlogica). Slice-lengte bewust hardcoded op LEN - 16 (niet
    /// dynamisch tegen een lopend veldenaantal) zodat deze test dezelfde,
    /// oorspronkelijke 231-byte-grens blijft bewaken ongeacht hoeveel velden
    /// er later nog bijkomen - zie de aparte test hieronder voor de nieuwste
    /// (239-vs-247) grens specifiek.
    #[test]
    fn old_231_byte_wallet_account_fails_closed_against_current_layout() {
        let wallet = sample_wallet_for_layout_tests();

        let mut current_layout_bytes = Vec::new();
        wallet.try_serialize(&mut current_layout_bytes).unwrap();
        assert_eq!(current_layout_bytes.len(), WalletAccount::LEN);

        // De oorspronkelijke, vóór-C-1-fix layout is de huidige MINUS de 16
        // achteraan toegevoegde bytes van action_nonce (8) + session_epoch
        // (8), nooit ertussenin (zie beide veldcommentaren) - dus gewoon de
        // eerste (LEN - 16) bytes van een geldig, huidig account simuleren
        // een echt, bestaand, oorspronkelijk account.
        let old_layout_bytes = &current_layout_bytes[..WalletAccount::LEN - 16];
        assert_eq!(old_layout_bytes.len(), 231);

        let mut slice: &[u8] = old_layout_bytes;
        let result = WalletAccount::try_deserialize(&mut slice);
        assert!(
            result.is_err(),
            "een oude 231-byte WalletAccount had schoon moeten falen (fail-closed) tegen de huidige layout, niet stilzwijgend giswaarden moeten aannemen"
        );
    }

    /// B2 (STATUS.md sectie 76) - dezelfde fail-closed-garantie, nu specifiek
    /// voor de session_epoch-grens: een 239-byte WalletAccount (mét
    /// action_nonce, van vóór session_epoch) moet SCHOON falen tegen de
    /// huidige 247-byte layout.
    #[test]
    fn old_239_byte_wallet_account_fails_closed_against_current_layout() {
        let wallet = sample_wallet_for_layout_tests();

        let mut current_layout_bytes = Vec::new();
        wallet.try_serialize(&mut current_layout_bytes).unwrap();
        assert_eq!(current_layout_bytes.len(), WalletAccount::LEN);

        let old_layout_bytes = &current_layout_bytes[..WalletAccount::LEN - 8];
        assert_eq!(old_layout_bytes.len(), 239);

        let mut slice: &[u8] = old_layout_bytes;
        let result = WalletAccount::try_deserialize(&mut slice);
        assert!(
            result.is_err(),
            "een 239-byte WalletAccount (mét action_nonce, zonder session_epoch) had schoon moeten falen tegen de huidige 247-byte layout"
        );
    }

    fn sample_session_for_layout_tests() -> SessionKeyAccount {
        SessionKeyAccount {
            wallet: Pubkey::default(),
            session_key: Pubkey::default(),
            bump: 255,
            expiry_slot: 0,
            can_execute: true,
            can_transfer_token: false,
            can_execute_advanced: false,
            count: 0,
            allowed_programs: [Pubkey::default(); MAX_SESSION_PROGRAMS],
            max_lamports_per_tx: 0,
            max_lamports_total: 0,
            spent_lamports: 0,
            token_mint: Pubkey::default(),
            max_token_amount_per_tx: 0,
            max_token_amount_total: 0,
            spent_token_amount: 0,
            epoch: 0,
        }
    }

    /// B2 (STATUS.md sectie 76) - zelfde fail-closed-garantie als hierboven,
    /// nu voor SessionKeyAccount: een 421-byte account (van vóór epoch)
    /// moet SCHOON falen tegen de huidige 429-byte layout.
    #[test]
    fn old_421_byte_session_key_account_fails_closed_against_current_layout() {
        let session = sample_session_for_layout_tests();

        let mut current_layout_bytes = Vec::new();
        session.try_serialize(&mut current_layout_bytes).unwrap();
        assert_eq!(current_layout_bytes.len(), SessionKeyAccount::LEN);

        let old_layout_bytes = &current_layout_bytes[..SessionKeyAccount::LEN - 8];
        assert_eq!(old_layout_bytes.len(), 421);

        let mut slice: &[u8] = old_layout_bytes;
        let result = SessionKeyAccount::try_deserialize(&mut slice);
        assert!(
            result.is_err(),
            "een oude 421-byte SessionKeyAccount had schoon moeten falen (fail-closed) tegen de huidige 429-byte layout, niet stilzwijgend een giswaarde voor epoch moeten aannemen"
        );
    }
}
