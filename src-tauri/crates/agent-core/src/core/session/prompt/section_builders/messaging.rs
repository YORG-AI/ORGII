//! Messaging-related sections: the `## Messaging` routing block, the silent
//! reply protocol (and its sentinel token), and the ATC automation block.

pub(crate) const SILENT_REPLY_TOKEN: &str = "<<SILENT>>";

pub(crate) fn build_messaging_section() -> String {
    [
        "## Messaging",
        "",
        "- Reply in current session: automatically routes to the source channel.",
        "- Cross-session messaging: use `spawn` to create a sub-agent, or `message` for proactive sends.",
        "- Never use exec/curl for messaging; the agent handles all routing internally.",
        &format!(
            "- If you use `message` (action=send) to deliver your user-visible reply, \
             respond with ONLY: {} (to avoid duplicate replies).",
            SILENT_REPLY_TOKEN
        ),
    ]
    .join("\n")
}

pub(crate) fn build_silent_replies_section() -> String {
    format!(
        "## Silent Replies\n\n\
         When you have nothing to say (e.g., after sending via `message` tool), respond with ONLY: {token}\n\n\
         Rules:\n\
         - It must be your ENTIRE message — nothing else before or after\n\
         - Never append it to an actual response\n\
         - Never wrap it in markdown or code blocks",
        token = SILENT_REPLY_TOKEN
    )
}

pub(crate) fn build_atc_section() -> String {
    [
        "## ATC (Automated Trigger Control)",
        "",
        "You may receive messages from the automation system (channel: \"automation\", sender: \"system\").",
        "These are automated trigger-action rules configured by the user.",
        "Process them like any other user request.",
        "If a health poll arrives and nothing needs attention, reply exactly: HEARTBEAT_OK",
        "If something needs attention, reply with the alert text instead.",
    ]
    .join("\n")
}
