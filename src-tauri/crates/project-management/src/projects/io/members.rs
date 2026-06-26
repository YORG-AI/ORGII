//! Per-project member catalog.
//!
//! Per-project member IO.
//!
//! `MemberEntry` carries a few low-cardinality optional fields
//! (`github_username`, `last_commit_date`, `active`) that we pack into
//! the `extras_json` column so we don't have to widen the schema every
//! time a new optional attribute is added. Hot fields (`name`, `email`,
//! `avatar`, `kind`) get dedicated columns.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::helpers::{conn, map_db, now_ms};
use super::projects::read_project;
use crate::projects::types::{MemberEntry, MembersFile};
use git::util::run_git_with_retry;

const DEFAULT_MEMBER_KIND: &str = "member";

/// Number of git command retries when reading contributor history.
const GIT_RETRIES: u32 = 3;

/// Result of a `sync_members_from_git` invocation.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncMembersResult {
    pub added: u32,
    pub updated: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct MemberExtras {
    #[serde(skip_serializing_if = "Option::is_none")]
    github_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_commit_date: Option<String>,
    /// Persisted explicitly so the inactive state survives round trips.
    /// Defaults to `true` to match `MemberEntry::active`.
    #[serde(default = "default_active")]
    active: bool,
}

fn default_active() -> bool {
    true
}

pub fn read_members(project_id: &str) -> Result<MembersFile, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT id, display_name, email, avatar_url, extras_json
         FROM members
         WHERE project_id = ?1
         ORDER BY display_name COLLATE NOCASE",
    ))?;
    let rows = map_db(stmt.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    }))?;

    let mut members: Vec<MemberEntry> = Vec::new();
    for row in rows {
        let (id, name, email, avatar, extras_json) = map_db(row)?;
        // Silent fallback to `MemberExtras::default()` would silently
        // drop github_username / last_commit_date / active for a member
        // whose extras row is corrupted — the UI would render them as
        // never-active with no GitHub link. Warn so DB corruption is
        // visible while still showing the rest of the member entry.
        let extras: MemberExtras = match extras_json.as_deref() {
            Some(raw) => match serde_json::from_str::<MemberExtras>(raw) {
                Ok(v) => v,
                Err(err) => {
                    tracing::warn!(
                        member_id = %id,
                        error = %err,
                        raw_len = raw.len(),
                        "members::io: extras JSON parse failed; rendering member with default extras"
                    );
                    MemberExtras::default()
                }
            },
            None => MemberExtras::default(),
        };

        members.push(MemberEntry {
            id,
            name,
            email,
            avatar,
            github_username: extras.github_username,
            last_commit_date: extras.last_commit_date,
            active: extras.active,
        });
    }

    Ok(MembersFile { members })
}

pub fn write_members(project_id: &str, members: &MembersFile) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction())?;

    map_db(tx.execute(
        "DELETE FROM members WHERE project_id = ?1",
        params![project_id],
    ))?;

    let timestamp = now_ms();
    for entry in &members.members {
        let extras = MemberExtras {
            github_username: entry.github_username.clone(),
            last_commit_date: entry.last_commit_date.clone(),
            active: entry.active,
        };
        let extras_json = serde_json::to_string(&extras)
            .map_err(|err| format!("serialize member extras: {}", err))?;

        map_db(tx.execute(
            "INSERT INTO members
             (id, project_id, display_name, email, avatar_url, kind, extras_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                project_id,
                entry.name,
                entry.email,
                entry.avatar,
                DEFAULT_MEMBER_KIND,
                extras_json,
                timestamp,
            ],
        ))?;
    }

    map_db(tx.commit())?;
    Ok(())
}

// ============================================================================
// Git contributor sync
// ============================================================================

/// Generate a stable member ID from an email address.
///
/// Stable deterministic scheme so existing rows stay
/// addressable.
pub fn member_id_from_email(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.to_lowercase().as_bytes());
    let result = hasher.finalize();
    format!("user-{}", &format!("{:x}", result)[..8])
}

fn gravatar_url(email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.trim().to_lowercase().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("https://gravatar.com/avatar/{}?s=64&d=identicon", hash)
}

struct GitContributor {
    name: String,
    email: String,
}

fn parse_shortlog(output: &str) -> Vec<GitContributor> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() != 2 {
                return None;
            }
            let author = parts[1].trim();
            let bracket_start = author.rfind('<')?;
            let bracket_end = author.rfind('>')?;
            let name = author[..bracket_start].trim().to_string();
            let email = author[bracket_start + 1..bracket_end].trim().to_string();
            Some(GitContributor { name, email })
        })
        .collect()
}

fn last_commit_dates(repo_path: &Path) -> HashMap<String, String> {
    let Ok(output) = run_git_with_retry(
        repo_path,
        &["log", "--all", "--no-merges", "--format=%ae %aI"],
        GIT_RETRIES,
    ) else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut dates: HashMap<String, String> = HashMap::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(space_idx) = line.find(' ') {
            let email = line[..space_idx].to_lowercase();
            let iso_date = &line[space_idx + 1..];
            let date_only = if iso_date.len() >= 10 {
                &iso_date[..10]
            } else {
                iso_date
            };
            dates.entry(email).or_insert_with(|| date_only.to_string());
        }
    }
    dates
}

fn shortlog_from_repo(repo_path: &Path) -> Result<Vec<GitContributor>, String> {
    let output = run_git_with_retry(
        repo_path,
        &["shortlog", "-sne", "--all", "--no-merges"],
        GIT_RETRIES,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git shortlog failed at {}: {}",
            repo_path.display(),
            if stderr.is_empty() {
                "unknown error".to_string()
            } else {
                stderr
            }
        ));
    }
    Ok(parse_shortlog(&String::from_utf8_lossy(&output.stdout)))
}

/// Sync the member roster for a project from `git shortlog` of every
/// repository in `linked_repos`.
///
/// - Existing members keyed by email or generated id are preserved
///   (manual edits to `name`, `github_username`, custom avatars survive).
/// - Members not present in any repo's history are kept (they may have
///   been added by hand and never authored a commit).
/// - The aggregated list is written back via `write_members`, so the new
///   `last_commit_date` ordering takes effect immediately.
///
/// Returns counts of added / updated rows and the new total.
pub fn sync_members_from_git(project_slug: &str) -> Result<SyncMembersResult, String> {
    let project = read_project(project_slug)?;
    let project_id = project.meta.id.clone();

    let mut contributors: Vec<GitContributor> = Vec::new();
    let mut latest_dates: HashMap<String, String> = HashMap::new();
    for repo in &project.meta.linked_repos {
        if repo.is_empty() {
            continue;
        }
        let path = Path::new(repo);
        if !path.exists() {
            continue;
        }
        contributors.extend(shortlog_from_repo(path)?);
        for (email, iso) in last_commit_dates(path) {
            // Keep the most recent date across repos.
            latest_dates
                .entry(email)
                .and_modify(|cur| {
                    if iso > *cur {
                        *cur = iso.clone();
                    }
                })
                .or_insert(iso);
        }
    }

    let existing = read_members(&project_id)?;
    let mut by_email: HashMap<String, MemberEntry> = HashMap::new();
    let mut by_id: HashMap<String, MemberEntry> = HashMap::new();
    for member in &existing.members {
        if let Some(email) = &member.email {
            by_email.insert(email.to_lowercase(), member.clone());
        }
        by_id.insert(member.id.clone(), member.clone());
    }

    let mut added = 0u32;
    let mut updated = 0u32;
    let mut merged: Vec<MemberEntry> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    for contributor in &contributors {
        let email_lower = contributor.email.to_lowercase();
        let generated_id = member_id_from_email(&email_lower);

        if let Some(existing_member) = by_email.get(&email_lower) {
            let mut member = existing_member.clone();
            member.last_commit_date = latest_dates.get(&email_lower).cloned();
            if member.avatar.is_none()
                || member
                    .avatar
                    .as_ref()
                    .map(|av| av.starts_with("https://gravatar.com"))
                    .unwrap_or(false)
            {
                member.avatar = Some(gravatar_url(&contributor.email));
            }
            if seen_ids.insert(member.id.clone()) {
                merged.push(member);
                updated += 1;
            }
        } else if by_id.contains_key(&generated_id) {
            let mut member = by_id.get(&generated_id).unwrap().clone();
            member.email = Some(contributor.email.clone());
            member.last_commit_date = latest_dates.get(&email_lower).cloned();
            if seen_ids.insert(member.id.clone()) {
                merged.push(member);
                updated += 1;
            }
        } else {
            let member = MemberEntry {
                id: generated_id.clone(),
                name: contributor.name.clone(),
                email: Some(contributor.email.clone()),
                avatar: Some(gravatar_url(&contributor.email)),
                github_username: None,
                last_commit_date: latest_dates.get(&email_lower).cloned(),
                active: true,
            };
            seen_ids.insert(generated_id);
            merged.push(member);
            added += 1;
        }
    }

    for member in &existing.members {
        if !seen_ids.contains(&member.id) {
            merged.push(member.clone());
        }
    }

    merged.sort_by(|left, right| {
        let date_l = left.last_commit_date.as_deref().unwrap_or("");
        let date_r = right.last_commit_date.as_deref().unwrap_or("");
        date_r.cmp(date_l).then_with(|| left.name.cmp(&right.name))
    });

    let total = merged.len() as u32;
    write_members(&project_id, &MembersFile { members: merged })?;

    Ok(SyncMembersResult {
        added,
        updated,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::projects::write_project;
    use crate::projects::types::ProjectMeta;
    use test_helpers::test_env;

    fn fixture_project(meta_id: &str, name: &str) -> ProjectMeta {
        ProjectMeta {
            id: meta_id.to_string(),
            name: name.to_string(),
            org_id: "personal-org".to_string(),
            status: String::new(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: false,
            agent_defaults: None,
        }
    }

    #[test]
    fn read_members_for_unknown_project_is_empty() {
        let _sandbox = test_env::sandbox();
        let members = read_members("nope").expect("read");
        assert!(members.members.is_empty());
    }

    #[test]
    fn sync_members_from_git_uses_project_id_for_member_rows() {
        let _sandbox = test_env::sandbox();
        let mut meta = fixture_project("project-alpha", "Alpha");
        meta.linked_repos = vec![];
        write_project("alpha", &meta, "", true).expect("create");

        let result = sync_members_from_git("alpha").expect("sync");
        assert_eq!(result.total, 0);
        assert_eq!(result.added, 0);
        assert_eq!(result.updated, 0);

        let members = read_members("project-alpha").expect("read by project id");
        assert!(members.members.is_empty());
    }

    #[test]
    fn write_then_read_preserves_extras() {
        let _sandbox = test_env::sandbox();
        let meta = fixture_project("p1", "P1");
        write_project("p1", &meta, "", true).expect("create");

        let payload = MembersFile {
            members: vec![
                MemberEntry {
                    id: "u1".into(),
                    name: "Alice".into(),
                    email: Some("alice@example.com".into()),
                    avatar: Some("https://avatar/1".into()),
                    github_username: Some("alice".into()),
                    last_commit_date: Some("2026-04-20".into()),
                    active: true,
                },
                MemberEntry {
                    id: "u2".into(),
                    name: "Bob".into(),
                    email: None,
                    avatar: None,
                    github_username: None,
                    last_commit_date: None,
                    active: false,
                },
            ],
        };
        write_members("p1", &payload).expect("write");

        let back = read_members("p1").expect("read");
        assert_eq!(back.members.len(), 2);

        // Ordered alphabetically by display_name.
        let alice = &back.members[0];
        assert_eq!(alice.name, "Alice");
        assert_eq!(alice.github_username.as_deref(), Some("alice"));
        assert_eq!(alice.last_commit_date.as_deref(), Some("2026-04-20"));
        assert!(alice.active);

        let bob = &back.members[1];
        assert_eq!(bob.name, "Bob");
        assert_eq!(bob.github_username, None);
        assert!(!bob.active, "inactive flag must round-trip");
    }
}
