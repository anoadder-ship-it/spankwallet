use anchor_lang::prelude::*;

#[error_code]
pub enum ActiveDefenseError {
    #[msg("Deze ontvanger staat niet op de authorized-lijst van dit poison token")]
    PoisonTokenUnauthorizedRecipient,

    #[msg("Dit adres staat al op de authorized-lijst van dit poison token")]
    PoisonTokenRecipientAlreadyAuthorized,

    #[msg("Dit adres staat niet op de authorized-lijst van dit poison token")]
    PoisonTokenRecipientNotAuthorized,

    #[msg("De authorized-lijst van dit poison token zit vol")]
    PoisonTokenAuthorizedListFull,

    #[msg("Dit poison token is al geactiveerd - verdere transfers zijn geblokkeerd")]
    PoisonTokenAlreadyTriggered,

    #[msg("Dit adres is gemarkeerd als malitieus - transactie geblokkeerd")]
    MaliciousAddressBlocked,

    #[msg("Dit adres staat al op de malitieuse-lijst van deze wallet")]
    AddressAlreadyMalicious,

    #[msg("Dit adres staat niet op de malitieuse-lijst van deze wallet")]
    AddressNotMalicious,

    #[msg("De malitieuse-lijst van deze wallet zit vol")]
    MaliciousListFull,

    #[msg("WebAuthn-challenge ontbreekt in clientDataJSON")]
    MissingWebAuthnChallenge,

    #[msg("WebAuthn-challenge komt niet overeen met de verwachte hash")]
    WebAuthnChallengeMismatch,

    #[msg("secp256r1-precompile verificatie mislukt")]
    InvalidPasskeySignature,

    #[msg("Ongeldig secp256r1-publieke-sleutel-prefix")]
    InvalidPasskeyPrefix,

    #[msg("De authenticator heeft geen User Verification bevestigd")]
    UserVerificationRequired,

    #[msg("clientDataJSON bevat geen webauthn.get type")]
    InvalidWebAuthnType,

    #[msg("Onverwachte overflow")]
    Overflow,
}
