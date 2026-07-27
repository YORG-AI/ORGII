//! Team Inbox read model for the global project store.
//!
//! The local project database currently contributes assigned Work Items. The
//! wire contract also reserves the comment-mention variant so cloud/session
//! comment sources can be merged by a higher layer without changing the DTO.

pub mod commands;
pub mod schema;
mod store;
mod types;

pub use store::{
    list_page, mark_all_read, mark_read, mark_unread, unread_count, TeamInboxListOptions,
};
pub use types::*;

#[cfg(test)]
mod tests;
