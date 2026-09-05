//! cc-switch (<https://github.com/farion1231/cc-switch>) keeps every relay /
//! provider profile it manages in `~/.cc-switch/cc-switch.db`, table
//! `providers` — one row per (`id`, `app_type`) with a `settings_config`
//! JSON blob. Claude rows carry `env.ANTHROPIC_AUTH_TOKEN` +
//! `env.ANTHROPIC_BASE_URL`, Codex rows `auth.OPENAI_API_KEY` plus a
//! `config` TOML string with `[model_providers.*].base_url`, Gemini rows
//! `env.GEMINI_API_KEY`. "Official" profiles have empty blobs (their auth is
//! OAuth elsewhere) and are skipped.
//!
//! Layout verified against cc-switch's live database on 2026-09-04; the
//! column check below turns schema drift into "no rows" instead of an
//! error.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

pub(super) const CC_SWITCH_DB_RELATIVE: &str = ".cc-switch/cc-switch.db";

/// Columns the reader depends on. Missing any of them ⇒ skip silently.
const REQUIRED_COLUMNS: &[&str] = &["id", "app_type", "name", "settings_config"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CcSwitchCredential {
    pub app_type: String,
    pub id: String,
    /// User-facing profile name ("Longcat", "OpenAI Official", ...).
    pub name: String,
    /// `ModelType::as_str()` this profile maps onto.
    pub agent: &'static str,
    pub secret: String,
    pub base_url: Option<String>,
    pub is_current: bool,
    pub model: Option<String>,
}

impl CcSwitchCredential {
    /// Opaque reference the import side uses to find the row again.
    pub fn reference(&self) -> String {
        format!("{}:{}", self.app_type, self.id)
    }
}

pub(super) fn cc_switch_db_path_in(home: &Path) -> PathBuf {
    home.join(CC_SWITCH_DB_RELATIVE)
}

/// Read every profile that carries a usable secret. Read-only; no writes,
/// no locks held beyond the query.
pub(super) fn read_cc_switch_credentials(
    db_path: &Path,
) -> Result<Vec<CcSwitchCredential>, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open cc-switch database: {e}"))?;

    let mut columns: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info(providers)")
            .map_err(|e| format!("cc-switch providers table missing: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("cc-switch table_info failed: {e}"))?;
        for row in rows.flatten() {
            columns.push(row);
        }
    }
    if let Some(missing) = REQUIRED_COLUMNS
        .iter()
        .find(|col| !columns.iter().any(|c| c == *col))
    {
        return Err(format!("cc-switch providers table lacks column {missing}"));
    }
    let has_is_current = columns.iter().any(|c| c == "is_current");

    let sql = if has_is_current {
        "SELECT id, app_type, name, settings_config, COALESCE(is_current, 0) FROM providers"
    } else {
        "SELECT id, app_type, name, settings_config, 0 FROM providers"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("cc-switch query failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? != 0,
            ))
        })
        .map_err(|e| format!("cc-switch query failed: {e}"))?;

    let mut out = Vec::new();
    for (id, app_type, name, settings_config, is_current) in rows.flatten() {
        let Ok(config) = serde_json::from_str::<serde_json::Value>(&settings_config) else {
            continue;
        };
        if let Some((agent, secret, base_url)) = credential_from_settings(&app_type, &config) {
            // Upstream's proxy takeover sentinel is not a provider credential.
            // Source: cc-switch services/proxy.rs PROXY_TOKEN_PLACEHOLDER.
            if secret == "PROXY_MANAGED" {
                continue;
            }
            out.push(CcSwitchCredential {
                app_type: app_type.clone(),
                id,
                name,
                agent,
                secret,
                base_url,
                model: model_from_settings(&app_type, &config),
                is_current,
            });
        }
    }
    Ok(out)
}

fn non_empty_str(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Map one profile's `settings_config` onto (agent, secret, base_url).
pub(super) fn credential_from_settings(
    app_type: &str,
    config: &serde_json::Value,
) -> Option<(&'static str, String, Option<String>)> {
    match app_type {
        "claude" | "claude-desktop" => {
            let env = config.get("env")?;
            let secret = non_empty_str(env.get("ANTHROPIC_AUTH_TOKEN"))
                .or_else(|| non_empty_str(env.get("ANTHROPIC_API_KEY")))?;
            Some((
                "claude_code",
                secret,
                non_empty_str(env.get("ANTHROPIC_BASE_URL")),
            ))
        }
        "codex" => {
            let native_bearer = || -> Option<String> {
                let parsed: toml::Value = toml::from_str(config.get("config")?.as_str()?).ok()?;
                let selected = parsed.get("model_provider")?.as_str()?;
                parsed
                    .get("model_providers")?
                    .get(selected)?
                    .get("experimental_bearer_token")?
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let secret = native_bearer().or_else(|| {
                non_empty_str(config.get("auth").and_then(|a| a.get("OPENAI_API_KEY")))
            })?;
            let base_url = config
                .get("config")
                .and_then(|c| c.as_str())
                .and_then(codex_base_url_from_config_toml);
            Some(("codex", secret, base_url))
        }
        "gemini" => {
            let env = config.get("env")?;
            let secret = non_empty_str(env.get("GEMINI_API_KEY"))
                .or_else(|| non_empty_str(env.get("GOOGLE_API_KEY")))?;
            Some((
                "gemini_api",
                secret,
                non_empty_str(env.get("GOOGLE_GEMINI_BASE_URL")),
            ))
        }
        _ => None,
    }
}

/// The relay base URL inside a cc-switch Codex profile's `config` TOML:
/// the provider named by top-level `model_provider`, else the first
/// `[model_providers.*]` entry with a `base_url`.
pub(super) fn codex_base_url_from_config_toml(config_toml: &str) -> Option<String> {
    let providers = super::codex_config::parse_codex_model_providers(config_toml);
    let selected: Option<String> = toml::from_str::<toml::Value>(config_toml)
        .ok()
        .and_then(|v| v.get("model_provider")?.as_str().map(str::to_string));
    if let Some(selected) = selected {
        if let Some(provider) = providers.iter().find(|p| p.id == selected) {
            return provider.base_url.clone();
        }
    }
    providers.into_iter().find_map(|p| p.base_url)
}

#[cfg(test)]
pub(super) mod fixtures {
    //! Build a cc-switch database with the live schema (2026-09-04) in a
    //! temp HOME so probe tests exercise the real SQL path.
    use std::path::Path;

    use rusqlite::Connection;

    pub(crate) const SCHEMA: &str = r#"
        CREATE TABLE providers (
            id TEXT NOT NULL,
            app_type TEXT NOT NULL,
            name TEXT NOT NULL,
            settings_config TEXT NOT NULL,
            website_url TEXT,
            category TEXT,
            created_at INTEGER,
            sort_index INTEGER,
            notes TEXT,
            icon TEXT,
            icon_color TEXT,
            meta TEXT NOT NULL DEFAULT '{}',
            is_current BOOLEAN NOT NULL DEFAULT 0,
            in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
            cost_multiplier TEXT NOT NULL DEFAULT '1.0',
            limit_daily_usd TEXT,
            limit_monthly_usd TEXT,
            provider_type TEXT,
            PRIMARY KEY (id, app_type)
        );
        CREATE TABLE provider_endpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_id TEXT NOT NULL,
            app_type TEXT NOT NULL,
            url TEXT NOT NULL,
            added_at INTEGER
        );
    "#;

    pub(crate) fn write_db(path: &Path, rows: &[(&str, &str, &str, &str, bool)]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (id, app_type, name, settings_config, is_current) in rows {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, app_type, name, settings_config, *is_current as i64],
            )
            .unwrap();
        }
    }

    /// Representative rows: two Official profiles with empty blobs, one
    /// Claude relay, one Codex relay with a TOML config, one Gemini key.
    pub(crate) fn sample_rows() -> Vec<(&'static str, &'static str, &'static str, &'static str, bool)> {
        vec![
            ("official", "claude", "Claude Official", r#"{"env":{}}"#, true),
            ("official", "codex", "OpenAI Official", r#"{"auth":{},"config":""}"#, true),
            (
                "longcat",
                "claude",
                "Longcat",
                r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.longcat.chat/anthropic","ANTHROPIC_AUTH_TOKEN":"ak_longcat_relay_token_0001","ANTHROPIC_MODEL":"LongCat-Flash","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":1}}"#,
                false,
            ),
            (
                "relay",
                "codex",
                "Codex Relay",
                r#"{"auth":{"OPENAI_API_KEY":"sk-relay-codex-0001"},"config":"model_provider = \"relay\"\n\n[model_providers.relay]\nname = \"Relay\"\nbase_url = \"https://relay.example/v1\"\nwire_api = \"responses\"\n"}"#,
                false,
            ),
            (
                "gem",
                "gemini",
                "Gemini Key",
                r#"{"env":{"GEMINI_API_KEY":"AIzaSyFixtureGeminiKey0000000000000000000"},"config":{}}"#,
                false,
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_profiles_with_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let db = cc_switch_db_path_in(dir.path());
        fixtures::write_db(&db, &fixtures::sample_rows());

        let creds = read_cc_switch_credentials(&db).unwrap();
        let mut names: Vec<&str> = creds.iter().map(|c| c.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Codex Relay", "Gemini Key", "Longcat"]);

        let longcat = creds.iter().find(|c| c.name == "Longcat").unwrap();
        assert_eq!(longcat.agent, "claude_code");
        assert_eq!(longcat.secret, "ak_longcat_relay_token_0001");
        assert_eq!(
            longcat.base_url.as_deref(),
            Some("https://api.longcat.chat/anthropic")
        );
        assert_eq!(longcat.reference(), "claude:longcat");
        assert!(!longcat.is_current);

        let codex = creds.iter().find(|c| c.name == "Codex Relay").unwrap();
        assert_eq!(codex.agent, "codex");
        assert_eq!(codex.base_url.as_deref(), Some("https://relay.example/v1"));

        let gemini = creds.iter().find(|c| c.name == "Gemini Key").unwrap();
        assert_eq!(gemini.agent, "gemini_api");
    }

    #[test]
    fn schema_drift_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cc-switch.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE providers (id TEXT, app_type TEXT);")
            .unwrap();
        drop(conn);
        let err = read_cc_switch_credentials(&db).unwrap_err();
        assert!(err.contains("lacks column"), "{err}");
    }

    #[test]
    fn codex_base_url_prefers_selected_provider() {
        let toml = "model_provider = \"b\"\n[model_providers.a]\nbase_url = \"https://a.example/v1\"\n[model_providers.b]\nbase_url = \"https://b.example/v1\"\n";
        assert_eq!(
            codex_base_url_from_config_toml(toml).as_deref(),
            Some("https://b.example/v1")
        );
        let toml = "[model_providers.a]\nbase_url = \"https://a.example/v1\"\n";
        assert_eq!(
            codex_base_url_from_config_toml(toml).as_deref(),
            Some("https://a.example/v1")
        );
        assert_eq!(codex_base_url_from_config_toml("not = [toml"), None);
    }
}

fn model_from_settings(app: &str, config: &serde_json::Value) -> Option<String> {
    match app {
        "claude" | "claude-desktop" => {
            non_empty_str(config.get("env").and_then(|env| env.get("ANTHROPIC_MODEL")))
                .or_else(|| non_empty_str(config.get("model")))
        }
        "codex" => {
            let config: toml::Value = toml::from_str(config.get("config")?.as_str()?).ok()?;
            config
                .get("model")?
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        }
        _ => None,
    }
}

#[cfg(test)]
mod connection_tests {
    use super::*;
    #[test]
    fn import_retains_model_and_selected_native_bearer_but_excludes_proxy_sentinels() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cc-switch.db");
        let config = serde_json::json!({"auth":{"OPENAI_API_KEY":"unused-login-key"},"config":"model = 'fixture-model'\nmodel_provider = 'gateway'\n[model_providers.gateway]\nbase_url='https://gateway.example/v1'\nexperimental_bearer_token='fixture-key'"}).to_string();
        fixtures::write_db(
            &path,
            &[
                ("test", "codex", "Gateway", &config, false),
                (
                    "proxy",
                    "claude",
                    "Proxy",
                    r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"PROXY_MANAGED"}}"#,
                    false,
                ),
            ],
        );
        let before = std::fs::read(&path).unwrap();
        let credentials = read_cc_switch_credentials(&path).unwrap();
        assert_eq!(credentials.len(), 1);
        assert_eq!(credentials[0].model.as_deref(), Some("fixture-model"));
        assert_eq!(credentials[0].secret, "fixture-key");
        assert_eq!(
            model_from_settings("claude", &serde_json::json!({"model":"root-model"})),
            Some("root-model".into())
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}
