use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use sha2::{Digest, Sha256};
use url::Url;

use crate::metadata::{FileSessionMetadataStore, SessionMetadataStore};
use crate::oauth::{
    create_pkce_material, HostedOAuthCodeExchange, OAuthCodeExchange, PendingHostedSignInFlow,
    PendingSignInFlow, ORG2_CLOUD_CALLBACK_PATH, ORG2_CLOUD_FLOW_TTL_SECS,
};
use crate::types::{CredentialRef, PersistedRegistry, PersistedSessionRecord};
use crate::{
    BrokerError, CredentialStore, CredentialStoreError, HostedServiceOAuthConfig, IdentityRealm,
    IdentitySessionId, IdentitySessionStatus, IdentitySessionView, IdentitySnapshot,
    ImportLegacyIdentityOutcome, LegacySupabaseSession, MigrationStage, Org2CloudOAuthConfig,
    PreparedSignIn, PreparedSupabaseRefresh, RefreshedSupabaseAccess, SecretBytes,
    SecureStoreStatus, SignInFlowPhase, SupabaseAccessLease, VerifiedHostedServiceSession,
    VerifiedOrg2CloudSession,
};

const ACCESS_LEASE_SKEW_SECS: i64 = 60;

struct CachedAccessLease {
    realm: IdentityRealm,
    issuer: String,
    public_client_key: String,
    subject: String,
    generation: u64,
    expires_at_unix: i64,
    access_credential: SecretBytes,
}

struct BrokerState {
    registry: PersistedRegistry,
    statuses: BTreeMap<IdentitySessionId, IdentitySessionStatus>,
    flows: BTreeMap<String, PendingSignInFlow>,
    hosted_flows: BTreeMap<String, PendingHostedSignInFlow>,
    access_leases: BTreeMap<IdentitySessionId, CachedAccessLease>,
}

pub struct IdentityBroker {
    credentials: Arc<dyn CredentialStore>,
    metadata: Arc<dyn SessionMetadataStore>,
    state: Mutex<BrokerState>,
}

impl IdentityBroker {
    pub(crate) fn new(
        credentials: Arc<dyn CredentialStore>,
        metadata: Arc<dyn SessionMetadataStore>,
    ) -> Self {
        Self {
            credentials,
            metadata,
            state: Mutex::new(BrokerState {
                registry: PersistedRegistry::default(),
                statuses: BTreeMap::new(),
                flows: BTreeMap::new(),
                hosted_flows: BTreeMap::new(),
                access_leases: BTreeMap::new(),
            }),
        }
    }

    pub fn with_file_metadata(
        credentials: Arc<dyn CredentialStore>,
        metadata_path: PathBuf,
    ) -> Self {
        Self::new(
            credentials,
            Arc::new(FileSessionMetadataStore::new(metadata_path)),
        )
    }

    fn lock_state(&self) -> MutexGuard<'_, BrokerState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot_from_state(
        &self,
        state: &BrokerState,
        secure_store_status: SecureStoreStatus,
    ) -> IdentitySnapshot {
        let sessions = state
            .registry
            .sessions
            .iter()
            .map(|session| IdentitySessionView {
                session_id: session.session_id.clone(),
                realm: session.realm,
                issuer: session.issuer.clone(),
                subject: session.subject.clone(),
                display_name: session.display_name.clone(),
                primary_email: session.primary_email.clone(),
                avatar_url: session.avatar_url.clone(),
                scopes: session.scopes.clone(),
                expires_at_unix: session.expires_at_unix,
                status: state
                    .statuses
                    .get(&session.session_id)
                    .copied()
                    .unwrap_or(IdentitySessionStatus::Restoring),
                generation: session.generation,
            })
            .collect();

        IdentitySnapshot {
            revision: state.registry.revision,
            sessions,
            active_sessions: state.registry.active_sessions.clone(),
            flows: state
                .flows
                .values()
                .map(PendingSignInFlow::view)
                .chain(
                    state
                        .hosted_flows
                        .values()
                        .map(PendingHostedSignInFlow::view),
                )
                .collect(),
            secure_store_status,
        }
    }

    pub fn snapshot(&self) -> IdentitySnapshot {
        let status = self.credentials.health();
        self.snapshot_from_state(&self.lock_state(), status)
    }

    pub fn cached_org2_cloud_access_lease(
        &self,
        session_id: &IdentitySessionId,
        generation: u64,
    ) -> Result<Option<SupabaseAccessLease>, BrokerError> {
        self.cached_access_lease_at(
            IdentityRealm::Org2Cloud,
            session_id,
            generation,
            Self::unix_now(),
        )
    }

    pub fn cached_hosted_service_access_lease(
        &self,
        session_id: &IdentitySessionId,
        generation: u64,
    ) -> Result<Option<SupabaseAccessLease>, BrokerError> {
        self.cached_access_lease_at(
            IdentityRealm::HostedServiceLegacy,
            session_id,
            generation,
            Self::unix_now(),
        )
    }

    fn cached_access_lease_at(
        &self,
        realm: IdentityRealm,
        session_id: &IdentitySessionId,
        generation: u64,
        now_unix: i64,
    ) -> Result<Option<SupabaseAccessLease>, BrokerError> {
        let mut state = self.lock_state();
        let active_id = state
            .registry
            .active_sessions
            .get(&realm)
            .ok_or(BrokerError::SessionNotFound)?;
        let session = state
            .registry
            .sessions
            .iter()
            .find(|session| {
                session.realm == realm
                    && session.session_id == *session_id
                    && session.generation == generation
                    && active_id == session_id
            })
            .ok_or(BrokerError::Superseded)?;
        if state.statuses.get(session_id) == Some(&IdentitySessionStatus::ReauthRequired) {
            return Err(BrokerError::ReauthRequired);
        }
        let expected = (
            session.issuer.clone(),
            session.public_client_key.clone(),
            session.subject.clone(),
        );
        let Some(cached) = state.access_leases.get(session_id) else {
            return Ok(None);
        };
        if cached.realm != realm
            || cached.generation != generation
            || cached.expires_at_unix.saturating_sub(now_unix) <= ACCESS_LEASE_SKEW_SECS
            || (
                cached.issuer.as_str(),
                cached.public_client_key.as_str(),
                cached.subject.as_str(),
            ) != (
                expected.0.as_str(),
                expected.1.as_str(),
                expected.2.as_str(),
            )
        {
            state.access_leases.remove(session_id);
            return Ok(None);
        }
        Ok(Some(SupabaseAccessLease {
            session_id: session_id.clone(),
            realm,
            issuer: cached.issuer.clone(),
            public_client_key: cached.public_client_key.clone(),
            subject: cached.subject.clone(),
            generation,
            expires_at_unix: cached.expires_at_unix,
            access_credential: cached.access_credential.copy_secret(),
        }))
    }

    pub fn prepare_org2_cloud_refresh(
        &self,
        session_id: &IdentitySessionId,
        generation: u64,
    ) -> Result<PreparedSupabaseRefresh, BrokerError> {
        self.prepare_supabase_refresh(IdentityRealm::Org2Cloud, session_id, generation)
    }

    pub fn prepare_hosted_service_refresh(
        &self,
        session_id: &IdentitySessionId,
        generation: u64,
    ) -> Result<PreparedSupabaseRefresh, BrokerError> {
        self.prepare_supabase_refresh(IdentityRealm::HostedServiceLegacy, session_id, generation)
    }

    fn prepare_supabase_refresh(
        &self,
        realm: IdentityRealm,
        session_id: &IdentitySessionId,
        generation: u64,
    ) -> Result<PreparedSupabaseRefresh, BrokerError> {
        let session = {
            let state = self.lock_state();
            let active_id = state
                .registry
                .active_sessions
                .get(&realm)
                .ok_or(BrokerError::SessionNotFound)?;
            let session = state
                .registry
                .sessions
                .iter()
                .find(|session| {
                    session.realm == realm
                        && session.session_id == *session_id
                        && session.generation == generation
                        && active_id == session_id
                })
                .cloned()
                .ok_or(BrokerError::Superseded)?;
            if state.statuses.get(session_id) == Some(&IdentitySessionStatus::ReauthRequired)
                || state
                    .registry
                    .quarantined_credentials
                    .contains(&session.credential_ref)
            {
                return Err(BrokerError::ReauthRequired);
            }
            session
        };

        let refresh_credential = self
            .credentials
            .get_refresh_credential(&session.credential_ref)?
            .ok_or(BrokerError::ReauthRequired)?;
        Ok(PreparedSupabaseRefresh {
            session_id: session.session_id,
            realm,
            issuer: session.issuer,
            public_client_key: session.public_client_key,
            oauth_client_id: session.oauth_client_id,
            subject: session.subject,
            scopes: session.scopes,
            generation: session.generation,
            refresh_credential,
            credential_ref: session.credential_ref,
        })
    }

    pub fn commit_supabase_refresh(
        &self,
        request: PreparedSupabaseRefresh,
        refreshed: RefreshedSupabaseAccess,
    ) -> Result<(SupabaseAccessLease, IdentitySnapshot), BrokerError> {
        let now_unix = Self::unix_now();
        if refreshed.subject != request.subject
            || refreshed.access_credential.is_empty()
            || refreshed.access_credential.expose().len() > 32_768
            || refreshed
                .refresh_credential
                .as_ref()
                .is_some_and(|credential| {
                    credential.is_empty() || credential.expose().len() > 16_384
                })
            || refreshed.expires_at_unix <= now_unix.saturating_add(ACCESS_LEASE_SKEW_SECS)
            || refreshed.expires_at_unix > now_unix.saturating_add(86_400)
        {
            return Err(BrokerError::InvalidInput(
                "refreshed access lease is invalid",
            ));
        }

        let mut state = self.lock_state();
        let active_id = state
            .registry
            .active_sessions
            .get(&request.realm)
            .ok_or(BrokerError::Superseded)?;
        let session_index = state
            .registry
            .sessions
            .iter()
            .position(|session| {
                session.realm == request.realm
                    && session.session_id == request.session_id
                    && session.generation == request.generation
                    && session.credential_ref == request.credential_ref
                    && active_id == &request.session_id
            })
            .ok_or(BrokerError::Superseded)?;
        let stored = self
            .credentials
            .get_refresh_credential(&request.credential_ref)?
            .ok_or(BrokerError::Superseded)?;
        if Sha256::digest(stored.expose()) != Sha256::digest(request.refresh_credential.expose()) {
            return Err(BrokerError::Superseded);
        }

        if let Some(rotated_credential) = refreshed.refresh_credential {
            let rotated_digest = Sha256::digest(rotated_credential.expose());
            self.credentials
                .put_refresh_credential(&request.credential_ref, rotated_credential)?;
            let rotated = self
                .credentials
                .get_refresh_credential(&request.credential_ref)?
                .ok_or(BrokerError::CredentialVerificationFailed)?;
            if Sha256::digest(rotated.expose()) != rotated_digest {
                return Err(BrokerError::CredentialVerificationFailed);
            }
        }

        let mut next = state.registry.clone();
        next.revision = next.revision.saturating_add(1);
        next.sessions[session_index].expires_at_unix = Some(refreshed.expires_at_unix);
        self.metadata.save(&next)?;
        state.registry = next;
        state
            .statuses
            .insert(request.session_id.clone(), IdentitySessionStatus::Ready);

        let lease_access = refreshed.access_credential.copy_secret();
        state.access_leases.insert(
            request.session_id.clone(),
            CachedAccessLease {
                realm: request.realm,
                issuer: request.issuer.clone(),
                public_client_key: request.public_client_key.clone(),
                subject: request.subject.clone(),
                generation: request.generation,
                expires_at_unix: refreshed.expires_at_unix,
                access_credential: refreshed.access_credential,
            },
        );
        let snapshot = self.snapshot_from_state(&state, self.credentials.health());
        Ok((
            SupabaseAccessLease {
                session_id: request.session_id,
                realm: request.realm,
                issuer: request.issuer,
                public_client_key: request.public_client_key,
                subject: request.subject,
                generation: request.generation,
                expires_at_unix: refreshed.expires_at_unix,
                access_credential: lease_access,
            },
            snapshot,
        ))
    }

    pub fn reject_supabase_refresh(
        &self,
        request: &PreparedSupabaseRefresh,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        {
            let mut state = self.lock_state();
            Self::validate_refresh_guard(&state, request)?;
            let stored = self
                .credentials
                .get_refresh_credential(&request.credential_ref)?
                .ok_or(BrokerError::Superseded)?;
            if Sha256::digest(stored.expose())
                != Sha256::digest(request.refresh_credential.expose())
            {
                return Err(BrokerError::Superseded);
            }
            let mut next = state.registry.clone();
            next.revision = next.revision.saturating_add(1);
            next.quarantined_credentials
                .insert(request.credential_ref.clone());
            self.metadata.save(&next)?;
            state.registry = next;
            state.statuses.insert(
                request.session_id.clone(),
                IdentitySessionStatus::ReauthRequired,
            );
            state.access_leases.remove(&request.session_id);
        }

        if self
            .credentials
            .delete_refresh_credential(&request.credential_ref)
            .is_ok()
        {
            let mut state = self.lock_state();
            if state
                .registry
                .quarantined_credentials
                .remove(&request.credential_ref)
            {
                state.registry.revision = state.registry.revision.saturating_add(1);
                self.metadata.save(&state.registry)?;
            }
            return Ok(self.snapshot_from_state(&state, secure_store_status));
        }
        Ok(self.snapshot_from_state(&self.lock_state(), secure_store_status))
    }

    pub fn mark_supabase_refresh_unavailable(
        &self,
        request: &PreparedSupabaseRefresh,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        Self::validate_refresh_guard(&state, request)?;
        let stored = self
            .credentials
            .get_refresh_credential(&request.credential_ref)?
            .ok_or(BrokerError::Superseded)?;
        if Sha256::digest(stored.expose()) != Sha256::digest(request.refresh_credential.expose()) {
            return Err(BrokerError::Superseded);
        }
        state.registry.revision = state.registry.revision.saturating_add(1);
        state.statuses.insert(
            request.session_id.clone(),
            IdentitySessionStatus::OfflineDegraded,
        );
        state.access_leases.remove(&request.session_id);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    fn validate_refresh_guard(
        state: &BrokerState,
        request: &PreparedSupabaseRefresh,
    ) -> Result<(), BrokerError> {
        let active_id = state
            .registry
            .active_sessions
            .get(&request.realm)
            .ok_or(BrokerError::Superseded)?;
        let valid = state.registry.sessions.iter().any(|session| {
            session.realm == request.realm
                && session.session_id == request.session_id
                && session.generation == request.generation
                && session.credential_ref == request.credential_ref
                && active_id == &request.session_id
        });
        valid.then_some(()).ok_or(BrokerError::Superseded)
    }

    /// Begin a realm-owned sign-in generation before opening the browser.
    ///
    /// If the realm already has an active session, moving that session to the
    /// new generation invalidates every access lease and refresh completion
    /// that started before an account switch or reauthentication attempt. The
    /// old verified account remains usable if the browser flow is cancelled;
    /// it simply continues under the new generation.
    fn begin_realm_sign_in_generation(
        &self,
        state: &mut BrokerState,
        realm: IdentityRealm,
    ) -> Result<u64, BrokerError> {
        let generation = state
            .registry
            .realm_generations
            .get(&realm)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        let mut next = state.registry.clone();
        next.revision = next.revision.saturating_add(1);
        next.realm_generations.insert(realm, generation);

        if let Some(active_session_id) = next.active_sessions.get(&realm).cloned() {
            if let Some(active_session) = next
                .sessions
                .iter_mut()
                .find(|session| session.realm == realm && session.session_id == active_session_id)
            {
                active_session.generation = generation;
            }
            state.access_leases.remove(&active_session_id);
        }

        // Persist the generation fence before launching a browser. A process
        // restart during account switching must not restore the pre-switch
        // generation and accept work that the switch already superseded.
        self.metadata.save(&next)?;
        state.registry = next;
        Ok(generation)
    }

    pub fn prepare_hosted_service_sign_in(
        &self,
        config: HostedServiceOAuthConfig,
    ) -> Result<PreparedSignIn, BrokerError> {
        self.prepare_hosted_service_sign_in_at(config, Self::unix_now())
    }

    fn prepare_hosted_service_sign_in_at(
        &self,
        config: HostedServiceOAuthConfig,
        now_unix: i64,
    ) -> Result<PreparedSignIn, BrokerError> {
        Self::validate_hosted_oauth_config(&config)?;
        let material = create_pkce_material()?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let mut authorization_url = Url::parse(&config.authorization_endpoint)
            .map_err(|_| BrokerError::InvalidInput("authorization endpoint is invalid"))?;
        authorization_url
            .query_pairs_mut()
            .append_pair("provider", &config.provider)
            .append_pair("redirect_to", &config.redirect_uri)
            .append_pair("scopes", &config.scopes.join(" "))
            .append_pair("skip_http_redirect", "true")
            .append_pair("code_challenge", &material.challenge)
            .append_pair("code_challenge_method", "s256");

        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let generation =
            self.begin_realm_sign_in_generation(&mut state, IdentityRealm::HostedServiceLegacy)?;
        state.hosted_flows.clear();
        state.hosted_flows.insert(
            flow_id.clone(),
            PendingHostedSignInFlow {
                flow_id: flow_id.clone(),
                phase: SignInFlowPhase::Preparing,
                generation,
                verifier: Some(material.verifier),
                config,
                created_at_unix: now_unix,
            },
        );
        Ok(PreparedSignIn {
            flow_id,
            generation,
            authorization_url: authorization_url.to_string(),
            snapshot: self.snapshot_from_state(&state, secure_store_status),
        })
    }

    pub fn mark_hosted_browser_opened(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_hosted_flow(
            flow_id,
            generation,
            SignInFlowPhase::Preparing,
            SignInFlowPhase::BrowserOpen,
        )
    }

    pub fn mark_hosted_awaiting_callback(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_hosted_flow(
            flow_id,
            generation,
            SignInFlowPhase::BrowserOpen,
            SignInFlowPhase::AwaitingCallback,
        )
    }

    pub fn mark_hosted_verifying_session(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_hosted_flow(
            flow_id,
            generation,
            SignInFlowPhase::ExchangingCode,
            SignInFlowPhase::VerifyingSession,
        )
    }

    fn transition_hosted_flow(
        &self,
        flow_id: &str,
        generation: u64,
        expected: SignInFlowPhase,
        next: SignInFlowPhase,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let flow = state
            .hosted_flows
            .get_mut(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        if flow.phase != expected {
            return Err(BrokerError::InvalidFlowPhase);
        }
        flow.phase = next;
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn fail_hosted_sign_in(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let flow = state
            .hosted_flows
            .get_mut(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        flow.phase = SignInFlowPhase::Failed;
        flow.verifier = None;
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn accept_hosted_service_callback(
        &self,
        code: &str,
    ) -> Result<HostedOAuthCodeExchange, BrokerError> {
        self.accept_hosted_service_callback_at(code, Self::unix_now())
    }

    fn accept_hosted_service_callback_at(
        &self,
        code: &str,
        now_unix: i64,
    ) -> Result<HostedOAuthCodeExchange, BrokerError> {
        if code.is_empty() || code.len() > 4_096 || code.chars().any(char::is_control) {
            return Err(BrokerError::InvalidCallback);
        }
        let (flow_id, generation, created_at_unix, phase) = {
            let state = self.lock_state();
            let mut pending = state
                .hosted_flows
                .values()
                .filter(|flow| flow.phase != SignInFlowPhase::Failed);
            let flow = pending.next().ok_or(BrokerError::FlowNotFound)?;
            if pending.next().is_some() {
                return Err(BrokerError::Superseded);
            }
            (
                flow.flow_id.clone(),
                flow.generation,
                flow.created_at_unix,
                flow.phase,
            )
        };
        if matches!(
            phase,
            SignInFlowPhase::ExchangingCode | SignInFlowPhase::VerifyingSession
        ) {
            return Err(BrokerError::CallbackAlreadyConsumed);
        }
        if phase != SignInFlowPhase::AwaitingCallback {
            return Err(BrokerError::InvalidFlowPhase);
        }
        if now_unix < created_at_unix
            || now_unix.saturating_sub(created_at_unix) > ORG2_CLOUD_FLOW_TTL_SECS
        {
            let _ = self.fail_hosted_sign_in(&flow_id, generation);
            return Err(BrokerError::CallbackExpired);
        }

        let mut state = self.lock_state();
        let flow = state
            .hosted_flows
            .get_mut(&flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        if flow.phase != SignInFlowPhase::AwaitingCallback {
            return Err(BrokerError::CallbackAlreadyConsumed);
        }
        let verifier = flow
            .verifier
            .take()
            .ok_or(BrokerError::CallbackAlreadyConsumed)?;
        flow.phase = SignInFlowPhase::ExchangingCode;
        let config = flow.config.clone();
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(HostedOAuthCodeExchange::new(
            flow_id,
            generation,
            SecretBytes::new(code.as_bytes().to_vec()),
            verifier,
            config,
        ))
    }

    pub fn complete_verified_hosted_service_session(
        &self,
        flow_id: &str,
        generation: u64,
        verified: VerifiedHostedServiceSession,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let now_unix = Self::unix_now();
        if verified.subject.trim().is_empty()
            || verified.subject.len() > 512
            || verified.expires_at_unix <= now_unix.saturating_add(60)
            || verified.expires_at_unix > now_unix.saturating_add(86_400)
            || verified.access_credential.is_empty()
            || verified.refresh_credential.is_empty()
        {
            return Err(BrokerError::InvalidInput(
                "verified hosted session is invalid",
            ));
        }
        let config = {
            let state = self.lock_state();
            let flow = state
                .hosted_flows
                .get(flow_id)
                .ok_or(BrokerError::FlowNotFound)?;
            if flow.generation != generation {
                return Err(BrokerError::Superseded);
            }
            if flow.phase != SignInFlowPhase::VerifyingSession {
                return Err(BrokerError::InvalidFlowPhase);
            }
            flow.config.clone()
        };
        let VerifiedHostedServiceSession {
            subject,
            display_name,
            primary_email,
            avatar_url,
            expires_at_unix,
            access_credential,
            refresh_credential,
        } = verified;
        let outcome = self.import_legacy_supabase_session(LegacySupabaseSession {
            realm: IdentityRealm::HostedServiceLegacy,
            issuer: config.issuer,
            public_client_key: config.public_client_key,
            subject,
            display_name,
            primary_email,
            avatar_url,
            scopes: config.scopes,
            expires_at_unix: Some(expires_at_unix),
            refresh_credential,
        })?;
        let session_id = outcome
            .snapshot
            .active_sessions
            .get(&IdentityRealm::HostedServiceLegacy)
            .cloned()
            .ok_or(BrokerError::SessionNotFound)?;
        let session = outcome
            .snapshot
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
            .ok_or(BrokerError::SessionNotFound)?;
        let request = self.prepare_hosted_service_refresh(&session_id, session.generation)?;
        let (_, _) = self.commit_supabase_refresh(
            request,
            RefreshedSupabaseAccess {
                subject: session.subject.clone(),
                expires_at_unix,
                access_credential,
                refresh_credential: None,
            },
        )?;

        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let flow = state
            .hosted_flows
            .get(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation || flow.phase != SignInFlowPhase::VerifyingSession {
            return Err(BrokerError::Superseded);
        }
        state.hosted_flows.remove(flow_id);
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn prepare_org2_cloud_sign_in(
        &self,
        config: Org2CloudOAuthConfig,
        loopback_port: u16,
    ) -> Result<PreparedSignIn, BrokerError> {
        self.prepare_org2_cloud_sign_in_at(config, loopback_port, Self::unix_now())
    }

    fn prepare_org2_cloud_sign_in_at(
        &self,
        config: Org2CloudOAuthConfig,
        loopback_port: u16,
        now_unix: i64,
    ) -> Result<PreparedSignIn, BrokerError> {
        Self::validate_oauth_config(&config)?;
        if loopback_port < 1_024 {
            return Err(BrokerError::InvalidInput(
                "loopback port must be unprivileged",
            ));
        }

        let material = create_pkce_material()?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let state_value = format!("org2v1.{loopback_port}.{}", material.nonce);
        let mut authorization_url = Url::parse(&config.authorization_endpoint)
            .map_err(|_| BrokerError::InvalidInput("authorization endpoint is invalid"))?;
        authorization_url
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", &config.redirect_uri)
            .append_pair("state", &state_value)
            .append_pair("code_challenge", &material.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("scope", &config.scopes.join(" "));

        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let generation =
            self.begin_realm_sign_in_generation(&mut state, IdentityRealm::Org2Cloud)?;
        state.flows.clear();
        state.flows.insert(
            flow_id.clone(),
            PendingSignInFlow {
                flow_id: flow_id.clone(),
                phase: SignInFlowPhase::Preparing,
                generation,
                state: state_value,
                verifier: Some(material.verifier),
                config,
                loopback_port,
                created_at_unix: now_unix,
            },
        );
        Ok(PreparedSignIn {
            flow_id,
            generation,
            authorization_url: authorization_url.to_string(),
            snapshot: self.snapshot_from_state(&state, secure_store_status),
        })
    }

    pub fn mark_browser_opened(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_flow(
            flow_id,
            generation,
            SignInFlowPhase::Preparing,
            SignInFlowPhase::BrowserOpen,
        )
    }

    pub fn mark_awaiting_callback(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_flow(
            flow_id,
            generation,
            SignInFlowPhase::BrowserOpen,
            SignInFlowPhase::AwaitingCallback,
        )
    }

    pub fn mark_verifying_session(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        self.transition_flow(
            flow_id,
            generation,
            SignInFlowPhase::ExchangingCode,
            SignInFlowPhase::VerifyingSession,
        )
    }

    fn transition_flow(
        &self,
        flow_id: &str,
        generation: u64,
        expected: SignInFlowPhase,
        next: SignInFlowPhase,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let flow = state
            .flows
            .get_mut(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        if flow.phase != expected {
            return Err(BrokerError::InvalidFlowPhase);
        }
        flow.phase = next;
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn fail_sign_in(
        &self,
        flow_id: &str,
        generation: u64,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        let flow = state
            .flows
            .get_mut(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        flow.phase = SignInFlowPhase::Failed;
        flow.verifier = None;
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn accept_org2_cloud_callback(
        &self,
        flow_id: &str,
        generation: u64,
        callback_url: &str,
    ) -> Result<OAuthCodeExchange, BrokerError> {
        self.accept_org2_cloud_callback_at(flow_id, generation, callback_url, Self::unix_now())
    }

    fn accept_org2_cloud_callback_at(
        &self,
        flow_id: &str,
        generation: u64,
        callback_url: &str,
        now_unix: i64,
    ) -> Result<OAuthCodeExchange, BrokerError> {
        let (expected_state, loopback_port, created_at_unix, phase) = {
            let state = self.lock_state();
            let flow = state.flows.get(flow_id).ok_or(BrokerError::FlowNotFound)?;
            if flow.generation != generation {
                return Err(BrokerError::Superseded);
            }
            (
                flow.state.clone(),
                flow.loopback_port,
                flow.created_at_unix,
                flow.phase,
            )
        };
        if matches!(
            phase,
            SignInFlowPhase::ExchangingCode | SignInFlowPhase::VerifyingSession
        ) {
            return Err(BrokerError::CallbackAlreadyConsumed);
        }
        if phase != SignInFlowPhase::AwaitingCallback {
            return Err(BrokerError::InvalidFlowPhase);
        }
        if now_unix < created_at_unix
            || now_unix.saturating_sub(created_at_unix) > ORG2_CLOUD_FLOW_TTL_SECS
        {
            let _ = self.fail_sign_in(flow_id, generation);
            return Err(BrokerError::CallbackExpired);
        }

        let code = match Self::parse_oauth_callback(callback_url, loopback_port, &expected_state) {
            Ok(code) => code,
            Err(error) => {
                let _ = self.fail_sign_in(flow_id, generation);
                return Err(error);
            }
        };

        let mut state = self.lock_state();
        let flow = state
            .flows
            .get_mut(flow_id)
            .ok_or(BrokerError::FlowNotFound)?;
        if flow.generation != generation {
            return Err(BrokerError::Superseded);
        }
        if flow.phase != SignInFlowPhase::AwaitingCallback {
            return Err(BrokerError::CallbackAlreadyConsumed);
        }
        let verifier = flow
            .verifier
            .take()
            .ok_or(BrokerError::CallbackAlreadyConsumed)?;
        flow.phase = SignInFlowPhase::ExchangingCode;
        let config = flow.config.clone();
        state.registry.revision = state.registry.revision.saturating_add(1);
        Ok(OAuthCodeExchange::new(
            flow_id.to_owned(),
            generation,
            code,
            verifier,
            config,
        ))
    }

    pub fn complete_verified_org2_cloud_session(
        &self,
        flow_id: &str,
        generation: u64,
        verified: VerifiedOrg2CloudSession,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let now_unix = Self::unix_now();
        Self::validate_verified_session(&verified, now_unix)?;
        let (config, guard_revision) = {
            let state = self.lock_state();
            let flow = state.flows.get(flow_id).ok_or(BrokerError::FlowNotFound)?;
            if flow.generation != generation {
                return Err(BrokerError::Superseded);
            }
            if flow.phase != SignInFlowPhase::VerifyingSession {
                return Err(BrokerError::InvalidFlowPhase);
            }
            (flow.config.clone(), state.registry.revision)
        };
        if !Self::same_scope_set(&verified.scopes, &config.scopes) {
            return Err(BrokerError::InvalidInput("verified scopes did not match"));
        }

        let VerifiedOrg2CloudSession {
            subject,
            display_name,
            primary_email,
            avatar_url,
            scopes,
            expires_at_unix,
            access_credential,
            refresh_credential,
        } = verified;
        let expected_digest = Sha256::digest(refresh_credential.expose());
        let session_id = IdentitySessionId::new();
        let credential_ref = CredentialRef::for_session(IdentityRealm::Org2Cloud, &session_id);
        self.credentials
            .put_refresh_credential(&credential_ref, refresh_credential)?;
        let stored = self
            .credentials
            .get_refresh_credential(&credential_ref)?
            .ok_or(BrokerError::CredentialVerificationFailed)?;
        if Sha256::digest(stored.expose()) != expected_digest {
            let _ = self.credentials.delete_refresh_credential(&credential_ref);
            return Err(BrokerError::CredentialVerificationFailed);
        }

        let (old_credentials, committed_revision) = {
            let mut state = self.lock_state();
            if state.registry.revision != guard_revision {
                drop(state);
                let _ = self.credentials.delete_refresh_credential(&credential_ref);
                return Err(BrokerError::Superseded);
            }
            let flow = state.flows.get(flow_id).ok_or(BrokerError::FlowNotFound)?;
            if flow.generation != generation || flow.phase != SignInFlowPhase::VerifyingSession {
                drop(state);
                let _ = self.credentials.delete_refresh_credential(&credential_ref);
                return Err(BrokerError::Superseded);
            }

            let replaced: Vec<_> = state
                .registry
                .sessions
                .iter()
                .filter(|session| session.realm == IdentityRealm::Org2Cloud)
                .map(|session| (session.session_id.clone(), session.credential_ref.clone()))
                .collect();
            let replaced_ids: std::collections::BTreeSet<_> =
                replaced.iter().map(|(id, _)| id.clone()).collect();
            let old_credentials: Vec<_> = replaced
                .iter()
                .map(|(_, credential_ref)| credential_ref.clone())
                .collect();

            let mut next = state.registry.clone();
            next.revision = next.revision.saturating_add(1);
            next.realm_generations
                .insert(IdentityRealm::Org2Cloud, generation);
            next.sessions
                .retain(|session| session.realm != IdentityRealm::Org2Cloud);
            next.quarantined_credentials
                .extend(old_credentials.iter().cloned());
            next.sessions.push(PersistedSessionRecord {
                session_id: session_id.clone(),
                realm: IdentityRealm::Org2Cloud,
                issuer: config.issuer.clone(),
                public_client_key: config.public_client_key.clone(),
                oauth_client_id: Some(config.client_id.clone()),
                subject: subject.clone(),
                display_name: display_name.clone(),
                primary_email: primary_email.clone(),
                avatar_url: avatar_url.clone(),
                scopes: scopes.clone(),
                expires_at_unix: Some(expires_at_unix),
                generation,
                credential_ref: credential_ref.clone(),
            });
            next.active_sessions
                .insert(IdentityRealm::Org2Cloud, session_id.clone());
            if let Err(error) = self.metadata.save(&next) {
                drop(state);
                let _ = self.credentials.delete_refresh_credential(&credential_ref);
                return Err(error);
            }

            let committed_revision = next.revision;
            state.registry = next;
            state.statuses.retain(|id, _| !replaced_ids.contains(id));
            state
                .access_leases
                .retain(|id, _| !replaced_ids.contains(id));
            state
                .statuses
                .insert(session_id.clone(), IdentitySessionStatus::Ready);
            state.access_leases.insert(
                session_id,
                CachedAccessLease {
                    realm: IdentityRealm::Org2Cloud,
                    issuer: config.issuer,
                    public_client_key: config.public_client_key,
                    subject: subject.clone(),
                    generation,
                    expires_at_unix,
                    access_credential,
                },
            );
            state.flows.remove(flow_id);
            (old_credentials, committed_revision)
        };

        let mut removed = Vec::new();
        for old in old_credentials {
            if self.credentials.delete_refresh_credential(&old).is_ok() {
                removed.push(old);
            }
        }

        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        if state.registry.revision != committed_revision {
            return Ok(self.snapshot_from_state(&state, secure_store_status));
        }
        if !removed.is_empty() {
            for credential_ref in removed {
                state
                    .registry
                    .quarantined_credentials
                    .remove(&credential_ref);
            }
            state.registry.revision = state.registry.revision.saturating_add(1);
            self.metadata.save(&state.registry)?;
        }
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    fn parse_oauth_callback(
        callback_url: &str,
        expected_port: u16,
        expected_state: &str,
    ) -> Result<SecretBytes, BrokerError> {
        if callback_url.len() > 8_192 {
            return Err(BrokerError::InvalidCallback);
        }
        let url = Url::parse(callback_url).map_err(|_| BrokerError::InvalidCallback)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port() != Some(expected_port)
            || url.path() != ORG2_CLOUD_CALLBACK_PATH
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(BrokerError::InvalidCallback);
        }

        let mut parameters = BTreeMap::new();
        for (name, value) in url.query_pairs() {
            if !matches!(
                name.as_ref(),
                "code" | "state" | "error" | "error_description"
            ) || parameters
                .insert(name.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(BrokerError::InvalidCallback);
            }
        }
        if parameters.get("state").map(String::as_str) != Some(expected_state) {
            return Err(BrokerError::StateMismatch);
        }

        let code = parameters.get("code");
        let error = parameters.get("error");
        if code.is_some() == error.is_some() {
            return Err(BrokerError::InvalidCallback);
        }
        if let Some(error) = error {
            let safe_error = !error.is_empty()
                && error.len() <= 128
                && error
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte));
            let safe_description = parameters
                .get("error_description")
                .is_none_or(|description| {
                    !description.is_empty()
                        && description.len() <= 256
                        && !description.chars().any(char::is_control)
                });
            if !safe_error || !safe_description {
                return Err(BrokerError::InvalidCallback);
            }
            return Err(BrokerError::AuthorizationDenied);
        }
        if parameters.contains_key("error_description") {
            return Err(BrokerError::InvalidCallback);
        }
        let code = code.ok_or(BrokerError::InvalidCallback)?;
        if code.is_empty() || code.len() > 4_096 || code.chars().any(char::is_control) {
            return Err(BrokerError::InvalidCallback);
        }
        Ok(SecretBytes::new(code.as_bytes().to_vec()))
    }

    pub fn retry_restore(&self) -> Result<IdentitySnapshot, BrokerError> {
        let (guard_revision, guard_generations) = {
            let state = self.lock_state();
            (
                state.registry.revision,
                state.registry.realm_generations.clone(),
            )
        };
        let mut registry = self.metadata.load()?.unwrap_or_default();
        for (realm, generation) in guard_generations {
            let current = registry.realm_generations.entry(realm).or_default();
            *current = (*current).max(generation);
        }

        let mut quarantine_changed = false;
        registry.quarantined_credentials.retain(|credential_ref| {
            match self.credentials.delete_refresh_credential(credential_ref) {
                Ok(()) => {
                    quarantine_changed = true;
                    false
                }
                Err(_) => true,
            }
        });

        let mut statuses = BTreeMap::new();
        for session in &registry.sessions {
            if registry
                .quarantined_credentials
                .contains(&session.credential_ref)
            {
                statuses.insert(
                    session.session_id.clone(),
                    IdentitySessionStatus::ReauthRequired,
                );
                continue;
            }
            let status = match self
                .credentials
                .get_refresh_credential(&session.credential_ref)
            {
                Ok(Some(_credential)) => IdentitySessionStatus::OfflineDegraded,
                Ok(None) => IdentitySessionStatus::ReauthRequired,
                Err(CredentialStoreError::Locked | CredentialStoreError::Unavailable) => {
                    IdentitySessionStatus::Restoring
                }
                Err(CredentialStoreError::OperationFailed { .. }) => {
                    IdentitySessionStatus::Restoring
                }
            };
            statuses.insert(session.session_id.clone(), status);
        }

        let secure_store_status = self.credentials.health();
        let mut state = self.lock_state();
        if state.registry.revision != guard_revision {
            return Ok(self.snapshot_from_state(&state, secure_store_status));
        }
        registry.revision = registry.revision.max(guard_revision).saturating_add(1);
        if quarantine_changed || registry.revision != guard_revision {
            self.metadata.save(&registry)?;
        }
        state.registry = registry;
        state.statuses = statuses;
        state.access_leases.clear();
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    pub fn import_legacy_supabase_session(
        &self,
        input: LegacySupabaseSession,
    ) -> Result<ImportLegacyIdentityOutcome, BrokerError> {
        Self::validate_legacy_input(&input)?;

        let expected_digest = Sha256::digest(input.refresh_credential.expose());
        let (guard_revision, existing) = {
            let state = self.lock_state();
            let existing = state
                .registry
                .sessions
                .iter()
                .find(|session| {
                    session.realm == input.realm
                        && session.issuer == input.issuer
                        && session.subject == input.subject
                })
                .cloned();
            (state.registry.revision, existing)
        };
        if let Some(existing) = existing {
            let stored = self
                .credentials
                .get_refresh_credential(&existing.credential_ref)?;
            let credential_unchanged = stored
                .as_ref()
                .is_some_and(|value| Sha256::digest(value.expose()) == expected_digest);
            if credential_unchanged {
                drop(input.refresh_credential);
            } else {
                self.credentials
                    .put_refresh_credential(&existing.credential_ref, input.refresh_credential)?;
                let persisted = self
                    .credentials
                    .get_refresh_credential(&existing.credential_ref)?
                    .ok_or(BrokerError::CredentialVerificationFailed)?;
                if Sha256::digest(persisted.expose()) != expected_digest {
                    return Err(BrokerError::CredentialVerificationFailed);
                }
            }

            let mut state = self.lock_state();
            if state.registry.revision != guard_revision {
                return Err(BrokerError::Superseded);
            }
            let mut next_registry = state.registry.clone();
            let current = next_registry
                .sessions
                .iter_mut()
                .find(|session| session.session_id == existing.session_id)
                .ok_or(BrokerError::Superseded)?;
            let metadata_unchanged = current.public_client_key == input.public_client_key
                && current.display_name == input.display_name
                && current.primary_email == input.primary_email
                && current.avatar_url == input.avatar_url
                && current.scopes == input.scopes
                && current.expires_at_unix == input.expires_at_unix;
            current.public_client_key = input.public_client_key;
            current.display_name = input.display_name;
            current.primary_email = input.primary_email;
            current.avatar_url = input.avatar_url;
            current.scopes = input.scopes;
            current.expires_at_unix = input.expires_at_unix;
            if !credential_unchanged || !metadata_unchanged {
                next_registry.revision = next_registry.revision.saturating_add(1);
                self.metadata.save(&next_registry)?;
                state.registry = next_registry;
            }
            state.statuses.insert(
                existing.session_id.clone(),
                IdentitySessionStatus::OfflineDegraded,
            );
            state.access_leases.remove(&existing.session_id);
            return Ok(ImportLegacyIdentityOutcome {
                snapshot: self.snapshot_from_state(&state, self.credentials.health()),
                stage: MigrationStage::CredentialImported,
                already_imported: credential_unchanged && metadata_unchanged,
                legacy_secret_can_be_deleted: false,
            });
        }

        let session_id = IdentitySessionId::new();
        let credential_ref = CredentialRef::for_session(input.realm, &session_id);
        self.credentials
            .put_refresh_credential(&credential_ref, input.refresh_credential)?;

        let persisted = self
            .credentials
            .get_refresh_credential(&credential_ref)?
            .ok_or(BrokerError::CredentialVerificationFailed)?;
        if Sha256::digest(persisted.expose()) != expected_digest {
            let _ = self.credentials.delete_refresh_credential(&credential_ref);
            return Err(BrokerError::CredentialVerificationFailed);
        }

        let mut state = self.lock_state();
        if state.registry.revision != guard_revision {
            drop(state);
            let _ = self.credentials.delete_refresh_credential(&credential_ref);
            return Err(BrokerError::Superseded);
        }

        let next_generation = state
            .registry
            .realm_generations
            .get(&input.realm)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        let mut next_registry = state.registry.clone();
        next_registry.revision = next_registry.revision.saturating_add(1);
        next_registry
            .realm_generations
            .insert(input.realm, next_generation);

        let replaced_credentials: Vec<_> = next_registry
            .sessions
            .iter()
            .filter(|session| {
                session.realm == input.realm
                    && session.issuer == input.issuer
                    && session.subject == input.subject
            })
            .map(|session| session.credential_ref.clone())
            .collect();
        next_registry.sessions.retain(|session| {
            !(session.realm == input.realm
                && session.issuer == input.issuer
                && session.subject == input.subject)
        });
        next_registry
            .quarantined_credentials
            .extend(replaced_credentials.iter().cloned());
        next_registry.sessions.push(PersistedSessionRecord {
            session_id: session_id.clone(),
            realm: input.realm,
            issuer: input.issuer,
            public_client_key: input.public_client_key,
            oauth_client_id: None,
            subject: input.subject,
            display_name: input.display_name,
            primary_email: input.primary_email,
            avatar_url: input.avatar_url,
            scopes: input.scopes,
            expires_at_unix: input.expires_at_unix,
            generation: next_generation,
            credential_ref: credential_ref.clone(),
        });
        next_registry
            .active_sessions
            .insert(input.realm, session_id.clone());

        if let Err(error) = self.metadata.save(&next_registry) {
            drop(state);
            let _ = self.credentials.delete_refresh_credential(&credential_ref);
            return Err(error);
        }
        state.registry = next_registry;
        state.access_leases.clear();
        state
            .statuses
            .insert(session_id, IdentitySessionStatus::OfflineDegraded);
        for old in &replaced_credentials {
            if let Some(session_id) = state
                .statuses
                .keys()
                .find(|session_id| {
                    !state
                        .registry
                        .sessions
                        .iter()
                        .any(|session| session.session_id == **session_id)
                })
                .cloned()
            {
                state.statuses.remove(&session_id);
            }
            if self.credentials.delete_refresh_credential(old).is_ok() {
                state.registry.quarantined_credentials.remove(old);
            }
        }
        if !replaced_credentials.is_empty() {
            state.registry.revision = state.registry.revision.saturating_add(1);
            self.metadata.save(&state.registry)?;
        }
        let snapshot = self.snapshot_from_state(&state, self.credentials.health());
        Ok(ImportLegacyIdentityOutcome {
            snapshot,
            stage: MigrationStage::CredentialImported,
            already_imported: false,
            // Phase 1 is the documented internal shadow rollout. The legacy
            // owner may delete only after a trusted endpoint verifies the
            // session; shape validation and Keychain read-back are not enough.
            legacy_secret_can_be_deleted: false,
        })
    }

    pub fn sign_out(
        &self,
        realm: IdentityRealm,
        session_id: Option<&IdentitySessionId>,
    ) -> Result<IdentitySnapshot, BrokerError> {
        let secure_store_status = self.credentials.health();
        let (credential_refs, mut next_registry) = {
            let mut state = self.lock_state();
            let next_generation = state
                .registry
                .realm_generations
                .get(&realm)
                .copied()
                .unwrap_or(0)
                .saturating_add(1);

            // Bump the in-memory revision/generation before any storage I/O so
            // a restore that already started cannot commit after sign-out.
            state.registry.revision = state.registry.revision.saturating_add(1);
            state
                .registry
                .realm_generations
                .insert(realm, next_generation);
            if realm == IdentityRealm::Org2Cloud {
                state.flows.clear();
            }
            if realm == IdentityRealm::HostedServiceLegacy {
                state.hosted_flows.clear();
            }

            let targets: Vec<_> = state
                .registry
                .sessions
                .iter()
                .filter(|session| {
                    session.realm == realm
                        && session_id
                            .map(|target| target == &session.session_id)
                            .unwrap_or(true)
                })
                .map(|session| (session.session_id.clone(), session.credential_ref.clone()))
                .collect();
            let target_ids: std::collections::BTreeSet<_> =
                targets.iter().map(|(id, _)| id.clone()).collect();
            let credential_refs: Vec<_> = targets
                .iter()
                .map(|(_, credential_ref)| credential_ref.clone())
                .collect();

            let mut next = state.registry.clone();
            next.sessions
                .retain(|session| !target_ids.contains(&session.session_id));
            next.active_sessions.retain(|active_realm, active_id| {
                *active_realm != realm || !target_ids.contains(active_id)
            });
            next.quarantined_credentials
                .extend(credential_refs.iter().cloned());
            self.metadata.save(&next)?;
            state.registry = next.clone();
            state.statuses.retain(|id, _| !target_ids.contains(id));
            state.access_leases.retain(|id, _| !target_ids.contains(id));
            (credential_refs, next)
        };

        let mut quarantine_changed = false;
        for credential_ref in &credential_refs {
            if self
                .credentials
                .delete_refresh_credential(credential_ref)
                .is_ok()
            {
                next_registry.quarantined_credentials.remove(credential_ref);
                quarantine_changed = true;
            }
        }

        let mut state = self.lock_state();
        if state.registry.revision != next_registry.revision {
            return Ok(self.snapshot_from_state(&state, secure_store_status));
        }
        if quarantine_changed {
            next_registry.revision = next_registry.revision.saturating_add(1);
            self.metadata.save(&next_registry)?;
            state.registry = next_registry;
        }
        Ok(self.snapshot_from_state(&state, secure_store_status))
    }

    fn validate_hosted_oauth_config(config: &HostedServiceOAuthConfig) -> Result<(), BrokerError> {
        let issuer = Url::parse(&config.issuer)
            .map_err(|_| BrokerError::InvalidInput("Hosted OAuth issuer is invalid"))?;
        Self::validate_origin_url(&issuer, "Hosted OAuth issuer is invalid")?;
        if !matches!(issuer.path(), "" | "/") {
            return Err(BrokerError::InvalidInput("Hosted OAuth issuer is invalid"));
        }
        let endpoint = Url::parse(&config.authorization_endpoint)
            .map_err(|_| BrokerError::InvalidInput("Hosted OAuth endpoint is invalid"))?;
        if endpoint.origin() != issuer.origin()
            || endpoint.path() != "/auth/v1/authorize"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err(BrokerError::InvalidInput(
                "Hosted OAuth endpoint did not match issuer",
            ));
        }
        let redirect = Url::parse(&config.redirect_uri)
            .map_err(|_| BrokerError::InvalidInput("Hosted OAuth redirect URI is invalid"))?;
        if redirect.scheme() != "yorgai"
            || redirect.host_str() != Some("marketplace")
            || redirect.path() != "/callback"
            || !redirect.username().is_empty()
            || redirect.password().is_some()
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err(BrokerError::InvalidInput(
                "Hosted OAuth redirect URI is invalid",
            ));
        }
        if config.provider != "github" {
            return Err(BrokerError::InvalidInput(
                "Hosted OAuth provider is invalid",
            ));
        }
        if config.public_client_key.trim().is_empty() || config.public_client_key.len() > 4_096 {
            return Err(BrokerError::InvalidInput("public client key is invalid"));
        }
        if config.scopes.is_empty()
            || config.scopes.len() > 16
            || config.scopes.iter().any(|scope| {
                scope.is_empty()
                    || scope.len() > 64
                    || !scope
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-._~:".contains(&byte))
            })
        {
            return Err(BrokerError::InvalidInput("Hosted OAuth scopes are invalid"));
        }
        Ok(())
    }

    fn validate_oauth_config(config: &Org2CloudOAuthConfig) -> Result<(), BrokerError> {
        let issuer = Url::parse(&config.issuer)
            .map_err(|_| BrokerError::InvalidInput("OAuth issuer is invalid"))?;
        Self::validate_origin_url(&issuer, "OAuth issuer is invalid")?;
        if !matches!(issuer.path(), "" | "/") {
            return Err(BrokerError::InvalidInput("OAuth issuer is invalid"));
        }

        let expected = [
            (&config.authorization_endpoint, "/auth/v1/oauth/authorize"),
            (&config.token_endpoint, "/auth/v1/oauth/token"),
            (&config.user_endpoint, "/auth/v1/oauth/userinfo"),
        ];
        for (raw_url, path) in expected {
            let endpoint = Url::parse(raw_url)
                .map_err(|_| BrokerError::InvalidInput("OAuth endpoint is invalid"))?;
            if endpoint.origin() != issuer.origin()
                || endpoint.path() != path
                || endpoint.query().is_some()
                || endpoint.fragment().is_some()
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
            {
                return Err(BrokerError::InvalidInput(
                    "OAuth endpoint did not match issuer",
                ));
            }
        }

        let redirect = Url::parse(&config.redirect_uri)
            .map_err(|_| BrokerError::InvalidInput("OAuth redirect URI is invalid"))?;
        Self::validate_origin_url(&redirect, "OAuth redirect URI is invalid")?;
        if redirect.path() != "/auth/desktop/oauth/callback" {
            return Err(BrokerError::InvalidInput(
                "OAuth redirect URI path is invalid",
            ));
        }
        if config.client_id.len() < 8
            || config.client_id.len() > 256
            || !config
                .client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
        {
            return Err(BrokerError::InvalidInput("OAuth client id is invalid"));
        }
        if config.public_client_key.trim().is_empty() || config.public_client_key.len() > 4_096 {
            return Err(BrokerError::InvalidInput("public client key is invalid"));
        }
        let required_scopes = vec!["email".to_owned(), "profile".to_owned()];
        if !Self::same_scope_set(&config.scopes, &required_scopes) {
            return Err(BrokerError::InvalidInput("OAuth scopes are invalid"));
        }
        Ok(())
    }

    fn validate_origin_url(url: &Url, message: &'static str) -> Result<(), BrokerError> {
        let loopback_http = url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
        if (url.scheme() != "https" && !loopback_http)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(BrokerError::InvalidInput(message));
        }
        Ok(())
    }

    fn same_scope_set(left: &[String], right: &[String]) -> bool {
        let left_set: std::collections::BTreeSet<_> = left.iter().map(String::as_str).collect();
        let right_set: std::collections::BTreeSet<_> = right.iter().map(String::as_str).collect();
        left.len() == left_set.len() && right.len() == right_set.len() && left_set == right_set
    }

    fn validate_verified_session(
        verified: &VerifiedOrg2CloudSession,
        now_unix: i64,
    ) -> Result<(), BrokerError> {
        if verified.subject.trim().is_empty() || verified.subject.len() > 512 {
            return Err(BrokerError::InvalidInput("verified subject is invalid"));
        }
        if verified.refresh_credential.is_empty() {
            return Err(BrokerError::InvalidInput(
                "verified refresh credential is empty",
            ));
        }
        if verified.access_credential.is_empty()
            || verified.access_credential.expose().len() > 32_768
        {
            return Err(BrokerError::InvalidInput(
                "verified access credential is invalid",
            ));
        }
        if verified.expires_at_unix <= now_unix.saturating_sub(60)
            || verified.expires_at_unix > now_unix.saturating_add(86_400)
        {
            return Err(BrokerError::InvalidInput(
                "verified access expiry is invalid",
            ));
        }
        for value in [
            verified.display_name.as_deref(),
            verified.primary_email.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
                return Err(BrokerError::InvalidInput(
                    "verified profile value is invalid",
                ));
            }
        }
        if let Some(avatar_url) = &verified.avatar_url {
            if avatar_url.len() > 2_048 {
                return Err(BrokerError::InvalidInput("verified avatar is invalid"));
            }
            let avatar = Url::parse(avatar_url)
                .map_err(|_| BrokerError::InvalidInput("verified avatar is invalid"))?;
            if avatar.scheme() != "https" || avatar.host_str().is_none() {
                return Err(BrokerError::InvalidInput("verified avatar is invalid"));
            }
        }
        if verified.scopes.is_empty()
            || verified.scopes.len() > 16
            || verified.scopes.iter().any(|scope| {
                scope.is_empty()
                    || scope.len() > 64
                    || !scope
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
            })
        {
            return Err(BrokerError::InvalidInput("verified scopes are invalid"));
        }
        Ok(())
    }

    fn unix_now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
            .unwrap_or(0)
    }

    fn validate_legacy_input(input: &LegacySupabaseSession) -> Result<(), BrokerError> {
        if !matches!(
            input.realm,
            IdentityRealm::Org2Cloud | IdentityRealm::HostedServiceLegacy
        ) {
            return Err(BrokerError::InvalidInput(
                "legacy Supabase realm is invalid",
            ));
        }
        let issuer = Url::parse(&input.issuer)
            .map_err(|_| BrokerError::InvalidInput("issuer must be an absolute URL"))?;
        let loopback_http = issuer.scheme() == "http"
            && issuer
                .host_str()
                .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "[::1]"));
        if issuer.scheme() != "https" && !loopback_http {
            return Err(BrokerError::InvalidInput(
                "issuer must use HTTPS outside loopback development",
            ));
        }
        if issuer.host_str().is_none()
            || !issuer.username().is_empty()
            || issuer.password().is_some()
        {
            return Err(BrokerError::InvalidInput("issuer authority is invalid"));
        }
        if input.subject.trim().is_empty() || input.subject.len() > 512 {
            return Err(BrokerError::InvalidInput("subject is invalid"));
        }
        if input.public_client_key.trim().is_empty() || input.public_client_key.len() > 4096 {
            return Err(BrokerError::InvalidInput("public client key is invalid"));
        }
        if input.refresh_credential.is_empty() {
            return Err(BrokerError::InvalidInput("refresh credential is empty"));
        }
        if input.scopes.len() > 128 || input.scopes.iter().any(|scope| scope.len() > 256) {
            return Err(BrokerError::InvalidInput("scope list is invalid"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;

    use super::*;
    use crate::metadata::{FileSessionMetadataStore, MemorySessionMetadataStore};
    use crate::{CredentialStore, FaultCredentialStore, MemoryCredentialStore, SecretBytes};

    fn legacy_session(secret: &str) -> LegacySupabaseSession {
        LegacySupabaseSession {
            realm: IdentityRealm::Org2Cloud,
            issuer: "https://cloud.example.test".to_owned(),
            public_client_key: "public-anon-key".to_owned(),
            subject: "user-123".to_owned(),
            display_name: Some("Ada".to_owned()),
            primary_email: Some("ada@example.test".to_owned()),
            avatar_url: None,
            scopes: vec!["openid".to_owned()],
            expires_at_unix: Some(2_000_000_000),
            refresh_credential: SecretBytes::new(secret.as_bytes().to_vec()),
        }
    }

    fn oauth_config() -> Org2CloudOAuthConfig {
        Org2CloudOAuthConfig {
            issuer: "https://project.supabase.co".to_owned(),
            public_client_key: "public-anon-key".to_owned(),
            authorization_endpoint: "https://project.supabase.co/auth/v1/oauth/authorize"
                .to_owned(),
            token_endpoint: "https://project.supabase.co/auth/v1/oauth/token".to_owned(),
            user_endpoint: "https://project.supabase.co/auth/v1/oauth/userinfo".to_owned(),
            client_id: "org2-desktop-client".to_owned(),
            redirect_uri: "https://cloud.example.test/auth/desktop/oauth/callback".to_owned(),
            scopes: vec!["email".to_owned(), "profile".to_owned()],
        }
    }

    fn hosted_oauth_config() -> HostedServiceOAuthConfig {
        HostedServiceOAuthConfig {
            issuer: "https://project.supabase.co".to_owned(),
            public_client_key: "public-anon-key".to_owned(),
            authorization_endpoint: "https://project.supabase.co/auth/v1/authorize".to_owned(),
            redirect_uri: "yorgai://marketplace/callback".to_owned(),
            provider: "github".to_owned(),
            scopes: vec!["read:user".to_owned(), "user:email".to_owned()],
        }
    }

    fn callback_for(prepared: &PreparedSignIn, code: &str) -> String {
        let authorization_url = Url::parse(&prepared.authorization_url).unwrap();
        let state = authorization_url
            .query_pairs()
            .find_map(|(name, value)| (name == "state").then(|| value.into_owned()))
            .unwrap();
        format!("http://127.0.0.1:49152{ORG2_CLOUD_CALLBACK_PATH}?code={code}&state={state}")
    }

    fn exchange_error(result: Result<OAuthCodeExchange, BrokerError>) -> BrokerError {
        match result {
            Ok(_) => panic!("expected callback rejection"),
            Err(error) => error,
        }
    }

    #[test]
    fn secret_debug_and_display_are_redacted() {
        let secret = SecretBytes::new(b"do-not-print".to_vec());
        assert_eq!(format!("{secret:?}"), "<redacted>");
        assert_eq!(secret.to_string(), "<redacted>");
    }

    #[test]
    fn public_snapshot_serialization_has_no_secret_fields() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials, metadata);
        let outcome = broker
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap();
        let wire = serde_json::to_string(&outcome.snapshot).unwrap();
        for forbidden in [
            "refreshToken",
            "refresh_token",
            "codeVerifier",
            "clientSecret",
            "idToken",
            "sessionToken",
            "authorizationHeader",
            "refresh-value",
        ] {
            assert!(
                !wire.contains(forbidden),
                "wire contained {forbidden}: {wire}"
            );
        }
    }

    #[test]
    fn prepared_pkce_flow_exposes_only_public_challenge_and_state() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let prepared = broker
            .prepare_org2_cloud_sign_in_at(oauth_config(), 49_152, 1_000)
            .unwrap();
        let authorize = Url::parse(&prepared.authorization_url).unwrap();
        let parameters: BTreeMap<_, _> = authorize.query_pairs().into_owned().collect();
        assert_eq!(
            parameters.get("response_type").map(String::as_str),
            Some("code")
        );
        assert_eq!(
            parameters.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(parameters.get("code_challenge").unwrap().len(), 43);
        assert!(parameters
            .get("state")
            .unwrap()
            .starts_with("org2v1.49152."));
        assert_eq!(prepared.snapshot.flows[0].phase, SignInFlowPhase::Preparing);

        let wire = serde_json::to_string(&prepared.snapshot).unwrap();
        assert!(!wire.contains("codeVerifier"));
        assert!(!wire.contains("code_verifier"));
        assert!(!prepared.authorization_url.contains("code_verifier"));
    }

    #[test]
    fn hosted_pkce_callback_commits_only_the_hosted_realm() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let prepared = broker
            .prepare_hosted_service_sign_in_at(hosted_oauth_config(), 1_000)
            .unwrap();
        let authorize = Url::parse(&prepared.authorization_url).unwrap();
        let parameters: BTreeMap<_, _> = authorize.query_pairs().into_owned().collect();
        assert_eq!(
            parameters.get("provider").map(String::as_str),
            Some("github")
        );
        assert_eq!(
            parameters.get("code_challenge_method").map(String::as_str),
            Some("s256")
        );
        assert!(!prepared.authorization_url.contains("code_verifier"));
        broker
            .mark_hosted_browser_opened(&prepared.flow_id, prepared.generation)
            .unwrap();
        broker
            .mark_hosted_awaiting_callback(&prepared.flow_id, prepared.generation)
            .unwrap();
        let exchange = broker
            .accept_hosted_service_callback_at("single-use-code", 1_001)
            .unwrap();
        assert_eq!(exchange.code(), b"single-use-code");
        assert!(matches!(
            broker.accept_hosted_service_callback_at("replay", 1_001),
            Err(BrokerError::CallbackAlreadyConsumed)
        ));
        broker
            .mark_hosted_verifying_session(&prepared.flow_id, prepared.generation)
            .unwrap();
        let snapshot = broker
            .complete_verified_hosted_service_session(
                &prepared.flow_id,
                prepared.generation,
                VerifiedHostedServiceSession {
                    subject: "hosted-user".to_owned(),
                    display_name: Some("Ada".to_owned()),
                    primary_email: Some("ada@example.test".to_owned()),
                    avatar_url: Some("https://example.test/avatar.png".to_owned()),
                    expires_at_unix: IdentityBroker::unix_now() + 3_600,
                    access_credential: SecretBytes::new(b"header.payload.signature".to_vec()),
                    refresh_credential: SecretBytes::new(b"hosted-refresh".to_vec()),
                },
            )
            .unwrap();
        let hosted = snapshot
            .sessions
            .iter()
            .find(|session| session.realm == IdentityRealm::HostedServiceLegacy)
            .unwrap();
        assert_eq!(hosted.status, IdentitySessionStatus::Ready);
        assert!(!snapshot
            .active_sessions
            .contains_key(&IdentityRealm::Org2Cloud));
        assert!(broker
            .cached_org2_cloud_access_lease(&hosted.session_id, hosted.generation)
            .is_err());
        assert!(broker
            .cached_hosted_service_access_lease(&hosted.session_id, hosted.generation)
            .unwrap()
            .is_some());
    }

    #[test]
    fn code_callback_verifies_then_commits_ready_session() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials.clone(), metadata.clone());
        let prepared = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        broker
            .mark_browser_opened(&prepared.flow_id, prepared.generation)
            .unwrap();
        broker
            .mark_awaiting_callback(&prepared.flow_id, prepared.generation)
            .unwrap();
        let exchange = broker
            .accept_org2_cloud_callback(
                &prepared.flow_id,
                prepared.generation,
                &callback_for(&prepared, "single-use-code"),
            )
            .unwrap();
        assert_eq!(exchange.code(), b"single-use-code");
        assert_eq!(exchange.verifier().len(), 43);
        broker
            .mark_verifying_session(&prepared.flow_id, prepared.generation)
            .unwrap();
        let snapshot = broker
            .complete_verified_org2_cloud_session(
                &prepared.flow_id,
                prepared.generation,
                VerifiedOrg2CloudSession {
                    subject: "user-123".to_owned(),
                    display_name: Some("Ada".to_owned()),
                    primary_email: Some("ada@example.test".to_owned()),
                    avatar_url: Some("https://example.test/avatar.png".to_owned()),
                    scopes: vec!["email".to_owned(), "profile".to_owned()],
                    expires_at_unix: IdentityBroker::unix_now() + 3_600,
                    access_credential: SecretBytes::new(b"header.payload.signature".to_vec()),
                    refresh_credential: SecretBytes::new(b"refresh-value".to_vec()),
                },
            )
            .unwrap();
        assert!(snapshot.flows.is_empty());
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].status, IdentitySessionStatus::Ready);
        assert_eq!(snapshot.sessions[0].issuer, "https://project.supabase.co");
        let initial_lease = broker
            .cached_org2_cloud_access_lease(
                &snapshot.sessions[0].session_id,
                snapshot.sessions[0].generation,
            )
            .unwrap()
            .expect("verified sign-in should publish its initial access lease");
        assert_eq!(
            initial_lease.access_credential.expose(),
            b"header.payload.signature"
        );
        let registry = metadata.load().unwrap().unwrap();
        assert_eq!(
            registry.sessions[0].oauth_client_id.as_deref(),
            Some("org2-desktop-client")
        );
        let credential_ref = &registry.sessions[0].credential_ref;
        assert_eq!(
            credentials
                .get_refresh_credential(credential_ref)
                .unwrap()
                .unwrap()
                .expose(),
            b"refresh-value"
        );
    }

    #[test]
    fn callback_state_mismatch_fails_without_exchanging() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let prepared = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        broker
            .mark_browser_opened(&prepared.flow_id, prepared.generation)
            .unwrap();
        broker
            .mark_awaiting_callback(&prepared.flow_id, prepared.generation)
            .unwrap();
        let wrong_state = format!("org2v1.49152.{}", "B".repeat(43));
        let error = exchange_error(broker.accept_org2_cloud_callback(
            &prepared.flow_id,
            prepared.generation,
            &format!("http://127.0.0.1:49152{ORG2_CLOUD_CALLBACK_PATH}?code=x&state={wrong_state}"),
        ));
        assert_eq!(error.code(), "state_mismatch");
        assert_eq!(broker.snapshot().flows[0].phase, SignInFlowPhase::Failed);
    }

    #[test]
    fn callback_is_single_use() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let prepared = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        broker
            .mark_browser_opened(&prepared.flow_id, prepared.generation)
            .unwrap();
        broker
            .mark_awaiting_callback(&prepared.flow_id, prepared.generation)
            .unwrap();
        let callback = callback_for(&prepared, "single-use-code");
        broker
            .accept_org2_cloud_callback(&prepared.flow_id, prepared.generation, &callback)
            .unwrap();
        assert_eq!(
            exchange_error(broker.accept_org2_cloud_callback(
                &prepared.flow_id,
                prepared.generation,
                &callback,
            ))
            .code(),
            "callback_already_consumed"
        );
    }

    #[test]
    fn expired_callback_and_exchange_failure_end_the_flow() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let expired = broker
            .prepare_org2_cloud_sign_in_at(oauth_config(), 49_152, 1_000)
            .unwrap();
        broker
            .mark_browser_opened(&expired.flow_id, expired.generation)
            .unwrap();
        broker
            .mark_awaiting_callback(&expired.flow_id, expired.generation)
            .unwrap();
        assert_eq!(
            exchange_error(broker.accept_org2_cloud_callback_at(
                &expired.flow_id,
                expired.generation,
                &callback_for(&expired, "late-code"),
                1_301,
            ))
            .code(),
            "callback_expired"
        );

        let network_failure = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        broker
            .mark_browser_opened(&network_failure.flow_id, network_failure.generation)
            .unwrap();
        broker
            .mark_awaiting_callback(&network_failure.flow_id, network_failure.generation)
            .unwrap();
        broker
            .accept_org2_cloud_callback(
                &network_failure.flow_id,
                network_failure.generation,
                &callback_for(&network_failure, "code-before-network-error"),
            )
            .unwrap();
        let snapshot = broker
            .fail_sign_in(&network_failure.flow_id, network_failure.generation)
            .unwrap();
        assert_eq!(snapshot.flows[0].phase, SignInFlowPhase::Failed);
    }

    #[test]
    fn newer_flow_supersedes_old_callback_generation() {
        let broker = IdentityBroker::new(
            Arc::new(MemoryCredentialStore::default()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let first = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        let second = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_153)
            .unwrap();
        assert!(second.generation > first.generation);
        assert_eq!(broker.snapshot().flows[0].flow_id, second.flow_id);
        assert_eq!(
            broker
                .mark_browser_opened(&first.flow_id, first.generation)
                .unwrap_err()
                .code(),
            "flow_not_found"
        );
    }

    #[test]
    fn credential_store_contract_is_idempotent() {
        let store = MemoryCredentialStore::default();
        let session_id = IdentitySessionId::new();
        let key = CredentialRef::for_session(IdentityRealm::Org2Cloud, &session_id);
        assert!(store.get_refresh_credential(&key).unwrap().is_none());
        store
            .put_refresh_credential(&key, SecretBytes::new(b"one".to_vec()))
            .unwrap();
        assert_eq!(
            store
                .get_refresh_credential(&key)
                .unwrap()
                .unwrap()
                .expose(),
            b"one"
        );
        store.delete_refresh_credential(&key).unwrap();
        store.delete_refresh_credential(&key).unwrap();
        assert!(store.get_refresh_credential(&key).unwrap().is_none());
    }

    #[test]
    fn unavailable_store_has_a_fail_closed_contract() {
        let store = FaultCredentialStore::unavailable();
        let key = CredentialRef::for_session(IdentityRealm::Org2Cloud, &IdentitySessionId::new());
        assert_eq!(store.health(), SecureStoreStatus::Unavailable);
        assert_eq!(
            store.get_refresh_credential(&key).unwrap_err(),
            CredentialStoreError::Unavailable
        );
        assert!(store
            .put_refresh_credential(&key, SecretBytes::new(b"value".to_vec()))
            .is_err());
        assert!(store.delete_refresh_credential(&key).is_err());
    }

    #[test]
    fn failed_secure_write_does_not_commit_identity() {
        let broker = IdentityBroker::new(
            Arc::new(FaultCredentialStore::fail_put()),
            Arc::new(MemorySessionMetadataStore::default()),
        );
        let error = broker
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap_err();
        assert_eq!(error.code(), "secure_store_operation_failed");
        assert!(broker.snapshot().sessions.is_empty());
    }

    #[test]
    fn imported_session_restores_and_signs_out_across_broker_instances() {
        let directory = tempfile::tempdir().unwrap();
        let metadata = Arc::new(FileSessionMetadataStore::new(
            directory.path().join("sessions-v1.json"),
        ));
        let credentials = Arc::new(MemoryCredentialStore::default());
        let first = IdentityBroker::new(credentials.clone(), metadata.clone());
        first
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap();
        let persisted_metadata =
            std::fs::read_to_string(directory.path().join("sessions-v1.json")).unwrap();
        assert!(persisted_metadata.contains("credentialRef"));
        assert!(!persisted_metadata.contains("refresh-value"));

        let second = IdentityBroker::new(credentials.clone(), metadata.clone());
        let restored = second.retry_restore().unwrap();
        assert_eq!(restored.sessions.len(), 1);
        assert_eq!(
            restored.sessions[0].status,
            IdentitySessionStatus::OfflineDegraded
        );
        assert!(restored
            .active_sessions
            .contains_key(&IdentityRealm::Org2Cloud));

        let signed_out = second.sign_out(IdentityRealm::Org2Cloud, None).unwrap();
        assert!(signed_out.sessions.is_empty());
        let third = IdentityBroker::new(credentials, metadata);
        assert!(third.retry_restore().unwrap().sessions.is_empty());
    }

    #[test]
    fn repeated_shadow_import_is_idempotent() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials, metadata);
        broker
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap();
        let second = broker
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap();
        assert!(second.already_imported);
        assert_eq!(second.snapshot.sessions.len(), 1);
    }

    #[test]
    fn shadow_import_updates_rotated_credential_without_changing_session_identity() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials.clone(), metadata.clone());
        let first = broker
            .import_legacy_supabase_session(legacy_session("refresh-one"))
            .unwrap();
        let first_session_id = first.snapshot.sessions[0].session_id.clone();

        let updated = broker
            .import_legacy_supabase_session(legacy_session("refresh-two"))
            .unwrap();
        assert!(!updated.already_imported);
        assert_eq!(updated.snapshot.sessions[0].session_id, first_session_id);

        let registry = metadata.load().unwrap().unwrap();
        let credential_ref = &registry.sessions[0].credential_ref;
        assert_eq!(
            credentials
                .get_refresh_credential(credential_ref)
                .unwrap()
                .unwrap()
                .expose(),
            b"refresh-two"
        );

        let restarted = IdentityBroker::new(credentials, metadata);
        let restored = restarted.retry_restore().unwrap();
        assert_eq!(restored.sessions[0].session_id, first_session_id);
    }

    #[test]
    fn refresh_rotation_is_committed_to_secure_storage_and_cached_as_a_lease() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials.clone(), metadata.clone());
        let imported = broker
            .import_legacy_supabase_session(legacy_session("refresh-one"))
            .unwrap();
        let session = &imported.snapshot.sessions[0];

        assert!(broker
            .cached_org2_cloud_access_lease(&session.session_id, session.generation)
            .unwrap()
            .is_none());
        let request = broker
            .prepare_org2_cloud_refresh(&session.session_id, session.generation)
            .unwrap();
        let (lease, snapshot) = broker
            .commit_supabase_refresh(
                request,
                RefreshedSupabaseAccess {
                    subject: "user-123".to_owned(),
                    expires_at_unix: IdentityBroker::unix_now() + 3_600,
                    access_credential: SecretBytes::new(b"access-two".to_vec()),
                    refresh_credential: Some(SecretBytes::new(b"refresh-two".to_vec())),
                },
            )
            .unwrap();

        assert_eq!(lease.access_credential.expose(), b"access-two");
        assert_eq!(snapshot.sessions[0].status, IdentitySessionStatus::Ready);
        let registry = metadata.load().unwrap().unwrap();
        assert_eq!(
            credentials
                .get_refresh_credential(&registry.sessions[0].credential_ref)
                .unwrap()
                .unwrap()
                .expose(),
            b"refresh-two"
        );
        assert_eq!(
            broker
                .cached_org2_cloud_access_lease(&session.session_id, session.generation)
                .unwrap()
                .unwrap()
                .access_credential
                .expose(),
            b"access-two"
        );
    }

    #[test]
    fn sign_out_supersedes_an_in_flight_refresh_commit_without_resurrection() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials.clone(), metadata.clone());
        let imported = broker
            .import_legacy_supabase_session(legacy_session("refresh-one"))
            .unwrap();
        let session = &imported.snapshot.sessions[0];
        let credential_ref = metadata.load().unwrap().unwrap().sessions[0]
            .credential_ref
            .clone();
        let request = broker
            .prepare_org2_cloud_refresh(&session.session_id, session.generation)
            .unwrap();

        broker
            .sign_out(IdentityRealm::Org2Cloud, Some(&session.session_id))
            .unwrap();
        let error = broker
            .commit_supabase_refresh(
                request,
                RefreshedSupabaseAccess {
                    subject: "user-123".to_owned(),
                    expires_at_unix: IdentityBroker::unix_now() + 3_600,
                    access_credential: SecretBytes::new(b"late-access".to_vec()),
                    refresh_credential: Some(SecretBytes::new(b"late-refresh".to_vec())),
                },
            )
            .err()
            .expect("late refresh must be rejected");

        assert_eq!(error.code(), "superseded");
        assert!(broker.snapshot().sessions.is_empty());
        assert!(credentials
            .get_refresh_credential(&credential_ref)
            .unwrap()
            .is_none());
    }

    #[test]
    fn account_switch_generation_supersedes_an_in_flight_refresh() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials, metadata.clone());
        let imported = broker
            .import_legacy_supabase_session(legacy_session("refresh-one"))
            .unwrap();
        let old_session = imported.snapshot.sessions[0].clone();
        let old_refresh = broker
            .prepare_org2_cloud_refresh(&old_session.session_id, old_session.generation)
            .unwrap();

        let switch = broker
            .prepare_org2_cloud_sign_in(oauth_config(), 49_152)
            .unwrap();
        let switched_session = switch
            .snapshot
            .sessions
            .iter()
            .find(|session| session.session_id == old_session.session_id)
            .expect("the previous verified account remains available during browser sign-in");
        assert_eq!(switched_session.generation, switch.generation);
        assert!(switched_session.generation > old_session.generation);
        assert_eq!(
            metadata.load().unwrap().unwrap().sessions[0].generation,
            switch.generation,
            "the generation fence must survive a process restart"
        );

        let error = match broker.commit_supabase_refresh(
            old_refresh,
            RefreshedSupabaseAccess {
                subject: "user-123".to_owned(),
                expires_at_unix: IdentityBroker::unix_now() + 3_600,
                access_credential: SecretBytes::new(b"late-access".to_vec()),
                refresh_credential: Some(SecretBytes::new(b"late-refresh".to_vec())),
            },
        ) {
            Ok(_) => panic!("the pre-switch refresh must not write into the new generation"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "superseded");
        assert_eq!(broker.snapshot().sessions[0].generation, switch.generation);
    }

    #[test]
    fn permanent_refresh_rejection_requires_reauthentication_and_deletes_secret() {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let broker = IdentityBroker::new(credentials.clone(), metadata.clone());
        let imported = broker
            .import_legacy_supabase_session(legacy_session("rejected-refresh"))
            .unwrap();
        let session = &imported.snapshot.sessions[0];
        let credential_ref = metadata.load().unwrap().unwrap().sessions[0]
            .credential_ref
            .clone();
        let request = broker
            .prepare_org2_cloud_refresh(&session.session_id, session.generation)
            .unwrap();

        let snapshot = broker.reject_supabase_refresh(&request).unwrap();

        assert_eq!(
            snapshot.sessions[0].status,
            IdentitySessionStatus::ReauthRequired
        );
        assert_eq!(
            broker
                .prepare_org2_cloud_refresh(&session.session_id, session.generation)
                .err()
                .expect("rejected session must not refresh again")
                .code(),
            "identity_reauth_required"
        );
        assert!(credentials
            .get_refresh_credential(&credential_ref)
            .unwrap()
            .is_none());
    }

    struct BlockingGetStore {
        inner: Arc<MemoryCredentialStore>,
        block_next_get: Mutex<bool>,
        gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
    }

    impl BlockingGetStore {
        fn new(inner: Arc<MemoryCredentialStore>) -> Self {
            Self {
                inner,
                block_next_get: Mutex::new(false),
                gate: Arc::new((Mutex::new((false, false)), Condvar::new())),
            }
        }

        fn block_next_get(&self) {
            *self.block_next_get.lock().unwrap() = true;
        }

        fn wait_until_blocked(&self) {
            let (lock, condvar) = &*self.gate;
            let state = lock.lock().unwrap();
            let _state = condvar.wait_while(state, |state| !state.0).unwrap();
        }

        fn release(&self) {
            let (lock, condvar) = &*self.gate;
            lock.lock().unwrap().1 = true;
            condvar.notify_all();
        }
    }

    impl CredentialStore for BlockingGetStore {
        fn put_refresh_credential(
            &self,
            key: &CredentialRef,
            secret: SecretBytes,
        ) -> Result<(), CredentialStoreError> {
            self.inner.put_refresh_credential(key, secret)
        }

        fn get_refresh_credential(
            &self,
            key: &CredentialRef,
        ) -> Result<Option<SecretBytes>, CredentialStoreError> {
            let should_block = std::mem::take(&mut *self.block_next_get.lock().unwrap());
            if should_block {
                let (lock, condvar) = &*self.gate;
                let mut state = lock.lock().unwrap();
                state.0 = true;
                condvar.notify_all();
                let _state = condvar.wait_while(state, |state| !state.1).unwrap();
            }
            self.inner.get_refresh_credential(key)
        }

        fn delete_refresh_credential(
            &self,
            key: &CredentialRef,
        ) -> Result<(), CredentialStoreError> {
            self.inner.delete_refresh_credential(key)
        }

        fn health(&self) -> SecureStoreStatus {
            SecureStoreStatus::Available
        }
    }

    #[test]
    fn sign_out_defeats_a_late_restore() {
        let metadata = Arc::new(MemorySessionMetadataStore::default());
        let memory = Arc::new(MemoryCredentialStore::default());
        let initial = IdentityBroker::new(memory.clone(), metadata.clone());
        initial
            .import_legacy_supabase_session(legacy_session("refresh-value"))
            .unwrap();

        let blocking = Arc::new(BlockingGetStore::new(memory));
        let broker = Arc::new(IdentityBroker::new(blocking.clone(), metadata));
        broker.retry_restore().unwrap();
        blocking.block_next_get();

        let restoring = {
            let broker = broker.clone();
            thread::spawn(move || broker.retry_restore().unwrap())
        };
        blocking.wait_until_blocked();
        let signed_out = broker.sign_out(IdentityRealm::Org2Cloud, None).unwrap();
        assert!(signed_out.sessions.is_empty());
        blocking.release();
        let late = restoring.join().unwrap();
        assert!(late.sessions.is_empty());
        assert!(broker.snapshot().sessions.is_empty());
    }
}
