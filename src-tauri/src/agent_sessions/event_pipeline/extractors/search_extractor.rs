//! Search, glob, and list_dir extractors.

use super::helpers::obj_str;
use crate::agent_sessions::event_pipeline::extractors::types::*;

pub(super) fn extract_search(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ExtractedSearchData {
    let query = args
        .and_then(|a| {
            obj_str(a, "query")
                .or_else(|| obj_str(a, "pattern"))
                .or_else(|| obj_str(a, "search_query"))
                .or_else(|| obj_str(a, "regex"))
                .or_else(|| obj_str(a, "search_term"))
                .or_else(|| obj_str(a, "searchTerm"))
                .or_else(|| obj_str(a, "text"))
                .or_else(|| obj_str(a, "input"))
        })
        .unwrap_or_default();

    let results: Vec<EventSearchMatch> = result
        .and_then(|r| r.get("matches"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let obj = item.as_object()?;
                    Some(EventSearchMatch {
                        file: obj_str(obj, "file").unwrap_or_default(),
                        line: obj.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                        content: obj_str(obj, "content").unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut total_matches = result
        .and_then(|r| r.get("total"))
        .and_then(|v| v.as_u64())
        .unwrap_or(results.len() as u64) as usize;

    if total_matches == 0 {
        if let Some(content) = result.and_then(|r| obj_str(r, "content")) {
            // Parse "Found N matches" pattern
            if let Some(start) = content.find(char::is_numeric) {
                let num_str: String = content[start..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(count) = num_str.parse::<usize>() {
                    total_matches = count;
                }
            }
        }
    }

    ExtractedSearchData {
        query,
        results,
        total_matches,
    }
}

pub(super) fn extract_glob(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ExtractedGlobData {
    let output = result
        .and_then(|r| r.get("output"))
        .and_then(|v| v.as_object());
    let success = output
        .and_then(|o| o.get("success"))
        .and_then(|v| v.as_object());

    let pattern = args
        .and_then(|a| {
            obj_str(a, "pattern")
                .or_else(|| obj_str(a, "glob_pattern"))
                .or_else(|| obj_str(a, "globPattern"))
                .or_else(|| obj_str(a, "query"))
        })
        .or_else(|| success.and_then(|s| obj_str(s, "pattern")))
        .unwrap_or_else(|| "*".to_string());

    let mut files: Vec<String> = Vec::new();

    let candidates = [
        result.and_then(|r| r.get("files")),
        result.and_then(|r| r.get("matches")),
        success.and_then(|s| s.get("files")),
    ];

    for value in candidates.iter().flatten() {
        if let Some(arr) = value.as_array() {
            for item in arr {
                if let Some(s) = item.as_str() {
                    files.push(s.to_string());
                }
            }
            if !files.is_empty() {
                break;
            }
        }
    }

    // Fallback: parse text output
    if files.is_empty() {
        let text_content = result
            .and_then(|r| obj_str(r, "content"))
            .or_else(|| result.and_then(|r| obj_str(r, "observation")))
            .or_else(|| result.and_then(|r| obj_str(r, "output")));
        if let Some(text) = text_content {
            for line in text.split('\n') {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with("Found ") {
                    continue;
                }
                let has_ext = trimmed.rfind('.').is_some_and(|idx| {
                    trimmed[idx + 1..]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric())
                });
                if trimmed.contains('/') || has_ext {
                    files.push(trimmed.to_string());
                }
            }
        }
    }

    let mut total_files = success
        .and_then(|s| s.get("totalFiles"))
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(files.len());

    if total_files == 0 {
        if let Some(content) = result.and_then(|r| obj_str(r, "content")) {
            // Parse "Found N (matching) file" — take first number
            if let Some(start) = content.find(char::is_numeric) {
                let num_str: String = content[start..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(count) = num_str.parse::<usize>() {
                    total_files = count;
                }
            }
        }
    }

    ExtractedGlobData {
        pattern,
        files,
        total_files,
    }
}

pub(super) fn parse_text_entries(text: &str) -> Vec<DirEntry> {
    let lines: Vec<&str> = text
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Vec::new();
    }

    // First pass: look for `[dir] foo` / `[file] bar`
    let mut entries = Vec::new();
    let mut has_bracket_format = false;

    for line in &lines {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if let Some(rest) = lower.strip_prefix("[dir]") {
            has_bracket_format = true;
            // Use original casing on the trimmed tail after the bracket keyword
            let original_tail = trimmed.get(lower.len() - rest.len()..).unwrap_or("").trim();
            if !original_tail.is_empty() {
                entries.push(DirEntry {
                    name: original_tail.to_string(),
                    is_directory: true,
                });
            }
            continue;
        }
        if let Some(rest) = lower.strip_prefix("[file]") {
            has_bracket_format = true;
            let original_tail = trimmed.get(lower.len() - rest.len()..).unwrap_or("").trim();
            if !original_tail.is_empty() {
                entries.push(DirEntry {
                    name: original_tail.to_string(),
                    is_directory: false,
                });
            }
            continue;
        }
    }

    if has_bracket_format {
        return entries;
    }

    // Fallback: trailing `/` = directory
    for line in &lines {
        let trimmed = line.trim();
        if let Some(stripped) = trimmed.strip_suffix('/') {
            entries.push(DirEntry {
                name: stripped.to_string(),
                is_directory: true,
            });
        } else {
            entries.push(DirEntry {
                name: trimmed.to_string(),
                is_directory: false,
            });
        }
    }

    entries
}

pub(super) fn extract_list_dir(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ExtractedListDirData {
    let directory = args
        .and_then(|a| {
            obj_str(a, "target_directory")
                .or_else(|| obj_str(a, "targetDirectory"))
                .or_else(|| obj_str(a, "path"))
                .or_else(|| obj_str(a, "dir"))
                .or_else(|| obj_str(a, "dir_path"))
                .or_else(|| obj_str(a, "file_path"))
        })
        .unwrap_or_else(|| ".".to_string());

    let mut entries: Vec<DirEntry> = Vec::new();

    // Preferred structured form: result.output.success.directoryTreeRoot
    let tree_root = result
        .and_then(|r| r.get("output"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("success"))
        .and_then(|v| v.as_object())
        .and_then(|s| s.get("directoryTreeRoot"))
        .and_then(|v| v.as_object());

    if let Some(tree) = tree_root {
        let root_path = obj_str(tree, "absPath");

        if let Some(children_files) = tree.get("childrenFiles").and_then(|v| v.as_array()) {
            for file in children_files {
                if let Some(name) = file.as_object().and_then(|o| obj_str(o, "name")) {
                    entries.push(DirEntry {
                        name,
                        is_directory: false,
                    });
                }
            }
        }

        if let Some(children_dirs) = tree.get("childrenDirs").and_then(|v| v.as_array()) {
            for dir in children_dirs {
                if let Some(dir_path) = dir.as_object().and_then(|o| obj_str(o, "absPath")) {
                    let name = dir_path.rsplit('/').next().unwrap_or(&dir_path).to_string();
                    entries.push(DirEntry {
                        name,
                        is_directory: true,
                    });
                }
            }
        }

        return ExtractedListDirData {
            directory: root_path.unwrap_or(directory),
            entries,
            content_summary: None,
        };
    }

    // Fallback: array under result.output / result.entries / result.files
    let raw_entries = result
        .and_then(|r| {
            r.get("output")
                .filter(|v| v.is_array())
                .or_else(|| r.get("entries"))
                .or_else(|| r.get("files"))
        })
        .and_then(|v| v.as_array());

    if let Some(arr) = raw_entries {
        for entry in arr {
            if let Some(s) = entry.as_str() {
                if let Some(stripped) = s.strip_suffix('/') {
                    entries.push(DirEntry {
                        name: stripped.to_string(),
                        is_directory: true,
                    });
                } else {
                    entries.push(DirEntry {
                        name: s.to_string(),
                        is_directory: false,
                    });
                }
            } else if let Some(obj) = entry.as_object() {
                let name = obj_str(obj, "name").unwrap_or_default();
                let is_directory = obj
                    .get("is_directory")
                    .and_then(|v| v.as_bool())
                    .or_else(|| obj.get("isDirectory").and_then(|v| v.as_bool()))
                    .unwrap_or_else(|| {
                        obj.get("type").and_then(|v| v.as_str()) == Some("directory")
                    });
                entries.push(DirEntry { name, is_directory });
            }
        }
    }

    // Text-parsing fallbacks
    if entries.is_empty() {
        if let Some(content) = result.and_then(|r| obj_str(r, "content")) {
            let parsed = parse_text_entries(&content);
            if !parsed.is_empty() {
                entries = parsed;
            }
        }
    }
    if entries.is_empty() {
        if let Some(observation) = result.and_then(|r| obj_str(r, "observation")) {
            let parsed = parse_text_entries(&observation);
            if !parsed.is_empty() {
                entries = parsed;
            }
        }
    }
    // Imported-history tool chunks carry their text in a string `output`
    // (the array-only filter above skips it deliberately).
    if entries.is_empty() {
        if let Some(output) = result.and_then(|r| obj_str(r, "output")) {
            let parsed = parse_text_entries(&output);
            if !parsed.is_empty() {
                entries = parsed;
            }
        }
    }

    let content_summary = if entries.is_empty() {
        result
            .and_then(|r| obj_str(r, "content"))
            .or_else(|| result.and_then(|r| obj_str(r, "output")))
    } else {
        None
    };

    ExtractedListDirData {
        directory,
        entries,
        content_summary,
    }
}
