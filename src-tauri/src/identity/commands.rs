use identity_broker::{
    BeginSignInOutcome, BrokerError, IdentityRealm, IdentitySessionId, IdentitySnapshot,
    ImportLegacyIdentityOutcome, SecretBytes, SupabaseAccessLease,
};
use serde::{Deserialize, Serialize, Serializer};
use tauri::{AppHandle, State};

use super::events::emit_snapshot_invalidated;
use super::migration;
use super::oauth::{HostedServiceSignInInput, Org2CloudSignInInput};
use super::runtime::{IdentityRuntime, IdentityRuntimeError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCommandError {
    code: String,
    message: String,
}

impl IdentityCommandError {
    pub(super) fn safe(code: &'static str) -> Self {
        Self {
            code: code.to_owned(),
            message: "Identity operation could not be completed".to_owned(),
        }
    }
}

impl From<BrokerError> for IdentityCommandError {
    fn from(error: BrokerError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

impl From<IdentityRuntimeError> for IdentityCommandError {
    fn from(error: IdentityRuntimeError) -> Self {
        Self::safe(error.code())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignOutInput {
    realm: IdentityRealm,
    session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessLeaseAudience {
    Org2CloudApi,
    HostedServiceApi,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessLeaseInput {
    session_id: String,
    generation: u64,
    audience: AccessLeaseAudience,
}

struct AccessCredentialWire(SecretBytes);

impl Serialize for AccessCredentialWire {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let value = std::str::from_utf8(self.0.expose()).map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(value)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseAccessLeaseWire {
    session_id: IdentitySessionId,
    generation: u64,
    issuer: String,
    public_client_key: String,
    subject: String,
    expires_at_unix: i64,
    audience: AccessLeaseAudience,
    access_token: AccessCredentialWire,
}

impl SupabaseAccessLeaseWire {
    fn from_broker(
        lease: SupabaseAccessLease,
        expected_realm: IdentityRealm,
        audience: AccessLeaseAudience,
    ) -> Result<Self, IdentityCommandError> {
        if lease.realm != expected_realm
            || std::str::from_utf8(lease.access_credential.expose()).is_err()
        {
            return Err(IdentityCommandError::safe("identity_access_lease_invalid"));
        }
        Ok(Self {
            session_id: lease.session_id,
            generation: lease.generation,
            issuer: lease.issuer,
            public_client_key: lease.public_client_key,
            subject: lease.subject,
            expires_at_unix: lease.expires_at_unix,
            audience,
            access_token: AccessCredentialWire(lease.access_credential),
        })
    }
}

#[tauri::command]
pub fn identity_get_snapshot(state: State<'_, IdentityRuntime>) -> IdentitySnapshot {
    state.broker().snapshot()
}

#[tauri::command]
pub async fn identity_begin_org2_cloud_sign_in(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: Org2CloudSignInInput,
) -> Result<BeginSignInOutcome, IdentityCommandError> {
    state
        .begin_org2_cloud_sign_in(app, input)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn identity_begin_hosted_service_sign_in(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: HostedServiceSignInInput,
) -> Result<BeginSignInOutcome, IdentityCommandError> {
    state
        .begin_hosted_service_sign_in(app, input)
        .await
        .map_err(Into::into)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteHostedSignInInput {
    code: String,
}

#[tauri::command]
pub async fn identity_complete_hosted_service_sign_in(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: CompleteHostedSignInInput,
) -> Result<IdentitySnapshot, IdentityCommandError> {
    state
        .complete_hosted_service_sign_in(&app, &input.code)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn identity_retry_restore(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
) -> Result<IdentitySnapshot, IdentityCommandError> {
    let broker = state.broker();
    let snapshot = tauri::async_runtime::spawn_blocking(move || broker.retry_restore())
        .await
        .map_err(|_| IdentityCommandError::safe("identity_task_failed"))??;
    emit_snapshot_invalidated(&app, snapshot.revision);
    Ok(snapshot)
}

#[tauri::command]
pub async fn identity_get_org2_cloud_access_lease(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: AccessLeaseInput,
) -> Result<SupabaseAccessLeaseWire, IdentityCommandError> {
    if !matches!(input.audience, AccessLeaseAudience::Org2CloudApi) {
        return Err(IdentityCommandError::safe("identity_access_lease_invalid"));
    }
    let session_id = IdentitySessionId::parse(input.session_id)
        .ok_or_else(|| IdentityCommandError::safe("invalid_session_id"))?;
    let lease = state
        .org2_cloud_access_lease(&app, session_id, input.generation)
        .await?;
    SupabaseAccessLeaseWire::from_broker(lease, IdentityRealm::Org2Cloud, input.audience)
}

#[tauri::command]
pub async fn identity_get_hosted_service_access_lease(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: AccessLeaseInput,
) -> Result<SupabaseAccessLeaseWire, IdentityCommandError> {
    if !matches!(input.audience, AccessLeaseAudience::HostedServiceApi) {
        return Err(IdentityCommandError::safe("identity_access_lease_invalid"));
    }
    let session_id = IdentitySessionId::parse(input.session_id)
        .ok_or_else(|| IdentityCommandError::safe("invalid_session_id"))?;
    let lease = state
        .hosted_service_access_lease(&app, session_id, input.generation)
        .await?;
    SupabaseAccessLeaseWire::from_broker(lease, IdentityRealm::HostedServiceLegacy, input.audience)
}

#[tauri::command]
pub async fn identity_migrate_legacy_org2_cloud(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
) -> Result<Option<ImportLegacyIdentityOutcome>, IdentityCommandError> {
    let task_app = app.clone();
    let broker = state.broker();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        migration::import_legacy_cloud_session(&task_app, &broker)
    })
    .await
    .map_err(|_| IdentityCommandError::safe("identity_task_failed"))??;
    if let Some(outcome) = &outcome {
        emit_snapshot_invalidated(&app, outcome.snapshot.revision);
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn identity_sign_out(
    app: AppHandle,
    state: State<'_, IdentityRuntime>,
    input: SignOutInput,
) -> Result<IdentitySnapshot, IdentityCommandError> {
    let SignOutInput { realm, session_id } = input;
    if realm == IdentityRealm::Org2Cloud {
        state.cancel_org2_cloud_sign_in(&app).await;
    }
    let session_id = match session_id {
        Some(value) => Some(
            IdentitySessionId::parse(value)
                .ok_or_else(|| IdentityCommandError::safe("invalid_session_id"))?,
        ),
        None => None,
    };
    let broker = state.broker();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || broker.sign_out(realm, session_id.as_ref()))
            .await
            .map_err(|_| IdentityCommandError::safe("identity_task_failed"))??;
    emit_snapshot_invalidated(&app, snapshot.revision);
    Ok(snapshot)
}
