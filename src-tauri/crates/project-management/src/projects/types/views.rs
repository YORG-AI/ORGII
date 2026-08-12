//! View-ready types for Kanban, Gantt, and Calendar.

use serde::{Deserialize, Serialize};

use super::enriched::{EnrichedWorkItem, ResolvedLabel, ResolvedPerson};
use super::project::{ProjectData, ProjectOrg};
use super::work_items::WorkItemData;

// ============================================
// View-Ready Types (for Kanban, Gantt, Calendar)
// ============================================

/// Kanban task status (maps from WorkItemStatus)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KanbanStatus {
    Backlog,
    Planned,
    InProgress,
    InReview,
    Completed,
    Cancelled,
    Duplicate,
}

/// Kanban task for board view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTask {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: KanbanStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub labels: Vec<ResolvedLabel>,
}

/// Gantt task status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GanttStatus {
    NotStarted,
    InProgress,
    Completed,
    Overdue,
    Cancelled,
}

/// Gantt task for timeline view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GanttTask {
    pub id: String,
    pub title: String,
    /// ISO 8601 date string
    pub start_date: String,
    /// ISO 8601 date string
    pub end_date: String,
    pub status: GanttStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub labels: Vec<ResolvedLabel>,
}

/// Calendar event for calendar view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    /// ISO 8601 date string
    pub start_date: String,
    /// ISO 8601 date string
    pub end_date: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<ResolvedPerson>,
    pub labels: Vec<ResolvedLabel>,
    pub all_day: bool,
}

/// Status counts for filter badges
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCounts {
    pub all: usize,
    pub backlog: usize,
    pub planned: usize,
    pub in_progress: usize,
    pub in_review: usize,
    pub completed: usize,
    pub cancelled: usize,
    pub duplicate: usize,
}

/// Work-items response with only the projection requested by the caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemsViewData {
    /// All work items (enriched)
    pub items: Vec<EnrichedWorkItem>,
    /// Status filter counts
    pub counts: StatusCounts,
    /// Kanban-ready tasks
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kanban_tasks: Vec<KanbanTask>,
    /// Gantt-ready tasks
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gantt_tasks: Vec<GanttTask>,
    /// Calendar-ready events
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calendar_events: Vec<CalendarEvent>,
}

/// One project's metadata and its pre-enriched work items for the workspace
/// list. Keeping the project beside the rows removes the frontend's N-command
/// project fan-out while preserving the same wire shapes used elsewhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectWorkItems {
    pub project: ProjectData,
    pub work_items: Vec<EnrichedWorkItem>,
}

/// A standalone work item and the organization scope that owns it.
///
/// Standalone short IDs are allocated per organization, so workspace-level
/// callers must keep the scope beside the row instead of assigning a default
/// organization after deserialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStandaloneWorkItem {
    pub org_id: String,
    pub work_item: WorkItemData,
}

/// Complete local dataset needed by the workspace work-items surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorkItemsData {
    pub project_entries: Vec<WorkspaceProjectWorkItems>,
    pub standalone_work_items: Vec<WorkspaceStandaloneWorkItem>,
    pub orgs: Vec<ProjectOrg>,
}
