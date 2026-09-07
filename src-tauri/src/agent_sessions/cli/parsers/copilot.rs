//! Copilot CLI ACP (Agent Client Protocol) integration.
//!
//! Thin wrapper over `acp_common` with Copilot-specific defaults.
//! Copilot uses standard ACP kinds so the default `map_tool_kind` is sufficient.

use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::acp_common::{self, AcpAgentAdapter, AcpSessionResult};
use core_types::activity::ActivityChunk;

/// Copilot adapter — uses all default ACP behavior.
struct CopilotAdapter;
impl AcpAgentAdapter for CopilotAdapter {}

/// Run the ACP protocol with Copilot CLI.
#[allow(clippy::too_many_arguments)]
pub async fn run_acp_protocol(
    stdin: ChildStdin,
    stdout: ChildStdout,
    session_id: &str,
    task: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    chunk_tx: mpsc::Sender<ActivityChunk>,
    image_paths: Vec<String>,
    mcp_servers: Vec<serde_json::Value>,
) -> Result<AcpSessionResult, String> {
    acp_common::run_acp_protocol(
        CopilotAdapter,
        stdin,
        stdout,
        session_id,
        task,
        working_dir,
        resume_session_id,
        chunk_tx,
        image_paths,
        mcp_servers,
    )
    .await
}
