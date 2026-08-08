//! Provider-specific credential validators

pub mod anthropic;
pub mod azure_openai;
pub mod claude_code;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod deepseek;
pub mod google;
pub mod kimi;
pub mod kiro;
pub mod minimax;
pub mod openai;
pub mod opencode_go;
pub mod openrouter;
pub mod qoder;
pub(crate) mod quota_http;
pub(crate) mod quota_windows;
pub mod zai_team;
pub mod zhipu;
