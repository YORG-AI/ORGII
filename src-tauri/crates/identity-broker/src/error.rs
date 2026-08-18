use thiserror::Error;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum CredentialStoreError {
    #[error("the secure credential store is locked")]
    Locked,
    #[error("the secure credential store is unavailable")]
    Unavailable,
    #[error("secure credential {operation} failed")]
    OperationFailed { operation: &'static str },
}

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("invalid identity input: {0}")]
    InvalidInput(&'static str),
    #[error("identity metadata is invalid: {0}")]
    InvalidMetadata(&'static str),
    #[error("identity metadata {operation} failed")]
    MetadataIo {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("identity metadata serialization failed")]
    MetadataSerialization(#[source] serde_json::Error),
    #[error(transparent)]
    CredentialStore(#[from] CredentialStoreError),
    #[error("secure credential read-back did not match the submitted credential")]
    CredentialVerificationFailed,
    #[error("identity operation was superseded by a newer operation")]
    Superseded,
    #[error("could not obtain cryptographically secure randomness")]
    RandomnessUnavailable,
    #[error("identity sign-in flow was not found")]
    FlowNotFound,
    #[error("identity sign-in callback was already consumed")]
    CallbackAlreadyConsumed,
    #[error("identity sign-in callback expired")]
    CallbackExpired,
    #[error("identity sign-in callback state did not match")]
    StateMismatch,
    #[error("identity sign-in callback was invalid")]
    InvalidCallback,
    #[error("identity sign-in was denied")]
    AuthorizationDenied,
    #[error("identity sign-in flow is in an invalid phase")]
    InvalidFlowPhase,
    #[error("identity session was not found")]
    SessionNotFound,
    #[error("identity session requires sign-in")]
    ReauthRequired,
}

impl BrokerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalid_input",
            Self::InvalidMetadata(_) => "invalid_metadata",
            Self::MetadataIo { .. } => "metadata_io_failed",
            Self::MetadataSerialization(_) => "metadata_serialization_failed",
            Self::CredentialStore(CredentialStoreError::Locked) => "secure_store_locked",
            Self::CredentialStore(CredentialStoreError::Unavailable) => "secure_store_unavailable",
            Self::CredentialStore(CredentialStoreError::OperationFailed { .. }) => {
                "secure_store_operation_failed"
            }
            Self::CredentialVerificationFailed => "credential_verification_failed",
            Self::Superseded => "superseded",
            Self::RandomnessUnavailable => "randomness_unavailable",
            Self::FlowNotFound => "flow_not_found",
            Self::CallbackAlreadyConsumed => "callback_already_consumed",
            Self::CallbackExpired => "callback_expired",
            Self::StateMismatch => "state_mismatch",
            Self::InvalidCallback => "invalid_callback",
            Self::AuthorizationDenied => "authorization_denied",
            Self::InvalidFlowPhase => "invalid_flow_phase",
            Self::SessionNotFound => "identity_session_not_found",
            Self::ReauthRequired => "identity_reauth_required",
        }
    }
}
