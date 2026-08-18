// Lokaal beheerde fee-payer-keypair (Stronghold), zie STATUS.md /
// Tauri-migratie-ontwerp: dit sleuteltje betaalt uitsluitend
// transactiekosten. Geverifieerd tegen instructions.rs: geen enkele
// wallet-instructie controleert de identiteit van de fee-payer voor
// autorisatie - alleen de secp256r1-passkey-handtekening telt. Een
// gestolen fee-payer-key kan dus nooit wallet-fondsen verplaatsen, alleen
// zijn eigen SOL-saldo verliezen.
//
// Private-keymateriaal verlaat de Stronghold-vault nooit - alle interactie
// loopt via Procedures (GenerateKey/PublicKey/Ed25519Sign), niet via
// rechtstreeks uitgelezen bytes. Wachtwoord-afleiding via Argon2 (memory-
// hard KDF, niet Stronghold's eigen snelle Blake2b-optie), met een
// willekeurig, per-installatie-salt naast het snapshot-bestand.

use argon2::Argon2;
use iota_stronghold::{
    procedures::{Ed25519Sign, GenerateKey, KeyType, PublicKey},
    Client, KeyProvider, Location, SnapshotPath, Stronghold,
};
use rand::RngCore;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

const FEE_PAYER_CLIENT: &[u8] = b"spankwallet-fee-payer";
const FEE_PAYER_VAULT: &[u8] = b"fee-payer-vault";
const FEE_PAYER_KEY_RECORD: &[u8] = b"fee-payer-key";
const SNAPSHOT_FILE: &str = "fee-payer.stronghold";
const SALT_FILE: &str = "fee-payer.salt";
const SALT_LEN: usize = 16;

pub struct FeePayerState(pub Mutex<Option<Stronghold>>);

impl Default for FeePayerState {
    fn default() -> Self {
        FeePayerState(Mutex::new(None))
    }
}

#[derive(Serialize)]
pub struct FeePayerInfo {
    pub pubkey_base58: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum FeePayerError {
    AlreadySetUp,
    NotSetUp,
    WrongPasswordOrCorrupt,
    Io(String),
    Internal(String),
}

impl<E: std::fmt::Display> From<E> for FeePayerError
where
    E: std::error::Error,
{
    fn from(e: E) -> Self {
        FeePayerError::Internal(e.to_string())
    }
}

fn snapshot_path(app: &AppHandle) -> Result<PathBuf, FeePayerError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| FeePayerError::Io(e.to_string()))?;
    Ok(dir.join(SNAPSHOT_FILE))
}

fn salt_path(app: &AppHandle) -> Result<PathBuf, FeePayerError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| FeePayerError::Io(e.to_string()))?;
    Ok(dir.join(SALT_FILE))
}

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<Vec<u8>>, FeePayerError> {
    let mut key = Zeroizing::new(vec![0u8; 32]);
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;
    Ok(key)
}

fn load_or_create_salt(path: &Path) -> Result<Vec<u8>, FeePayerError> {
    if path.exists() {
        fs::read(path).map_err(|e| FeePayerError::Io(e.to_string()))
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| FeePayerError::Io(e.to_string()))?;
        }
        let mut salt = vec![0u8; SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        fs::write(path, &salt).map_err(|e| FeePayerError::Io(e.to_string()))?;
        Ok(salt)
    }
}

fn fee_payer_pubkey_location() -> Location {
    Location::generic(FEE_PAYER_VAULT.to_vec(), FEE_PAYER_KEY_RECORD.to_vec())
}

fn read_pubkey_base58(client: &Client) -> Result<String, FeePayerError> {
    let output = client
        .execute_procedure(PublicKey {
            ty: KeyType::Ed25519,
            private_key: fee_payer_pubkey_location(),
        })
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;
    let pubkey_bytes: [u8; 32] = output
        .try_into()
        .map_err(|_| FeePayerError::Internal("onverwachte publieke-sleutel-lengte".into()))?;
    Ok(bs58::encode(pubkey_bytes).into_string())
}

/// Eenmalig: genereert een nieuw Ed25519-fee-payer-keypair DIRECT in de
/// Stronghold-vault (verlaat de vault nooit) en persisteert het
/// versleutelde snapshot. Faalt expliciet als er al een snapshot bestaat -
/// gebruik unlock_fee_payer in dat geval.
#[tauri::command]
pub fn setup_fee_payer(
    app: AppHandle,
    state: State<'_, FeePayerState>,
    password: String,
) -> Result<FeePayerInfo, FeePayerError> {
    let snap_path = snapshot_path(&app)?;
    if snap_path.exists() {
        return Err(FeePayerError::AlreadySetUp);
    }

    let salt = load_or_create_salt(&salt_path(&app)?)?;
    let key = derive_key(&password, &salt)?;
    let key_provider = KeyProvider::try_from(key).map_err(|e| FeePayerError::Internal(e.to_string()))?;

    let stronghold = Stronghold::default();
    let client = stronghold
        .create_client(FEE_PAYER_CLIENT)
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;

    client
        .execute_procedure(GenerateKey {
            ty: KeyType::Ed25519,
            output: fee_payer_pubkey_location(),
        })
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;

    let pubkey_base58 = read_pubkey_base58(&client)?;

    let snapshot = SnapshotPath::from_path(&snap_path);
    stronghold
        .commit_with_keyprovider(&snapshot, &key_provider)
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;

    *state.0.lock().unwrap() = Some(stronghold);

    Ok(FeePayerInfo { pubkey_base58 })
}

/// Bij een bestaand snapshot: ontgrendelt met het opgegeven wachtwoord en
/// laadt de fee-payer-client in het geheugen voor deze sessie.
#[tauri::command]
pub fn unlock_fee_payer(
    app: AppHandle,
    state: State<'_, FeePayerState>,
    password: String,
) -> Result<FeePayerInfo, FeePayerError> {
    let snap_path = snapshot_path(&app)?;
    if !snap_path.exists() {
        return Err(FeePayerError::NotSetUp);
    }

    let salt = load_or_create_salt(&salt_path(&app)?)?;
    let key = derive_key(&password, &salt)?;
    let key_provider = KeyProvider::try_from(key).map_err(|e| FeePayerError::Internal(e.to_string()))?;

    let stronghold = Stronghold::default();
    let snapshot = SnapshotPath::from_path(&snap_path);
    let client = stronghold
        .load_client_from_snapshot(FEE_PAYER_CLIENT, &key_provider, &snapshot)
        .map_err(|_| FeePayerError::WrongPasswordOrCorrupt)?;

    let pubkey_base58 = read_pubkey_base58(&client)?;

    *state.0.lock().unwrap() = Some(stronghold);

    Ok(FeePayerInfo { pubkey_base58 })
}

/// Bevestigt of er al een fee-payer-snapshot bestaat op schijf - gebruikt
/// door de frontend om te bepalen of de setup- of de ontgrendel-kaart
/// getoond moet worden bij app-start.
#[tauri::command]
pub fn fee_payer_exists(app: AppHandle) -> Result<bool, FeePayerError> {
    Ok(snapshot_path(&app)?.exists())
}

/// Ondertekent `message` met het ontgrendelde fee-payer-keypair. De
/// private key verlaat de Stronghold-vault niet - alleen de resulterende
/// 64-byte Ed25519-handtekening komt terug. Wordt aangeroepen vanuit het
/// execute_action-command (nog te bouwen), niet rechtstreeks vanuit JS.
pub fn sign_with_fee_payer(
    state: &State<'_, FeePayerState>,
    message: Vec<u8>,
) -> Result<[u8; 64], FeePayerError> {
    let guard = state.0.lock().unwrap();
    let stronghold = guard.as_ref().ok_or(FeePayerError::NotSetUp)?;
    let client = stronghold
        .get_client(FEE_PAYER_CLIENT)
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;
    let output = client
        .execute_procedure(Ed25519Sign {
            msg: message,
            private_key: fee_payer_pubkey_location(),
        })
        .map_err(|e| FeePayerError::Internal(e.to_string()))?;
    output
        .try_into()
        .map_err(|_| FeePayerError::Internal("onverwachte handtekening-lengte".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    /// Bewijst het volledige rondje zonder Tauri AppHandle/State nodig te
    /// hebben (die zijn alleen dunne wrappers rond deze logica): aanmaken +
    /// committen -> een NIEUWE Stronghold-instantie (simuleert een app-
    /// herstart) laadt het snapshot met hetzelfde wachtwoord-afgeleide
    /// sleutel -> dezelfde publieke sleutel komt terug. Plus: een verkeerd
    /// wachtwoord wordt geweigerd, en een handtekening is daadwerkelijk
    /// cryptografisch geldig (onafhankelijk geverifieerd met ed25519-dalek,
    /// niet zomaar "er kwamen 64 bytes terug").
    #[test]
    fn setup_commit_reload_unlock_roundtrip_and_signature_is_valid() {
        let dir = tempfile::tempdir().unwrap();
        let snap_path = dir.path().join(SNAPSHOT_FILE);
        let salt = load_or_create_salt(&dir.path().join(SALT_FILE)).unwrap();

        let key = derive_key("correct horse battery staple", &salt).unwrap();
        let key_provider = KeyProvider::try_from(key).unwrap();

        // --- setup ---
        let stronghold = Stronghold::default();
        let client = stronghold.create_client(FEE_PAYER_CLIENT).unwrap();
        client
            .execute_procedure(GenerateKey {
                ty: KeyType::Ed25519,
                output: fee_payer_pubkey_location(),
            })
            .unwrap();
        let pubkey_at_setup = read_pubkey_base58(&client).unwrap();

        let snapshot = SnapshotPath::from_path(&snap_path);
        stronghold.commit_with_keyprovider(&snapshot, &key_provider).unwrap();
        assert!(snap_path.exists(), "snapshot-bestand moet op schijf staan na commit");

        // --- "app herstart": geheel nieuwe Stronghold-instantie, laadt vanaf schijf ---
        let reloaded = Stronghold::default();
        let reloaded_client = reloaded
            .load_client_from_snapshot(FEE_PAYER_CLIENT, &key_provider, &snapshot)
            .expect("laden met het juiste wachtwoord moet slagen");
        let pubkey_after_reload = read_pubkey_base58(&reloaded_client).unwrap();
        assert_eq!(
            pubkey_at_setup, pubkey_after_reload,
            "publieke sleutel moet identiek zijn na herladen vanaf snapshot"
        );

        // --- verkeerd wachtwoord moet geweigerd worden ---
        let wrong_key = derive_key("totaal ander wachtwoord", &salt).unwrap();
        let wrong_provider = KeyProvider::try_from(wrong_key).unwrap();
        let wrong_attempt = Stronghold::default();
        assert!(
            wrong_attempt
                .load_client_from_snapshot(FEE_PAYER_CLIENT, &wrong_provider, &snapshot)
                .is_err(),
            "laden met een verkeerd wachtwoord mag niet slagen"
        );

        // --- handtekening: echt cryptografisch geldig, onafhankelijk geverifieerd ---
        let message = b"execute: 1000000 lamports naar 11111111111111111111111111111111".to_vec();
        let sig_output = reloaded_client
            .execute_procedure(Ed25519Sign {
                msg: message.clone(),
                private_key: fee_payer_pubkey_location(),
            })
            .unwrap();
        let sig_bytes: [u8; 64] = sig_output.try_into().unwrap();

        let pubkey_bytes = bs58::decode(&pubkey_after_reload).into_vec().unwrap();
        let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes.try_into().unwrap()).unwrap();
        let signature = Signature::from_bytes(&sig_bytes);
        assert!(
            verifying_key.verify(&message, &signature).is_ok(),
            "handtekening moet cryptografisch geldig zijn voor de bijbehorende publieke sleutel"
        );

        // --- handtekening over een ANDER bericht moet NIET valideren ---
        let tampered = b"execute: 1000000 lamports naar AANVALLER111111111111111111111111".to_vec();
        assert!(
            verifying_key.verify(&tampered, &signature).is_err(),
            "een handtekening mag niet valideren voor een ander bericht dan waarover getekend is"
        );
    }
}
