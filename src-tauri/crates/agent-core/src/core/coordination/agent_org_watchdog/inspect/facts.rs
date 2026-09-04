//! Machine-stable recovery facts and the fingerprints derived from them:
//! the per-fact digest, the fingerprint over a fact set, the corrupt
//! task-row facts read from SQLite, and the task-board snapshot hash.

use super::super::*;

/// A machine-stable recovery fact. Human-readable repair prose is excluded so
/// copy edits do not reset retry budgets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RecoveryRepairFact {
    kind: &'static str,
    fields: Vec<Option<String>>,
}

impl RecoveryRepairFact {
    pub(super) fn new(
        kind: &'static str,
        fields: impl IntoIterator<Item = Option<String>>,
    ) -> Self {
        Self {
            kind,
            fields: fields.into_iter().collect(),
        }
    }

    pub(super) fn marker(kind: &'static str) -> Self {
        Self::new(kind, std::iter::empty())
    }

    pub(super) fn digest(&self) -> String {
        fn write_bytes(hasher: &mut blake3::Hasher, bytes: &[u8]) {
            hasher.update(&(bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }

        let mut hasher = blake3::Hasher::new();
        write_bytes(&mut hasher, b"agent-org-recovery-fact-v1");
        write_bytes(&mut hasher, self.kind.as_bytes());
        hasher.update(&(self.fields.len() as u64).to_le_bytes());
        for field in &self.fields {
            match field {
                Some(value) => {
                    hasher.update(&[1]);
                    write_bytes(&mut hasher, value.as_bytes());
                }
                None => {
                    hasher.update(&[0]);
                }
            }
        }
        hasher.finalize().to_hex().to_string()
    }
}

pub(super) fn recovery_repair_fingerprint(facts: &[RecoveryRepairFact]) -> Option<String> {
    if facts.is_empty() {
        return None;
    }
    let mut digests = facts
        .iter()
        .map(RecoveryRepairFact::digest)
        .collect::<Vec<_>>();
    digests.sort();
    digests.dedup();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"agent-org-recovery-set-v1");
    hasher.update(&(digests.len() as u64).to_le_bytes());
    for digest in digests {
        hasher.update(&(digest.len() as u64).to_le_bytes());
        hasher.update(digest.as_bytes());
    }
    Some(hasher.finalize().to_hex().to_string())
}

pub(super) fn corrupt_task_repair_facts(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<RecoveryRepairFact>, String> {
    let task_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_tasks WHERE org_run_id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if task_count > crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS as i64 {
        return Ok(vec![RecoveryRepairFact::new(
            "task_run_limit_exceeded",
            [Some(task_count.to_string())],
        )]);
    }
    let predicate = agent_org_tasks::corrupt_task_row_predicate_sql();
    let dependency_json_max =
        crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    let metadata_max = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
    let sql = format!(
        "SELECT substr(id,1,1024), length(CAST(id AS BLOB)),
                substr(status,1,128),
                length(CAST(blocks_json AS BLOB)), hex(substr(blocks_json,1,1024)),
                length(CAST(blocked_by_json AS BLOB)), hex(substr(blocked_by_json,1,1024)),
                length(CAST(COALESCE(metadata_json,'') AS BLOB)),
                hex(substr(COALESCE(metadata_json,''),1,1024))
         FROM (
             SELECT id, subject, description, active_form, owner, status,
                    created_at, updated_at,
                    CASE WHEN length(CAST(blocks_json AS BLOB))<={dependency_json_max}
                         THEN blocks_json ELSE '!' END AS blocks_json,
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_tasks WHERE org_run_id=?1
         ) AS bounded_tasks
         WHERE {predicate}
         ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![run_id], |row| {
            Ok(RecoveryRepairFact::new(
                "corrupt_task_data",
                [
                    Some(row.get::<_, String>(0)?),
                    Some(row.get::<_, i64>(1)?.to_string()),
                    Some(row.get::<_, String>(2)?),
                    Some(row.get::<_, i64>(3)?.to_string()),
                    Some(row.get::<_, String>(4)?),
                    Some(row.get::<_, i64>(5)?.to_string()),
                    Some(row.get::<_, String>(6)?),
                    Some(row.get::<_, i64>(7)?.to_string()),
                    Some(row.get::<_, String>(8)?),
                ],
            ))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub(in crate::core::coordination::agent_org_watchdog) fn task_snapshot_fingerprint(
    tasks: &[Task],
) -> String {
    fn hash_field(hasher: &mut blake3::Hasher, field_kind: &str, value: &str) {
        hasher.update(&(field_kind.len() as u64).to_le_bytes());
        hasher.update(field_kind.as_bytes());
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }

    fn hash_list(hasher: &mut blake3::Hasher, field_kind: &str, values: &[String]) {
        hasher.update(&(field_kind.len() as u64).to_le_bytes());
        hasher.update(field_kind.as_bytes());
        hasher.update(&(values.len() as u64).to_le_bytes());
        for value in values {
            hash_field(hasher, "item", value);
        }
    }

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"agent-org-task-snapshot-v2");
    let mut ordered_tasks = tasks.iter().collect::<Vec<_>>();
    ordered_tasks.sort_by(|left, right| left.id.cmp(&right.id));
    hasher.update(&(ordered_tasks.len() as u64).to_le_bytes());
    for task in ordered_tasks {
        let mut blocked_by = task.blocked_by.clone();
        blocked_by.sort();
        blocked_by.dedup();
        let mut eligible_member_ids = agent_org_tasks::eligible_member_ids(task);
        eligible_member_ids.sort();
        eligible_member_ids.dedup();
        hash_field(&mut hasher, "task_id", &task.id);
        hash_field(&mut hasher, "status", task.status.as_wire());
        match task.owner.as_deref() {
            Some(owner) => hash_field(&mut hasher, "owner_some", owner),
            None => hash_field(&mut hasher, "owner_none", ""),
        }
        hash_list(&mut hasher, "blocked_by", &blocked_by);
        hash_list(&mut hasher, "eligible_member_ids", &eligible_member_ids);
        hash_field(&mut hasher, "updated_at", &task.updated_at);
    }
    hasher.finalize().to_hex().to_string()
}
