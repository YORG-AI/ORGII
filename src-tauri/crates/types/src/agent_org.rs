//! Shared Agent Org (Team) identity constants.

/// Reserved member id of the Team coordinator.
///
/// The coordinator is not part of `members`; this id addresses it in task
/// ownership, inbox routing, and plan-approval flows. Definition and
/// snapshot validators reject `members` entries that claim this id.
///
/// Single source of truth for both the definitions store
/// (`agent-core::core::definitions::orgs`) and the run coordination layer
/// (`agent-core::core::coordination::agent_org_runs`).
pub const COORDINATOR_MEMBER_ID: &str = "coordinator";
