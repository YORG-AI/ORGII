//! SQLite-backed IO for projects, labels, milestones, and members.
//!
//! The store is global: every project / work item / label / milestone /
//! member lives in `~/.orgii/projects/projects.db` and is identified by
//! its row ID, not by a filesystem location.

mod assets;
mod git_folder_sync;
pub(crate) mod helpers;
mod labels;
mod members;
mod milestones;
mod orgs;
mod projects;
pub mod repo_resolver;
mod routines;
mod work_items;

pub use assets::{delete_asset, list_assets, resolve_asset_path, save_asset};
pub use git_folder_sync::{resolve_project_org_git_folder_conflict, sync_project_org_git_folder};
pub use labels::{read_labels, write_labels};
pub use members::{
    member_id_from_email, read_members, sync_members_from_git, write_members, SyncMembersResult,
};
pub use milestones::{read_milestones, write_milestones};
pub use orgs::{
    configure_project_org_collab_sync, configure_project_org_git_folder_sync, create_project_org,
    delete_project_org, read_project_org, read_project_orgs, resolve_local_org_scope,
};
pub use projects::{
    delete_project, derive_work_item_prefix, move_project_to_org,
    normalize_custom_work_item_prefix, read_all_projects, read_all_projects_scoped, read_project,
    read_project_scoped, write_project,
};
pub(crate) use projects::{
    read_project_field_revisions, write_project_remote, PROJECT_SYNC_FIELDS,
};
pub use routines::{
    create_routine_fire, create_routine_fire_for_policy, create_routine_fire_for_policy_with_key,
    delete_routine, disable_routine, find_started_fire_by_session, find_started_fire_by_work_item,
    list_enabled_routines, list_routine_fires, list_routines, mark_routine_fire_failed,
    mark_routine_fire_started, mark_routine_fire_succeeded, mark_routine_fire_work_item_created,
    mark_routine_fire_work_item_started, read_pm_change_seq, read_routine,
    reconcile_terminal_dispatch_fires, take_next_queued_fire, update_routine_schedule_marks,
    upsert_routine,
};
pub use work_items::orchestrator_view;
pub use work_items::{
    acquire_execution_lock, allocate_short_id, allocate_standalone_short_id, apply_remote_merge,
    batch_delete_work_items, batch_update_work_items, delete_work_item, find_by_external_ref,
    move_work_item, purge_expired_deleted_work_items, read_all_work_items,
    read_all_work_items_enriched, read_all_work_items_enriched_scoped,
    read_all_work_items_enriched_scoped_filtered, read_all_work_items_scoped,
    read_all_work_items_scoped_filtered, read_scheduled_work_item_candidates,
    read_standalone_work_item, read_standalone_work_items, read_standalone_work_items_filtered,
    read_sync_metadata, read_work_item, read_work_item_by_row_id, read_work_item_enriched,
    read_work_item_enriched_scoped, read_work_item_scoped, read_work_items_view_data,
    read_work_items_view_data_scoped, read_work_items_view_data_scoped_for_view,
    read_workspace_work_items_data, release_execution_lock, restore_work_item,
    transition_standalone_work_item_handoff, transition_work_item_handoff,
    update_standalone_work_item_atomic, update_standalone_work_item_atomic_by,
    update_standalone_work_item_atomic_serviced, update_standalone_work_item_partial,
    update_work_item_atomic, update_work_item_atomic_serviced,
    update_work_item_atomic_with_revisions, update_work_item_partial,
    update_work_item_partial_enriched, update_work_item_partial_with_revisions,
    write_standalone_work_item, write_work_item, AtomicServiceOptions, FieldRevision, SyncMetadata,
    REVISION_SOURCE_LOCAL,
};
pub(crate) use work_items::{
    allocate_short_id_in_tx, apply_execution_claim, resolve_project_scope_in_tx,
    write_work_item_in_tx,
};
pub(crate) use work_items::{purge_work_item, write_work_item_remote};
pub(crate) use work_items::{
    read_standalone_sync_metadata, update_standalone_work_item_partial_with_revisions,
};
