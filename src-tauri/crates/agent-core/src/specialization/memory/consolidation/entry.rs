//! `consolidate()` entry point: drains all pending rows for a scope,
//! groups them by `account_id`, and runs one batch per group.

use chrono::Utc;
use std::collections::HashMap;
use tracing::{debug, info, warn};

use super::batch::{
    consolidate_batch, resolve_batch_provider_info, resolve_embed_mode, resolve_provider,
    BatchContext,
};
use super::events::EventCounts;
use super::types::ConsolidationTrigger;
use crate::core::definitions::resolve_learnings_for;
use crate::integrations::config::EmbeddingConfig;
use crate::specialization::memory::learnings::{self, ConsolidationRunRecord, Learning};

fn load_embedding_config_for_consolidation() -> Result<EmbeddingConfig, String> {
    // Read through the process-wide IntegrationsStore so in-memory edits
    // from the settings UI are visible to background consolidation —
    // never re-read integrations.json from disk directly.
    Ok(crate::state::integrations_store::integrations_store()
        .snapshot()
        .embedding)
}

/// Entry: drain all pending learnings for `scope`, group by `account_id`,
/// and run a consolidation batch per group. Persists one
/// `consolidation_runs` row per batch.
///
/// Returns the total event counts aggregated across all batches.
pub async fn consolidate(
    scope: &str,
    trigger: ConsolidationTrigger,
) -> Result<EventCounts, String> {
    let conn = crate::foundation::db_bridge::get_connection()
        .map_err(|e| format!("consolidation DB: {}", e))?;

    // Per-agent learnings policy. Strict: scope must name an agent.
    let def_id = scope
        .strip_prefix(learnings::AGENT_SCOPE_PREFIX)
        .unwrap_or(scope);
    let learnings_cfg = if def_id.is_empty() {
        info!(
            "[consolidation] scope={} cannot extract agent id — using default learnings policy",
            scope
        );
        crate::core::definitions::AgentLearningsConfig::default()
    } else {
        resolve_learnings_for(def_id)
    };
    if !learnings_cfg.enabled {
        info!(
            "[consolidation] scope={} learnings disabled — skipping",
            scope
        );
        return Ok(EventCounts::default());
    }

    let pending = learnings::load_pending_learnings(&conn, scope)
        .map_err(|e| format!("load_pending_learnings: {}", e))?;
    if pending.is_empty() {
        debug!("[consolidation] scope={} no pending rows", scope);
        return Ok(EventCounts::default());
    }

    info!(
        "[consolidation] scope={} trigger={} pending={}",
        scope,
        trigger.as_str(),
        pending.len()
    );

    // App-level embedding engine settings drive recall mode. A corrupt
    // integrations.json must fail this background pass rather than silently
    // switching consolidation to default recall behavior.
    let embedding_cfg = load_embedding_config_for_consolidation()?;
    let (mode, embed) = resolve_embed_mode(embedding_cfg).await;

    // Group pending rows by account_id. Billing for the consolidation LLM
    // call follows the account that produced the rows.
    let mut groups: HashMap<Option<String>, Vec<Learning>> = HashMap::new();
    for row in pending {
        groups.entry(row.account_id.clone()).or_default().push(row);
    }

    let mut totals = EventCounts::default();

    for (account_id, batch) in groups {
        let started_at = Utc::now().to_rfc3339();
        let pending_input = batch.len() as u32;
        let info = match resolve_batch_provider_info(&conn, scope, &batch, account_id.as_deref()) {
            Ok(info) => info,
            Err(err) => {
                warn!("[consolidation] {}", err);
                let finished_at = Utc::now().to_rfc3339();
                let _ = learnings::record_consolidation_run(
                    &conn,
                    &ConsolidationRunRecord {
                        agent_scope: scope.to_string(),
                        account_id: account_id.clone(),
                        trigger: trigger.as_str().to_string(),
                        mode: mode.as_str().to_string(),
                        pending_input,
                        error: Some(err),
                        started_at,
                        finished_at,
                        ..Default::default()
                    },
                );
                continue;
            }
        };
        let model = info.model;

        let provider = match resolve_provider(&model, info.account_id.as_deref()) {
            Ok(p) => p,
            Err(err) => {
                warn!(
                    "[consolidation] scope={} account={:?} provider resolve failed: {}",
                    scope, account_id, err
                );
                let finished_at = Utc::now().to_rfc3339();
                let _ = learnings::record_consolidation_run(
                    &conn,
                    &ConsolidationRunRecord {
                        agent_scope: scope.to_string(),
                        account_id: account_id.clone(),
                        trigger: trigger.as_str().to_string(),
                        mode: mode.as_str().to_string(),
                        pending_input,
                        error: Some(err),
                        started_at,
                        finished_at,
                        ..Default::default()
                    },
                );
                continue;
            }
        };

        let ctx = BatchContext {
            scope,
            provider,
            model,
            mode,
            embed: embed.clone(),
        };

        let counts = consolidate_batch(&conn, &ctx, batch).await;

        let finished_at = Utc::now().to_rfc3339();
        let _ = learnings::record_consolidation_run(
            &conn,
            &ConsolidationRunRecord {
                agent_scope: scope.to_string(),
                account_id: account_id.clone(),
                trigger: trigger.as_str().to_string(),
                mode: mode.as_str().to_string(),
                pending_input,
                added: counts.added,
                updated: counts.updated,
                deleted: counts.deleted,
                none_count: counts.none,
                abandoned: counts.abandoned,
                reinforced: 0,
                error: None,
                started_at,
                finished_at,
            },
        );

        totals.added += counts.added;
        totals.updated += counts.updated;
        totals.deleted += counts.deleted;
        totals.none += counts.none;
        totals.abandoned += counts.abandoned;
    }

    info!(
        "[consolidation] scope={} done added={} updated={} deleted={} none={} abandoned={}",
        scope, totals.added, totals.updated, totals.deleted, totals.none, totals.abandoned
    );
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::load_embedding_config_for_consolidation;

    #[test]
    fn embedding_config_reads_through_integrations_store() {
        // cfg(test) integrations_store() returns a fresh store; defaults
        // resolve to the safe disabled embedding provider.
        let embedding = load_embedding_config_for_consolidation().expect("embedding config");
        assert_eq!(embedding.provider, "disabled");
    }
}
