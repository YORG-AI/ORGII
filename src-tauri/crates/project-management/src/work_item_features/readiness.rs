use rusqlite::{params, OptionalExtension};

use super::store::resolve_work_item;
use super::{PrReadiness, WorkItemScope};
use crate::projects::io::helpers::conn;
use crate::projects::types::{
    PrStatus, ProofOfWork, WorkItemCloseOut, WorkItemCloseOutStatus, WorkItemWorkProduct,
    WorkItemWorkProductStatus, WorkItemWorkProductType,
};

fn metadata_bool(product: &WorkItemWorkProduct, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| {
        product
            .metadata
            .get(*key)
            .and_then(serde_json::Value::as_bool)
    })
}

fn metadata_string(product: &WorkItemWorkProduct, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        product
            .metadata
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    })
}

fn metadata_strings(product: &WorkItemWorkProduct, keys: &[&str]) -> Vec<String> {
    keys.iter()
        .find_map(|key| {
            product
                .metadata
                .get(*key)
                .and_then(serde_json::Value::as_array)
        })
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn status_string(status: &PrStatus) -> String {
    match status {
        PrStatus::Draft => "draft",
        PrStatus::Open => "open",
        PrStatus::Merged => "merged",
        PrStatus::Closed => "closed",
    }
    .to_string()
}

pub(crate) fn evaluate(scope: &WorkItemScope) -> Result<(PrReadiness, bool), String> {
    let connection = conn()?;
    let item = resolve_work_item(&connection, scope)?;
    let proof = item
        .extras
        .get("proof_of_work")
        .cloned()
        .and_then(|value| serde_json::from_value::<ProofOfWork>(value).ok());
    let products = item
        .extras
        .get("work_products")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<WorkItemWorkProduct>>(value).ok())
        .unwrap_or_default();
    let close_out = item
        .extras
        .get("close_out")
        .cloned()
        .and_then(|value| serde_json::from_value::<WorkItemCloseOut>(value).ok());
    let pull_requests = products
        .iter()
        .filter(|product| product.product_type == WorkItemWorkProductType::PullRequest)
        .collect::<Vec<_>>();
    let primary = pull_requests
        .iter()
        .copied()
        .find(|product| product.is_primary)
        .or_else(|| pull_requests.first().copied());

    let pr_url = primary
        .and_then(|product| product.url.clone())
        .or_else(|| proof.as_ref().and_then(|value| value.pr_url.clone()));
    let pr_status = proof
        .as_ref()
        .and_then(|value| value.pr_status.as_ref())
        .map(status_string)
        .or_else(|| {
            primary.map(|product| match product.status.as_ref() {
                Some(WorkItemWorkProductStatus::Merged) => "merged".to_string(),
                Some(WorkItemWorkProductStatus::Pending)
                | Some(WorkItemWorkProductStatus::Passed)
                | Some(WorkItemWorkProductStatus::Unknown)
                | None => "open".to_string(),
                Some(WorkItemWorkProductStatus::Failed) => "open".to_string(),
                Some(WorkItemWorkProductStatus::Deployed) => "merged".to_string(),
            })
        });
    let is_draft = primary
        .and_then(|product| metadata_bool(product, &["isDraft", "is_draft", "draft"]))
        .unwrap_or_else(|| pr_status.as_deref() == Some("draft"));
    let mergeable =
        primary.and_then(|product| metadata_bool(product, &["mergeable", "canMerge", "can_merge"]));
    let ci_status = primary.and_then(|product| {
        metadata_string(
            product,
            &["ciStatus", "ci_status", "checksStatus", "checks_status"],
        )
    });
    let failed_checks = primary
        .map(|product| {
            metadata_strings(product, &["failedChecks", "failed_checks", "failingChecks"])
        })
        .unwrap_or_default();
    let other_open_prs = pull_requests
        .iter()
        .copied()
        .filter(|product| primary.is_none_or(|selected| selected.id != product.id))
        .filter(|product| {
            !matches!(
                product.status,
                Some(WorkItemWorkProductStatus::Merged | WorkItemWorkProductStatus::Deployed)
            )
        })
        .filter_map(|product| product.url.clone().or_else(|| Some(product.title.clone())))
        .collect::<Vec<_>>();
    let latest_snapshot_revision: Option<i64> = connection
        .query_row(
            "SELECT work_item_revision FROM pm_work_item_runs
              WHERE scope_key = ?1 AND work_item_id = ?2
              ORDER BY created_at DESC, id DESC LIMIT 1",
            params![item.scope_key, item.short_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("PR readiness store: {err}"))?;
    let snapshot_stale = latest_snapshot_revision.is_some_and(|revision| revision != item.revision);
    let close_intent = close_out
        .as_ref()
        .is_some_and(|value| value.status == WorkItemCloseOutStatus::Done)
        || primary
            .and_then(|product| metadata_bool(product, &["closeIntent", "close_intent"]))
            .unwrap_or(false);
    let has_pr_evidence = pr_url.is_some() || primary.is_some();
    let mut blockers = Vec::new();
    if !has_pr_evidence {
        blockers.push("No pull request is associated with this Work Item".to_string());
    }
    if is_draft {
        blockers.push("The primary pull request is still a draft".to_string());
    }
    if mergeable == Some(false) {
        blockers.push("The primary pull request has merge conflicts".to_string());
    }
    if !failed_checks.is_empty() {
        blockers.push(format!(
            "{} required check(s) are failing",
            failed_checks.len()
        ));
    }
    if ci_status
        .as_deref()
        .is_some_and(|status| !matches!(status, "success" | "passed" | "completed" | "neutral"))
    {
        blockers.push(format!(
            "CI is not ready ({})",
            ci_status.as_deref().unwrap_or("unknown")
        ));
    }
    if !other_open_prs.is_empty() {
        blockers.push("Another pull request for this Work Item is still open".to_string());
    }
    if snapshot_stale {
        blockers.push("Execution evidence is stale relative to the Work Item revision".to_string());
    }
    if pr_status.as_deref() != Some("merged") {
        blockers.push("The primary pull request has not been merged".to_string());
    }
    if !close_intent {
        blockers.push("No explicit close intent has been recorded".to_string());
    }
    let can_complete = has_pr_evidence
        && pr_status.as_deref() == Some("merged")
        && close_intent
        && !is_draft
        && mergeable != Some(false)
        && failed_checks.is_empty()
        && other_open_prs.is_empty()
        && !snapshot_stale;
    let state = if can_complete {
        "ready_to_complete"
    } else if !has_pr_evidence {
        "missing"
    } else if pr_status.as_deref() == Some("merged") {
        "merged_blocked"
    } else {
        "blocked"
    }
    .to_string();
    Ok((
        PrReadiness {
            state,
            pr_url,
            pr_status,
            is_draft,
            mergeable,
            ci_status,
            failed_checks,
            other_open_prs,
            snapshot_stale,
            close_intent,
            can_complete,
            blockers,
            evidence_at: chrono::Utc::now().to_rfc3339(),
        },
        has_pr_evidence,
    ))
}

pub(super) fn get(scope: &WorkItemScope) -> Result<PrReadiness, String> {
    evaluate(scope).map(|(readiness, _)| readiness)
}
