//! Helpers for advanced search indexing commands.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

use super::types::SearchFilters;

pub(crate) static CUSTOM_MODEL_DIR: LazyLock<RwLock<Option<PathBuf>>> =
    LazyLock::new(|| RwLock::new(None));

pub(crate) fn read_file_content(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub(crate) fn collect_files(root: &Path, filters: &SearchFilters) -> Vec<PathBuf> {
    use ignore::WalkBuilder;
    use std::sync::Mutex;

    let files = Mutex::new(Vec::new());
    let exclude_dirs = filters.exclude_dirs.clone().unwrap_or_else(|| {
        vec![
            "node_modules".into(),
            ".git".into(),
            "target".into(),
            "dist".into(),
            "build".into(),
            ".next".into(),
            "__pycache__".into(),
            ".venv".into(),
            "venv".into(),
        ]
    });
    let extensions: Option<Vec<String>> = filters
        .file_extensions
        .as_ref()
        .map(|exts| exts.iter().map(|value| value.to_string()).collect());

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .threads(
            std::thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(1)
                .min(8),
        );

    builder.build_parallel().run(|| {
        let files = &files;
        let exclude_dirs = &exclude_dirs;
        let extensions = &extensions;

        Box::new(move |entry| {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => return ignore::WalkState::Continue,
            };
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                    if exclude_dirs.iter().any(|excluded| excluded == name) {
                        return ignore::WalkState::Skip;
                    }
                }
                return ignore::WalkState::Continue;
            }
            if !path.is_file() {
                return ignore::WalkState::Continue;
            }
            if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
                let should_include = extensions
                    .as_ref()
                    .map(|values| {
                        values
                            .iter()
                            .any(|value| value == extension || value == &format!(".{extension}"))
                    })
                    .unwrap_or_else(|| is_supported_extension(extension));
                if should_include {
                    files.lock().unwrap().push(path.to_path_buf());
                }
            }
            ignore::WalkState::Continue
        })
    });

    files.into_inner().unwrap()
}

pub(crate) fn get_gpu_layers() -> u32 {
    let platform_default = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        32
    } else {
        0
    };
    std::env::var("ORGII_GPU_LAYERS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(platform_default)
        .min(64)
}

pub(crate) fn is_supported_extension(extension: &str) -> bool {
    matches!(
        extension,
        "ts" | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "swift"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "cs"
            | "php"
            | "rb"
            | "scala"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "sql"
            | "html"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "vue"
            | "svelte"
            | "md"
            | "mdx"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
    )
}
