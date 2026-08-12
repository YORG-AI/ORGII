//! Timer, scheduled-time, and cron-based automation trigger listeners.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use tokio::sync::mpsc;
use tracing::{error, info};

use super::common::{TriggerEvent, TriggerHandle};
use crate::automation::types::{
    ScheduleFrequency, ScheduleMonthlyMode, ScheduleWeekday, WeekOfMonth,
};

/// Bundled inputs for the scheduled-time listener. Mirrors the fields on the
/// [`AutomationTrigger::ScheduledTime`] variant — kept as a struct so the
/// listener spawn-site doesn't need to thread 9 positional arguments through
/// the dispatch matcher.
pub(super) struct ScheduledTimeSpec {
    pub frequency: ScheduleFrequency,
    pub time: String,
    pub timezone: String,
    pub days_of_week: Vec<ScheduleWeekday>,
    pub monthly_mode: Option<ScheduleMonthlyMode>,
    pub day_of_month: Option<u8>,
    pub week_of_month: Option<WeekOfMonth>,
    pub weekday_of_month: Option<ScheduleWeekday>,
}

/// Borrowed view of [`ScheduledTimeSpec`] used by the inner schedule-math
/// helper. The math doesn't mutate any of the inputs, so passing references
/// avoids cloning the day-of-week list every iteration.
struct ScheduleResolution<'a> {
    frequency: &'a ScheduleFrequency,
    time: NaiveTime,
    days_of_week: &'a [ScheduleWeekday],
    monthly_mode: Option<&'a ScheduleMonthlyMode>,
    day_of_month: Option<u8>,
    week_of_month: Option<&'a WeekOfMonth>,
    weekday_of_month: Option<&'a ScheduleWeekday>,
}

pub(super) fn spawn_timer(
    rule_id: String,
    interval_secs: u64,
    event_tx: mpsc::Sender<TriggerEvent>,
) -> Option<TriggerHandle> {
    let interval = std::time::Duration::from_secs(interval_secs);
    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let rid = rule_id.clone();

    let handle = tokio::spawn(async move {
        info!(
            "[automation] Timer trigger started for rule '{}' (interval: {}s)",
            rid,
            interval.as_secs()
        );

        while running_clone.load(Ordering::Relaxed) {
            tokio::time::sleep(interval).await;

            if !running_clone.load(Ordering::Relaxed) {
                break;
            }

            if let Err(err) = event_tx
                .send(TriggerEvent {
                    rule_id: rid.clone(),
                })
                .await
            {
                error!(
                    "[automation] Failed to send trigger event for rule '{}': {}",
                    rid, err
                );
                break;
            }
        }

        info!("[automation] Timer trigger stopped for rule '{}'", rid);
    });

    Some(TriggerHandle {
        rule_id,
        running,
        handle: Some(handle),
    })
}

pub(super) fn spawn_scheduled_time(
    rule_id: String,
    spec: ScheduledTimeSpec,
    event_tx: mpsc::Sender<TriggerEvent>,
) -> Option<TriggerHandle> {
    let tz = if spec.timezone.eq_ignore_ascii_case("utc") {
        chrono_tz::UTC
    } else {
        match spec.timezone.parse::<Tz>() {
            Ok(tz) => tz,
            Err(err) => {
                error!(
                    "[automation] Invalid timezone '{}' for rule '{}': {}",
                    spec.timezone, rule_id, err
                );
                return None;
            }
        }
    };

    let scheduled_time = match NaiveTime::parse_from_str(&spec.time, "%H:%M") {
        Ok(time) => time,
        Err(err) => {
            error!(
                "[automation] Invalid scheduled time '{}' for rule '{}': {}",
                spec.time, rule_id, err
            );
            return None;
        }
    };

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let rid = rule_id.clone();

    let handle = tokio::spawn(async move {
        info!(
            "[automation] ScheduledTime trigger started for rule '{}' ({:?} at {} {})",
            rid, spec.frequency, scheduled_time, spec.timezone
        );

        while running_clone.load(Ordering::Relaxed) {
            let now = Utc::now();
            let resolution = ScheduleResolution {
                frequency: &spec.frequency,
                time: scheduled_time,
                days_of_week: &spec.days_of_week,
                monthly_mode: spec.monthly_mode.as_ref(),
                day_of_month: spec.day_of_month,
                week_of_month: spec.week_of_month.as_ref(),
                weekday_of_month: spec.weekday_of_month.as_ref(),
            };
            let Some(next) = next_scheduled_occurrence(now, tz, &resolution) else {
                error!(
                    "[automation] Could not compute next scheduled occurrence for rule '{}'",
                    rid
                );
                break;
            };

            let delay = (next - now)
                .to_std()
                .unwrap_or_else(|_| std::time::Duration::from_secs(60));
            info!(
                "[automation] ScheduledTime rule '{}' next fire at {} (in {}s)",
                rid,
                next.to_rfc3339(),
                delay.as_secs()
            );

            tokio::time::sleep(delay).await;

            if !running_clone.load(Ordering::Relaxed) {
                break;
            }

            if let Err(err) = event_tx
                .send(TriggerEvent {
                    rule_id: rid.clone(),
                })
                .await
            {
                error!(
                    "[automation] Failed to send scheduled trigger event for rule '{}': {}",
                    rid, err
                );
                break;
            }
        }

        info!(
            "[automation] ScheduledTime trigger stopped for rule '{}'",
            rid
        );
    });

    Some(TriggerHandle {
        rule_id,
        running,
        handle: Some(handle),
    })
}

fn next_scheduled_occurrence(
    now: DateTime<Utc>,
    timezone: Tz,
    resolution: &ScheduleResolution<'_>,
) -> Option<DateTime<Utc>> {
    let now_local = now.with_timezone(&timezone);
    let time = resolution.time;
    match resolution.frequency {
        ScheduleFrequency::Daily => {
            next_matching_day(now, timezone, time, |date| date >= now_local.date_naive())
        }
        ScheduleFrequency::Weekly => {
            let weekdays = if resolution.days_of_week.is_empty() {
                vec![ScheduleWeekday::from_chrono(now_local.weekday())]
            } else {
                resolution.days_of_week.to_vec()
            };
            next_matching_day(now, timezone, time, |date| {
                weekdays.iter().any(|day| day.matches(date.weekday()))
            })
        }
        ScheduleFrequency::Monthly => match resolution
            .monthly_mode
            .unwrap_or(&ScheduleMonthlyMode::DayOfMonth)
        {
            ScheduleMonthlyMode::DayOfMonth => {
                let target_day = resolution.day_of_month.unwrap_or(1).clamp(1, 31) as u32;
                next_matching_day(now, timezone, time, |date| date.day() == target_day)
            }
            ScheduleMonthlyMode::WeekdayOfMonth => {
                let week = resolution.week_of_month.unwrap_or(&WeekOfMonth::First);
                let weekday = resolution
                    .weekday_of_month
                    .unwrap_or(&ScheduleWeekday::Monday);
                next_matching_day(now, timezone, time, |date| {
                    weekday.matches(date.weekday()) && week.matches(date)
                })
            }
            ScheduleMonthlyMode::LastDay => next_matching_day(now, timezone, time, |date| {
                date.checked_add_signed(Duration::days(1))
                    .map(|next_date| next_date.month() != date.month())
                    .unwrap_or(false)
            }),
        },
    }
}

fn next_matching_day(
    now: DateTime<Utc>,
    timezone: Tz,
    time: NaiveTime,
    matches: impl Fn(NaiveDate) -> bool,
) -> Option<DateTime<Utc>> {
    let start_date = now.with_timezone(&timezone).date_naive();
    for day_offset in 0..=370 {
        let date = start_date.checked_add_signed(Duration::days(day_offset))?;
        if !matches(date) {
            continue;
        }
        let local_naive = date.and_time(time);
        if let Some(candidate) = local_naive_to_utc(timezone, local_naive) {
            if candidate > now {
                return Some(candidate);
            }
        }
    }
    None
}

fn local_naive_to_utc(timezone: Tz, local: chrono::NaiveDateTime) -> Option<DateTime<Utc>> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, second) => Some(first.min(second).with_timezone(&Utc)),
        LocalResult::None => {
            for minute_offset in 1..=180 {
                let adjusted = local.checked_add_signed(Duration::minutes(minute_offset))?;
                match timezone.from_local_datetime(&adjusted) {
                    LocalResult::Single(value) => return Some(value.with_timezone(&Utc)),
                    LocalResult::Ambiguous(first, second) => {
                        return Some(first.min(second).with_timezone(&Utc));
                    }
                    LocalResult::None => {}
                }
            }
            None
        }
    }
}

impl WeekOfMonth {
    fn matches(&self, date: NaiveDate) -> bool {
        match self {
            Self::First => (1..=7).contains(&date.day()),
            Self::Second => (8..=14).contains(&date.day()),
            Self::Third => (15..=21).contains(&date.day()),
            Self::Fourth => (22..=28).contains(&date.day()),
            Self::Last => date
                .checked_add_signed(Duration::days(7))
                .map(|next_week| next_week.month() != date.month())
                .unwrap_or(false),
        }
    }
}

impl ScheduleWeekday {
    fn from_chrono(weekday: chrono::Weekday) -> Self {
        match weekday {
            chrono::Weekday::Mon => Self::Monday,
            chrono::Weekday::Tue => Self::Tuesday,
            chrono::Weekday::Wed => Self::Wednesday,
            chrono::Weekday::Thu => Self::Thursday,
            chrono::Weekday::Fri => Self::Friday,
            chrono::Weekday::Sat => Self::Saturday,
            chrono::Weekday::Sun => Self::Sunday,
        }
    }

    fn matches(&self, weekday: chrono::Weekday) -> bool {
        match self {
            Self::Monday => weekday == chrono::Weekday::Mon,
            Self::Tuesday => weekday == chrono::Weekday::Tue,
            Self::Wednesday => weekday == chrono::Weekday::Wed,
            Self::Thursday => weekday == chrono::Weekday::Thu,
            Self::Friday => weekday == chrono::Weekday::Fri,
            Self::Saturday => weekday == chrono::Weekday::Sat,
            Self::Sunday => weekday == chrono::Weekday::Sun,
        }
    }
}
