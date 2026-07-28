//! Pin the listing degradation ladder: per-entry 250-char description
//! cap, 8,000-char total budget with even truncation, and a names-only
//! floor that never drops entries.
use super::{SkillsLoader, SKILL_LISTING_CHAR_BUDGET, SKILL_LISTING_MAX_DESC_CHARS};
use crate::skills::loader::SkillListingEntry;

fn entry(name: &str, description: &str) -> SkillListingEntry {
    SkillListingEntry {
        name: name.to_string(),
        source: "workspace".to_string(),
        description: description.to_string(),
        available: true,
    }
}

fn listing_lines(rendered: &str) -> Vec<&str> {
    rendered
        .lines()
        .filter(|line| line.starts_with("- **"))
        .collect()
}

#[test]
fn per_entry_description_capped_at_250_chars() {
    let long_desc = "x".repeat(SKILL_LISTING_MAX_DESC_CHARS + 150);
    let entries = vec![entry("verbose", &long_desc)];
    let rendered =
        SkillsLoader::format_skill_listing_entries(&entries).expect("listing populated");
    let line = listing_lines(&rendered)[0];
    assert!(
        line.contains('\u{2026}'),
        "capped desc must end in ellipsis"
    );
    assert!(
        !rendered.contains(&long_desc),
        "full over-cap description must not be rendered",
    );
    // Desc portion is exactly the cap: strip prefix/suffix markup.
    let desc = line
        .strip_prefix("- **verbose** (workspace): ")
        .and_then(|rest| rest.strip_suffix(" [available]"))
        .expect("line keeps the standard markup");
    assert_eq!(desc.chars().count(), SKILL_LISTING_MAX_DESC_CHARS);
}

#[test]
fn total_budget_trims_descriptions_evenly() {
    let desc = "d".repeat(240);
    let entries: Vec<SkillListingEntry> = (0..50)
        .map(|i| entry(&format!("s-{i:03}"), &desc))
        .collect();
    let rendered =
        SkillsLoader::format_skill_listing_entries(&entries).expect("listing populated");
    let lines = listing_lines(&rendered);
    assert_eq!(lines.len(), 50, "no entry may be dropped");
    let total_chars: usize =
        lines.iter().map(|l| l.chars().count()).sum::<usize>() + lines.len() - 1;
    assert!(
        total_chars <= SKILL_LISTING_CHAR_BUDGET,
        "entry lines must fit the {SKILL_LISTING_CHAR_BUDGET}-char budget, got {total_chars}",
    );
    for line in &lines {
        assert!(
            line.ends_with(" [available]"),
            "trimmed lines keep full markup: {line}",
        );
        assert!(
            line.contains('\u{2026}'),
            "descriptions trimmed evenly: {line}"
        );
    }
}

#[test]
fn names_only_floor_never_drops_entries() {
    let desc = "d".repeat(240);
    let entries: Vec<SkillListingEntry> = (0..400)
        .map(|i| entry(&format!("s-{i:03}"), &desc))
        .collect();
    let rendered =
        SkillsLoader::format_skill_listing_entries(&entries).expect("listing populated");
    let lines = listing_lines(&rendered);
    assert_eq!(lines.len(), 400, "floor keeps every invocable name");
    for (i, line) in lines.iter().enumerate() {
        assert_eq!(
            *line,
            format!("- **s-{i:03}**"),
            "extreme pressure falls back to names only",
        );
    }
}

#[test]
fn under_budget_listing_keeps_full_descriptions() {
    let entries = vec![entry("alpha", "first"), entry("beta", "second")];
    let rendered =
        SkillsLoader::format_skill_listing_entries(&entries).expect("listing populated");
    assert!(rendered.contains("- **alpha** (workspace): first [available]"));
    assert!(rendered.contains("- **beta** (workspace): second [available]"));
}
