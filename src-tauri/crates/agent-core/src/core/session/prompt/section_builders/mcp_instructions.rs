//! `# MCP Server Instructions` — server-published usage guidance, filtered to
//! servers with a bridge tool registered in this session.

// ============================================
// MCP server instructions
// ============================================

/// Render the `# MCP Server Instructions` section from the published
/// `(server, instructions)` snapshot, filtered to servers that actually
/// have a bridge tool registered in THIS session (`mcp__<server>__*` in
/// `tool_names`) — a server disabled for this session must not leak its
/// instructions here even though it is connected process-wide.
pub(crate) fn build_mcp_instructions_section(
    entries: &[(String, String)],
    tool_names: &[&str],
) -> Option<String> {
    let blocks: Vec<String> = entries
        .iter()
        .filter(|(server, _)| {
            let prefix = format!(
                "mcp__{}__",
                crate::specialization::mcp::bridge::normalize_name_for_mcp(server)
            );
            tool_names.iter().any(|name| name.starts_with(&prefix))
        })
        .map(|(server, instructions)| format!("## {}\n{}", server, instructions))
        .collect();
    if blocks.is_empty() {
        return None;
    }
    Some(format!(
        "# MCP Server Instructions\n\n\
         The following MCP servers have provided instructions for how to use their tools and resources:\n\n{}",
        blocks.join("\n\n")
    ))
}

#[cfg(test)]
mod mcp_instructions_tests {
    use super::build_mcp_instructions_section;

    fn entries() -> Vec<(String, String)> {
        vec![
            (
                "code graph".to_string(),
                "Inspect relationships first.".to_string(),
            ),
            ("chrome dev".to_string(), "Batch tool loads.".to_string()),
        ]
    }

    #[test]
    fn renders_only_servers_with_registered_tools() {
        let body =
            build_mcp_instructions_section(&entries(), &["read_file", "mcp__code_graph__explore"])
                .expect("code graph has a registered tool");
        assert!(body.starts_with("# MCP Server Instructions"));
        assert!(body.contains("## code graph\nInspect relationships first."));
        assert!(
            !body.contains("chrome dev"),
            "server without registered tools must not leak instructions"
        );
    }

    #[test]
    fn matches_normalized_server_names() {
        // "chrome dev" normalizes to "chrome_dev" in bridge tool names.
        let body = build_mcp_instructions_section(&entries(), &["mcp__chrome_dev__navigate"])
            .expect("normalized prefix must match");
        assert!(body.contains("## chrome dev\nBatch tool loads."));
    }

    #[test]
    fn returns_none_without_matching_tools() {
        assert!(build_mcp_instructions_section(&entries(), &["read_file"]).is_none());
        assert!(build_mcp_instructions_section(&[], &["mcp__code_graph__explore"]).is_none());
    }
}
