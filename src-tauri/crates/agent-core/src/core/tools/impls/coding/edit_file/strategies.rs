//! Fuzzy search-and-replace strategies for the edit tool.
//!
//! 9 strategies tried in order:
//! 1. Simple — exact string match
//! 2. LineTrimmed — per-line `.trim()` comparison
//! 3. BlockAnchor — first/last line anchors + Levenshtein on middles
//! 4. WhitespaceNormalized — collapse all whitespace to single space
//! 5. IndentationFlexible — strip common indentation, then compare
//! 6. EscapeNormalized — unescape `\\n`, `\\t`, etc. before comparing
//! 7. TrimmedBoundary — `.trim()` the entire search string
//! 8. ContextAware — anchors + 50% exact middle-line match + same line count
//! 9. MultiOccurrence — yields all exact occurrences (for `replace_all`)

/// Try all 9 replacement strategies in order. Returns the new file content.
pub fn replace(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<String, String> {
    if old_string.is_empty() {
        return Err("old_string must not be empty".to_string());
    }

    if old_string == new_string {
        return Err("old_string and new_string are identical".to_string());
    }

    let replacers: &[fn(&str, &str) -> Vec<String>] = &[
        simple_replacer,
        line_trimmed_replacer,
        block_anchor_replacer,
        whitespace_normalized_replacer,
        indentation_flexible_replacer,
        escape_normalized_replacer,
        trimmed_boundary_replacer,
        context_aware_replacer,
        multi_occurrence_replacer,
    ];

    let mut not_found = true;
    let mut ambiguous_match_count = 0usize;

    for replacer in replacers {
        for search in replacer(content, old_string) {
            let index = content.find(&search);
            let Some(idx) = index else { continue };
            not_found = false;

            if replace_all {
                return Ok(content.replace(&search, new_string));
            }

            let last_idx = content.rfind(&search).unwrap_or(idx);
            if idx != last_idx {
                if ambiguous_match_count == 0 {
                    ambiguous_match_count = content.matches(&search).count();
                }
                continue;
            }

            let mut result = String::with_capacity(content.len() + new_string.len());
            result.push_str(&content[..idx]);
            result.push_str(new_string);
            result.push_str(&content[idx + search.len()..]);
            return Ok(result);
        }
    }

    if not_found {
        Err(
            "Could not find old_string in the file. It must match the file content \
             (whitespace, indentation, and line endings are matched flexibly). \
             Re-read the file and copy the exact text, without the line-number prefix."
                .to_string(),
        )
    } else {
        Err(format!(
            "Found {ambiguous_match_count} matches for old_string. To replace only one occurrence, \
             include more surrounding lines in old_string to make it unique. \
             To replace all {ambiguous_match_count} occurrences (e.g. renaming a symbol), \
             retry with replace_all: true.",
        ))
    }
}

// ── Strategy 1: Simple (exact match) ─────────────────────────────────────────

fn simple_replacer(_content: &str, find: &str) -> Vec<String> {
    vec![find.to_string()]
}

// ── Strategy 2: Line-trimmed ─────────────────────────────────────────────────

fn line_trimmed_replacer(content: &str, find: &str) -> Vec<String> {
    let original_lines: Vec<&str> = content.split('\n').collect();
    let mut search_lines: Vec<&str> = find.split('\n').collect();

    if search_lines.last().is_some_and(|line| line.is_empty()) {
        search_lines.pop();
    }

    if search_lines.is_empty() || search_lines.len() > original_lines.len() {
        return Vec::new();
    }

    let mut results = Vec::new();

    for window_start in 0..=original_lines.len() - search_lines.len() {
        let mut matches = true;
        for offset in 0..search_lines.len() {
            if original_lines[window_start + offset].trim() != search_lines[offset].trim() {
                matches = false;
                break;
            }
        }
        if matches {
            let matched_block: Vec<&str> = (0..search_lines.len())
                .map(|offset| original_lines[window_start + offset])
                .collect();
            results.push(matched_block.join("\n"));
        }
    }

    results
}

// ── Strategy 3: Block-anchor (Levenshtein) ───────────────────────────────────

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD: f64 = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD: f64 = 0.3;

pub(crate) fn levenshtein(source: &str, target: &str) -> usize {
    let source_chars: Vec<char> = source.chars().collect();
    let target_chars: Vec<char> = target.chars().collect();

    if source_chars.is_empty() {
        return target_chars.len();
    }
    if target_chars.is_empty() {
        return source_chars.len();
    }

    let target_len = target_chars.len();
    let mut prev_row: Vec<usize> = (0..=target_len).collect();
    let mut curr_row = vec![0usize; target_len + 1];

    for (source_idx, source_char) in source_chars.iter().enumerate() {
        curr_row[0] = source_idx + 1;
        for (target_idx, target_char) in target_chars.iter().enumerate() {
            let cost = if source_char == target_char { 0 } else { 1 };
            curr_row[target_idx + 1] = (prev_row[target_idx + 1] + 1)
                .min(curr_row[target_idx] + 1)
                .min(prev_row[target_idx] + cost);
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[target_len]
}

fn block_anchor_replacer(content: &str, find: &str) -> Vec<String> {
    let original_lines: Vec<&str> = content.split('\n').collect();
    let mut search_lines: Vec<&str> = find.split('\n').collect();

    if search_lines.len() < 3 {
        return Vec::new();
    }
    if search_lines.last().is_some_and(|line| line.is_empty()) {
        search_lines.pop();
    }
    if search_lines.len() < 3 {
        return Vec::new();
    }

    let first_line = search_lines[0].trim();
    let last_line = search_lines[search_lines.len() - 1].trim();
    let search_block_size = search_lines.len();

    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for start in 0..original_lines.len() {
        if original_lines[start].trim() != first_line {
            continue;
        }
        for (end, orig_line) in original_lines.iter().enumerate().skip(start + 2) {
            if orig_line.trim() == last_line {
                candidates.push((start, end));
                break;
            }
        }
    }

    if candidates.is_empty() {
        return Vec::new();
    }

    let compute_similarity = |start: usize, end: usize| -> f64 {
        let actual_block_size = end - start + 1;
        let middle_count = (search_block_size - 2).min(actual_block_size - 2);
        if middle_count == 0 {
            return 1.0;
        }
        let mut total_similarity = 0.0;
        let mut compared = 0usize;
        for offset in 1..search_block_size.min(actual_block_size) - 1 {
            let orig = original_lines[start + offset].trim();
            let search = search_lines[offset].trim();
            let max_len = orig.len().max(search.len());
            if max_len == 0 {
                compared += 1;
                total_similarity += 1.0;
                continue;
            }
            compared += 1;
            let dist = levenshtein(orig, search);
            total_similarity += 1.0 - dist as f64 / max_len as f64;
        }
        if compared == 0 {
            1.0
        } else {
            total_similarity / compared as f64
        }
    };

    let extract_block =
        |start: usize, end: usize| -> String { original_lines[start..=end].join("\n") };

    if candidates.len() == 1 {
        let (start, end) = candidates[0];
        let similarity = compute_similarity(start, end);
        if similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD {
            return vec![extract_block(start, end)];
        }
        return Vec::new();
    }

    let mut best: Option<(usize, usize)> = None;
    let mut max_similarity: f64 = -1.0;
    for (start, end) in &candidates {
        let similarity = compute_similarity(*start, *end);
        if similarity > max_similarity {
            max_similarity = similarity;
            best = Some((*start, *end));
        }
    }

    if max_similarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD {
        if let Some((start, end)) = best {
            return vec![extract_block(start, end)];
        }
    }

    Vec::new()
}

// ── Strategy 4: Whitespace-normalized ────────────────────────────────────────

fn normalize_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn whitespace_normalized_replacer(content: &str, find: &str) -> Vec<String> {
    let normalized_find = normalize_whitespace(find);
    let lines: Vec<&str> = content.split('\n').collect();
    let mut results = Vec::new();

    for line in &lines {
        if normalize_whitespace(line) == normalized_find {
            results.push(line.to_string());
        } else if normalize_whitespace(line).contains(&normalized_find) {
            let words: Vec<&str> = find.split_whitespace().collect();
            if !words.is_empty() {
                let pattern = words
                    .iter()
                    .map(|word| regex::escape(word))
                    .collect::<Vec<_>>()
                    .join(r"\s+");
                if let Ok(re) = regex::Regex::new(&pattern) {
                    if let Some(matched) = re.find(line) {
                        results.push(matched.as_str().to_string());
                    }
                }
            }
        }
    }

    let find_lines: Vec<&str> = find.split('\n').collect();
    if find_lines.len() > 1 && find_lines.len() <= lines.len() {
        for window_start in 0..=lines.len() - find_lines.len() {
            let block: Vec<&str> = lines[window_start..window_start + find_lines.len()].to_vec();
            if normalize_whitespace(&block.join("\n")) == normalized_find {
                results.push(block.join("\n"));
            }
        }
    }

    results
}

// ── Strategy 5: Indentation-flexible ─────────────────────────────────────────

fn remove_indentation(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let min_indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);

    lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                *line
            } else if line.len() >= min_indent {
                &line[min_indent..]
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn indentation_flexible_replacer(content: &str, find: &str) -> Vec<String> {
    let normalized_find = remove_indentation(find);
    let content_lines: Vec<&str> = content.split('\n').collect();
    let find_lines: Vec<&str> = find.split('\n').collect();
    let mut results = Vec::new();

    if find_lines.is_empty() || find_lines.len() > content_lines.len() {
        return results;
    }

    for window_start in 0..=content_lines.len() - find_lines.len() {
        let block = content_lines[window_start..window_start + find_lines.len()].join("\n");
        if remove_indentation(&block) == normalized_find {
            results.push(block);
        }
    }

    results
}

// ── Strategy 6: Escape-normalized ────────────────────────────────────────────

fn unescape_string(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek() {
                Some('n') => {
                    chars.next();
                    result.push('\n');
                }
                Some('t') => {
                    chars.next();
                    result.push('\t');
                }
                Some('r') => {
                    chars.next();
                    result.push('\r');
                }
                Some('\'') => {
                    chars.next();
                    result.push('\'');
                }
                Some('"') => {
                    chars.next();
                    result.push('"');
                }
                Some('`') => {
                    chars.next();
                    result.push('`');
                }
                Some('\\') => {
                    chars.next();
                    result.push('\\');
                }
                Some('\n') => {
                    chars.next();
                    result.push('\n');
                }
                Some('$') => {
                    chars.next();
                    result.push('$');
                }
                _ => result.push(ch),
            }
        } else {
            result.push(ch);
        }
    }

    result
}

fn escape_normalized_replacer(content: &str, find: &str) -> Vec<String> {
    let unescaped_find = unescape_string(find);
    if unescaped_find == find {
        return Vec::new();
    }

    let mut results = Vec::new();

    if content.contains(&unescaped_find) {
        results.push(unescaped_find);
    }

    results
}

// ── Strategy 7: Trimmed-boundary ─────────────────────────────────────────────

fn trimmed_boundary_replacer(content: &str, find: &str) -> Vec<String> {
    let trimmed = find.trim();
    if trimmed == find {
        return Vec::new();
    }

    let mut results = Vec::new();

    if content.contains(trimmed) {
        results.push(trimmed.to_string());
    }

    let lines: Vec<&str> = content.split('\n').collect();
    let find_lines: Vec<&str> = find.split('\n').collect();
    if find_lines.len() > 1 && find_lines.len() <= lines.len() {
        for window_start in 0..=lines.len() - find_lines.len() {
            let block = lines[window_start..window_start + find_lines.len()].join("\n");
            if block.trim() == trimmed {
                results.push(block);
            }
        }
    }

    results
}

// ── Strategy 8: Context-aware ────────────────────────────────────────────────

fn context_aware_replacer(content: &str, find: &str) -> Vec<String> {
    let mut find_lines: Vec<&str> = find.split('\n').collect();
    if find_lines.len() < 3 {
        return Vec::new();
    }
    if find_lines.last().is_some_and(|line| line.is_empty()) {
        find_lines.pop();
    }
    if find_lines.len() < 3 {
        return Vec::new();
    }

    let content_lines: Vec<&str> = content.split('\n').collect();
    let first_line = find_lines[0].trim();
    let last_line = find_lines[find_lines.len() - 1].trim();

    for start in 0..content_lines.len() {
        if content_lines[start].trim() != first_line {
            continue;
        }
        for end in (start + 2)..content_lines.len() {
            if content_lines[end].trim() != last_line {
                continue;
            }

            let block_lines = &content_lines[start..=end];

            if block_lines.len() != find_lines.len() {
                break;
            }

            let mut matching = 0;
            let mut total_non_empty = 0;
            for offset in 1..block_lines.len() - 1 {
                let block_line = block_lines[offset].trim();
                let find_line = find_lines[offset].trim();
                if !block_line.is_empty() || !find_line.is_empty() {
                    total_non_empty += 1;
                    if block_line == find_line {
                        matching += 1;
                    }
                }
            }

            if total_non_empty == 0 || (matching as f64 / total_non_empty as f64) >= 0.5 {
                return vec![block_lines.join("\n")];
            }

            break;
        }
    }

    Vec::new()
}

// ── Strategy 9: Multi-occurrence ─────────────────────────────────────────────

fn multi_occurrence_replacer(content: &str, find: &str) -> Vec<String> {
    let mut results = Vec::new();
    let mut start = 0;
    while let Some(idx) = content[start..].find(find) {
        let next = start + idx + find.len();
        if next <= start {
            break;
        }
        results.push(find.to_string());
        start = next;
    }
    results
}
