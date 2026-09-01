//! `PromptSection` trait implementations.
//!
//! Each section is a zero-sized marker struct. Per-call state flows through
//! `PromptCtx`. Ordering, sovereign-safety, and gating are declared on the
//! trait impl so a contributor can read one block and see the full policy.
//!
//! String builders for section content live in `section_builders`.
//!
//! The impls are split across the `sections/` submodules below and re-exported
//! here, so `prompt::sections::<name>` keeps resolving for every caller.

mod coordination;
mod execution_safety;
mod identity_and_environment;
mod rules_and_memory;
mod session_state;

pub use identity_and_environment::{
    AvailableToolsSection, EnvironmentSection, IdentitySection, McpInstructionsSection,
    ModelIdentitySection, SystemMetaSection,
};

pub use rules_and_memory::{
    AlwaysSkillsSection, BehavioralRulesSection, LearningsSection, ProjectConventionsSection,
    RulesSection, WorkspaceMemoryProtocolSection,
};

pub use coordination::{
    AgentOrgContextSection, AtcSection, MessagingSection, SilentRepliesSection,
    SubAgentDelegationSection, TaskRoutingSection,
};

pub use execution_safety::{CommandApprovalSection, FunctionResultClearingSection};

pub use session_state::{
    AgentModeSuffixSection, FlowAwarenessSection, IdeContextSection, RuntimeLineSection,
    UserPresenceSection, UserProfileSection,
};

pub use super::section_builders::build_agent_org_context_section;
pub(crate) use super::section_builders::build_agent_org_context_section_with_task_snapshot;
