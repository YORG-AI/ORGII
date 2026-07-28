//! Per-turn skill listing rendering: entries, budgeted description
//! truncation, and the `always: true` skills manifest.

use super::SkillsLoader;
use super::super::types::{SkillInfo, SkillListingEntry};

// Listing budget mirrors the reference harness: the listing exists for
// discovery only (full bodies load via the `skill` tool), so verbose
// descriptions waste first-request cache-creation tokens without improving
// match rate. Budget is in chars (~2K tokens); applies to the entry lines,
// not the fixed preamble.
pub(super) const SKILL_LISTING_CHAR_BUDGET: usize = 8_000;
pub(super) const SKILL_LISTING_MAX_DESC_CHARS: usize = 250;
const SKILL_LISTING_MIN_DESC_CHARS: usize = 20;

impl SkillsLoader {
    /// Get skills marked as "always" loaded (must also be available and enabled).
    pub fn get_always_skills(&self) -> Vec<SkillInfo> {
        self.list_skills()
            .into_iter()
            .filter(|skill| skill.always && skill.available && skill.enabled)
            .collect()
    }

    /// Build a stable manifest for `always: true` skills.
    ///
    /// The manifest gives the model each skill's name, description, and
    /// `SKILL.md` path. It intentionally does not inline full skill bodies;
    /// those are loaded on demand through `read_file` only after the model
    /// decides the skill is needed.
    pub fn build_always_skills_manifest_section(
        &self,
        disabled_skills: &[String],
        include_filter: Option<&[String]>,
    ) -> Vec<String> {
        let is_allowed = |name: &str| -> bool {
            if disabled_skills.iter().any(|disabled| disabled == name) {
                return false;
            }
            if let Some(includes) = include_filter {
                return includes.iter().any(|included| included == name);
            }
            true
        };

        let always_skills: Vec<_> = self
            .get_always_skills()
            .into_iter()
            .filter(|skill| is_allowed(&skill.name))
            .collect();

        if always_skills.is_empty() {
            return Vec::new();
        }

        let lines: Vec<String> = always_skills
            .iter()
            .map(|skill| {
                let description = if skill.description.is_empty() {
                    "No description".to_string()
                } else {
                    skill.description.clone()
                };
                format!(
                    "- **{}** ({}): {} — load it with the `skill` tool before applying.",
                    skill.name, skill.source, description,
                )
            })
            .collect();

        vec![format!(
            "# Active Skills\n\n\
             The skills below are always available for this session. Their full SKILL.md bodies are not inlined here to keep the prompt cache stable.\n\
             Before applying one, load it with the `skill` tool (skill: \"<name>\") and follow it exactly.\n\n\
             {}",
            lines.join("\n")
        )]
    }

    /// Build the per-turn skill listing entries.
    pub fn build_skill_listing_entries(
        &self,
        disabled_skills: &[String],
        include_filter: Option<&[String]>,
    ) -> Vec<SkillListingEntry> {
        let is_allowed = |name: &str| -> bool {
            if disabled_skills.iter().any(|d| d == name) {
                return false;
            }
            if let Some(includes) = include_filter {
                return includes.iter().any(|inc| inc == name);
            }
            true
        };

        let mut entries: Vec<SkillListingEntry> = self
            .list_skills()
            .into_iter()
            .filter(|skill| skill.enabled && skill.available && is_allowed(&skill.name))
            .map(|skill| SkillListingEntry {
                name: skill.name,
                source: skill.source,
                description: skill.description,
                available: skill.available,
            })
            .collect();
        // fs scan order is platform-dependent; sort so the rendered listing
        // is byte-stable across requests (it is re-sent every request).
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries
    }

    pub fn format_skill_listing_entries(entries: &[SkillListingEntry]) -> Option<String> {
        if entries.is_empty() {
            return None;
        }

        let lines = Self::render_listing_lines_within_budget(entries);
        Some(format!(
            "Skills relevant to your task:\n\
             BLOCKING REQUIREMENT: scan the skill descriptions below BEFORE generating any other response. \
             If a skill matches the task, you MUST load it with the `skill` tool (skill: \"<name>\") and follow it before answering — \
             skills encode workspace-specific conventions that override your defaults. \
             NEVER mention or apply a skill without loading it first.\n\
             - If exactly one skill matches: load it, then follow it.\n\
             - If multiple could apply: choose the most specific one, then load/follow it.\n\
             - Only skip loading when no skill plausibly relates to the task.\n\
             Constraints: never load more than one skill up front; only load after selecting.\n\n\
             {}",
            lines.join("\n")
        ))
    }

    fn listing_entry_description(entry: &SkillListingEntry) -> String {
        let desc = if entry.description.is_empty() {
            "No description"
        } else {
            entry.description.as_str()
        };
        truncate_listing_text(desc, SKILL_LISTING_MAX_DESC_CHARS)
    }

    fn render_listing_line(entry: &SkillListingEntry, desc: &str) -> String {
        let status = if entry.available {
            "available"
        } else {
            "unavailable"
        };
        format!(
            "- **{}** ({}): {} [{}]",
            entry.name, entry.source, desc, status,
        )
    }

    /// Degradation ladder for the listing lines: full (per-entry capped)
    /// descriptions if they fit the total budget, otherwise descriptions
    /// truncated evenly, otherwise names only. Entries are never dropped —
    /// the model must see every invocable name.
    fn render_listing_lines_within_budget(entries: &[SkillListingEntry]) -> Vec<String> {
        let full: Vec<String> = entries
            .iter()
            .map(|entry| Self::render_listing_line(entry, &Self::listing_entry_description(entry)))
            .collect();
        let total_chars: usize = full.iter().map(|line| line.chars().count()).sum::<usize>()
            + full.len().saturating_sub(1);
        if total_chars <= SKILL_LISTING_CHAR_BUDGET {
            return full;
        }

        // Over budget: split the remaining space evenly across descriptions.
        let overhead: usize = entries
            .iter()
            .map(|entry| Self::render_listing_line(entry, "").chars().count())
            .sum::<usize>()
            + entries.len().saturating_sub(1);
        let available_for_descs = SKILL_LISTING_CHAR_BUDGET.saturating_sub(overhead);
        let max_desc_chars = available_for_descs / entries.len();
        if max_desc_chars < SKILL_LISTING_MIN_DESC_CHARS {
            return entries
                .iter()
                .map(|entry| format!("- **{}**", entry.name))
                .collect();
        }
        entries
            .iter()
            .map(|entry| {
                let desc =
                    truncate_listing_text(&Self::listing_entry_description(entry), max_desc_chars);
                Self::render_listing_line(entry, &desc)
            })
            .collect()
    }

    /// Build the per-turn skill listing attachment.
    pub fn build_skill_listing_attachment(
        &self,
        disabled_skills: &[String],
        include_filter: Option<&[String]>,
    ) -> Option<String> {
        let entries = self.build_skill_listing_entries(disabled_skills, include_filter);
        Self::format_skill_listing_entries(&entries)
    }
}

/// Char-boundary-safe truncation with a trailing ellipsis; byte slicing
/// would panic on multi-byte UTF-8.
fn truncate_listing_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{cut}\u{2026}")
}
