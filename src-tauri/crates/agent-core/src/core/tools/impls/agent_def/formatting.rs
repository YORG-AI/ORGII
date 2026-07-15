//! Formatting helpers for agent and org display strings.

use crate::definitions::orgs::{OrgDefinition, OrgMember};
use crate::definitions::AgentDefinition;

pub fn format_agent_summary(agent: &AgentDefinition) -> String {
    let mut line = format!("- **{}** (id: `{}`)", agent.name, agent.id);
    if let Some(ref desc) = agent.description {
        let preview: String = crate::utils::safe_truncate_chars_to_string(&desc, 80);
        if desc.chars().count() > 80 {
            line.push_str(&format!(": {}...", preview));
        } else {
            line.push_str(&format!(": {}", preview));
        }
    }
    if let Some(temp) = agent.temperature {
        line.push_str(&format!(", temperature={}", temp));
    }
    if let Some(ref subs) = agent.sub_agents {
        if !subs.is_empty() {
            let ids: Vec<&str> = subs.iter().map(|s| s.agent_id.as_str()).collect();
            line.push_str(&format!(", sub_agents: [{}]", ids.join(", ")));
        }
    }
    line
}

pub fn format_agent_detail(agent: &AgentDefinition) -> String {
    let mut out = format!("# Agent: {}\n\n", agent.name);
    out.push_str(&format!("- **ID:** `{}`\n", agent.id));
    out.push_str(&format!("- **Built-in:** {}\n", agent.built_in));
    if let Some(ref desc) = agent.description {
        out.push_str(&format!("- **Description:** {}\n", desc));
    }
    if let Some(temp) = agent.temperature {
        out.push_str(&format!("- **Temperature:** {}\n", temp));
    }
    if let Some(max) = agent.max_tokens {
        out.push_str(&format!("- **Max tokens:** {}\n", max));
    }
    if let Some(ctx) = agent.context_window {
        out.push_str(&format!("- **Context window:** {}\n", ctx));
    }
    if let Some(ref soul) = agent.soul_content {
        out.push_str(&format!("\n## Soul\n\n{}\n", soul));
    }
    if let Some(ref subs) = agent.sub_agents {
        if !subs.is_empty() {
            out.push_str("\n## Sub-agents\n\n");
            for sub in subs {
                out.push_str(&format!("- `{}`\n", sub.agent_id));
            }
        }
    }
    out
}

pub fn format_org_summary(org: &OrgDefinition) -> String {
    let mut line = format!(
        "- **{}** (id: `{}`, {} members)",
        org.name,
        org.id,
        org.member_count()
    );
    if let Some(ref desc) = org.description {
        let preview: String = crate::utils::safe_truncate_chars_to_string(&desc, 80);
        let suffix = if desc.chars().count() > 80 { "..." } else { "" };
        line.push_str(&format!(": {}{}", preview, suffix));
    }
    line
}

pub fn format_org_detail(org: &OrgDefinition) -> String {
    let mut out = format!("# Org: {}\n\n", org.name);
    out.push_str(&format!("- **ID:** `{}`\n", org.id));
    out.push_str(&format!("- **Role:** {}\n", org.role));
    if !org.agent_id.is_empty() {
        out.push_str(&format!("- **Agent ID:** `{}`\n", org.agent_id));
    }
    if let Some(ref desc) = org.description {
        out.push_str(&format!("- **Description:** {}\n", desc));
    }
    if let Some(ref instructions) = org.instructions {
        out.push_str(&format!(
            "\n## Coordinator instructions\n\n{}\n",
            instructions
        ));
    }
    out.push_str(&format!("- **Total members:** {}\n", org.member_count()));
    if !org.children.is_empty() {
        out.push_str("\n## Team members\n\n");
        format_member_tree(&org.children, &mut out, 0);
    }
    out
}

pub fn format_member_tree(members: &[OrgMember], out: &mut String, depth: usize) {
    let indent = "  ".repeat(depth);
    for member in members {
        out.push_str(&format!(
            "{}- **{}** (role: {}, agent: `{}`)\n",
            indent, member.name, member.role, member.agent_id
        ));
        if let Some(instructions) = member.instructions.as_deref() {
            out.push_str(&format!("{}  - Instructions: {}\n", indent, instructions));
        }
        if !member.children.is_empty() {
            format_member_tree(&member.children, out, depth + 1);
        }
    }
}
