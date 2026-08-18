use std::collections::BTreeMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use identity_broker::{
    platform_credential_store, BeginSignInOutcome, BrokerError, IdentityBroker, IdentityRealm,
    IdentitySessionId, IdentitySnapshot, SecretBytes, SupabaseAccessLease,
};
use reqwest::Client;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::events::emit_snapshot_invalidated;
use super::oauth::{self, HostedServiceSignInInput, OAuthAdapterError, Org2CloudSignInInput};

struct ActiveFlow {
    flow_id: String,
    generation: u64,
    task: JoinHandle<()>,
}

#[derive(Debug, Clone, Copy)]
pub struct IdentityRuntimeError {
    code: &'static str,
}

impl IdentityRuntimeError {
    pub fn code(self) -> &'static str {
        self.code
    }
}

impl From<BrokerError> for IdentityRuntimeError {
    fn from(error: BrokerError) -> Self {
        Self { code: error.code() }
    }
}

impl From<OAuthAdapterError> for IdentityRuntimeError {
    fn from(error: OAuthAdapterError) -> Self {
        Self { code: error.code() }
    }
}

pub struct IdentityRuntime {
    broker: Arc<IdentityBroker>,
    http: Client,
    begin_guard: Mutex<()>,
    active_org2_cloud_flow: Mutex<Option<ActiveFlow>>,
    org2_cloud_refresh_guards: Mutex<BTreeMap<IdentitySessionId, Weak<Mutex<()>>>>,
}

impl IdentityRuntime {
    pub fn new(runtime_identifier: &str) -> Self {
        let credentials = platform_credential_store(runtime_identifier);
        let metadata_path = app_paths::orgii_root()
            .join("identity")
            .join("sessions-v1.json");
        Self {
            broker: Arc::new(IdentityBroker::with_file_metadata(
                credentials,
                metadata_path,
            )),
            http: oauth::build_http_client(),
            begin_guard: Mutex::new(()),
            active_org2_cloud_flow: Mutex::new(None),
            org2_cloud_refresh_guards: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn broker(&self) -> Arc<IdentityBroker> {
        Arc::clone(&self.broker)
    }

    pub async fn begin_org2_cloud_sign_in(
        &self,
        app: AppHandle,
        input: Org2CloudSignInInput,
    ) -> Result<BeginSignInOutcome, IdentityRuntimeError> {
        let _begin_guard = self.begin_guard.lock().await;
        if let Some(outcome) = self.reusable_active_flow().await {
            return Ok(outcome);
        }
        self.cancel_active_flow(&app).await;

        let config = oauth::fetch_desktop_oauth_config(&self.http, &input).await?;
        let listener = oauth::bind_loopback().await?;
        let port = listener
            .local_addr()
            .map_err(|_| OAuthAdapterError::new("identity_loopback_bind_failed"))?
            .port();

        let prepared = self.broker.prepare_org2_cloud_sign_in(config, port)?;
        emit_snapshot_invalidated(&app, prepared.snapshot.revision);

        if app
            .opener()
            .open_url(&prepared.authorization_url, None::<&str>)
            .is_err()
        {
            let snapshot = self
                .broker
                .fail_sign_in(&prepared.flow_id, prepared.generation)?;
            emit_snapshot_invalidated(&app, snapshot.revision);
            return Err(IdentityRuntimeError {
                code: "identity_browser_open_failed",
            });
        }

        let browser_open = self
            .broker
            .mark_browser_opened(&prepared.flow_id, prepared.generation)?;
        emit_snapshot_invalidated(&app, browser_open.revision);
        let awaiting = self
            .broker
            .mark_awaiting_callback(&prepared.flow_id, prepared.generation)?;
        emit_snapshot_invalidated(&app, awaiting.revision);

        let flow_id = prepared.flow_id.clone();
        let generation = prepared.generation;
        let broker = Arc::clone(&self.broker);
        let http = self.http.clone();
        let task_app = app.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = run_org2_cloud_flow(
                &task_app, &broker, &http, listener, port, &flow_id, generation,
            )
            .await
            {
                tracing::warn!(
                    flow_id,
                    code = error.code(),
                    "ORG2 Cloud identity flow failed"
                );
                if let Ok(snapshot) = broker.fail_sign_in(&flow_id, generation) {
                    emit_snapshot_invalidated(&task_app, snapshot.revision);
                }
            }
        });
        *self.active_org2_cloud_flow.lock().await = Some(ActiveFlow {
            flow_id: prepared.flow_id.clone(),
            generation,
            task,
        });

        Ok(BeginSignInOutcome {
            flow_id: prepared.flow_id,
            snapshot: awaiting,
        })
    }

    pub async fn cancel_org2_cloud_sign_in(&self, app: &AppHandle) {
        let _begin_guard = self.begin_guard.lock().await;
        self.cancel_active_flow(app).await;
    }

    pub async fn begin_hosted_service_sign_in(
        &self,
        app: AppHandle,
        input: HostedServiceSignInInput,
    ) -> Result<BeginSignInOutcome, IdentityRuntimeError> {
        let _begin_guard = self.begin_guard.lock().await;
        let existing = self.broker.snapshot();
        if let Some(flow) = existing.flows.iter().find(|flow| {
            flow.realm == IdentityRealm::HostedServiceLegacy
                && flow.phase != identity_broker::SignInFlowPhase::Failed
        }) {
            return Ok(BeginSignInOutcome {
                flow_id: flow.flow_id.clone(),
                snapshot: existing,
            });
        }

        let prepared = self
            .broker
            .prepare_hosted_service_sign_in(input.into_config()?)?;
        emit_snapshot_invalidated(&app, prepared.snapshot.revision);
        if app
            .opener()
            .open_url(&prepared.authorization_url, None::<&str>)
            .is_err()
        {
            let snapshot = self
                .broker
                .fail_hosted_sign_in(&prepared.flow_id, prepared.generation)?;
            emit_snapshot_invalidated(&app, snapshot.revision);
            return Err(IdentityRuntimeError {
                code: "identity_browser_open_failed",
            });
        }
        let browser_open = self
            .broker
            .mark_hosted_browser_opened(&prepared.flow_id, prepared.generation)?;
        emit_snapshot_invalidated(&app, browser_open.revision);
        let awaiting = self
            .broker
            .mark_hosted_awaiting_callback(&prepared.flow_id, prepared.generation)?;
        emit_snapshot_invalidated(&app, awaiting.revision);
        Ok(BeginSignInOutcome {
            flow_id: prepared.flow_id,
            snapshot: awaiting,
        })
    }

    pub async fn complete_hosted_service_sign_in(
        &self,
        app: &AppHandle,
        code: &str,
    ) -> Result<IdentitySnapshot, IdentityRuntimeError> {
        let exchange = self.broker.accept_hosted_service_callback(code)?;
        let flow_id = exchange.flow_id().to_owned();
        let generation = exchange.generation();
        emit_snapshot_invalidated(app, self.broker.snapshot().revision);
        let verified = match oauth::exchange_hosted_service_code(&self.http, &exchange).await {
            Ok(verified) => verified,
            Err(error) => {
                if let Ok(snapshot) = self.broker.fail_hosted_sign_in(&flow_id, generation) {
                    emit_snapshot_invalidated(app, snapshot.revision);
                }
                return Err(error.into());
            }
        };
        let verifying = self
            .broker
            .mark_hosted_verifying_session(&flow_id, generation)?;
        emit_snapshot_invalidated(app, verifying.revision);
        let snapshot = self
            .broker
            .complete_verified_hosted_service_session(&flow_id, generation, verified)?;
        emit_snapshot_invalidated(app, snapshot.revision);
        Ok(snapshot)
    }

    pub async fn org2_cloud_access_lease(
        &self,
        app: &AppHandle,
        session_id: IdentitySessionId,
        generation: u64,
    ) -> Result<SupabaseAccessLease, IdentityRuntimeError> {
        self.supabase_access_lease(app, IdentityRealm::Org2Cloud, session_id, generation)
            .await
    }

    pub async fn hosted_service_access_lease(
        &self,
        app: &AppHandle,
        session_id: IdentitySessionId,
        generation: u64,
    ) -> Result<SupabaseAccessLease, IdentityRuntimeError> {
        self.supabase_access_lease(
            app,
            IdentityRealm::HostedServiceLegacy,
            session_id,
            generation,
        )
        .await
    }

    async fn supabase_access_lease(
        &self,
        app: &AppHandle,
        realm: IdentityRealm,
        session_id: IdentitySessionId,
        generation: u64,
    ) -> Result<SupabaseAccessLease, IdentityRuntimeError> {
        let refresh_guard = self.refresh_guard(&session_id).await;
        let _refresh = refresh_guard.lock().await;

        let cached = match realm {
            IdentityRealm::Org2Cloud => self
                .broker
                .cached_org2_cloud_access_lease(&session_id, generation)?,
            IdentityRealm::HostedServiceLegacy => self
                .broker
                .cached_hosted_service_access_lease(&session_id, generation)?,
            _ => return Err(BrokerError::SessionNotFound.into()),
        };
        if let Some(lease) = cached {
            return Ok(lease);
        }

        let broker = Arc::clone(&self.broker);
        let prepared_session_id = session_id.clone();
        let request = tauri::async_runtime::spawn_blocking(move || match realm {
            IdentityRealm::Org2Cloud => {
                broker.prepare_org2_cloud_refresh(&prepared_session_id, generation)
            }
            IdentityRealm::HostedServiceLegacy => {
                broker.prepare_hosted_service_refresh(&prepared_session_id, generation)
            }
            _ => Err(BrokerError::SessionNotFound),
        })
        .await
        .map_err(|_| IdentityRuntimeError {
            code: "identity_task_failed",
        })??;

        match oauth::refresh_supabase_access(&self.http, &request).await {
            Ok(oauth::RefreshOutcome::Refreshed(refreshed)) => {
                let broker = Arc::clone(&self.broker);
                let (lease, snapshot) = tauri::async_runtime::spawn_blocking(move || {
                    broker.commit_supabase_refresh(request, refreshed)
                })
                .await
                .map_err(|_| IdentityRuntimeError {
                    code: "identity_task_failed",
                })??;
                emit_snapshot_invalidated(app, snapshot.revision);
                Ok(lease)
            }
            Ok(oauth::RefreshOutcome::Rejected) => {
                let broker = Arc::clone(&self.broker);
                let snapshot = tauri::async_runtime::spawn_blocking(move || {
                    broker.reject_supabase_refresh(&request)
                })
                .await
                .map_err(|_| IdentityRuntimeError {
                    code: "identity_task_failed",
                })??;
                emit_snapshot_invalidated(app, snapshot.revision);
                Err(IdentityRuntimeError {
                    code: "identity_access_refresh_rejected",
                })
            }
            Err(error) => {
                let broker = Arc::clone(&self.broker);
                if let Ok(Ok(snapshot)) = tauri::async_runtime::spawn_blocking(move || {
                    broker.mark_supabase_refresh_unavailable(&request)
                })
                .await
                {
                    emit_snapshot_invalidated(app, snapshot.revision);
                }
                Err(error.into())
            }
        }
    }

    async fn refresh_guard(&self, session_id: &IdentitySessionId) -> Arc<Mutex<()>> {
        let mut guards = self.org2_cloud_refresh_guards.lock().await;
        guards.retain(|_, guard| guard.strong_count() > 0);
        if let Some(existing) = guards.get(session_id).and_then(Weak::upgrade) {
            return existing;
        }
        let guard = Arc::new(Mutex::new(()));
        guards.insert(session_id.clone(), Arc::downgrade(&guard));
        guard
    }

    async fn cancel_active_flow(&self, app: &AppHandle) {
        let Some(active) = self.active_org2_cloud_flow.lock().await.take() else {
            return;
        };
        active.task.abort();
        if let Ok(snapshot) = self.broker.fail_sign_in(&active.flow_id, active.generation) {
            emit_snapshot_invalidated(app, snapshot.revision);
        }
    }

    async fn reusable_active_flow(&self) -> Option<BeginSignInOutcome> {
        let active = self.active_org2_cloud_flow.lock().await;
        let active = active.as_ref().filter(|flow| !flow.task.is_finished())?;
        let snapshot = self.broker.snapshot();
        snapshot
            .flows
            .iter()
            .any(|flow| {
                flow.flow_id == active.flow_id
                    && flow.phase != identity_broker::SignInFlowPhase::Failed
            })
            .then(|| BeginSignInOutcome {
                flow_id: active.flow_id.clone(),
                snapshot,
            })
    }
}

async fn run_org2_cloud_flow(
    app: &AppHandle,
    broker: &IdentityBroker,
    http: &Client,
    listener: tokio::net::TcpListener,
    port: u16,
    flow_id: &str,
    generation: u64,
) -> Result<IdentitySnapshot, IdentityRuntimeError> {
    let callback_url = tokio::time::timeout(
        Duration::from_secs(5 * 60),
        oauth::wait_for_callback(listener, port),
    )
    .await
    .map_err(|_| OAuthAdapterError::new("identity_callback_timeout"))??;
    let callback_url = SecretBytes::new(callback_url.into_bytes());
    let callback_url = std::str::from_utf8(callback_url.expose())
        .map_err(|_| OAuthAdapterError::new("identity_oauth_callback_invalid"))?;

    let exchange = broker.accept_org2_cloud_callback(flow_id, generation, callback_url)?;
    let exchanging = broker.snapshot();
    emit_snapshot_invalidated(app, exchanging.revision);

    let config = exchange.config().clone();
    let tokens = oauth::exchange_code(http, &exchange).await?;
    let verifying = broker.mark_verifying_session(flow_id, generation)?;
    emit_snapshot_invalidated(app, verifying.revision);

    let verified = oauth::verify_tokens(http, &config, tokens).await?;
    let snapshot = broker.complete_verified_org2_cloud_session(flow_id, generation, verified)?;
    emit_snapshot_invalidated(app, snapshot.revision);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn one_refresh_owner_serves_one_hundred_concurrent_callers() {
        crate::test_utils::install_crypto_provider_for_tests();
        let runtime = Arc::new(IdentityRuntime::new("orgii-identity-single-flight-test"));
        let session_id = IdentitySessionId::parse("018f52fa-8136-7c8b-b58d-45b91a147f71")
            .expect("fixed session id should be valid");
        let access_lease_available = Arc::new(AtomicBool::new(false));
        let refresh_count = Arc::new(AtomicUsize::new(0));

        let callers = (0..100).map(|_| {
            let runtime = Arc::clone(&runtime);
            let session_id = session_id.clone();
            let access_lease_available = Arc::clone(&access_lease_available);
            let refresh_count = Arc::clone(&refresh_count);
            tokio::spawn(async move {
                let guard = runtime.refresh_guard(&session_id).await;
                let _refresh_owner = guard.lock().await;
                if !access_lease_available.swap(true, Ordering::SeqCst) {
                    refresh_count.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                }
            })
        });

        for caller in callers {
            caller.await.expect("caller should complete");
        }

        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);
    }
}
