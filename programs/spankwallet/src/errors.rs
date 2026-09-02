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

    #[msg("vault_token_account is geen Associated Token Account van deze vault voor deze mint")]
    InvalidVaultTokenAccount,

    #[msg("recipient_token_account hoort niet bij de opgegeven mint")]
    InvalidRecipientTokenAccount,

    #[msg("Onverwachte tijdstempel-overflow bij het berekenen van verstreken recovery-tijd")]
    TimestampOverflow,

    #[msg("Dit programma-ID staat al op de allowlist van deze wallet")]
    ProgramAlreadyAllowed,

    #[msg("Dit programma-ID staat niet op de allowlist van deze wallet")]
    ProgramNotAllowed,

    #[msg("De allowlist van deze wallet zit vol (maximum aantal programma's bereikt)")]
    AllowlistFull,

    #[msg("SpankWallet zelf mag nooit op de eigen allowlist staan of als CPI-doel dienen")]
    SelfCpiNotAllowed,

    #[msg("Het opgegeven CPI-doelaccount is geen uitvoerbaar (executable) programma-account")]
    CpiTargetNotExecutable,

    #[msg("De authenticator heeft geen User Verification (biometrie/PIN) bevestigd voor deze handtekening")]
    UserVerificationRequired,

    #[msg("clientDataJSON bevat geen \"type\":\"webauthn.get\" - vereist om cross-ceremony-typeverwarring te voorkomen")]
    InvalidWebAuthnType,

    #[msg("Deze passkey staat al geregistreerd op deze wallet")]
    PasskeyAlreadyRegistered,

    #[msg("Deze passkey staat niet geregistreerd op deze wallet")]
    PasskeyNotRegistered,

    #[msg("Het maximum aantal extra passkeys op deze wallet is bereikt")]
    AdditionalPasskeysFull,

    #[msg("Kan de laatste geldige passkey van deze wallet niet verwijderen - zou de wallet onbereikbaar maken")]
    CannotRemoveLastPasskey,

    #[msg("Deze sessiesleutel is verlopen (voorbij expiry_slot)")]
    SessionExpired,

    #[msg("Deze sessiesleutel is nog niet verlopen - kan nog niet permissionless opgeruimd worden")]
    SessionNotYetExpired,

    #[msg("expiry_slot moet in de toekomst liggen (na de huidige slot)")]
    SessionExpirySlotNotInFuture,

    #[msg("Deze sessiesleutel is niet gescoped voor deze instructiesoort")]
    SessionInstructionNotAllowed,

    #[msg("Dit programma-ID staat niet in de eigen sub-allowlist van deze sessiesleutel")]
    SessionProgramNotAllowed,

    #[msg("De sub-allowlist van deze sessiesleutel zit vol (maximum aantal programma's bereikt)")]
    SessionAllowlistFull,

    #[msg("Dit bedrag overschrijdt de maximale lamports/tokens per transactie van deze sessiesleutel")]
    SessionSpendPerTxExceeded,

    #[msg("Dit bedrag zou de cumulatieve sessie-limiet van deze sessiesleutel overschrijden")]
    SessionSpendTotalExceeded,

    #[msg("Onverwachte overflow bij het optellen van het verplaatste bedrag op deze sessiesleutel")]
    SessionSpendOverflow,

    #[msg("Deze mint komt niet overeen met de mint waarop deze sessiesleutel is vastgepind")]
    SessionTokenMintNotAllowed,

    #[msg("token_mint is verplicht wanneer can_transfer_token true is")]
    SessionTokenMintRequired,

    #[msg("Deze actie is ondertekend met een verouderde action_nonce - er is inmiddels een andere actie op dit wallet bevestigd, probeer opnieuw")]
    StaleActionNonce,

    #[msg("Onverwachte overflow bij het verhogen van action_nonce")]
    ActionNonceOverflow,

    #[msg("Deze sessiesleutel is ingetrokken door een recovery - maak een nieuwe sessie aan")]
    SessionRevokedByRecovery,

    #[msg("Onverwachte overflow bij het verhogen van session_epoch")]
    SessionEpochOverflow,

    #[msg("expiry_slot ligt te ver in de toekomst - een sessie mag maximaal MAX_SESSION_DURATION_SLOTS geldig zijn")]
    SessionDurationTooLong,

    // --- Spend-cap-mechanisme (STATUS.md sectie 115/116) ---
    #[msg("De tweede, bevestigende handtekening moet van een ANDERE passkey komen dan degene die deze actie initieerde")]
    SecondPasskeyMustDifferFromInitiator,

    #[msg("Deze pending action is aangemaakt vóór de laatste recovery en is daardoor niet meer geldig - annuleer 'm en dien opnieuw in")]
    PendingActionStaleEpoch,

    #[msg("Deze pending action vereist nog een bevestiging van een tweede, andere passkey voordat hij afgerond kan worden")]
    PendingActionNotConfirmed,

    #[msg("Het wachttijdslot van deze pending action is nog niet verstreken")]
    PendingActionTimelockNotElapsed,

    #[msg("De opgegeven waarden komen niet overeen met wat oorspronkelijk voor deze pending action geautoriseerd is")]
    PendingActionCommitmentMismatch,

    #[msg("Deze wallet staat in noodstop (disarmed) - roep eerst rearm_wallet aan")]
    WalletDisarmed,

    #[msg("Dit bedrag zou de cumulatieve bestedingslimiet van het huidige glijdende venster overschrijden - gebruik initiate_withdrawal in plaats daarvan")]
    SpendWindowExceeded,

    // Toegevoegd tijdens STATUS.md sectie 132/133/134 (stap B, stap c):
    // zelfde patroon als SessionSpendOverflow - checked_add faalt in de
    // praktijk alleen bij een astronomisch grote spent_lamports_this_window
    // (nabij u64::MAX), maar de optelling mag nooit stilzwijgend
    // overlopen/paniekeren.
    #[msg("Onverwachte overflow bij het optellen van het bedrag binnen het huidige glijdende venster")]
    SpendWindowOverflow,

    // Toegevoegd tijdens sectie 118 (stap 4, initiate_withdrawal) - ontbrak
    // in de oorspronkelijke lijst van zeven uit sectie 117: nodig om sectie
    // 115 punt 1's eigen eis af te dwingen ("controleer of dit bedrag
    // uberhaupt de wachtrij in moet"), zie STATUS.md sectie 118 voor de
    // volledige toelichting op deze afwijking van de stap-3-scope.
    #[msg("Dit bedrag ligt onder of op spend_threshold_lamports - gebruik execute rechtstreeks in plaats van de wachtrij")]
    AmountEligibleForInstantExecute,

    // Toegevoegd tijdens STATUS.md sectie 127/128 (stap A, Route 2): de
    // OMGEKEERDE richting van AmountEligibleForInstantExecute - samen
    // partitioneren de twee foutcodes het volledige bedragbereik zodra een
    // wallet een niet-nul spend_threshold_lamports heeft: een bedrag hoort
    // dan bij PRECIES één van de twee paden, nooit bij beide, nooit bij
    // geen van beide. `execute`/`hunt` gooien deze fout als het bedrag
    // BOVEN de drempel ligt (hoort in de wachtrij, via
    // initiate_withdrawal); `initiate_withdrawal` gooit
    // AmountEligibleForInstantExecute als het bedrag OP of ONDER de
    // drempel ligt (hoort rechtstreeks via execute). Bij
    // spend_threshold_lamports == 0 (de fail-safe default, sectie 115)
    // wordt deze fout nooit gegooid - 0 is een sentinel voor "geen drempel
    // geconfigureerd", geen letterlijke bovengrens, zie sectie 127.
    #[msg("Dit bedrag ligt boven spend_threshold_lamports - gebruik initiate_withdrawal om het via de wachtrij te laten verlopen")]
    AmountExceedsInstantThreshold,

    // Toegevoegd tijdens STATUS.md sectie 127-131 (vervolg op stap A): waar
    // execute/hunt drempel=0 als sentinel-uitweg hadden (bestaand gedrag
    // volledig ongewijzigd), bestaat zo'n uitweg hier NIET - er is geen
    // betrouwbare vergelijking tussen een lamport-drempel en een
    // willekeurig SPL-tokenbedrag of ondoorzichtige CPI-instructiedata
    // (sectie 115). transfer_token weigert daarom ONVOORWAARDELIJK, altijd,
    // ongeacht bedrag - een harde knip, geen geleidelijke overgang. Raakt
    // NIET transfer_token_via_session (bewust gedupliceerde, losstaande
    // implementatie met een eigen autorisatiepad via sessiesleutels, zie
    // sectie 131).
    #[msg("transfer_token is permanent geblokkeerd voor directe aanroep - gebruik initiate_token_transfer/finalize_token_transfer")]
    TransferMustUseQueue,

    // Zelfde onvoorwaardelijke redenering als TransferMustUseQueue
    // hierboven, voor execute_advanced - een willekeurige CPI naar een
    // extern programma is nog minder vergelijkbaar met een lamport-drempel
    // dan een tokenbedrag. Raakt NIET execute_advanced_via_session (zelfde
    // reden als hierboven).
    #[msg("execute_advanced is permanent geblokkeerd voor directe aanroep - gebruik initiate_advanced_action/finalize_advanced_action")]
    AdvancedActionMustUseQueue,
}
