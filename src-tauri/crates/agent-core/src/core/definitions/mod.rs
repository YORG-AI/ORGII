//! Agent definitions and organizations.
//!
//! # Modules
//!
//! - **capabilities**: Composable capability types (gateway, coding, desktop, browser, plugins, management)
//! - **schema**: `AgentDefinition` struct and supporting field types
//! - **store**: In-memory store + disk persistence for user-created agents
//! - **builtin/**: Built-in agent templates (base, os, sde, wingman, subagents, memory workers)
//! - **resolver**: Template inheritance resolver
//! - **orgs**: Agent organizations / team hierarchies
//! - **commands**: Tauri commands for agent definition and org CRUD
//!
//! # Architecture
//!
//! All agents are instances of `AgentDefinition`. Builtin agents are defined
//! in Rust code, custom agents are stored in `~/.orgii/agent-definitions.json`.
//!
//! ```text
//! builtin:base (root template)
//!     ├── builtin:os (desktop automation)
//!     ├── builtin:sde (coding assistant)
//!     ├── builtin:wingman (desktop co-pilot)
//!     ├── subagents (explore, general)
//!     └── memory workers (extractor, consolidator)
//! ```
//!
//! # Template Inheritance
//!
//! Agents can inherit from other agents via the `inherits_from` field.
//! Use `resolver::resolve_definition()` to get a fully merged definition.

pub mod builtin;
pub mod capabilities;
pub mod commands;
pub mod learnings_lookup;
pub mod orgs;
pub mod patch;
pub mod prefix_lookup;
pub mod resolved;
pub mod resolver;
pub mod schema;
pub mod store;

// Items kept at the `definitions::` surface — checked one by one against
// real call sites. Anything else (`builtin::*`, `capabilities::*`,
// `commands::*`, `orgs::*`, `learnings_lookup::*`, `patch::*`,
// `resolved::*`, the rest of `schema::*`, and the rest of `store::*`) is
// either consumed via the explicit submodule path or registered through
// the deep `definitions::commands::*` Tauri handler list, so flat
// re-exports for those would be dead surface.
pub use learnings_lookup::resolve_learnings_for;
pub use resolved::{ResolvedAgent, SkillsParams};
pub use resolver::resolve_definition_by_id;
pub use schema::{
    AgentDefinition, AgentLearningsConfig, AgentPolicy, AgentSkillsConfig, AgentTier,
    AgentToolSelection, DelegationConfig, SessionMode, SessionModel, SubAgentRef,
};
pub use store::{definitions_store, set_definitions_changed_hook, AgentDefinitionsStore};
// Per-builtin entry points reached as `definitions::{os_agent, OS_AGENT_ID,
// sde_agent, SDE_AGENT_ID, wingman_agent}` from session-launch and test
// fixtures. Other builtin items (memory_consolidator/extractor,
// subagents, base) are consumed via the deeper `definitions::builtin::*`
// path, so we deliberately don't flatten the whole `builtin::*` set.
pub use builtin::{
    ai_research_agent, os_agent, sde_agent, wingman_agent, AI_RESEARCH_AGENT_ID, OS_AGENT_ID,
    SDE_AGENT_ID,
};
pub use capabilities::CapabilitySet;
