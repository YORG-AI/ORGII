//! Per-agent inbox drain hook for the unified turn processor.
//!
//! See [`drain_and_render_deferred`] for the production entry point and
//! [`hooks`] / [`render`] sub-modules for the shutdown hook trait and
//! attachment XML renderer respectively.

pub mod hooks;
pub(super) mod render;

pub(super) mod drain;
mod guard;
mod routing;

#[cfg(test)]
pub use hooks::MemberShutdownHookGuard;
pub use hooks::{install_member_shutdown_hook, MemberShutdownHook, NoopMemberShutdownHook};

pub use drain::drain_and_render_deferred;
pub use guard::DrainGuard;

#[cfg(test)]
pub use drain::drain_and_render;

// Implementation lives in focused submodules:
//   guard.rs   — DrainGuard struct and its impl
//   routing.rs — resolve_recipient_member_id, resolve_sender_member
//   drain.rs   — drain_and_render_deferred and typed inbox side effects
//   tests.rs   — #[cfg(test)] mod tests for this module's public entry points

// These imports are not used in mod.rs itself — they are brought in solely
// so the `mod tests` child module can access them via `use super::*`.
#[cfg(test)]
use crate::coordination::agent_inbox::{
    AgentInboxStore, AgentMessage, SYSTEM_SENDER_ID, USER_SENDER_ID,
};
#[cfg(test)]
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

#[cfg(test)]
mod tests;
