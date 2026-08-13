//! Work item schedule executor.
//!
//! Background task that reads a narrow candidate projection and auto-starts
//! items when:
//! - `start_date` is in the past and status is `backlog` / `planned` / `todo`
//! - `schedule.at` is in the past (one-shot)
//!
//! Recurring (cron) execution is the Routine system's job — see
//! `routine_scheduler` and the startup migration in `migrate_cron_schedules`.
//!
//! On failure, writes a notification to the user's inbox.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use tracing::{debug, info, warn};

use project_management::projects::io;
use project_management::projects::types::ScheduledWorkItemCandidate;
#[cfg(test)]
use project_management::projects::types::{WorkItemFrontmatter, WorkItemSchedule};

const MAX_IDLE_RESCAN_SECS: u64 = 30 * 60;
const FAILED_START_RETRY_SECS: u64 = 5 * 60;
const BLOCKED_NOTIFICATION_COOLDOWN_SECS: i64 = 60 * 60;
const BLOCKED_NOTIFICATION_RETENTION_SECS: i64 = 2 * BLOCKED_NOTIFICATION_COOLDOWN_SECS;
const BLOCKED_NOTIFICATION_CACHE_MAX_ENTRIES: usize = 512;

static BLOCKED_NOTIFICATION_LAST_SENT: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();

/// Spawn the scheduler background task.
///
/// The first candidate check happens immediately. Afterwards the task sleeps
/// until the next due item or a committed work-item mutation wakes it. A
/// low-frequency safety rescan covers out-of-process database writes.
pub fn spawn(app_handle: tauri::AppHandle) {
    let wake = Arc::new(tokio::sync::Notify::new());
    let notifier = Arc::clone(&wake);
    project_management::projects::events::register_work_item_schedule_changed_notifier(Box::new(
        move || notifier.notify_one(),
    ));

    tauri::async_runtime::spawn(async move {
        info!(
            "[scheduler] Work item scheduler started (event-driven, safety_rescan={}s)",
            MAX_IDLE_RESCAN_SECS
        );
        let mut wait = Duration::ZERO;
        loop {
            if !wait.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = wake.notified() => {
                        debug!("[scheduler] Work-item mutation woke schedule evaluation");
                    }
                }
            }

            wait = match check_and_trigger(&app_handle).await {
                Ok(next_wait) => next_wait,
                Err(err) => {
                    warn!("[scheduler] Evaluation error: {}", err);
                    Duration::from_secs(FAILED_START_RETRY_SECS)
                }
            };
            if wait.is_zero() {
                // Never spin if a malformed candidate accidentally calculates
                // a zero deadline.
                wait = Duration::from_secs(1);
            }
        }
    });
}

pub async fn debug_run_once(app: &tauri::AppHandle) -> Result<(), String> {
    check_and_trigger(app).await.map(|_| ())
}

async fn check_and_trigger(app: &tauri::AppHandle) -> Result<Duration, String> {
    let candidates = tokio::task::spawn_blocking(io::read_scheduled_work_item_candidates)
        .await
        .map_err(|err| format!("scheduler candidate reader join error: {err}"))??;
    let now = Utc::now();
    let mut next_wait = Duration::from_secs(MAX_IDLE_RESCAN_SECS);

    for candidate in candidates {
        if let Some(start_at) =
            eligible_start_date(&candidate.status, candidate.start_date.as_deref())
        {
            if start_at <= now {
                let retry = trigger_candidate(&candidate, "start_date reached", app).await;
                next_wait = next_wait.min(retry);
                continue;
            }
            next_wait = next_wait.min(duration_until(start_at, now));
        }

        let Some(schedule) = candidate
            .schedule
            .as_ref()
            .filter(|schedule| schedule.enabled)
        else {
            continue;
        };
        let Some(schedule_at) = schedule.at.as_deref().and_then(parse_schedule_datetime) else {
            continue;
        };
        if schedule_at <= now {
            let _ = trigger_candidate(&candidate, "one-shot schedule reached", app).await;
            disable_one_shot_schedule(&candidate.project_slug, &candidate.short_id).await;
        } else {
            next_wait = next_wait.min(duration_until(schedule_at, now));
        }
    }

    Ok(next_wait)
}

/// Check if work item should auto-start based on its `start_date`.
#[cfg(test)]
fn should_trigger_by_start_date(fm: &WorkItemFrontmatter) -> bool {
    eligible_start_date(&fm.status, fm.start_date.as_deref())
        .is_some_and(|start_at| Utc::now() >= start_at)
}

/// Check if a one-shot schedule should fire.
#[cfg(test)]
fn should_trigger_at(schedule: &WorkItemSchedule, now: &chrono::DateTime<chrono::Utc>) -> bool {
    schedule
        .at
        .as_deref()
        .and_then(parse_schedule_datetime)
        .is_some_and(|at| *now >= at)
}

fn eligible_start_date(status: &str, start_date: Option<&str>) -> Option<DateTime<Utc>> {
    if !matches!(status, "backlog" | "planned" | "todo") {
        return None;
    }
    start_date.and_then(parse_start_datetime)
}

fn parse_start_datetime(value: &str) -> Option<DateTime<Utc>> {
    parse_schedule_datetime(value).or_else(|| {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()?
            .and_hms_opt(0, 0, 0)
            .map(|value| value.and_utc())
    })
}

fn parse_schedule_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|value| value.and_utc())
        })
}

fn duration_until(deadline: DateTime<Utc>, now: DateTime<Utc>) -> Duration {
    deadline
        .signed_duration_since(now)
        .to_std()
        .unwrap_or(Duration::ZERO)
}

async fn trigger_candidate(
    candidate: &ScheduledWorkItemCandidate,
    reason: &str,
    _app: &tauri::AppHandle,
) -> Duration {
    let config = candidate.orchestrator_config.clone().unwrap_or_default();
    if config.selected_account_id.is_none() {
        notify_inbox_blocked(
            &candidate.project_slug,
            &candidate.short_id,
            &candidate.title,
            "No code account configured (selected_account_id is empty)",
        )
        .await;
        return Duration::from_secs(BLOCKED_NOTIFICATION_COOLDOWN_SECS as u64);
    }

    info!(
        "[scheduler] Triggering work item {} ({}) in project {}",
        candidate.short_id, reason, candidate.project_slug
    );
    let schedule_key = candidate
        .schedule
        .as_ref()
        .and_then(|schedule| schedule.at.clone())
        .or_else(|| candidate.start_date.clone())
        .unwrap_or_else(|| reason.to_string());
    let request = project_management::projects::types::EnqueueWorkItemRunRequest {
        project_slug: Some(candidate.project_slug.clone()),
        org_id: project_management::projects::types::PERSONAL_ORG_ID.to_string(),
        work_item_id: candidate.short_id.clone(),
        trigger: project_management::projects::types::WorkItemRunTrigger::Schedule {
            schedule_key: schedule_key.clone(),
        },
        target_snapshot: project_management::projects::types::WorkItemRunTargetSnapshot::new(
            project_management::projects::types::WorkItemRunTarget::StartWorkItem {
                account_id: config.selected_account_id.clone(),
                model_id: config.selected_model_id.clone(),
            },
        ),
        input: serde_json::json!({ "reason": reason }),
        idempotency_key: format!("schedule:{schedule_key}"),
        max_attempts: 3,
        parent_run_id: None,
    };
    match tokio::task::spawn_blocking(move || {
        project_management::work_run_service::enqueue(request)
    })
    .await
    {
        Ok(Ok(run)) => {
            info!("[scheduler] Queued durable Run: {}", run.id);
            Duration::from_secs(MAX_IDLE_RESCAN_SECS)
        }
        Ok(Err(err)) => {
            warn!(
                "[scheduler] Failed to start {}: {}",
                candidate.short_id, err
            );
            notify_inbox_blocked(
                &candidate.project_slug,
                &candidate.short_id,
                &candidate.title,
                &err,
            )
            .await;
            Duration::from_secs(FAILED_START_RETRY_SECS)
        }
        Err(err) => {
            warn!(
                "[scheduler] Failed to enqueue {}: {}",
                candidate.short_id, err
            );
            Duration::from_secs(FAILED_START_RETRY_SECS)
        }
    }
}

async fn disable_one_shot_schedule(slug: &str, short_id: &str) {
    let slug = slug.to_string();
    let short_id = short_id.to_string();
    match tokio::task::spawn_blocking(move || {
        io::update_work_item_atomic(&slug, &short_id, |fm, _body| {
            if let Some(ref mut schedule) = fm.schedule {
                if schedule.at.is_some() {
                    schedule.enabled = false;
                }
            }
            Ok(fm.title.clone())
        })
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => warn!("[scheduler] Schedule disable failed: {}", err),
        Err(err) => warn!("[scheduler] Schedule disable worker failed: {}", err),
    }
}

/// One-time startup migration: work items carrying a recurring
/// `schedule.cron` violate "work item = tracking" (each re-run wipes the
/// previous run's state). Convert each into a Routine with
/// `UpdateExistingWorkItem` output mode pointing back at the item, then
/// clear the item's schedule.
pub fn migrate_cron_schedules() -> Result<usize, String> {
    use project_management::projects::types::{
        RoutineDefinition, RoutineOutputMode, RoutineOutputPolicy, RoutineResourceSelection,
        RoutineRunTarget, RoutineRunTemplate, RoutineTrigger, RoutineWorkspaceTarget,
    };

    let projects = io::read_all_projects()?;
    let mut migrated = 0usize;

    for project in &projects {
        let slug = &project.slug;
        let items = match io::read_all_work_items(slug) {
            Ok(items) => items,
            Err(_) => continue,
        };
        for item in &items {
            let fm = &item.frontmatter;
            let cron = match fm.schedule.as_ref() {
                Some(sched) if sched.enabled => match sched.cron.as_deref() {
                    Some(expr) if !expr.is_empty() => expr.to_string(),
                    _ => continue,
                },
                _ => continue,
            };

            let config = fm.orchestrator_config.clone().unwrap_or_default();
            let routine = RoutineDefinition {
                id: String::new(),
                name: format!("Recurring: {}", fm.title),
                description: format!("Migrated from work item {} recurring schedule", fm.short_id),
                enabled: true,
                trigger: RoutineTrigger::Cron {
                    cron,
                    timezone: "UTC".to_string(),
                },
                run_template: RoutineRunTemplate {
                    prompt: fm.title.clone(),
                    target: RoutineRunTarget::AgentDefinition {
                        agent_definition_id: config.agent_definition_id.clone(),
                    },
                    resources: RoutineResourceSelection {
                        key_source: None,
                        account_id: config.selected_account_id.clone(),
                        model: config.selected_model_id.clone(),
                        native_harness_type: None,
                    },
                    workspace: RoutineWorkspaceTarget::None,
                    mode: config.agent_mode.clone(),
                    name: Some(fm.title.clone()),
                },
                output_policy: RoutineOutputPolicy {
                    mode: RoutineOutputMode::UpdateExistingWorkItem,
                    update_work_item_short_id: Some(fm.short_id.clone()),
                    update_work_item_project_slug: Some(slug.clone()),
                    ..Default::default()
                },
                last_evaluated_at: None,
                next_fire_at: None,
                last_fire_at: None,
                last_fire_status: None,
                last_fire_error: None,
                last_fire_session_id: None,
                last_fire_work_item_id: None,
                created_at: String::new(),
                updated_at: String::new(),
            };

            if let Err(err) = io::upsert_routine(routine) {
                warn!(
                    "[scheduler] cron→routine migration failed for {}: {}",
                    fm.short_id, err
                );
                continue;
            }

            let _ = io::update_work_item_atomic(slug, &fm.short_id, |fm, _body| {
                fm.schedule = None;
                fm.updated_at = chrono::Utc::now().to_rfc3339();
                Ok(fm.title.clone())
            });
            migrated += 1;
            info!(
                "[scheduler] migrated work item {} cron schedule to a routine",
                fm.short_id
            );
        }
    }
    Ok(migrated)
}

fn blocked_notification_key(project_slug: &str, short_id: &str, reason: &str) -> String {
    format!("{project_slug}:{short_id}:{}", truncate(reason, 160))
}

fn should_emit_blocked_notification(key: &str, now_ts: i64) -> bool {
    let cache = BLOCKED_NOTIFICATION_LAST_SENT.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut cache) = cache.lock() else {
        return true;
    };

    should_emit_blocked_notification_in(&mut cache, key, now_ts)
}

fn should_emit_blocked_notification_in(
    cache: &mut HashMap<String, i64>,
    key: &str,
    now_ts: i64,
) -> bool {
    cache.retain(|_, last_sent_at| {
        now_ts.saturating_sub(*last_sent_at) < BLOCKED_NOTIFICATION_RETENTION_SECS
    });

    if let Some(last_sent_at) = cache.get(key) {
        if now_ts.saturating_sub(*last_sent_at) < BLOCKED_NOTIFICATION_COOLDOWN_SECS {
            return false;
        }
    }

    if !cache.contains_key(key) && cache.len() >= BLOCKED_NOTIFICATION_CACHE_MAX_ENTRIES {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, last_sent_at)| *last_sent_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest_key);
        }
    }
    cache.insert(key.to_string(), now_ts);
    true
}

/// Write a "blocked" notification to the user's inbox.
async fn notify_inbox_blocked(project_slug: &str, short_id: &str, title: &str, reason: &str) {
    let project_slug = project_slug.to_string();
    let short_id = short_id.to_string();
    let title = title.to_string();
    let reason = reason.to_string();
    if let Err(err) = tokio::task::spawn_blocking(move || {
        notify_inbox_blocked_sync(&project_slug, &short_id, &title, &reason)
    })
    .await
    {
        warn!("[scheduler] Inbox notification worker failed: {}", err);
    }
}

fn notify_inbox_blocked_sync(project_slug: &str, short_id: &str, title: &str, reason: &str) {
    let now = chrono::Utc::now();
    let key = blocked_notification_key(project_slug, short_id, reason);
    if !should_emit_blocked_notification(&key, now.timestamp()) {
        debug!(
            "[scheduler] Suppressed duplicate blocked notification for {}",
            short_id
        );
        return;
    }

    let now_rfc3339 = now.to_rfc3339();
    let msg = inbox::persistence::InboxMessage {
        id: format!("schedule-blocked-{}-{}", project_slug, short_id),
        title: format!("[Scheduled Task Blocked] {} \"{}\"", short_id, title),
        preview: format!("Reason: {}", truncate(reason, 100)),
        content: format!(
            "Work item {} \"{}\"\
             could not auto-start.\n\n\
             **Reason:** {}\n\n\
             **Action needed:**\n\
             - Assign a code account (selected_account_id)\n\
             - Or change the assigned agent\n\
             - Or adjust the model",
            short_id, title, reason
        ),
        category: "workitems".to_string(),
        priority: "high".to_string(),
        status: "unread".to_string(),
        sender_name: Some("Scheduler".to_string()),
        metadata: "{}".to_string(),
        labels: serde_json::to_string(&["schedule-blocked"])
            .expect("serializing a static [&str] is infallible"),
        created_at: now_rfc3339.clone(),
        updated_at: now_rfc3339,
    };
    if let Err(err) = inbox::persistence::upsert_message(&msg) {
        warn!(
            "[scheduler] Failed to write inbox notification for {}: {}",
            short_id, err
        );
    } else {
        info!("[scheduler] Sent inbox notification: {} blocked", short_id);
    }
}

fn truncate(s: &str, max_len: usize) -> &str {
    crate::utils::safe_truncate_utf8(s, max_len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    // ============================================
    // truncate
    // ============================================

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_exact_length_unchanged() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn truncate_cuts_at_boundary() {
        assert_eq!(truncate("hello world", 5), "hello");
    }

    #[test]
    fn truncate_multibyte_does_not_panic() {
        let result = truncate("你好世界", 4);
        assert_eq!(result, "你");
    }

    #[test]
    fn truncate_empty_string() {
        assert_eq!(truncate("", 5), "");
    }

    #[test]
    fn truncate_zero_max() {
        assert_eq!(truncate("hello", 0), "");
    }

    // ============================================
    // should_trigger_by_start_date
    // ============================================

    fn make_frontmatter(status: &str, start_date: Option<&str>) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: "id-1".into(),
            short_id: "TST-0001".into(),
            title: "Test".into(),
            project: None,
            status: status.into(),
            priority: "none".into(),
            assignee: None,
            assignee_type: None,
            labels: vec![],
            milestone: None,
            parent: None,
            stage: None,
            start_date: start_date.map(|s| s.to_string()),
            target_date: None,
            created_by: None,
            origin_session: None,
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            handoff: None,
            linked_sessions: vec![],
            proof_of_work: None,
            orchestrator_config: None,
            orchestrator_state: None,
            follow_up_items: vec![],
            schedule: None,
            routine_source: None,
            execution_lock: None,
            close_out: None,
            work_products: vec![],
        }
    }

    #[test]
    fn trigger_by_start_date_no_date_returns_false() {
        let fm = make_frontmatter("backlog", None);
        assert!(!should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_empty_string_returns_false() {
        let fm = make_frontmatter("backlog", Some(""));
        assert!(!should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_wrong_status_returns_false() {
        let fm = make_frontmatter("in_progress", Some("2020-01-01T00:00:00Z"));
        assert!(!should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_future_rfc3339_returns_false() {
        let fm = make_frontmatter("backlog", Some("2099-12-31T23:59:59Z"));
        assert!(!should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_past_rfc3339_returns_true() {
        let fm = make_frontmatter("backlog", Some("2020-01-01T00:00:00Z"));
        assert!(should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_past_naive_datetime_returns_true() {
        let fm = make_frontmatter("planned", Some("2020-06-15T12:00:00"));
        assert!(should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_past_date_only_returns_true() {
        let fm = make_frontmatter("todo", Some("2020-06-15"));
        assert!(should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_future_date_only_returns_false() {
        let fm = make_frontmatter("backlog", Some("2099-06-15"));
        assert!(!should_trigger_by_start_date(&fm));
    }

    #[test]
    fn trigger_by_start_date_invalid_format_returns_false() {
        let fm = make_frontmatter("backlog", Some("not-a-date"));
        assert!(!should_trigger_by_start_date(&fm));
    }

    // ============================================
    // should_trigger_at
    // ============================================

    #[test]
    fn trigger_at_none_returns_false() {
        let schedule = WorkItemSchedule {
            at: None,
            cron: None,
            enabled: true,
            last_run: None,
        };
        let now = Utc::now();
        assert!(!should_trigger_at(&schedule, &now));
    }

    #[test]
    fn trigger_at_past_rfc3339_returns_true() {
        let schedule = WorkItemSchedule {
            at: Some("2020-01-01T00:00:00Z".into()),
            cron: None,
            enabled: true,
            last_run: None,
        };
        let now = Utc::now();
        assert!(should_trigger_at(&schedule, &now));
    }

    #[test]
    fn trigger_at_future_rfc3339_returns_false() {
        let schedule = WorkItemSchedule {
            at: Some("2099-12-31T23:59:59Z".into()),
            cron: None,
            enabled: true,
            last_run: None,
        };
        let now = Utc::now();
        assert!(!should_trigger_at(&schedule, &now));
    }

    #[test]
    fn trigger_at_past_naive_datetime_returns_true() {
        let schedule = WorkItemSchedule {
            at: Some("2020-06-15T12:00:00".into()),
            cron: None,
            enabled: true,
            last_run: None,
        };
        let now = Utc::now();
        assert!(should_trigger_at(&schedule, &now));
    }

    #[test]
    fn trigger_at_invalid_format_returns_false() {
        let schedule = WorkItemSchedule {
            at: Some("not-a-date".into()),
            cron: None,
            enabled: true,
            last_run: None,
        };
        let now = Utc::now();
        assert!(!should_trigger_at(&schedule, &now));
    }

    #[test]
    fn trigger_at_exact_moment() {
        let moment = Utc.with_ymd_and_hms(2025, 6, 15, 12, 0, 0).unwrap();
        let schedule = WorkItemSchedule {
            at: Some(moment.to_rfc3339()),
            cron: None,
            enabled: true,
            last_run: None,
        };
        assert!(should_trigger_at(&schedule, &moment));
    }

    #[test]
    fn blocked_notification_cache_enforces_hard_entry_limit() {
        let mut cache = HashMap::new();
        for index in 0..(BLOCKED_NOTIFICATION_CACHE_MAX_ENTRIES + 25) {
            assert!(should_emit_blocked_notification_in(
                &mut cache,
                &format!("project:item-{index}:reason"),
                10_000 + index as i64,
            ));
        }
        assert_eq!(cache.len(), BLOCKED_NOTIFICATION_CACHE_MAX_ENTRIES);
    }

    #[test]
    fn blocked_notification_cache_prunes_expired_entries() {
        let mut cache = HashMap::from([
            ("expired".to_string(), 1),
            ("recent".to_string(), BLOCKED_NOTIFICATION_RETENTION_SECS),
        ]);
        let now = BLOCKED_NOTIFICATION_RETENTION_SECS + 2;

        assert!(should_emit_blocked_notification_in(&mut cache, "new", now,));
        assert!(!cache.contains_key("expired"));
        assert!(cache.contains_key("recent"));
        assert!(cache.contains_key("new"));
    }

    #[test]
    fn blocked_notification_identity_includes_project_scope() {
        assert_ne!(
            blocked_notification_key("alpha", "WI-0001", "missing account"),
            blocked_notification_key("beta", "WI-0001", "missing account"),
        );
    }
}
