//! Timezone-aware schedule math shared by Routine persistence and dispatch.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use super::types::RoutineTrigger;

fn parse_timezone(raw: &str) -> Result<Tz, String> {
    if raw.trim().is_empty() || raw.eq_ignore_ascii_case("utc") {
        return Ok(chrono_tz::UTC);
    }
    raw.parse::<Tz>()
        .map_err(|err| format!("invalid routine timezone '{raw}': {err}"))
}

fn parse_trigger_time(raw: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return Ok(parsed.with_timezone(&Utc));
    }
    if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Ok(parsed.and_utc());
    }
    Err(format!("invalid one-time trigger timestamp: {raw}"))
}

/// Return every trigger instant in `(window_start, now]`.
pub fn due_times(
    trigger: &RoutineTrigger,
    window_start: &DateTime<Utc>,
    now: &DateTime<Utc>,
) -> Result<Vec<DateTime<Utc>>, String> {
    match trigger {
        RoutineTrigger::OneTime { at } => {
            let at_time = parse_trigger_time(at)?;
            if at_time > *window_start && at_time <= *now {
                Ok(vec![at_time])
            } else if at_time <= *window_start {
                // A missed one-time trigger remains due exactly once. The
                // caller's catch-up policy decides whether it executes.
                Ok(vec![at_time])
            } else {
                Ok(Vec::new())
            }
        }
        RoutineTrigger::Cron { cron, timezone } => {
            let parsed = croner::Cron::new(cron)
                .parse()
                .map_err(|err| format!("invalid cron expression '{cron}': {err}"))?;
            let timezone = parse_timezone(timezone)?;
            let now_local = now.with_timezone(&timezone);
            let mut cursor = window_start.with_timezone(&timezone);
            let mut due = Vec::new();
            // Bound replay after long downtime or pathological expressions.
            const MAX_DUE: usize = 1000;
            while due.len() < MAX_DUE {
                match parsed.find_next_occurrence(&cursor, false) {
                    Ok(next) if next <= now_local => {
                        due.push(next.with_timezone(&Utc));
                        cursor = next;
                    }
                    Ok(_) => break,
                    Err(err) => {
                        return Err(format!(
                            "compute next occurrence for '{cron}' in '{timezone}': {err}"
                        ));
                    }
                }
            }
            Ok(due)
        }
    }
}

/// Compute the next trigger instant after `now`.
pub fn next_occurrence(
    trigger: &RoutineTrigger,
    now: &DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    match trigger {
        RoutineTrigger::OneTime { at } => {
            let at_time = parse_trigger_time(at)?;
            Ok((at_time > *now).then_some(at_time))
        }
        RoutineTrigger::Cron { cron, timezone } => {
            let parsed = croner::Cron::new(cron)
                .parse()
                .map_err(|err| format!("invalid cron expression '{cron}': {err}"))?;
            let timezone = parse_timezone(timezone)?;
            let local_now = now.with_timezone(&timezone);
            let next = parsed
                .find_next_occurrence(&local_now, false)
                .map_err(|err| {
                    format!("compute next occurrence for '{cron}' in '{timezone}': {err}")
                })?;
            Ok(Some(next.with_timezone(&Utc)))
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

    #[test]
    fn cron_uses_the_declared_timezone() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "America/Vancouver".to_string(),
        };
        let now = at(2026, 8, 8, 17, 0);
        let next = next_occurrence(&trigger, &now).unwrap().unwrap();
        assert_eq!(next, at(2026, 8, 9, 16, 0));
    }

    #[test]
    fn cron_due_window_is_compared_in_the_declared_timezone() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "Asia/Shanghai".to_string(),
        };
        let due = due_times(&trigger, &at(2026, 8, 8, 0, 0), &at(2026, 8, 8, 2, 0)).unwrap();
        assert_eq!(due, vec![at(2026, 8, 8, 1, 0)]);
    }

    #[test]
    fn legacy_cron_without_timezone_defaults_to_utc() {
        let trigger: RoutineTrigger =
            serde_json::from_str(r#"{"kind":"cron","cron":"0 9 * * *"}"#).unwrap();
        assert_eq!(
            trigger,
            RoutineTrigger::Cron {
                cron: "0 9 * * *".to_string(),
                timezone: "UTC".to_string(),
            }
        );
    }

    #[test]
    fn invalid_timezone_is_rejected() {
        let trigger = RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "Mars/Olympus".to_string(),
        };
        assert!(next_occurrence(&trigger, &Utc::now())
            .unwrap_err()
            .contains("invalid routine timezone"));
    }
}
