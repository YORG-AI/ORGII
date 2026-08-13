//! Routine trigger scheduler.
//!
//! Background task that evaluates every enabled routine's trigger
//! (`RoutineTrigger::Cron` / `RoutineTrigger::OneTime`) and fires it through
//! the same path as the manual "Fire Now" command. The whole loop runs in the
//! backend so routines work unattended — the frontend never participates.
//!
//! Catch-up: missed trigger times in `(last_evaluated_at, now]` (app was
//! closed) are resolved per the routine's `catch_up_policy`. Every
//! scheduler-originated fire carries an idempotency key
//! `"{routine_id}:{scheduled_at}"` so a crash between fire-insert and
//! watermark-update cannot double-fire after restart.

use chrono::{DateTime, Utc};
use tracing::{info, warn};

use project_management::projects::io;
use project_management::projects::routine_schedule::{due_times, next_occurrence};
use project_management::projects::types::{
    RoutineCatchUpPolicy, RoutineDefinition, RoutineTrigger,
};

const POLL_INTERVAL_SECS: u64 = 30;

/// Spawn the routine scheduler background task. Polls every 30 seconds.
pub fn spawn(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        info!("[routine-scheduler] started (poll={}s)", POLL_INTERVAL_SECS);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
            if let Err(err) = tick(&app_handle, Utc::now()).await {
                warn!("[routine-scheduler] tick error: {}", err);
            }
        }
    });
}

/// Run one scheduler evaluation pass (e2e/debug hook).
pub async fn debug_run_once(app: &tauri::AppHandle) -> Result<(), String> {
    tick(app, Utc::now()).await
}

async fn tick(app: &tauri::AppHandle, now: DateTime<Utc>) -> Result<(), String> {
    let routines = match tokio::task::spawn_blocking(io::list_enabled_routines).await {
        Ok(Ok(routines)) => routines,
        Ok(Err(err)) => return Err(err),
        Err(err) => return Err(format!("Task join error: {err}")),
    };

    for routine in routines {
        if let Err(err) = evaluate_routine(app, &routine, now).await {
            warn!(
                "[routine-scheduler] evaluation of {} failed: {}",
                routine.id, err
            );
        }
    }

    // Portable pass: pm_routines schedule activations fire through the
    // canonical routine.invoke — the same entry manual CLI runs use.
    // Converted legacy rows are disabled at conversion time, so a routine
    // is only ever driven by ONE of the two passes.
    if let Err(err) = portable_tick(now).await {
        warn!("[routine-scheduler] portable tick error: {}", err);
    }
    Ok(())
}

/// Evaluate the portable `pm_routines` schedule activations (design
/// §10.4). Cron is evaluated in the timezone declared by the portable spec.
/// Catch-up: both portable policies (`none`, `fire_once`) reduce to
/// "fire the latest missed tick once", matching the legacy collapse.
async fn portable_tick(now: DateTime<Utc>) -> Result<(), String> {
    use project_management::routine_service as routines;

    let candidates = tokio::task::spawn_blocking(routines::scheduled_candidates)
        .await
        .map_err(|err| format!("Task join error: {err}"))??;

    for candidate in candidates {
        let window_start = candidate
            .last_evaluated_at
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(|| now - chrono::Duration::seconds(POLL_INTERVAL_SECS as i64));
        let trigger = RoutineTrigger::Cron {
            cron: candidate.cron.clone(),
            timezone: candidate.timezone.clone(),
        };
        let due = match due_times(&trigger, &window_start, &now) {
            Ok(due) => due,
            Err(err) => {
                warn!(
                    "[routine-scheduler] portable routine {} cron error: {}",
                    candidate.name, err
                );
                continue;
            }
        };

        if let Some(scheduled_at) = due.last() {
            let name = candidate.name.clone();
            let scheduled_millis = scheduled_at.timestamp_millis();
            let policy = format!("{:?}", candidate.concurrency).to_lowercase();
            let scope = candidate.default_scope.clone();
            let fired: Result<(), String> = tokio::task::spawn_blocking(move || {
                let active = routines::has_active_run(&name)?;
                if active {
                    // skip/coalesce suppress; queue also suppresses for
                    // now (pending-run dequeue lands with the cancel
                    // machinery) — always audited, never silent.
                    routines::audit_suppressed_fire(&name, &policy, scheduled_millis)?;
                    return Ok(());
                }
                let Some(scope) = scope else {
                    routines::audit_suppressed_fire(&name, "no_scope_binding", scheduled_millis)?;
                    return Ok(());
                };
                let invoke_key = format!("{}:{}", name, scheduled_millis);
                let run =
                    routines::invoke(&name, &scope, &Default::default(), None, Some(&invoke_key))?;
                info!(
                    "[routine-scheduler] portable routine {} fired run {}",
                    name, run.run_id
                );
                Ok(())
            })
            .await
            .map_err(|err| format!("Task join error: {err}"))?;
            if let Err(err) = fired {
                warn!(
                    "[routine-scheduler] portable routine {} fire failed: {}",
                    candidate.name, err
                );
            }
        }

        let next = next_occurrence(
            &RoutineTrigger::Cron {
                cron: candidate.cron.clone(),
                timezone: candidate.timezone.clone(),
            },
            &now,
        )
        .ok()
        .flatten();
        let name = candidate.name.clone();
        let _ = tokio::task::spawn_blocking(move || {
            routines::mark_evaluated(
                &name,
                now.timestamp_millis(),
                next.map(|at| at.timestamp_millis()),
            )
        })
        .await;
    }
    Ok(())
}

async fn evaluate_routine(
    app: &tauri::AppHandle,
    routine: &RoutineDefinition,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let window_start = watermark(routine, now);
    let due = due_times(&routine.trigger, &window_start, &now)?;
    let to_fire = apply_catch_up_policy(
        &due,
        &routine.output_policy.catch_up_policy,
        routine.output_policy.max_catch_up_runs,
        &now,
    );

    for scheduled_at in &to_fire {
        fire(app, routine, scheduled_at).await;
    }

    if matches!(routine.trigger, RoutineTrigger::OneTime { .. }) && !due.is_empty() {
        let routine_id = routine.id.clone();
        tokio::task::spawn_blocking(move || io::disable_routine(&routine_id))
            .await
            .map_err(|err| format!("Task join error: {err}"))??;
    }

    let next_fire_at = match &routine.trigger {
        RoutineTrigger::OneTime { .. } if !due.is_empty() => None,
        trigger => next_occurrence(trigger, &now)?,
    };
    let routine_id = routine.id.clone();
    tokio::task::spawn_blocking(move || {
        io::update_routine_schedule_marks(
            &routine_id,
            now.timestamp_millis(),
            next_fire_at.map(|at| at.timestamp_millis()),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;

    Ok(())
}

async fn fire(app: &tauri::AppHandle, routine: &RoutineDefinition, scheduled_at: &DateTime<Utc>) {
    use tauri::Manager;
    let state = app.state::<crate::state::AgentAppState>();
    let org_store = app.state::<std::sync::Arc<crate::definitions::orgs::AgentOrgsStore>>();
    let key = idempotency_key(&routine.id, scheduled_at);

    info!(
        "[routine-scheduler] firing routine {} (scheduled {})",
        routine.id, scheduled_at
    );
    match crate::state::commands::routines::fire_routine_internal(
        state.inner(),
        org_store.inner(),
        app,
        routine,
        Some(key),
    )
    .await
    {
        Ok(result) => info!(
            "[routine-scheduler] routine {} fire {} → {:?}",
            routine.id, result.fire.id, result.fire.status
        ),
        Err(err) => warn!(
            "[routine-scheduler] routine {} fire failed: {}",
            routine.id, err
        ),
    }
}

fn idempotency_key(routine_id: &str, scheduled_at: &DateTime<Utc>) -> String {
    format!("{}:{}", routine_id, scheduled_at.to_rfc3339())
}

/// Evaluation window start: persisted watermark, or "now − poll interval"
/// for routines that have never been evaluated (avoids replaying the entire
/// cron history of a freshly created routine).
fn watermark(routine: &RoutineDefinition, now: DateTime<Utc>) -> DateTime<Utc> {
    routine
        .last_evaluated_at
        .as_deref()
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
        .unwrap_or_else(|| now - chrono::Duration::seconds(POLL_INTERVAL_SECS as i64))
}

/// Reduce the due list according to the catch-up policy. The latest due time
/// always fires; earlier (missed) ones are policy-dependent.
fn apply_catch_up_policy(
    due: &[DateTime<Utc>],
    policy: &RoutineCatchUpPolicy,
    max_catch_up_runs: u32,
    now: &DateTime<Utc>,
) -> Vec<DateTime<Utc>> {
    if due.is_empty() {
        return Vec::new();
    }
    match policy {
        RoutineCatchUpPolicy::SkipMissed => {
            // Only the most recent tick fires; older missed ones are dropped.
            vec![*due.last().expect("due is non-empty")]
        }
        RoutineCatchUpPolicy::RunOnce => {
            // One catch-up run for the whole missed window, stamped with the
            // latest due time.
            let _ = now;
            vec![*due.last().expect("due is non-empty")]
        }
        RoutineCatchUpPolicy::RunAllLimited => {
            let limit = (max_catch_up_runs.max(1)) as usize;
            let start = due.len().saturating_sub(limit);
            due[start..].to_vec()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    // ============================================
    // due_times — cron
    // ============================================

    #[test]
    fn cron_no_tick_in_window_returns_empty() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        };
        let window_start = at(2026, 6, 10, 10, 0);
        let now = at(2026, 6, 10, 10, 5);
        assert!(due_times(&trigger, &window_start, &now).unwrap().is_empty());
    }

    #[test]
    fn cron_single_tick_in_window() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        };
        let window_start = at(2026, 6, 10, 8, 0);
        let now = at(2026, 6, 10, 10, 0);
        let due = due_times(&trigger, &window_start, &now).unwrap();
        assert_eq!(due, vec![at(2026, 6, 10, 9, 0)]);
    }

    #[test]
    fn cron_multiple_missed_ticks_accumulate() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        };
        // Three days of downtime → three missed 09:00 ticks.
        let window_start = at(2026, 6, 7, 12, 0);
        let now = at(2026, 6, 10, 12, 0);
        let due = due_times(&trigger, &window_start, &now).unwrap();
        assert_eq!(
            due,
            vec![
                at(2026, 6, 8, 9, 0),
                at(2026, 6, 9, 9, 0),
                at(2026, 6, 10, 9, 0)
            ]
        );
    }

    #[test]
    fn cron_invalid_expression_is_error() {
        let trigger = RoutineTrigger::Cron {
            cron: "not a cron".to_string(),
            timezone: "UTC".to_string(),
        };
        let now = Utc::now();
        assert!(due_times(&trigger, &now, &now).is_err());
    }

    // ============================================
    // due_times — one-time
    // ============================================

    #[test]
    fn one_time_future_not_due() {
        let trigger = RoutineTrigger::OneTime {
            at: "2099-01-01T00:00:00Z".to_string(),
        };
        let window_start = at(2026, 6, 10, 8, 0);
        let now = at(2026, 6, 10, 10, 0);
        assert!(due_times(&trigger, &window_start, &now).unwrap().is_empty());
    }

    #[test]
    fn one_time_in_window_is_due() {
        let trigger = RoutineTrigger::OneTime {
            at: "2026-06-10T09:00:00Z".to_string(),
        };
        let window_start = at(2026, 6, 10, 8, 0);
        let now = at(2026, 6, 10, 10, 0);
        let due = due_times(&trigger, &window_start, &now).unwrap();
        assert_eq!(due, vec![at(2026, 6, 10, 9, 0)]);
    }

    #[test]
    fn one_time_missed_before_window_is_still_due() {
        let trigger = RoutineTrigger::OneTime {
            at: "2026-06-01T09:00:00Z".to_string(),
        };
        let window_start = at(2026, 6, 10, 8, 0);
        let now = at(2026, 6, 10, 10, 0);
        let due = due_times(&trigger, &window_start, &now).unwrap();
        assert_eq!(due.len(), 1);
    }

    // ============================================
    // apply_catch_up_policy
    // ============================================

    #[test]
    fn skip_missed_keeps_only_latest() {
        let due = vec![
            at(2026, 6, 8, 9, 0),
            at(2026, 6, 9, 9, 0),
            at(2026, 6, 10, 9, 0),
        ];
        let now = at(2026, 6, 10, 12, 0);
        let fired = apply_catch_up_policy(&due, &RoutineCatchUpPolicy::SkipMissed, 5, &now);
        assert_eq!(fired, vec![at(2026, 6, 10, 9, 0)]);
    }

    #[test]
    fn run_once_collapses_to_single_run() {
        let due = vec![at(2026, 6, 8, 9, 0), at(2026, 6, 9, 9, 0)];
        let now = at(2026, 6, 10, 12, 0);
        let fired = apply_catch_up_policy(&due, &RoutineCatchUpPolicy::RunOnce, 5, &now);
        assert_eq!(fired, vec![at(2026, 6, 9, 9, 0)]);
    }

    #[test]
    fn run_all_limited_respects_max() {
        let due = vec![
            at(2026, 6, 7, 9, 0),
            at(2026, 6, 8, 9, 0),
            at(2026, 6, 9, 9, 0),
            at(2026, 6, 10, 9, 0),
        ];
        let now = at(2026, 6, 10, 12, 0);
        let fired = apply_catch_up_policy(&due, &RoutineCatchUpPolicy::RunAllLimited, 2, &now);
        assert_eq!(fired, vec![at(2026, 6, 9, 9, 0), at(2026, 6, 10, 9, 0)]);
    }

    #[test]
    fn empty_due_fires_nothing() {
        let now = Utc::now();
        assert!(apply_catch_up_policy(&[], &RoutineCatchUpPolicy::RunOnce, 1, &now).is_empty());
    }

    // ============================================
    // next_occurrence / idempotency
    // ============================================

    #[test]
    fn next_occurrence_cron() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        };
        let now = at(2026, 6, 10, 10, 0);
        let next = next_occurrence(&trigger, &now).unwrap().unwrap();
        assert_eq!(next, at(2026, 6, 11, 9, 0));
    }

    #[test]
    fn next_occurrence_one_time_past_is_none() {
        let trigger = RoutineTrigger::OneTime {
            at: "2020-01-01T00:00:00Z".to_string(),
        };
        let now = Utc::now();
        assert!(next_occurrence(&trigger, &now).unwrap().is_none());
    }

    #[test]
    fn idempotency_key_is_stable_per_tick() {
        let tick = at(2026, 6, 10, 9, 0);
        assert_eq!(
            idempotency_key("routine-1", &tick),
            idempotency_key("routine-1", &tick)
        );
        assert_ne!(
            idempotency_key("routine-1", &tick),
            idempotency_key("routine-2", &tick)
        );
    }

    #[test]
    fn watermark_defaults_to_one_poll_interval() {
        let routine = RoutineDefinition {
            id: "r".into(),
            name: "r".into(),
            description: String::new(),
            enabled: true,
            trigger: RoutineTrigger::Cron {
                cron: "* * * * *".into(),
                timezone: "UTC".into(),
            },
            run_template: project_management::projects::types::RoutineRunTemplate {
                prompt: String::new(),
                target: project_management::projects::types::RoutineRunTarget::AgentDefinition {
                    agent_definition_id: None,
                },
                resources: project_management::projects::types::RoutineResourceSelection {
                    key_source: None,
                    account_id: None,
                    model: None,
                    native_harness_type: None,
                },
                workspace: project_management::projects::types::RoutineWorkspaceTarget::None,
                mode: None,
                name: None,
            },
            output_policy: Default::default(),
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
        let now = Utc::now();
        let mark = watermark(&routine, now);
        assert_eq!(now - mark, chrono::Duration::seconds(30));
    }
}
