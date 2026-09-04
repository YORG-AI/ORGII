//! Work-routing guidance: when a request becomes a tracked work item and when
//! it should be handed to a delegate/shadow sub-agent.

use crate::tools::names as tool_names;

pub(crate) fn build_task_routing_section(include_pm_guidance: bool) -> String {
    let mut section = "## Task Routing\n\n\
     Not every request needs a work item. Work items exist for **tracking** — \
     if the user doesn't need to track it, handle it directly in conversation.\n\n\
     **Handle in conversation (no work item):**\n\
     - Questions, status checks, information lookups\n\
     - Agent/org management — use `manage_agent_def` directly\n\
     - Quick operations you can do with your own tools\n\
     - Casual requests (open app, search the web, run a command)\n\
     - Simple file edits (change a config value, update an env var)\n\n"
        .to_string();
    // Only Project sessions may mutate the work system; elsewhere the
    // create-a-work-item branch would point at a refused command.
    if include_pm_guidance {
        section.push_str(
            "**Create a work item (via `org2-pm work create`) when:**\n\
             - The task needs a full coding workflow (branch, tests, commit, PR)\n\
             - The user explicitly asks to track/schedule something\n\
             - The task requires long async execution the user wants to monitor\n\
             - The user's language implies a formal task (\"implement X\", \"fix the bug in Y\")\n\n\
             **When unsure**, ask the user.\n\n",
        );
    }
    section
        .push_str("**Never** treat status checks, polling, or follow-up questions as new tasks.\n");
    section
}

pub(crate) fn build_sub_agent_delegation_section() -> String {
    format!(
        "## Delegates and Shadows\n\n\
         Use the `{agent}` tool in `delegate` mode when the task should be handed to another explicit Agent whose \
         description matches the work. Use `shadow` mode when the current Agent should fork a self-copy / sidechain \
         for parallel work. Delegate/Shadow workers parallelize independent queries or scoped implementation tasks \
         and protect the main context window from excessive results. If an agent's description says it should be used \
         proactively, use it proactively without waiting for the user to ask. When multiple independent units of \
         work exist, launch multiple workers concurrently in a single message. \
         Importantly, avoid duplicating work that workers are already doing — if you delegate research to another Agent \
         or branch a Shadow for it, do not also perform the same searches yourself.\n\n\
         Broad research → use `{agent}` with `mode: \"delegate\"` and `agent_id: \"builtin:explore\"`, especially \
         for open-ended codebase exploration or anything likely to take more than ~3 search/read round-trips. \
         Parallel implementation → use `builtin:general` or `shadow` workers when write sets are isolated and the \
         acceptance criteria are clear; keep architecture choices, integration, and final review in the parent agent.\n\n\
         When NOT to delegate: reading one specific file, a single `{code_search}` query for a known \
         symbol/class/function, or a single `{list_dir}` listing — do those directly.\n",
        agent = tool_names::AGENT,
        code_search = tool_names::CODE_SEARCH,
        list_dir = tool_names::LIST_DIR,
    )
}
