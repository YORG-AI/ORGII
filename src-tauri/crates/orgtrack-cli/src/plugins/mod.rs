//! Loader and processor plugins.
//!
//! A plugin is a directory containing a `plugin.toml`. Kinds:
//!
//! - `kind = "loader"`, `format = "anthropic-jsonl"` — a *no-code* source over
//!   `orgtrack_core`'s generic JSONL reader (reads files only; no trust).
//! - `kind = "loader"`, `format = "exec"` — an executable that speaks the
//!   plugin JSON protocol (`scan` / `load`). Runs code → requires trust.
//! - `kind = "processor"`, `format = "exec"` — an executable that transforms
//!   the loaded data on the read/display path: `stage = "session"` reshapes the
//!   `list`/`search` rows; `stage = "chunk"` reshapes a `show`'s chunks (redact,
//!   enrich, filter, rename). Runs code → requires trust.
//!
//! Exec plugins are **inert until trusted**: `~/.orgtrack/trust.json` pins a
//! sha256 of the manifest + executable; any change re-arms it. Discovery is
//! user-scoped (`~/.orgtrack/plugins`) plus `$ORGTRACK_PLUGIN_PATH`.
//! Project-scoped plugins (`./.orgtrack/plugins`) are intentionally not
//! auto-loaded — running code from a cloned repo is a supply-chain risk.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use orgtrack_core::sources::anthropic_jsonl::AnthropicJsonlSource;
use serde::Deserialize;

mod trust_store;
pub use trust_store::trust;
use trust_store::{content_hash, load_trust_store};

/// The wire protocol version this build implements.
pub const PROTOCOL_VERSION: u32 = 1;

/// How a loader plugin produces sessions.
pub enum LoaderImpl {
    /// No-code reader over the generic Anthropic JSONL loader.
    Jsonl(AnthropicJsonlSource),
    /// An executable speaking the plugin JSON protocol.
    Exec(ExecSpec),
}

#[derive(Clone)]
pub struct ExecSpec {
    /// Absolute path to the executable (manifest-relative paths are resolved).
    pub exec_path: PathBuf,
    /// Working directory for the child (the manifest dir).
    pub cwd: PathBuf,
    /// Wire protocol version the plugin declares.
    pub protocol: u32,
    pub parser_version: i64,
}

/// Whether an exec plugin is allowed to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// No trust needed (declarative, code-free).
    NotRequired,
    /// Exec plugin whose content hash matches the trust store.
    Trusted,
    /// Exec plugin not yet trusted, or changed since it was trusted.
    Untrusted,
}

impl Trust {
    pub fn label(self) -> &'static str {
        match self {
            Trust::NotRequired => "-",
            Trust::Trusted => "trusted",
            Trust::Untrusted => "UNTRUSTED",
        }
    }
}

/// Which read stage a processor transforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// `list` / `search` session rows.
    Session,
    /// A `show`'s activity chunks.
    Chunk,
}

impl Stage {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "session" => Ok(Stage::Session),
            "chunk" => Ok(Stage::Chunk),
            other => Err(format!("unknown processor stage '{other}' (session|chunk)")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Session => "session",
            Stage::Chunk => "chunk",
        }
    }
}

/// A validated loader plugin.
pub struct LoaderPlugin {
    pub id: &'static str,
    pub label: &'static str,
    pub session_prefix: &'static str,
    pub imp: LoaderImpl,
    pub trust: Trust,
    pub manifest_dir: PathBuf,
}

impl LoaderPlugin {
    pub fn runnable(&self) -> bool {
        !matches!(self.trust, Trust::Untrusted)
    }

    pub fn kind_label(&self) -> &'static str {
        match self.imp {
            LoaderImpl::Jsonl(_) => "loader (jsonl)",
            LoaderImpl::Exec(_) => "loader (exec)",
        }
    }
}

/// A validated processor plugin.
pub struct ProcessorPlugin {
    pub id: &'static str,
    pub label: &'static str,
    pub stage: Stage,
    /// Source ids this applies to; `["*"]` = all.
    pub scope: Vec<String>,
    pub spec: ExecSpec,
    pub trust: Trust,
    pub manifest_dir: PathBuf,
}

impl ProcessorPlugin {
    pub fn runnable(&self) -> bool {
        !matches!(self.trust, Trust::Untrusted)
    }

    /// Whether this processor applies to the given source id.
    pub fn applies_to(&self, source: &str) -> bool {
        self.scope
            .iter()
            .any(|entry| entry == "*" || entry == source)
    }
}

/// A validated formatter plugin: a sandboxed template rendered against a
/// command's result JSON. Templates run no code (no fs/network access), so no
/// trust is required.
pub struct FormatterPlugin {
    pub id: &'static str,
    pub label: &'static str,
    pub template_path: PathBuf,
    pub manifest_dir: PathBuf,
}

/// A plugin directory that failed to load, kept so `plugins list` can surface
/// the reason instead of silently dropping it.
pub struct BrokenPlugin {
    pub dir: PathBuf,
    pub error: String,
}

#[derive(Default)]
pub struct Discovered {
    pub loaders: Vec<LoaderPlugin>,
    pub processors: Vec<ProcessorPlugin>,
    pub formatters: Vec<FormatterPlugin>,
    pub hooks: Vec<HookPlugin>,
    pub broken: Vec<BrokenPlugin>,
}

/// A validated action **hook**: an executable run by `orgtrack check` when a
/// trigger fires, receiving the firings JSON on stdin. Runs code → trust-gated.
pub struct HookPlugin {
    pub id: &'static str,
    pub label: &'static str,
    pub spec: ExecSpec,
    pub trust: Trust,
    /// Severities that invoke this hook (`error`/`warn`/`info`); empty = any.
    pub on: Vec<String>,
    pub manifest_dir: PathBuf,
}

impl HookPlugin {
    pub fn runnable(&self) -> bool {
        !matches!(self.trust, Trust::Untrusted)
    }

    /// Whether this hook cares about a firing of the given severity.
    pub fn wants(&self, severity: &str) -> bool {
        self.on.is_empty() || self.on.iter().any(|entry| entry == severity)
    }
}

enum Parsed {
    Loader(LoaderPlugin),
    Processor(ProcessorPlugin),
    Formatter(FormatterPlugin),
    Hook(HookPlugin),
}

#[derive(Deserialize)]
struct Manifest {
    plugin: PluginMeta,
    loader: Option<LoaderSpec>,
    processor: Option<ProcessorSpec>,
    formatter: Option<FormatterSpec>,
    hook: Option<HookSpec>,
}

#[derive(Deserialize, Default)]
struct HookSpec {
    #[serde(default)]
    on: Vec<String>,
}

#[derive(Deserialize)]
struct PluginMeta {
    id: String,
    #[serde(default)]
    label: String,
    kind: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    exec: String,
    #[serde(default = "default_protocol")]
    protocol: u32,
}

#[derive(Deserialize)]
struct LoaderSpec {
    #[serde(default)]
    session_prefix: String,
    #[serde(default = "default_parser_version")]
    parser_version: i64,
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    exclude_subagent_dirs: bool,
}

#[derive(Deserialize)]
struct ProcessorSpec {
    #[serde(default = "default_stage")]
    stage: String,
    #[serde(default = "default_scope")]
    scope: Vec<String>,
}

#[derive(Deserialize)]
struct FormatterSpec {
    #[serde(default)]
    template: String,
}

fn default_parser_version() -> i64 {
    1
}
fn default_protocol() -> u32 {
    1
}
fn default_stage() -> String {
    "session".to_string()
}
fn default_scope() -> Vec<String> {
    vec!["*".to_string()]
}

/// Discover every plugin under the search path. `enabled = false` skips
/// discovery entirely (the `--no-plugins` escape hatch).
pub fn discover(enabled: bool) -> Discovered {
    let mut found = Discovered::default();
    if !enabled {
        return found;
    }
    let trust_store = load_trust_store();
    for dir in plugin_dirs() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let manifest_path = entry.path().join("plugin.toml");
            if !manifest_path.is_file() {
                continue;
            }
            match load_manifest(&manifest_path, &trust_store) {
                Ok(Parsed::Loader(plugin)) => {
                    if id_taken(&found, plugin.id) {
                        found.broken.push(duplicate(entry.path(), plugin.id));
                    } else {
                        found.loaders.push(plugin);
                    }
                }
                Ok(Parsed::Processor(plugin)) => {
                    if id_taken(&found, plugin.id) {
                        found.broken.push(duplicate(entry.path(), plugin.id));
                    } else {
                        found.processors.push(plugin);
                    }
                }
                Ok(Parsed::Formatter(plugin)) => {
                    if id_taken(&found, plugin.id) {
                        found.broken.push(duplicate(entry.path(), plugin.id));
                    } else {
                        found.formatters.push(plugin);
                    }
                }
                Ok(Parsed::Hook(plugin)) => {
                    if id_taken(&found, plugin.id) {
                        found.broken.push(duplicate(entry.path(), plugin.id));
                    } else {
                        found.hooks.push(plugin);
                    }
                }
                Err(error) => found.broken.push(BrokenPlugin {
                    dir: entry.path(),
                    error,
                }),
            }
        }
    }
    found
}

fn id_taken(found: &Discovered, id: &str) -> bool {
    found.loaders.iter().any(|plugin| plugin.id == id)
        || found.processors.iter().any(|plugin| plugin.id == id)
        || found.formatters.iter().any(|plugin| plugin.id == id)
        || found.hooks.iter().any(|plugin| plugin.id == id)
}

fn duplicate(dir: PathBuf, id: &str) -> BrokenPlugin {
    BrokenPlugin {
        dir,
        error: format!("duplicate plugin id '{id}'"),
    }
}

/// Search path, highest precedence first: `$ORGTRACK_PLUGIN_PATH` (colon-sep)
/// then `~/.orgtrack/plugins`.
fn plugin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path) = std::env::var("ORGTRACK_PLUGIN_PATH") {
        for part in path.split(':').filter(|part| !part.is_empty()) {
            dirs.push(PathBuf::from(expand_path(part)));
        }
    }
    if let Some(home) = home_dir() {
        dirs.push(home.join(".orgtrack/plugins"));
    }
    dirs
}

fn load_manifest(path: &Path, trust_store: &BTreeMap<String, String>) -> Result<Parsed, String> {
    let raw = std::fs::read_to_string(path).map_err(|err| format!("read: {err}"))?;
    let manifest: Manifest = toml::from_str(&raw).map_err(|err| format!("parse: {err}"))?;
    let manifest_dir = path.parent().unwrap_or(path).to_path_buf();

    let id = manifest.plugin.id.trim().to_string();
    if !is_valid_id(&id) {
        return Err(format!(
            "invalid plugin id '{id}' (use lowercase letters, digits, '_')"
        ));
    }
    let label = if manifest.plugin.label.trim().is_empty() {
        id.clone()
    } else {
        manifest.plugin.label.trim().to_string()
    };
    let id_static: &'static str = leak(id.clone());
    let label_static: &'static str = leak(label);

    match manifest.plugin.kind.as_str() {
        "loader" => load_loader(
            path,
            &manifest,
            &manifest_dir,
            &id,
            id_static,
            label_static,
            trust_store,
        )
        .map(Parsed::Loader),
        "processor" => {
            let (exec, trust) = exec_spec(&manifest, &manifest_dir, path, &id, trust_store)?;
            let spec = manifest
                .processor
                .ok_or_else(|| "missing [processor] section".to_string())?;
            let stage = Stage::parse(spec.stage.trim())?;
            Ok(Parsed::Processor(ProcessorPlugin {
                id: id_static,
                label: label_static,
                stage,
                scope: spec.scope,
                spec: exec,
                trust,
                manifest_dir,
            }))
        }
        "formatter" => {
            if manifest.plugin.format != "template" {
                return Err(format!(
                    "unsupported formatter format '{}' (only 'template' today)",
                    manifest.plugin.format
                ));
            }
            let spec = manifest
                .formatter
                .ok_or_else(|| "missing [formatter] section".to_string())?;
            let template = spec.template.trim();
            if template.is_empty() {
                return Err("[formatter].template must name a template file".to_string());
            }
            let template_path = resolve_exec(&manifest_dir, template);
            if !template_path.is_file() {
                return Err(format!("template not found: {}", template_path.display()));
            }
            Ok(Parsed::Formatter(FormatterPlugin {
                id: id_static,
                label: label_static,
                template_path,
                manifest_dir,
            }))
        }
        "hook" => {
            let (exec, trust) = exec_spec(&manifest, &manifest_dir, path, &id, trust_store)?;
            let spec = manifest.hook.unwrap_or_default();
            Ok(Parsed::Hook(HookPlugin {
                id: id_static,
                label: label_static,
                spec: exec,
                trust,
                on: spec.on,
                manifest_dir,
            }))
        }
        other => Err(format!(
            "unsupported plugin kind '{other}' (loader, processor, formatter, or hook)"
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn load_loader(
    path: &Path,
    manifest: &Manifest,
    manifest_dir: &Path,
    id: &str,
    id_static: &'static str,
    label_static: &'static str,
    trust_store: &BTreeMap<String, String>,
) -> Result<LoaderPlugin, String> {
    let spec = manifest
        .loader
        .as_ref()
        .ok_or_else(|| "missing [loader] section".to_string())?;
    let session_prefix = spec.session_prefix.trim().to_string();
    if session_prefix.is_empty() {
        return Err("[loader].session_prefix must not be empty".to_string());
    }
    let prefix_static: &'static str = leak(session_prefix);

    let (imp, trust) = match manifest.plugin.format.as_str() {
        "anthropic-jsonl" => {
            let roots: Vec<PathBuf> = spec
                .roots
                .iter()
                .map(|root| PathBuf::from(expand_path(root)))
                .collect();
            if roots.is_empty() {
                return Err("[loader].roots must list at least one directory".to_string());
            }
            let config = AnthropicJsonlSource {
                source: id_static,
                session_prefix: prefix_static,
                provider_slug: id_static,
                display_name: label_static,
                parser_version: spec.parser_version,
                candidate_roots: roots,
                exclude_subagent_dirs: spec.exclude_subagent_dirs,
            };
            (LoaderImpl::Jsonl(config), Trust::NotRequired)
        }
        "exec" => {
            let (exec, trust) = exec_spec(manifest, manifest_dir, path, id, trust_store)?;
            (LoaderImpl::Exec(exec), trust)
        }
        other => {
            return Err(format!(
                "unsupported loader format '{other}' (expected 'anthropic-jsonl' or 'exec')"
            ))
        }
    };

    Ok(LoaderPlugin {
        id: id_static,
        label: label_static,
        session_prefix: prefix_static,
        imp,
        trust,
        manifest_dir: manifest_dir.to_path_buf(),
    })
}

/// Build an [`ExecSpec`] from the manifest's `exec` + `protocol`, and resolve
/// its trust state from the store.
fn exec_spec(
    manifest: &Manifest,
    manifest_dir: &Path,
    manifest_path: &Path,
    id: &str,
    trust_store: &BTreeMap<String, String>,
) -> Result<(ExecSpec, Trust), String> {
    if manifest.plugin.protocol > PROTOCOL_VERSION {
        return Err(format!(
            "plugin protocol {} is newer than supported {}",
            manifest.plugin.protocol, PROTOCOL_VERSION
        ));
    }
    let exec_raw = manifest.plugin.exec.trim();
    if exec_raw.is_empty() {
        return Err("exec plugin needs `exec = \"…\"` in [plugin]".to_string());
    }
    let exec_path = resolve_exec(manifest_dir, exec_raw);
    if !exec_path.is_file() {
        return Err(format!("exec not found: {}", exec_path.display()));
    }
    let hash = content_hash(manifest_path, &exec_path)?;
    let trust = if trust_store.get(id).is_some_and(|stored| *stored == hash) {
        Trust::Trusted
    } else {
        Trust::Untrusted
    };
    let parser_version = manifest
        .loader
        .as_ref()
        .map(|spec| spec.parser_version)
        .unwrap_or_else(default_parser_version);
    Ok((
        ExecSpec {
            exec_path,
            cwd: manifest_dir.to_path_buf(),
            protocol: manifest.plugin.protocol,
            parser_version,
        },
        trust,
    ))
}

fn resolve_exec(manifest_dir: &Path, raw: &str) -> PathBuf {
    let expanded = expand_path(raw);
    let candidate = PathBuf::from(&expanded);
    if candidate.is_absolute() {
        candidate
    } else {
        manifest_dir.join(candidate)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

/// Expand a leading `~` and any `${VAR}` occurrences in a path string.
fn expand_path(raw: &str) -> String {
    let mut expanded = raw.to_string();
    if let Some(rest) = expanded.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            expanded = home.join(rest).to_string_lossy().into_owned();
        }
    } else if expanded == "~" {
        if let Some(home) = home_dir() {
            expanded = home.to_string_lossy().into_owned();
        }
    }
    while let Some(start) = expanded.find("${") {
        let Some(end) = expanded[start..].find('}').map(|offset| start + offset) else {
            break;
        };
        let var = &expanded[start + 2..end];
        let value = std::env::var(var).unwrap_or_default();
        expanded.replace_range(start..=end, &value);
    }
    expanded
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn leak(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::File::create(&path)
            .unwrap()
            .write_all(contents.as_bytes())
            .unwrap();
        path
    }

    fn write_manifest(dir: &Path, toml: &str) -> PathBuf {
        write_file(dir, "plugin.toml", toml)
    }

    #[test]
    fn valid_ids() {
        assert!(is_valid_id("my_agent1"));
        assert!(!is_valid_id("Bad ID"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("dash-not-ok"));
    }

    #[test]
    fn stage_parse_roundtrips() {
        assert_eq!(Stage::parse("session").unwrap().as_str(), "session");
        assert_eq!(Stage::parse("chunk").unwrap().as_str(), "chunk");
        assert!(Stage::parse("bogus").is_err());
    }

    #[test]
    fn expand_path_env_and_home() {
        std::env::set_var("ORGTRACK_TEST_ROOT", "/xyz");
        assert_eq!(expand_path("${ORGTRACK_TEST_ROOT}/a"), "/xyz/a");
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_path("~/foo"), format!("{home}/foo"));
    }

    #[test]
    fn content_hash_rearms_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = write_file(dir.path(), "plugin.toml", "id=1");
        let exec = write_file(dir.path(), "scan.py", "print(1)");
        let first = content_hash(&manifest, &exec).unwrap();
        assert_eq!(first, content_hash(&manifest, &exec).unwrap());
        write_file(dir.path(), "scan.py", "print(2)");
        assert_ne!(first, content_hash(&manifest, &exec).unwrap());
    }

    #[test]
    fn jsonl_loader_needs_no_trust() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_manifest(
            dir.path(),
            "[plugin]\nid=\"j\"\nkind=\"loader\"\nformat=\"anthropic-jsonl\"\n\
             [loader]\nsession_prefix=\"j-\"\nroots=[\"/tmp/x\"]\n",
        );
        match load_manifest(&path, &BTreeMap::new()).unwrap() {
            Parsed::Loader(plugin) => {
                assert_eq!(plugin.id, "j");
                assert!(matches!(plugin.imp, LoaderImpl::Jsonl(_)));
                assert_eq!(plugin.trust, Trust::NotRequired);
            }
            _ => panic!("expected a loader"),
        }
    }

    #[test]
    fn exec_loader_trust_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let exec = write_file(dir.path(), "scan.py", "#!/usr/bin/env python3\n");
        let path = write_manifest(
            dir.path(),
            "[plugin]\nid=\"e\"\nkind=\"loader\"\nformat=\"exec\"\nexec=\"./scan.py\"\n\
             [loader]\nsession_prefix=\"e-\"\n",
        );

        // Empty store → untrusted.
        let trust = match load_manifest(&path, &BTreeMap::new()).unwrap() {
            Parsed::Loader(plugin) => {
                assert!(matches!(plugin.imp, LoaderImpl::Exec(_)));
                plugin.trust
            }
            _ => panic!("expected a loader"),
        };
        assert_eq!(trust, Trust::Untrusted);

        // Store carries the current content hash → trusted.
        let mut store = BTreeMap::new();
        store.insert("e".to_string(), content_hash(&path, &exec).unwrap());
        let trust = match load_manifest(&path, &store).unwrap() {
            Parsed::Loader(plugin) => plugin.trust,
            _ => panic!(),
        };
        assert_eq!(trust, Trust::Trusted);

        // Tampering the exec re-arms trust even with the (now stale) store.
        write_file(
            dir.path(),
            "scan.py",
            "#!/usr/bin/env python3\nprint('x')\n",
        );
        let trust = match load_manifest(&path, &store).unwrap() {
            Parsed::Loader(plugin) => plugin.trust,
            _ => panic!(),
        };
        assert_eq!(trust, Trust::Untrusted);
    }

    #[test]
    fn processor_parses_stage_and_scope() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "p.py", "x");
        let path = write_manifest(
            dir.path(),
            "[plugin]\nid=\"p\"\nkind=\"processor\"\nformat=\"exec\"\nexec=\"./p.py\"\n\
             [processor]\nstage=\"chunk\"\nscope=[\"a\",\"b\"]\n",
        );
        match load_manifest(&path, &BTreeMap::new()).unwrap() {
            Parsed::Processor(plugin) => {
                assert_eq!(plugin.stage, Stage::Chunk);
                assert!(plugin.applies_to("a"));
                assert!(!plugin.applies_to("c"));
            }
            _ => panic!("expected a processor"),
        }
    }

    #[test]
    fn wildcard_scope_applies_to_all() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "p.py", "x");
        let path = write_manifest(
            dir.path(),
            "[plugin]\nid=\"p\"\nkind=\"processor\"\nformat=\"exec\"\nexec=\"./p.py\"\n\
             [processor]\nstage=\"session\"\n",
        );
        match load_manifest(&path, &BTreeMap::new()).unwrap() {
            Parsed::Processor(plugin) => {
                assert!(plugin.applies_to("anything"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn formatter_parses() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "t.j2", "hi");
        let path = write_manifest(
            dir.path(),
            "[plugin]\nid=\"f\"\nkind=\"formatter\"\nformat=\"template\"\n\
             [formatter]\ntemplate=\"t.j2\"\n",
        );
        match load_manifest(&path, &BTreeMap::new()).unwrap() {
            Parsed::Formatter(plugin) => assert_eq!(plugin.id, "f"),
            _ => panic!("expected a formatter"),
        }
    }

    #[test]
    fn rejects_bad_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            // invalid id
            "[plugin]\nid=\"Bad\"\nkind=\"loader\"\nformat=\"anthropic-jsonl\"\n[loader]\nsession_prefix=\"x-\"\nroots=[\"/t\"]\n",
            // unknown kind
            "[plugin]\nid=\"a\"\nkind=\"widget\"\nformat=\"exec\"\n",
            // unknown loader format
            "[plugin]\nid=\"a\"\nkind=\"loader\"\nformat=\"nope\"\n[loader]\nsession_prefix=\"a-\"\n",
            // exec missing exec path
            "[plugin]\nid=\"a\"\nkind=\"loader\"\nformat=\"exec\"\n[loader]\nsession_prefix=\"a-\"\n",
            // jsonl missing roots
            "[plugin]\nid=\"a\"\nkind=\"loader\"\nformat=\"anthropic-jsonl\"\n[loader]\nsession_prefix=\"a-\"\n",
        ];
        for toml in cases {
            let path = write_manifest(dir.path(), toml);
            assert!(
                load_manifest(&path, &BTreeMap::new()).is_err(),
                "should reject: {toml}"
            );
        }
    }
}
