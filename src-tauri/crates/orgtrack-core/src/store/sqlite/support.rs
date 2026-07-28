use rusqlite::{params, Connection};

use super::SqliteRecordStore;

/// Run the two-table file-resource write atomically without assuming whether
/// the caller already owns a transaction. SQLite savepoints work both inside
/// an existing transaction and in autocommit mode, so this hot-path upsert is
/// safely composable in larger reconciliation transactions.
pub(super) fn with_file_resource_savepoint<T>(
    conn: &Connection,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    const BEGIN: &str = "SAVEPOINT orgtrack_file_resource_write";
    const COMMIT: &str = "RELEASE SAVEPOINT orgtrack_file_resource_write";
    const ROLLBACK: &str = "ROLLBACK TO SAVEPOINT orgtrack_file_resource_write;
                            RELEASE SAVEPOINT orgtrack_file_resource_write";
    conn.execute_batch(BEGIN).map_err(|err| err.to_string())?;

    match operation() {
        Ok(value) => {
            conn.execute_batch(COMMIT).map_err(|err| err.to_string())?;
            Ok(value)
        }
        Err(operation_error) => {
            let rollback = conn.execute_batch(ROLLBACK);
            match rollback {
                Ok(()) => Err(operation_error),
                Err(rollback_error) => Err(format!(
                    "{operation_error}; failed to roll back store savepoint: {rollback_error}"
                )),
            }
        }
    }
}

impl SqliteRecordStore<'_> {
    pub(super) fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
        serde_json::to_string(value).map_err(|err| err.to_string())
    }

    pub(super) fn from_json<T: serde::de::DeserializeOwned>(value: String) -> Result<T, String> {
        serde_json::from_str(&value).map_err(|err| err.to_string())
    }

    pub(super) fn list_by_scope<T: serde::de::DeserializeOwned>(
        &self,
        table_name: &str,
        source: Option<&str>,
        session_id: Option<&str>,
        order_by: &str,
    ) -> Result<Vec<T>, String> {
        let mut records = Vec::new();
        let query = match (source, session_id) {
            (Some(_), Some(_)) => format!(
                "SELECT payload_json FROM {table_name} WHERE source = ?1 AND session_id = ?2 ORDER BY {order_by}"
            ),
            (Some(_), None) => format!(
                "SELECT payload_json FROM {table_name} WHERE source = ?1 ORDER BY {order_by}"
            ),
            (None, Some(_)) => format!(
                "SELECT payload_json FROM {table_name} WHERE session_id = ?1 ORDER BY {order_by}"
            ),
            (None, None) => format!("SELECT payload_json FROM {table_name} ORDER BY {order_by}"),
        };
        let mut stmt = self.conn.prepare(&query).map_err(|err| err.to_string())?;
        match (source, session_id) {
            (Some(source), Some(session_id)) => {
                let rows = stmt
                    .query_map(params![source, session_id], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (Some(source), None) => {
                let rows = stmt
                    .query_map(params![source], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (None, Some(session_id)) => {
                let rows = stmt
                    .query_map(params![session_id], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (None, None) => {
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
        }
        Ok(records)
    }
}
