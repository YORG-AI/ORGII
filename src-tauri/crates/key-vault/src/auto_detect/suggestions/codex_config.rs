//! `~/.codex/config.toml` (`$CODEX_HOME/config.toml`) declares relays as
//! `[model_providers.<id>]` tables with `base_url` and `env_key`: the key
//! itself lives in the environment variable named by `env_key`. Each such
//! entry becomes an env-var owner for the `codex` agent carrying the relay
//! base URL, so a bespoke `LONGCAT_API_KEY` export is attributed to Codex
//! with the right endpoint instead of being ignored.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CodexModelProvider {
    pub id: String,
    pub base_url: Option<String>,
    pub env_key: Option<String>,
}

pub(super) fn codex_config_path_in(codex_home: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = codex_home.map(str::trim).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("config.toml"));
    }
    home.map(|home| home.join(".codex/config.toml"))
}

pub(super) fn parse_codex_model_providers(toml_text: &str) -> Vec<CodexModelProvider> {
    let Ok(value) = toml::from_str::<toml::Value>(toml_text) else {
        return Vec::new();
    };
    let Some(table) = value.get("model_providers").and_then(|v| v.as_table()) else {
        return Vec::new();
    };
    let str_field = |entry: &toml::Value, key: &str| {
        entry
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    table
        .iter()
        .map(|(id, entry)| CodexModelProvider {
            id: id.clone(),
            base_url: str_field(entry, "base_url"),
            env_key: str_field(entry, "env_key"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_providers_and_ignores_other_tables() {
        let toml = r#"
model = "gpt-5"
[mcp_servers.node_repl]
command = "node"
[model_providers.longcat]
name = "LongCat"
base_url = "https://api.longcat.chat/openai/v1"
env_key = "LONGCAT_API_KEY"
wire_api = "chat"
[model_providers.local]
base_url = "http://localhost:11434/v1"
"#;
        let mut providers = parse_codex_model_providers(toml);
        providers.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            providers,
            vec![
                CodexModelProvider {
                    id: "local".into(),
                    base_url: Some("http://localhost:11434/v1".into()),
                    env_key: None,
                },
                CodexModelProvider {
                    id: "longcat".into(),
                    base_url: Some("https://api.longcat.chat/openai/v1".into()),
                    env_key: Some("LONGCAT_API_KEY".into()),
                },
            ]
        );
    }

    #[test]
    fn invalid_toml_yields_nothing() {
        assert!(parse_codex_model_providers("[broken").is_empty());
        assert!(parse_codex_model_providers("").is_empty());
    }

    #[test]
    fn codex_home_override_wins() {
        let home = Path::new("/home/u");
        assert_eq!(
            codex_config_path_in(Some("/opt/codex"), Some(home)),
            Some(PathBuf::from("/opt/codex/config.toml"))
        );
        assert_eq!(
            codex_config_path_in(Some("  "), Some(home)),
            Some(PathBuf::from("/home/u/.codex/config.toml"))
        );
    }
}
