use std::sync::{Arc, OnceLock};

use tokio::sync::RwLock;

use super::queue::{
    enqueue_snapshot, ensure_install_id, now_rfc3339, read_unsent_records, unsent_count,
    DiagnosticsPaths,
};
use super::sanitize::sanitize_snapshot;
use super::types::{
    DiagnosticsFlushStatus, DiagnosticsServiceConfig, DiagnosticsUploadPayload,
    DiagnosticsUsageSnapshot, DIAGNOSTICS_SCHEMA_VERSION,
};

const ENDPOINT_ENV: &str = "ORGII_DIAGNOSTICS_ENDPOINT";
const TOKEN_ENV: &str = "ORGII_DIAGNOSTICS_TOKEN";
const USER_AGENT: &str = "ORGII Diagnostics";

static GLOBAL_SERVICE: OnceLock<Arc<DiagnosticsService>> = OnceLock::new();

#[derive(Debug)]
pub struct DiagnosticsService {
    paths: DiagnosticsPaths,
    config: RwLock<DiagnosticsServiceConfig>,
    install_id: RwLock<Option<String>>,
}

impl DiagnosticsService {
    pub fn global() -> Arc<Self> {
        GLOBAL_SERVICE
            .get_or_init(|| {
                Arc::new(Self {
                    paths: DiagnosticsPaths::new(app_paths::diagnostics_dir()),
                    config: RwLock::new(DiagnosticsServiceConfig::default()),
                    install_id: RwLock::new(None),
                })
            })
            .clone()
    }

    pub async fn initialize(&self, config: DiagnosticsServiceConfig) -> Result<(), String> {
        self.configure(config).await;
        self.ensure_install_id().await?;
        Ok(())
    }

    async fn configure(&self, config: DiagnosticsServiceConfig) {
        let mut guard = self.config.write().await;
        *guard = config;
    }

    pub async fn submit_usage_snapshot(
        &self,
        snapshot: DiagnosticsUsageSnapshot,
    ) -> Result<DiagnosticsFlushStatus, String> {
        let config = self.config.read().await.clone();
        let sanitized = sanitize_snapshot(snapshot, config.diagnostics_level);
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || enqueue_snapshot(&paths, sanitized))
            .await
            .map_err(|err| format!("Task join error: {}", err))??;
        self.flush_now().await
    }

    async fn flush_now(&self) -> Result<DiagnosticsFlushStatus, String> {
        let config = self.config.read().await.clone();
        if !config.uploads_enabled() {
            let paths = self.paths.clone();
            let queued_unsent = tokio::task::spawn_blocking(move || unsent_count(&paths.queue))
                .await
                .map_err(|err| format!("Task join error: {}", err))??;
            return Ok(DiagnosticsFlushStatus {
                endpoint_configured: endpoint_url().is_some(),
                attempted: false,
                uploaded: 0,
                queued_unsent,
            });
        }

        let Some(endpoint) = endpoint_url() else {
            let paths = self.paths.clone();
            let queued_unsent = tokio::task::spawn_blocking(move || unsent_count(&paths.queue))
                .await
                .map_err(|err| format!("Task join error: {}", err))??;
            return Ok(DiagnosticsFlushStatus {
                endpoint_configured: false,
                attempted: false,
                uploaded: 0,
                queued_unsent,
            });
        };

        let install_id = self.ensure_install_id().await?;
        let paths = self.paths.clone();
        let records = tokio::task::spawn_blocking(move || read_unsent_records(&paths.queue))
            .await
            .map_err(|err| format!("Task join error: {}", err))??;

        if records.is_empty() {
            return Ok(DiagnosticsFlushStatus {
                endpoint_configured: true,
                attempted: false,
                uploaded: 0,
                queued_unsent: 0,
            });
        }

        let payload = DiagnosticsUploadPayload {
            schema_version: DIAGNOSTICS_SCHEMA_VERSION,
            install_id,
            generated_at: now_rfc3339(),
            records: records.clone(),
        };
        let client = reqwest::Client::new();
        let mut request = client
            .post(endpoint)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .json(&payload);
        if let Some(token) = auth_token() {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|err| format!("Diagnostics upload failed: {}", err))?;

        if !response.status().is_success() {
            return Err(format!(
                "Diagnostics upload failed with status {}",
                response.status()
            ));
        }

        let sent_at = now_rfc3339();
        let sent_ids: Vec<String> = records.into_iter().map(|record| record.id).collect();
        let paths = self.paths.clone();
        let uploaded = sent_ids.len();
        tokio::task::spawn_blocking(move || {
            super::queue::mark_records_sent(&paths.queue, &sent_ids, &sent_at)?;
            unsent_count(&paths.queue)
        })
        .await
        .map_err(|err| format!("Task join error: {}", err))?
        .map(|queued_unsent| DiagnosticsFlushStatus {
            endpoint_configured: true,
            attempted: true,
            uploaded,
            queued_unsent,
        })
    }

    async fn ensure_install_id(&self) -> Result<String, String> {
        if let Some(existing) = self.install_id.read().await.clone() {
            return Ok(existing);
        }
        let paths = self.paths.clone();
        let install_id = tokio::task::spawn_blocking(move || ensure_install_id(&paths))
            .await
            .map_err(|err| format!("Task join error: {}", err))??;
        let mut guard = self.install_id.write().await;
        *guard = Some(install_id.clone());
        Ok(install_id)
    }

    #[cfg(test)]
    pub(super) fn new_for_test(paths: DiagnosticsPaths) -> Self {
        Self {
            paths,
            config: RwLock::new(DiagnosticsServiceConfig::default()),
            install_id: RwLock::new(None),
        }
    }
}

fn endpoint_url() -> Option<String> {
    std::env::var(ENDPOINT_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("ORGII_DIAGNOSTICS_ENDPOINT").map(ToOwned::to_owned))
        .filter(|value| !value.trim().is_empty())
}

fn auth_token() -> Option<String> {
    std::env::var(TOKEN_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| option_env!("ORGII_DIAGNOSTICS_TOKEN").map(ToOwned::to_owned))
        .filter(|value| !value.trim().is_empty())
}
