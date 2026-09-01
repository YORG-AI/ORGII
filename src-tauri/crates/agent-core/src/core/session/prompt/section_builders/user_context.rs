//! User profile and user presence rendering, including the compact presence
//! stance used by prompt surfaces without the full section pipeline.

// ============================================
// User profile helpers
// ============================================

pub(crate) fn user_profile_is_empty(profile: &crate::session::UserProfile) -> bool {
    profile
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
        && profile
            .tech_savvy
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        && profile.job_roles.is_empty()
        && profile.familiar_tech_stacks.is_empty()
        && profile
            .description
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
}

pub(crate) fn format_user_profile(profile: &crate::session::UserProfile) -> String {
    let mut lines = Vec::with_capacity(8);
    lines.push("# User Profile".to_string());
    lines.push(String::new());
    lines.push(
        "Use this profile to calibrate explanation depth, examples, assumptions, and terminology."
            .to_string(),
    );

    if let Some(ref name) = profile.name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            lines.push(format!("- Active profile: {}", trimmed));
        }
    }

    if let Some(ref tech_savvy) = profile.tech_savvy {
        let trimmed = tech_savvy.trim();
        if !trimmed.is_empty() {
            lines.push(format!("- Technical familiarity: {}", trimmed));
        }
    }

    if !profile.job_roles.is_empty() {
        lines.push(format!("- Job roles: {}", profile.job_roles.join(", ")));
    }

    if !profile.familiar_tech_stacks.is_empty() {
        lines.push(format!(
            "- Familiar languages / tech stacks: {}",
            profile.familiar_tech_stacks.join(", ")
        ));
    }

    if let Some(ref description) = profile.description {
        let trimmed = description.trim();
        if !trimmed.is_empty() {
            lines.push(format!("- About the user: {}", trimmed));
        }
    }

    lines.join("\n")
}

pub(crate) fn format_user_presence(presence: &crate::session::UserPresence) -> String {
    use crate::interaction::presence_policy::PresencePolicy;
    use crate::session::PresenceStance;

    let policy = PresencePolicy::resolve(presence);
    let label = presence.display_label();

    let mut lines = Vec::with_capacity(12);
    lines.push("# User Presence".to_string());
    lines.push(String::new());
    lines.push(format!("Current status: **{}**", label));

    if let Some(ref back_at) = presence.back_at {
        if !back_at.is_empty() {
            lines.push(format!("Expected to be back at: {}", back_at));
        }
    }

    lines.push(String::new());
    let stance_contract = match policy.prompt_stance {
        PresenceStance::Interactive => {
            "The user is actively watching this session. Feel free to ask clarifying \
             questions at any time, and confirm destructive or irreversible actions \
             with the user before running them."
        }
        PresenceStance::DeferAndBatch => {
            "The user has stepped away. Do all low-risk work first and do not block on \
             them: batch any questions into a single summary at the end instead of \
             asking one by one. Hold genuinely irreversible actions (pushes, deletions, \
             messages to other people) until they are back; everything else should keep \
             moving. Never idle waiting for a reply."
        }
        PresenceStance::Autonomous => {
            "The user is not watching. Do NOT call ask_user_questions and do NOT wait \
             for confirmations — make low-risk decisions yourself and list every \
             autonomous decision in your final summary. Before ending a turn, check \
             whether the user's original goal is fully achieved; if not, continue \
             working instead of wrapping up. Only stop for genuinely irreversible \
             high-risk actions, and leave a note explaining what you need. The system \
             auto-resolves blocking prompts after a grace period, but do not rely on \
             it — avoid creating them."
        }
    };
    lines.push(stance_contract.to_string());

    if let Some(ref guidance) = presence.guidance {
        let trimmed = guidance.trim();
        if !trimmed.is_empty() {
            lines.push(String::new());
            lines.push("User's guidance for this mode:".to_string());
            lines.push(trimmed.to_string());
        }
    }

    lines.join("\n")
}

/// Compact one-line presence stance for instances without the full
/// system-prompt pipeline (subagent spawn prompts, CLI message prefixes).
/// Subagents already cannot call `ask_user_questions`; this just sets the
/// decision-making expectation.
pub fn format_user_presence_compact(presence: &crate::session::UserPresence) -> Option<String> {
    use crate::interaction::presence_policy::PresencePolicy;
    use crate::session::PresenceStance;

    let policy = PresencePolicy::resolve(presence);
    let label = presence.display_label();
    match policy.prompt_stance {
        PresenceStance::Interactive => None,
        PresenceStance::DeferAndBatch => Some(format!(
            "User presence: \"{}\" — the user has stepped away. Work autonomously, \
             make reasonable decisions yourself, and list them in your report.",
            label
        )),
        PresenceStance::Autonomous => Some(format!(
            "User presence: \"{}\" — the user is not watching. Never wait for user \
             input; make every decision autonomously and list each one in your report.",
            label
        )),
    }
}
