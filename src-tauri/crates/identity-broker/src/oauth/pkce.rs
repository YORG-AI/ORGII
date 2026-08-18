use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, TryRngCore};
use sha2::{Digest, Sha256};

use crate::{BrokerError, SecretBytes};

pub(crate) struct PkceMaterial {
    pub verifier: SecretBytes,
    pub challenge: String,
    pub nonce: String,
}

pub(crate) fn create_pkce_material() -> Result<PkceMaterial, BrokerError> {
    let mut verifier_entropy = [0_u8; 32];
    let mut state_entropy = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut verifier_entropy)
        .map_err(|_| BrokerError::RandomnessUnavailable)?;
    OsRng
        .try_fill_bytes(&mut state_entropy)
        .map_err(|_| BrokerError::RandomnessUnavailable)?;

    let verifier = URL_SAFE_NO_PAD.encode(verifier_entropy);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let nonce = URL_SAFE_NO_PAD.encode(state_entropy);
    Ok(PkceMaterial {
        verifier: SecretBytes::new(verifier.into_bytes()),
        challenge,
        nonce,
    })
}
