//! Work application service (`orgtrack/v1` Phase 2a).
//!
//! Single business layer above the atomic store choke point. Every entry
//! point (Tauri commands, agent tools, the PM CLI, schedulers, and sync
//! adapters) is expected to mutate work items through here.
//!
//! Error contract: typed sentinels with the `PM_ERR:` prefix
//! ([`error::REVISION_CONFLICT`], [`error::INVALID_TRANSITION`]) let upper
//! layers map failures onto stable wire error codes without string guessing.

pub mod audit;
mod bootstrap;
mod creation;
pub mod error;
mod idempotency;
mod lifecycle;
mod mutation;
mod notes;
mod relations;
mod run_review;
pub mod state;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
pub mod tests_support;

pub use bootstrap::bootstrap_root_standalone_item;
pub(crate) use creation::{build_frontmatter_for_graph, guard_new_work_item_id_in_tx};
pub use creation::{
    create_project_work_item, create_standalone_work_item, read_project_work_item_revision,
    CreateWorkItemRequest,
};
pub use idempotency::{run_idempotent, IdempotencyOutcome};
pub use lifecycle::{
    claim_project_work_item, claim_standalone_work_item, release_project_work_item,
    transition_project_work_item, transition_project_work_item_scoped,
    transition_standalone_work_item,
};
pub use mutation::{
    assign_project_work_item, overwrite_project_work_item, overwrite_standalone_work_item,
    patch_project_work_item, patch_standalone_work_item,
};
pub use notes::{
    note_project_work_item, note_project_work_item_idempotent, note_project_work_item_threaded,
    note_standalone_work_item, note_standalone_work_item_idempotent,
    note_standalone_work_item_threaded, work_item_noted_by_actor_since,
};
pub use relations::{list_work_item_relations, relate_project_work_item};
pub use run_review::{project_run_success_to_review, RunSuccessReviewProjection};
pub use state::WorkItemState;
