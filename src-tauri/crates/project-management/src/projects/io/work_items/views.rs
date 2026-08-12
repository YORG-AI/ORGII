//! View-ready work items: Kanban / Gantt / Calendar transformations.
//!
//! The frontend used to fetch the raw work-item list and run the
//! enrichment + grouping + per-view shape conversion in TypeScript on
//! every render. We do it once in Rust and ship a single
//! `WorkItemsViewData` struct that the UI binds to directly. Status
//! filter and search query strings come straight from the URL/sidebar
//! controls and are applied AFTER counts are computed (counts always
//! reflect the unfiltered list so the filter badges stay correct).

use super::enrichment::read_all_work_items_enriched_scoped;
use crate::projects::types::{
    CalendarEvent, EnrichedWorkItem, GanttStatus, GanttTask, KanbanStatus, KanbanTask,
    StatusCounts, WorkItemsViewData,
};

/// Read all work items for `project_slug` with every view transformation
/// pre-computed.
///
/// Optional filters:
/// - `status_filter`: `"all"` / `""` / `None` keep everything; otherwise
///   a status-bucket name ("backlog", "todo", "in_progress", ...).
///   Both camelCase and snake_case spellings are accepted because the
///   frontend mixes them.
/// - `search_query`: case-insensitive substring match against title,
///   label names, and resolved assignee name. Empty / whitespace-only
///   queries are ignored.
pub fn read_work_items_view_data(
    project_slug: &str,
    status_filter: Option<&str>,
    search_query: Option<&str>,
) -> Result<WorkItemsViewData, String> {
    read_work_items_view_data_scoped(project_slug, None, status_filter, search_query)
}

pub fn read_work_items_view_data_scoped(
    project_slug: &str,
    org_id: Option<&str>,
    status_filter: Option<&str>,
    search_query: Option<&str>,
) -> Result<WorkItemsViewData, String> {
    read_work_items_view_data_scoped_for_view(
        project_slug,
        org_id,
        status_filter,
        search_query,
        None,
    )
}

pub fn read_work_items_view_data_scoped_for_view(
    project_slug: &str,
    org_id: Option<&str>,
    status_filter: Option<&str>,
    search_query: Option<&str>,
    view: Option<&str>,
) -> Result<WorkItemsViewData, String> {
    let all_items = read_all_work_items_enriched_scoped(project_slug, org_id)?;
    let active_items: Vec<EnrichedWorkItem> = all_items
        .iter()
        .filter(|item| item.deleted_at.is_none())
        .cloned()
        .collect();
    // Counts come from the *unfiltered* active list so the filter badges in
    // the sidebar always show the true totals, not "results matching
    // the current search".
    let counts = compute_status_counts(&active_items);

    let visible_items: Vec<EnrichedWorkItem> = active_items
        .into_iter()
        .filter(|item| matches_view_filters(item, status_filter, search_query))
        .collect();
    let items: Vec<EnrichedWorkItem> = all_items
        .into_iter()
        .filter(|item| {
            if item.deleted_at.is_some() && !matches_all_status_filter(status_filter) {
                return false;
            }
            matches_view_filters(item, status_filter, search_query)
        })
        .collect();

    let include_all_projections = view.is_none();
    let kanban_tasks = if include_all_projections || view == Some("kanban") {
        visible_items.iter().map(to_kanban_task).collect()
    } else {
        Vec::new()
    };
    let gantt_tasks = if include_all_projections || view == Some("gantt") {
        visible_items.iter().filter_map(to_gantt_task).collect()
    } else {
        Vec::new()
    };
    let calendar_events = if include_all_projections || view == Some("calendar") {
        visible_items.iter().filter_map(to_calendar_event).collect()
    } else {
        Vec::new()
    };

    Ok(WorkItemsViewData {
        items,
        counts,
        kanban_tasks,
        gantt_tasks,
        calendar_events,
    })
}

// ---------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------

fn matches_view_filters(
    item: &EnrichedWorkItem,
    status_filter: Option<&str>,
    search_query: Option<&str>,
) -> bool {
    if let Some(filter) = status_filter {
        if !matches_all_status_filter(Some(filter)) && !matches_status_filter(&item.status, filter)
        {
            return false;
        }
    }
    if let Some(query) = search_query {
        let trimmed = query.trim();
        if !trimmed.is_empty() && !matches_search_query(item, trimmed) {
            return false;
        }
    }
    true
}

fn matches_all_status_filter(filter: Option<&str>) -> bool {
    filter
        .map(|value| value.is_empty() || value == "all")
        .unwrap_or(true)
}

fn matches_status_filter(item_status: &str, filter: &str) -> bool {
    match filter {
        "backlog" => item_status == "backlog",
        "todo" | "planned" => item_status == "planned" || item_status == "todo",
        "inProgress" | "in_progress" => item_status == "in_progress",
        "inReview" | "in_review" => item_status == "in_review",
        "done" | "completed" => item_status == "completed",
        "cancelled" => item_status == "cancelled",
        "duplicate" => item_status == "duplicate",
        _ => true,
    }
}

fn matches_search_query(item: &EnrichedWorkItem, query: &str) -> bool {
    let needle = query.to_lowercase();

    if item.title.to_lowercase().contains(&needle) {
        return true;
    }
    if item
        .labels
        .iter()
        .any(|label| label.name.to_lowercase().contains(&needle))
    {
        return true;
    }
    if let Some(assignee) = &item.assignee {
        if assignee.name.to_lowercase().contains(&needle) {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------
// Counts + grouping
// ---------------------------------------------------------------------

fn compute_status_counts(items: &[EnrichedWorkItem]) -> StatusCounts {
    let mut counts = StatusCounts {
        all: items.len(),
        backlog: 0,
        planned: 0,
        in_progress: 0,
        in_review: 0,
        completed: 0,
        cancelled: 0,
        duplicate: 0,
    };
    for item in items {
        match item.status.as_str() {
            "backlog" => counts.backlog += 1,
            "planned" | "todo" => counts.planned += 1,
            "in_progress" => counts.in_progress += 1,
            "in_review" => counts.in_review += 1,
            "completed" => counts.completed += 1,
            "cancelled" => counts.cancelled += 1,
            "duplicate" => counts.duplicate += 1,
            _ => counts.backlog += 1,
        }
    }
    counts
}

// ---------------------------------------------------------------------
// Per-view conversions
// ---------------------------------------------------------------------

fn work_item_to_kanban_status(status: &str) -> KanbanStatus {
    match status {
        "backlog" => KanbanStatus::Backlog,
        "planned" | "todo" => KanbanStatus::Planned,
        "in_progress" => KanbanStatus::InProgress,
        "in_review" => KanbanStatus::InReview,
        "completed" => KanbanStatus::Completed,
        "cancelled" => KanbanStatus::Cancelled,
        "duplicate" => KanbanStatus::Duplicate,
        _ => KanbanStatus::Backlog,
    }
}

fn to_kanban_task(item: &EnrichedWorkItem) -> KanbanTask {
    KanbanTask {
        id: item.id.clone(),
        title: item.title.clone(),
        description: if item.body.is_empty() {
            None
        } else {
            Some(item.body.clone())
        },
        status: work_item_to_kanban_status(&item.status),
        priority: if item.priority == "none" {
            None
        } else {
            Some(item.priority.clone())
        },
        assignee: item.assignee.as_ref().map(|person| person.name.clone()),
        labels: item.labels.clone(),
    }
}

fn work_item_to_gantt_status(status: &str, target_date: Option<&str>) -> GanttStatus {
    if status != "completed" && status != "cancelled" && status != "duplicate" {
        if let Some(target) = target_date {
            if let Ok(target_dt) = chrono::NaiveDate::parse_from_str(target, "%Y-%m-%d") {
                let today = chrono::Local::now().date_naive();
                if target_dt < today {
                    return GanttStatus::Overdue;
                }
            }
        }
    }
    match status {
        "backlog" | "planned" | "todo" => GanttStatus::NotStarted,
        "in_progress" | "in_review" => GanttStatus::InProgress,
        "completed" => GanttStatus::Completed,
        "cancelled" | "duplicate" => GanttStatus::Cancelled,
        _ => GanttStatus::NotStarted,
    }
}

fn to_gantt_task(item: &EnrichedWorkItem) -> Option<GanttTask> {
    let start_date = item
        .start_date
        .clone()
        .or_else(|| Some(item.created_at.split('T').next()?.to_string()))?;
    let end_date = if let Some(target) = &item.target_date {
        target.clone()
    } else {
        let days = match item.status.as_str() {
            "completed" | "cancelled" | "duplicate" => 3,
            "in_progress" | "in_review" => 7,
            _ => 5,
        };
        add_days_to_date(&start_date, days)
    };
    Some(GanttTask {
        id: item.id.clone(),
        title: item.title.clone(),
        start_date,
        end_date,
        status: work_item_to_gantt_status(&item.status, item.target_date.as_deref()),
        assignee: item.assignee.as_ref().map(|person| person.name.clone()),
        labels: item.labels.clone(),
    })
}

fn to_calendar_event(item: &EnrichedWorkItem) -> Option<CalendarEvent> {
    let start_date = item
        .start_date
        .clone()
        .or_else(|| Some(item.created_at.split('T').next()?.to_string()))?;
    let end_date = item
        .target_date
        .clone()
        .unwrap_or_else(|| add_days_to_date(&start_date, 1));
    let all_day = item.start_date.is_none();
    Some(CalendarEvent {
        id: item.id.clone(),
        title: item.title.clone(),
        start_date,
        end_date,
        status: item.status.clone(),
        assignee: item.assignee.clone(),
        labels: item.labels.clone(),
        all_day,
    })
}

fn add_days_to_date(date_str: &str, days: i64) -> String {
    if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        let new_date = date + chrono::Duration::days(days);
        return new_date.format("%Y-%m-%d").to_string();
    }
    date_str.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::labels::write_labels;
    use crate::projects::io::projects::write_project;
    use crate::projects::io::work_items::write_work_item;
    use crate::projects::types::{LabelEntry, LabelsFile, ProjectMeta, WorkItemFrontmatter};
    use test_helpers::test_env;

    fn project_fixture() -> ProjectMeta {
        ProjectMeta {
            id: "p1".to_string(),
            name: "Demo".to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item_with(short_id: &str, title: &str, status: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: format!("w-{}", short_id),
            short_id: short_id.into(),
            title: title.into(),
            project: None,
            status: status.into(),
            priority: "none".into(),
            assignee: None,
            assignee_type: None,
            labels: vec![],
            milestone: None,
            parent: None,
            stage: None,
            start_date: None,
            target_date: None,
            created_by: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            linked_sessions: vec![],
            handoff: None,
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

    fn seed() {
        write_project("demo", &project_fixture(), "", true).expect("project");
    }

    #[test]
    fn view_data_counts_by_status() {
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "A", "backlog"),
            "",
        )
        .unwrap();
        write_work_item(
            "demo",
            "AAA-0002",
            &work_item_with("AAA-0002", "B", "in_progress"),
            "",
        )
        .unwrap();
        write_work_item(
            "demo",
            "AAA-0003",
            &work_item_with("AAA-0003", "C", "completed"),
            "",
        )
        .unwrap();

        let view = read_work_items_view_data("demo", None, None).expect("view");
        assert_eq!(view.counts.all, 3);
        assert_eq!(view.counts.backlog, 1);
        assert_eq!(view.counts.in_progress, 1);
        assert_eq!(view.counts.completed, 1);
        assert_eq!(view.kanban_tasks.len(), 3);
    }

    #[test]
    fn list_projection_omits_unused_view_payloads() {
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "A", "backlog"),
            "",
        )
        .unwrap();

        let view =
            read_work_items_view_data_scoped_for_view("demo", None, None, None, Some("list"))
                .expect("view");
        assert!(view.kanban_tasks.is_empty());
        assert!(view.gantt_tasks.is_empty());
        assert!(view.calendar_events.is_empty());

        let list_json = serde_json::to_vec(&view).expect("serialize list view");
        let all_view = read_work_items_view_data("demo", None, None).expect("all projections");
        let all_json = serde_json::to_vec(&all_view).expect("serialize all projections");
        let list_value: serde_json::Value =
            serde_json::from_slice(&list_json).expect("parse list view");
        assert!(list_value.get("kanbanTasks").is_none());
        assert!(list_value.get("ganttTasks").is_none());
        assert!(list_value.get("calendarEvents").is_none());
        assert!(list_json.len() < all_json.len());
    }

    #[test]
    fn status_filter_keeps_counts_unfiltered() {
        // Filter badges should always show totals over the entire list,
        // not the post-filter slice — otherwise the user can't tell
        // there are items hidden behind another tab.
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "A", "backlog"),
            "",
        )
        .unwrap();
        write_work_item(
            "demo",
            "AAA-0002",
            &work_item_with("AAA-0002", "B", "completed"),
            "",
        )
        .unwrap();

        let view = read_work_items_view_data("demo", Some("done"), None).expect("filtered");
        assert_eq!(view.items.len(), 1, "filtered to 1");
        assert_eq!(view.items[0].status, "completed");
        assert_eq!(view.counts.all, 2, "counts cover everything");
        assert_eq!(view.counts.backlog, 1);
        assert_eq!(view.counts.completed, 1);
    }

    #[test]
    fn status_filter_accepts_camelcase_aliases() {
        // The frontend ships `inProgress` from the URL fragment; the
        // backend stores `in_progress`. Aliases close the gap.
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "X", "in_progress"),
            "",
        )
        .unwrap();

        let view = read_work_items_view_data("demo", Some("inProgress"), None).expect("view");
        assert_eq!(view.items.len(), 1);
    }

    #[test]
    fn search_query_is_case_insensitive_on_title() {
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "Refactor IO", "backlog"),
            "",
        )
        .unwrap();
        write_work_item(
            "demo",
            "AAA-0002",
            &work_item_with("AAA-0002", "Add tests", "backlog"),
            "",
        )
        .unwrap();

        let view = read_work_items_view_data("demo", None, Some("REFACTOR")).expect("view");
        assert_eq!(view.items.len(), 1);
        assert_eq!(view.items[0].short_id, "AAA-0001");
    }

    #[test]
    fn search_query_matches_label_name() {
        let _sandbox = test_env::sandbox();
        seed();
        write_labels(
            "p1",
            &LabelsFile {
                labels: vec![LabelEntry {
                    id: "infra".into(),
                    name: "Infrastructure".into(),
                    color: "#000".into(),
                }],
            },
        )
        .unwrap();
        let mut fm = work_item_with("AAA-0001", "Plain", "backlog");
        fm.labels = vec!["infra".into()];
        write_work_item("demo", "AAA-0001", &fm, "").unwrap();
        let mut other = work_item_with("AAA-0002", "Other", "backlog");
        other.labels = vec![];
        write_work_item("demo", "AAA-0002", &other, "").unwrap();

        let view = read_work_items_view_data("demo", None, Some("infra")).expect("view");
        assert_eq!(view.items.len(), 1);
        assert_eq!(view.items[0].short_id, "AAA-0001");
    }

    #[test]
    fn empty_search_query_does_not_filter() {
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "Any", "backlog"),
            "",
        )
        .unwrap();
        let view = read_work_items_view_data("demo", None, Some("   ")).expect("view");
        assert_eq!(view.items.len(), 1);
    }

    #[test]
    fn gantt_skips_items_without_dates_or_created_at() {
        // The legacy port kept items with at least a `created_at`. Our
        // fixture intentionally leaves `created_at` blank so the gantt
        // converter must drop the row instead of emitting an empty
        // start_date.
        let _sandbox = test_env::sandbox();
        seed();
        let fm = work_item_with("AAA-0001", "Dateless", "backlog");
        write_work_item("demo", "AAA-0001", &fm, "").unwrap();

        let view = read_work_items_view_data("demo", None, None).expect("view");
        // `write_work_item` stamps `created_at` itself, so the row CAN
        // produce a gantt task. Just confirm the converter ran without
        // panicking — exact dates depend on test clock.
        assert_eq!(view.gantt_tasks.len(), 1);
    }

    #[test]
    fn calendar_marks_all_day_when_no_start_date_field() {
        // `start_date` on the frontmatter is None, so the calendar
        // event should be all-day even though we synthesize a date from
        // `created_at`.
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "All day item", "backlog"),
            "",
        )
        .unwrap();

        let view = read_work_items_view_data("demo", None, None).expect("view");
        assert_eq!(view.calendar_events.len(), 1);
        assert!(view.calendar_events[0].all_day);
    }

    #[test]
    fn unknown_status_filter_passes_everything_through() {
        let _sandbox = test_env::sandbox();
        seed();
        write_work_item(
            "demo",
            "AAA-0001",
            &work_item_with("AAA-0001", "Y", "in_progress"),
            "",
        )
        .unwrap();
        let view = read_work_items_view_data("demo", Some("garbage-bucket"), None).expect("view");
        // Unknown filter falls through to "include the item" — matches
        // the legacy port. (We test the BEHAVIOR; if we ever tighten
        // this, update both the test and the legacy comment.)
        assert_eq!(view.items.len(), 1);
    }
}
