//! Tauri-independent identity/session ownership for the ORGII desktop app.
//!
//! The broker deliberately exposes only non-sensitive snapshots. Refresh
//! credentials cross the boundary only through [`CredentialStore`] and are
//! zeroized when their owning [`SecretBytes`] value is dropped.

mod broker;
mod credential_store;
mod error;
mod metadata;
mod oauth;
mod types;

pub use broker::IdentityBroker;
pub use credential_store::{
    platform_credential_store, CredentialStore, FaultCredentialStore, MemoryCredentialStore,
    SecretBytes, UnavailableCredentialStore,
};
pub use error::{BrokerError, CredentialStoreError};
pub use oauth::{HostedOAuthCodeExchange, OAuthCodeExchange};
pub use types::{
    BeginSignInOutcome, CredentialRef, HostedServiceOAuthConfig, IdentityRealm, IdentitySessionId,
    IdentitySessionStatus, IdentitySessionView, IdentitySnapshot, ImportLegacyIdentityOutcome,
    LegacySupabaseSession, MigrationStage, Org2CloudOAuthConfig, PreparedSignIn,
    PreparedSupabaseRefresh, RefreshedSupabaseAccess, SecureStoreStatus, SignInFlowPhase,
    SignInFlowView, SupabaseAccessLease, VerifiedHostedServiceSession, VerifiedOrg2CloudSession,
};
