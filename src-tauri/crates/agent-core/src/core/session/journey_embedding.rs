//! Durable embedding outbox for Journey annotations and confirmed facts.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JourneyEmbeddingKind {
    ReviewAnnotation,
    ConfirmedFact,
}
impl JourneyEmbeddingKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ReviewAnnotation => "review_annotation",
            Self::ConfirmedFact => "confirmed_fact",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JourneyEmbeddingJob {
    pub source_id: String,
    pub source_kind: JourneyEmbeddingKind,
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub fork_id: String,
    pub review_id: String,
    pub content: String,
    pub attempt: u64,
}

pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
"CREATE TABLE IF NOT EXISTS session_journey_embedding_outbox(source_id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,session_id TEXT NOT NULL,workspace_id TEXT,project_id TEXT,fork_id TEXT NOT NULL,review_id TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_journey_embedding_outbox_state ON session_journey_embedding_outbox(state,created_at);
CREATE TABLE IF NOT EXISTS session_journey_embedding_index(source_id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,session_id TEXT NOT NULL,workspace_id TEXT,project_id TEXT,fork_id TEXT NOT NULL,review_id TEXT NOT NULL,content TEXT NOT NULL,embedding BLOB NOT NULL,embedding_model TEXT NOT NULL,embedding_source TEXT NOT NULL,embedding_dimensions INTEGER NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")
}
fn scope(conn: &Connection, sid: &str) -> (Option<String>, Option<String>) {
    conn.query_row("SELECT m.workspace_id,s.project_id FROM agent_sessions s LEFT JOIN session_journey_metadata m ON m.session_id=s.session_id WHERE s.session_id=?1",[sid],|r|Ok((r.get(0)?,r.get(1)?))).optional().ok().flatten().unwrap_or((None,None))
}
pub fn enqueue(
    conn: &Connection,
    id: &str,
    kind: JourneyEmbeddingKind,
    sid: &str,
    fork: &str,
    review: &str,
    content: &str,
) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    let (ws, project) = scope(conn, sid);
    conn.execute("INSERT INTO session_journey_embedding_outbox(source_id,source_kind,session_id,workspace_id,project_id,fork_id,review_id,content,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued') ON CONFLICT(source_id) DO UPDATE SET content=excluded.content,workspace_id=excluded.workspace_id,project_id=excluded.project_id,state=CASE WHEN session_journey_embedding_outbox.content=excluded.content THEN session_journey_embedding_outbox.state ELSE 'queued' END,error=NULL,updated_at=CURRENT_TIMESTAMP",params![id,kind.as_str(),sid,ws,project,fork,review,content])?;
    crate::core::session::journey_review_queue::notify_review_queue();
    Ok(())
}
pub fn discard_review_annotation(conn: &Connection, review: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute("DELETE FROM session_journey_embedding_outbox WHERE review_id=?1 AND source_kind='review_annotation'",[review])?;
    conn.execute("DELETE FROM session_journey_embedding_index WHERE review_id=?1 AND source_kind='review_annotation'",[review])?;
    Ok(())
}
pub fn claim(conn: &mut Connection) -> rusqlite::Result<Option<JourneyEmbeddingJob>> {
    ensure_schema(conn)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let id:Option<String>=tx.query_row("SELECT source_id FROM session_journey_embedding_outbox WHERE state='queued' ORDER BY created_at LIMIT 1",[],|r|r.get(0)).optional()?;
    let Some(id) = id else {
        tx.commit()?;
        return Ok(None);
    };
    tx.execute("UPDATE session_journey_embedding_outbox SET state='running',attempt=attempt+1,error=NULL WHERE source_id=?1",[&id])?;
    let job=tx.query_row("SELECT source_id,source_kind,session_id,workspace_id,project_id,fork_id,review_id,content,attempt FROM session_journey_embedding_outbox WHERE source_id=?1",[&id],|r|{let k:String=r.get(1)?;Ok(JourneyEmbeddingJob{source_id:r.get(0)?,source_kind:if k=="confirmed_fact"{JourneyEmbeddingKind::ConfirmedFact}else{JourneyEmbeddingKind::ReviewAnnotation},session_id:r.get(2)?,workspace_id:r.get(3)?,project_id:r.get(4)?,fork_id:r.get(5)?,review_id:r.get(6)?,content:r.get(7)?,attempt:r.get::<_,i64>(8)? as u64})})?;
    tx.commit()?;
    Ok(Some(job))
}
pub fn complete(
    conn: &Connection,
    j: &JourneyEmbeddingJob,
    v: &[f32],
    model: &str,
    source: &str,
) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    let tx = conn.unchecked_transaction()?;
    let owned = tx.execute(
        "UPDATE session_journey_embedding_outbox SET state='completed',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE source_id=?1 AND state='running'",
        [&j.source_id],
    )?;
    if owned == 0 {
        tx.commit()?;
        return Ok(());
    }
    tx.execute(
        "INSERT INTO session_journey_embedding_index(source_id,source_kind,session_id,workspace_id,project_id,fork_id,review_id,content,embedding,embedding_model,embedding_source,embedding_dimensions) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(source_id) DO UPDATE SET content=excluded.content,embedding=excluded.embedding,embedding_model=excluded.embedding_model,embedding_source=excluded.embedding_source,embedding_dimensions=excluded.embedding_dimensions,updated_at=CURRENT_TIMESTAMP",
        params![j.source_id,j.source_kind.as_str(),j.session_id,j.workspace_id,j.project_id,j.fork_id,j.review_id,j.content,bytes,model,source,v.len() as i64],
    )?;
    tx.commit()
}

pub fn retry(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "UPDATE session_journey_embedding_outbox SET state='queued',error=NULL,updated_at=CURRENT_TIMESTAMP WHERE source_id=?1 AND state='failed'",
        [id],
    )?;
    crate::core::session::journey_review_queue::notify_review_queue();
    Ok(())
}

pub fn fail(conn: &Connection, id: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE session_journey_embedding_outbox SET state='failed',error=?2 WHERE source_id=?1",
        params![id, error],
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE agent_sessions(session_id TEXT PRIMARY KEY,project_id TEXT);CREATE TABLE session_journey_metadata(session_id TEXT PRIMARY KEY,workspace_id TEXT);INSERT INTO agent_sessions VALUES('s','p');INSERT INTO session_journey_metadata VALUES('s','w');").unwrap();
        c
    }
    #[test]
    fn kinds_are_scoped_and_discard_only_removes_annotation() {
        let mut c = db();
        enqueue(
            &c,
            "review:r",
            JourneyEmbeddingKind::ReviewAnnotation,
            "s",
            "f",
            "r",
            "draft",
        )
        .unwrap();
        enqueue(
            &c,
            "fact:x",
            JourneyEmbeddingKind::ConfirmedFact,
            "s",
            "f",
            "r",
            "fact",
        )
        .unwrap();
        let j = claim(&mut c).unwrap().unwrap();
        assert_eq!(
            (j.workspace_id.as_deref(), j.project_id.as_deref()),
            (Some("w"), Some("p"))
        );
        discard_review_annotation(&c, "r").unwrap();
        // A completion racing after discard cannot resurrect annotation data.
        complete(&c, &j, &[1., 2.], "m", "p/m/2").unwrap();
        let resurrected: i64 = c.query_row(
            "SELECT COUNT(*) FROM session_journey_embedding_index WHERE source_kind='review_annotation'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(resurrected, 0);
        let n:i64=c.query_row("SELECT COUNT(*) FROM session_journey_embedding_outbox WHERE source_kind='confirmed_fact'",[],|r|r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
