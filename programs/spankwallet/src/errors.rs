use anchor_lang::prelude::*;

#[error_code]
pub enum SpankWalletError {
    #[msg("wallet_seed_hash komt niet overeen met SHA-256(seed_key)")]
    InvalidWalletSeedHash,

    #[msg("Het WebAuthn-challenge-veld ontbreekt in clientDataJSON")]
    MissingWebAuthnChallenge,

    #[msg("Het WebAuthn-challenge komt niet overeen met de verwachte, domain-gebonden hash")]
    WebAuthnChallengeMismatch,

    #[msg("De secp256r1-precompile ondertekende niet authenticatorData || SHA-256(clientDataJSON)")]
    WebAuthnMessageHashMismatch,

    #[msg("secp256r1 precompile-verificatie ontbreekt of komt niet overeen met owner_passkey")]
    InvalidPasskeySignature,

    #[msg("Meegegeven incinerator-account komt niet overeen met het vaste, verwachte adres")]
    InvalidIncineratorAccount,

    #[msg("Onverwachte lamport-boekhouding bij het splitsen van teruggewonnen rent in hunt")]
    RentAccountingOverflow,

    #[msg("Er loopt al een recovery-verzoek voor deze wallet")]
    RecoveryAlreadyInProgress,

    #[msg("Er loopt geen recovery-verzoek om te annuleren of af te ronden")]
    NoRecoveryInProgress,

    #[msg("Recovery-tijdslot is nog niet verstreken")]
    RecoveryTimelockNotElapsed,

    #[msg("Ed25519-handtekening van backup_authority ontbreekt of is ongeldig")]
    InvalidBackupAuthoritySignature,

    #[msg("Deze mint staat niet in de door de client opgegeven hunt-lijst als spam")]
    MintNotInHuntList,

    #[msg("Fee-inbox (deposit_authority) is nog niet actief - fase 2 functionaliteit")]
    DepositGateNotActive,

    #[msg("Onvoldoende fee betaald voor gated deposit")]
    InsufficientDepositFee,

    #[msg("Ongeldig secp256r1-publieke-sleutel-prefix - moet 0x02 of 0x03 zijn (gecomprimeerd punt)")]
    InvalidPasskeyPrefix,

    #[msg("target_token_account is geen Associated Token Account van deze vault voor deze mint")]
    InvalidTargetTokenAccount,

    #[msg("Onverwachte lamport-boekhouding bij transfer_sol in execute")]
    ExecuteTransferOverflow,

    #[msg("Deze overdracht zou de vault onder zijn rent-exempte minimum laten zakken")]
    VaultWouldFallBelowRentExempt,

    #[msg("Onverwachte tijdstempel-overflow bij het berekenen van verstreken recovery-tijd")]
    TimestampOverflow,
}
