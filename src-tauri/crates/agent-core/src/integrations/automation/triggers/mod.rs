//! Automation trigger listener implementations.
//!
//! Each trigger type spawns a background task that sends a rule ID
//! through a channel when the trigger condition is met.
//!
//! The dispatcher `spawn_trigger` routes to per-trigger modules so each
//! trigger can evolve independently without growing a single mega-file.

use tokio::sync::mpsc;

mod channel_message;
mod common;
mod file_watch;
mod git_activity;
mod timer;
mod webhook;

pub use common::{GitBroadcastEvent, TriggerContext, TriggerEvent, TriggerHandle};
pub use webhook::webhook_registry;

use super::types::AutomationTrigger;

/// Spawn a trigger listener for the given rule.
///
/// Returns a handle that can be used to stop the listener.
pub fn spawn_trigger(
    rule_id: String,
    trigger: &AutomationTrigger,
    event_tx: mpsc::Sender<TriggerEvent>,
    ctx: &TriggerContext,
) -> Option<TriggerHandle> {
    match trigger {
        AutomationTrigger::Timer { interval_secs } => {
            timer::spawn_timer(rule_id, *interval_secs, event_tx)
        }
        AutomationTrigger::ScheduledTime {
            frequency,
            time,
            timezone,
            days_of_week,
            monthly_mode,
            day_of_month,
            week_of_month,
            weekday_of_month,
        } => timer::spawn_scheduled_time(
            rule_id,
            timer::ScheduledTimeSpec {
                frequency: frequency.clone(),
                time: time.clone(),
                timezone: timezone.clone(),
                days_of_week: days_of_week.clone(),
                monthly_mode: monthly_mode.clone(),
                day_of_month: *day_of_month,
                week_of_month: week_of_month.clone(),
                weekday_of_month: weekday_of_month.clone(),
            },
            event_tx,
        ),
        AutomationTrigger::Cron { expression } => {
            // Orgtrack migration (Phase 5): recurring execution belongs to
            // the Routine subsystem — this was the third parallel cron
            // path. Persisted cron rules still load (no data break) but
            // no longer spawn an execution loop.
            tracing::warn!(
                "[automation] cron trigger '{}' on rule '{}' no longer fires; \
                 recurring execution moved to Routines",
                expression,
                rule_id
            );
            None
        }
        AutomationTrigger::GitActivity {
            events,
            repo_filter,
        } => git_activity::spawn_git_activity(
            rule_id,
            events.clone(),
            repo_filter.clone(),
            event_tx,
            ctx,
        ),
        AutomationTrigger::ChannelMessage { channel, pattern } => {
            channel_message::spawn_channel_message(
                rule_id,
                channel.clone(),
                pattern.clone(),
                event_tx,
                ctx,
            )
        }
        AutomationTrigger::FileWatch { paths, debounce_ms } => {
            file_watch::spawn_file_watch(rule_id, paths.clone(), *debounce_ms, event_tx)
        }
        AutomationTrigger::Webhook { route } => {
            webhook::spawn_webhook(rule_id, route.clone(), event_tx)
        }
    }
}
