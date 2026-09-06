//! Routine trigger scheduler.
//!
//! One backend-owned loop evaluates portable `pm_routines` schedule
//! activations. Legacy definitions remain UI control-plane mirrors, but the
//! legacy scheduler pass is gone, so there is no parallel execution path.

use chrono::{DateTime, Utc};
use tracing::{info, warn};

use project_management::projects::routine_schedule::{due_times, next_occurrence};
use project_management::projects::types::RoutineTrigger;

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
    let _ = app;
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

    let queued = tokio::task::spawn_blocking(|| {
        routines::queued_activations(routines::MAX_SCHEDULE_CANDIDATES_PER_TICK)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;
    for queued in queued {
        let event_id = queued.event_id.clone();
        let routine_name = queued.routine_name.clone();
        let result =
            tokio::task::spawn_blocking(move || routines::promote_queued_activation(&queued))
                .await
                .map_err(|err| format!("Task join error: {err}"))?;
        match result {
            Ok(Some(run)) => {
                info!(
                    "[routine-scheduler] promoted queued routine {} as run {}",
                    routine_name, run.run_id
                );
            }
            Ok(None) => continue,
            Err(error) => {
                routines::finish_queued_activation(&event_id, Some(&error))?;
                warn!(
                    "[routine-scheduler] queued routine {} failed: {}",
                    routine_name, error
                );
            }
        }
    }

    let evaluate_before = now.timestamp_millis();
    let candidates =
        tokio::task::spawn_blocking(move || routines::scheduled_candidates(evaluate_before))
            .await
            .map_err(|err| format!("Task join error: {err}"))??;

    let mut schedule_marks: std::collections::BTreeMap<String, Option<i64>> =
        std::collections::BTreeMap::new();
    for candidate in candidates {
        let window_start = candidate
            .last_evaluated_at
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(|| now - chrono::Duration::seconds(POLL_INTERVAL_SECS as i64));
        let trigger = match &candidate.trigger {
            routines::ScheduledTrigger::Cron { cron, timezone } => RoutineTrigger::Cron {
                cron: cron.clone(),
                timezone: timezone.clone(),
            },
            routines::ScheduledTrigger::OneTime { at } => {
                RoutineTrigger::OneTime { at: at.clone() }
            }
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

        let mut activation_accepted = false;
        for scheduled_at in
            apply_catch_up_policy(&due, candidate.catch_up, candidate.max_catch_up_runs)
        {
            let name = candidate.name.clone();
            let scheduled_millis = scheduled_at.timestamp_millis();
            let target = candidate.target.clone();
            let policy = candidate.concurrency;
            let fired = tokio::task::spawn_blocking(move || {
                let invoke_key = format!("{}:{}", name, scheduled_millis);
                routines::request_activation(
                    &name,
                    &target,
                    &Default::default(),
                    &invoke_key,
                    policy,
                    scheduled_millis,
                )
            })
            .await
            .map_err(|err| format!("Task join error: {err}"))?;
            match fired {
                Ok(routines::RoutineActivationOutcome::Invoked(run)) => {
                    activation_accepted = true;
                    info!(
                        "[routine-scheduler] portable routine {} fired run {}",
                        candidate.name, run.run_id
                    );
                }
                Ok(routines::RoutineActivationOutcome::Deferred(event)) => {
                    activation_accepted = true;
                    info!(
                        "[routine-scheduler] portable routine {} activation {}",
                        candidate.name, event.status
                    );
                }
                Err(err) => warn!(
                    "[routine-scheduler] portable routine {} fire failed: {}",
                    candidate.name, err
                ),
            }
        }

        let next = next_occurrence(&trigger, &now)
            .ok()
            .flatten()
            .map(|at| at.timestamp_millis());
        schedule_marks
            .entry(candidate.name.clone())
            .and_modify(|current| {
                if let Some(next) = next {
                    *current = Some(current.map_or(next, |current| current.min(next)));
                }
            })
            .or_insert(next);
        if matches!(
            candidate.trigger,
            routines::ScheduledTrigger::OneTime { .. }
        ) && activation_accepted
        {
            routines::legacy_bridge::disable_one_time(&candidate.name)?;
        }
    }
    for (name, next_fire_at) in schedule_marks {
        tokio::task::spawn_blocking(move || {
            routines::mark_evaluated(&name, now.timestamp_millis(), next_fire_at)
        })
        .await
        .map_err(|err| format!("Task join error: {err}"))??;
    }
    Ok(())
}

fn apply_catch_up_policy(
    due: &[DateTime<Utc>],
    policy: project_management::routine_service::spec::CatchUpPolicy,
    max_catch_up_runs: u32,
) -> Vec<DateTime<Utc>> {
    use project_management::routine_service::spec::CatchUpPolicy;
    if due.is_empty() {
        return Vec::new();
    }
    match policy {
        CatchUpPolicy::None | CatchUpPolicy::FireOnce => {
            vec![*due.last().expect("due is non-empty")]
        }
        CatchUpPolicy::RunAllLimited => {
            let start = due.len().saturating_sub(max_catch_up_runs.max(1) as usize);
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

    fn one_time_fixture(
        name: &str,
        at: DateTime<Utc>,
    ) -> project_management::routine_service::spec::RoutineSpecFile {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json"),
        )
        .expect("fixture");
        let mut file: project_management::routine_service::spec::RoutineSpecFile =
            serde_json::from_str(&raw).expect("parse fixture");
        file.metadata.id = format!("routine-{name}");
        file.metadata.name = name.to_string();
        file.metadata.revision = None;
        file.spec.inputs.clear();
        file.spec.root_work.title = "One-time root".to_string();
        file.spec.activations = vec![
            project_management::routine_service::spec::Activation::OneTime {
                at: at.to_rfc3339(),
                policies: Default::default(),
            },
        ];
        file
    }

    fn portable_enabled(name: &str) -> bool {
        project_management::routine_service::list_routines()
            .expect("list routines")
            .into_iter()
            .find(|routine| routine["name"] == name)
            .and_then(|routine| routine["enabled"].as_bool())
            .expect("routine enabled state")
    }

    fn portable_run_count() -> usize {
        project_management::routine_service::list_runs(None, 100)
            .expect("list runs")
            .len()
    }

    fn init_project_schema() {
        let connection = database::db::get_projects_connection().expect("projects connection");
        project_management::projects::schema::init_project_tables(&connection)
            .expect("project schema");
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

    #[test]
    fn catch_up_policies_preserve_collapse_and_bounded_replay() {
        use project_management::routine_service::spec::CatchUpPolicy;

        let due = vec![
            at(2026, 6, 8, 9, 0),
            at(2026, 6, 9, 9, 0),
            at(2026, 6, 10, 9, 0),
        ];
        assert_eq!(
            apply_catch_up_policy(&due, CatchUpPolicy::None, 9),
            vec![at(2026, 6, 10, 9, 0)]
        );
        assert_eq!(
            apply_catch_up_policy(&due, CatchUpPolicy::FireOnce, 9),
            vec![at(2026, 6, 10, 9, 0)]
        );
        assert_eq!(
            apply_catch_up_policy(&due, CatchUpPolicy::RunAllLimited, 2),
            vec![at(2026, 6, 9, 9, 0), at(2026, 6, 10, 9, 0)]
        );
    }

    #[tokio::test]
    async fn portable_one_time_activation_runs_once_and_disables_itself() {
        let _sandbox = test_helpers::test_env::sandbox();
        init_project_schema();
        let now = Utc::now();
        let file = one_time_fixture("portable-one-time", now - chrono::Duration::seconds(1));
        project_management::routine_service::apply(&file).expect("apply one-time");

        portable_tick(now).await.expect("first tick");
        assert_eq!(portable_run_count(), 1);
        assert!(
            !portable_enabled(&file.metadata.name),
            "accepted one-time activation becomes inert"
        );

        portable_tick(now + chrono::Duration::seconds(30))
            .await
            .expect("second tick");
        assert_eq!(
            portable_run_count(),
            1,
            "disabled one-time activation cannot refire"
        );
    }

    #[tokio::test]
    async fn failed_one_time_activation_stays_enabled_for_retry() {
        let _sandbox = test_helpers::test_env::sandbox();
        init_project_schema();
        let now = Utc::now();
        let file = one_time_fixture("one-time-retry", now - chrono::Duration::seconds(1));
        project_management::routine_service::apply(&file).expect("apply one-time");
        project_management::routine_service::set_default_target(
            &file.metadata.name,
            &project_management::routine_service::RoutineInvocationTarget::ExistingProjectWork {
                project_slug: "missing-project".to_string(),
                root_work_item_id: "MISSING-0001".to_string(),
            },
        )
        .expect("set failing target");

        portable_tick(now)
            .await
            .expect("failed invocation is contained");
        assert_eq!(portable_run_count(), 0);
        assert!(
            portable_enabled(&file.metadata.name),
            "failed one-time activation remains retryable"
        );
    }

    #[tokio::test]
    async fn multiple_schedule_activations_persist_the_earliest_next_fire_once() {
        use project_management::routine_service::spec::{Activation, ActivationPolicies};

        let _sandbox = test_helpers::test_env::sandbox();
        init_project_schema();
        let now = at(2026, 8, 19, 10, 30);
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json"),
        )
        .expect("fixture");
        let mut file: project_management::routine_service::spec::RoutineSpecFile =
            serde_json::from_str(&raw).expect("parse fixture");
        file.metadata.id = "routine-multi-schedule".to_string();
        file.metadata.name = "multi-schedule".to_string();
        file.metadata.revision = None;
        file.spec.inputs.clear();
        file.spec.root_work.title = "Multi-schedule root".to_string();
        // The later activation intentionally comes last. The old per-candidate
        // watermark writes would overwrite 10:31 with 11:00.
        file.spec.activations = vec![
            Activation::Schedule {
                cron: "* * * * *".to_string(),
                timezone: "UTC".to_string(),
                policies: ActivationPolicies::default(),
            },
            Activation::Schedule {
                cron: "0 * * * *".to_string(),
                timezone: "UTC".to_string(),
                policies: ActivationPolicies::default(),
            },
        ];
        project_management::routine_service::apply(&file).expect("apply multi schedule");
        project_management::routine_service::mark_evaluated(
            &file.metadata.name,
            now.timestamp_millis(),
            None,
        )
        .expect("force due scan");

        portable_tick(now).await.expect("multi schedule tick");
        let connection = database::db::get_projects_connection().expect("projects connection");
        let (last_evaluated_at, next_fire_at): (i64, i64) = connection
            .query_row(
                "SELECT last_evaluated_at, next_fire_at
                   FROM pm_routines WHERE name = ?1",
                rusqlite::params![file.metadata.name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("schedule watermark");
        assert_eq!(last_evaluated_at, now.timestamp_millis());
        assert_eq!(next_fire_at, at(2026, 8, 19, 10, 31).timestamp_millis());
        assert_eq!(portable_run_count(), 0);
    }

    // ============================================
    // next occurrence
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
}
