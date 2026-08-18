use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::SecretBytes;

pub(crate) const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_PERSISTED_SESSIONS: usize = 32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum IdentityRealm {
    Org2Cloud,
    HostedServiceLegacy,
    CloudWeb,
    RemoteWorkspace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct IdentitySessionId(String);

impl IdentitySessionId {
    pub(crate) fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn parse(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        Uuid::parse_str(&value).ok().map(|_| Self(value))
    }

    pub(crate) fn is_valid(&self) -> bool {
        Uuid::parse_str(&self.0).is_ok()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct CredentialRef(String);

impl CredentialRef {
    pub(crate) fn for_session(realm: IdentityRealm, session_id: &IdentitySessionId) -> Self {
        let realm = match realm {
            IdentityRealm::Org2Cloud => "org2_cloud",
            IdentityRealm::HostedServiceLegacy => "hosted_service_legacy",
            IdentityRealm::CloudWeb => "cloud_web",
            IdentityRealm::RemoteWorkspace => "remote_workspace",
        };
        Self(format!("v1/{realm}/{}/refresh", session_id.as_str()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn is_valid(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= 180
            && self
                .0
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_/".contains(&byte))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdentitySessionStatus {
    Restoring,
    Ready,
    OfflineDegraded,
    ReauthRequired,
    SigningOut,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecureStoreStatus {
    Available,
    Locked,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignInFlowPhase {
    Preparing,
    BrowserOpen,
    AwaitingCallback,
    ExchangingCode,
    VerifyingSession,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInFlowView {
    pub flow_id: String,
    pub realm: IdentityRealm,
    pub phase: SignInFlowPhase,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Org2CloudOAuthConfig {
    pub issuer: String,
    pub public_client_key: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub user_endpoint: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedServiceOAuthConfig {
    pub issuer: String,
    pub public_client_key: String,
    pub authorization_endpoint: String,
    pub redirect_uri: String,
    pub provider: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeginSignInOutcome {
    pub flow_id: String,
    pub snapshot: IdentitySnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSignIn {
    pub flow_id: String,
    pub generation: u64,
    pub authorization_url: String,
    pub snapshot: IdentitySnapshot,
}

/// Trusted-endpoint-verified session data. Secret-bearing by construction:
/// it intentionally implements neither `Debug` nor serialization.
pub struct VerifiedOrg2CloudSession {
    pub subject: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_unix: i64,
    pub access_credential: SecretBytes,
    pub refresh_credential: SecretBytes,
}

/// Provider-verified Hosted Service session data. It never crosses the
/// renderer boundary and owns both credentials until the Broker commits them.
pub struct VerifiedHostedServiceSession {
    pub subject: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub avatar_url: Option<String>,
    pub expires_at_unix: i64,
    pub access_credential: SecretBytes,
    pub refresh_credential: SecretBytes,
}

/// One short-lived access grant for the renderer. The access credential is
/// deliberately non-serializable here; the Tauri adapter owns the only wire
/// DTO that can expose it to a requesting WebView.
pub struct SupabaseAccessLease {
    pub session_id: IdentitySessionId,
    pub realm: IdentityRealm,
    pub issuer: String,
    pub public_client_key: String,
    pub subject: String,
    pub generation: u64,
    pub expires_at_unix: i64,
    pub access_credential: SecretBytes,
}

/// Immutable refresh input captured from one exact Broker session version.
/// It is safe to use outside the Broker lock, while commit/rejection methods
/// compare the credential again so stale network work cannot resurrect a
/// signed-out or replaced identity.
pub struct PreparedSupabaseRefresh {
    pub session_id: IdentitySessionId,
    pub realm: IdentityRealm,
    pub issuer: String,
    pub public_client_key: String,
    pub oauth_client_id: Option<String>,
    pub subject: String,
    pub scopes: Vec<String>,
    pub generation: u64,
    pub refresh_credential: SecretBytes,
    pub(crate) credential_ref: CredentialRef,
}

/// Provider-verified refresh result. Secret-bearing by construction.
pub struct RefreshedSupabaseAccess {
    pub subject: String,
    pub expires_at_unix: i64,
    pub access_credential: SecretBytes,
    /// `None` is used only when an already-persisted credential is paired
    /// with a newly verified access token (for example, migration/finalize).
    pub refresh_credential: Option<SecretBytes>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySessionView {
    pub session_id: IdentitySessionId,
    pub realm: IdentityRealm,
    pub issuer: String,
    pub subject: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_unix: Option<i64>,
    pub status: IdentitySessionStatus,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySnapshot {
    pub revision: u64,
    pub sessions: Vec<IdentitySessionView>,
    pub active_sessions: BTreeMap<IdentityRealm, IdentitySessionId>,
    pub flows: Vec<SignInFlowView>,
    pub secure_store_status: SecureStoreStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStage {
    CredentialImported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportLegacyIdentityOutcome {
    pub snapshot: IdentitySnapshot,
    pub stage: MigrationStage,
    pub already_imported: bool,
    pub legacy_secret_can_be_deleted: bool,
}

/// Secret-bearing migration input. It intentionally implements neither
/// `Debug` nor serialization so it cannot accidentally become a public DTO.
pub struct LegacySupabaseSession {
    pub realm: IdentityRealm,
    pub issuer: String,
    pub public_client_key: String,
    pub subject: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_unix: Option<i64>,
    pub refresh_credential: SecretBytes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedSessionRecord {
    pub session_id: IdentitySessionId,
    pub realm: IdentityRealm,
    pub issuer: String,
    pub public_client_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
    pub subject: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub avatar_url: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_unix: Option<i64>,
    pub generation: u64,
    pub credential_ref: CredentialRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedRegistry {
    pub schema_version: u32,
    pub revision: u64,
    pub sessions: Vec<PersistedSessionRecord>,
    pub active_sessions: BTreeMap<IdentityRealm, IdentitySessionId>,
    pub realm_generations: BTreeMap<IdentityRealm, u64>,
    pub quarantined_credentials: BTreeSet<CredentialRef>,
}

impl Default for PersistedRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            revision: 0,
            sessions: Vec::new(),
            active_sessions: BTreeMap::new(),
            realm_generations: BTreeMap::new(),
            quarantined_credentials: BTreeSet::new(),
        }
    }
}
