//! Database connection management for PostgreSQL and MySQL.
//!
//! Provides Tauri commands that the frontend TypeScript providers
//! (PostgresProvider, MySQLProvider) call via `invoke()`. Each engine
//! is gated behind a Cargo feature (`postgres`, `mysql`); both are
//! default-on so the production binary ships unchanged. A build with
//! `--no-default-features --features postgres` (or `mysql`) compiles
//! only the requested engine, dropping the other's driver crates.
//!
//! Uses sqlx connection pools behind the scenes.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
#[cfg(any(feature = "postgres", feature = "mysql"))]
use sqlx::{Column, Row, TypeInfo};
use tokio::sync::Mutex;

static POOLS: LazyLock<Mutex<HashMap<String, PoolEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MAX_POOLS: usize = 20;

#[allow(dead_code)] // Variant set is feature-gated; both off is a no-op build.
enum PoolEntry {
    #[cfg(feature = "postgres")]
    Postgres(sqlx::PgPool),
    #[cfg(feature = "mysql")]
    Mysql(sqlx::MySqlPool),
}

// ============================================
// Tauri-serializable result types
// ============================================

#[derive(Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
}

#[derive(Serialize, Deserialize)]
pub struct ExecuteResult {
    pub rows_affected: u64,
}

#[derive(Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String,
    pub row_count: Option<i64>,
}

#[derive(Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    pub auto_increment: bool,
}

// ============================================
// Helpers
// ============================================

#[cfg(feature = "postgres")]
fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> Vec<serde_json::Value> {
    let columns = row.columns();
    columns
        .iter()
        .map(|col| {
            let type_name = col.type_info().name();
            match type_name {
                "BOOL" => row
                    .try_get::<bool, _>(col.ordinal())
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null),
                "INT2" | "INT4" => row
                    .try_get::<i32, _>(col.ordinal())
                    .map(|v| serde_json::Value::Number(v.into()))
                    .unwrap_or(serde_json::Value::Null),
                "INT8" => row
                    .try_get::<i64, _>(col.ordinal())
                    .map(|v| serde_json::Value::Number(v.into()))
                    .unwrap_or(serde_json::Value::Null),
                "FLOAT4" | "FLOAT8" | "NUMERIC" => row
                    .try_get::<f64, _>(col.ordinal())
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null),
                "JSONB" | "JSON" => row
                    .try_get::<serde_json::Value, _>(col.ordinal())
                    .unwrap_or(serde_json::Value::Null),
                _ => row
                    .try_get::<String, _>(col.ordinal())
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null),
            }
        })
        .collect()
}

#[cfg(feature = "mysql")]
fn mysql_row_to_json(row: &sqlx::mysql::MySqlRow) -> Vec<serde_json::Value> {
    let columns = row.columns();
    columns
        .iter()
        .map(|col| {
            let type_name = col.type_info().name();
            match type_name {
                "BOOLEAN" | "TINYINT(1)" => row
                    .try_get::<bool, _>(col.ordinal())
                    .map(serde_json::Value::Bool)
                    .unwrap_or(serde_json::Value::Null),
                "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" => row
                    .try_get::<i32, _>(col.ordinal())
                    .map(|v| serde_json::Value::Number(v.into()))
                    .unwrap_or(serde_json::Value::Null),
                "BIGINT" => row
                    .try_get::<i64, _>(col.ordinal())
                    .map(|v| serde_json::Value::Number(v.into()))
                    .unwrap_or(serde_json::Value::Null),
                "FLOAT" | "DOUBLE" | "DECIMAL" => row
                    .try_get::<f64, _>(col.ordinal())
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null),
                "JSON" => row
                    .try_get::<serde_json::Value, _>(col.ordinal())
                    .unwrap_or(serde_json::Value::Null),
                _ => row
                    .try_get::<String, _>(col.ordinal())
                    .map(serde_json::Value::String)
                    .unwrap_or(serde_json::Value::Null),
            }
        })
        .collect()
}

// ============================================
// Tauri Commands
// ============================================

#[tauri::command]
pub async fn db_sql_connect(
    connection_id: String,
    db_type: String,
    connection_string: String,
) -> Result<(), String> {
    let mut pools = POOLS.lock().await;

    if pools.contains_key(&connection_id) {
        return Ok(());
    }

    // FIFO eviction
    if pools.len() >= MAX_POOLS {
        let first_key = pools.keys().next().cloned();
        if let Some(key) = first_key {
            pools.remove(&key);
        }
    }

    let entry = match db_type.as_str() {
        #[cfg(feature = "postgres")]
        "postgres" => {
            let pool = sqlx::PgPool::connect(&connection_string)
                .await
                .map_err(|err| format!("PostgreSQL connection failed: {err}"))?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|err| format!("PostgreSQL ping failed: {err}"))?;
            PoolEntry::Postgres(pool)
        }
        #[cfg(feature = "mysql")]
        "mysql" => {
            let pool = sqlx::MySqlPool::connect(&connection_string)
                .await
                .map_err(|err| format!("MySQL connection failed: {err}"))?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|err| format!("MySQL ping failed: {err}"))?;
            PoolEntry::Mysql(pool)
        }
        other => return Err(format!("Unsupported db_type: {other}")),
    };

    pools.insert(connection_id, entry);
    Ok(())
}

#[tauri::command]
pub async fn db_sql_disconnect(connection_id: String) -> Result<(), String> {
    let mut pools = POOLS.lock().await;
    if let Some(entry) = pools.remove(&connection_id) {
        match entry {
            #[cfg(feature = "postgres")]
            PoolEntry::Postgres(pool) => pool.close().await,
            #[cfg(feature = "mysql")]
            PoolEntry::Mysql(pool) => pool.close().await,
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn db_sql_query(connection_id: String, sql: String) -> Result<QueryResult, String> {
    let pools = POOLS.lock().await;
    let entry = pools
        .get(&connection_id)
        .ok_or_else(|| format!("No connection found for: {connection_id}"))?;

    match entry {
        #[cfg(feature = "postgres")]
        PoolEntry::Postgres(pool) => {
            let rows: Vec<sqlx::postgres::PgRow> = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|err| format!("Query failed: {err}"))?;

            let columns: Vec<String> = if rows.is_empty() {
                vec![]
            } else {
                rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect()
            };
            let row_count = rows.len();
            let json_rows: Vec<Vec<serde_json::Value>> = rows.iter().map(pg_row_to_json).collect();
            Ok(QueryResult {
                columns,
                rows: json_rows,
                row_count,
            })
        }
        #[cfg(feature = "mysql")]
        PoolEntry::Mysql(pool) => {
            let rows: Vec<sqlx::mysql::MySqlRow> = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|err| format!("Query failed: {err}"))?;

            let columns: Vec<String> = if rows.is_empty() {
                vec![]
            } else {
                rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect()
            };
            let row_count = rows.len();
            let json_rows: Vec<Vec<serde_json::Value>> =
                rows.iter().map(mysql_row_to_json).collect();
            Ok(QueryResult {
                columns,
                rows: json_rows,
                row_count,
            })
        }
    }
}

#[tauri::command]
pub async fn db_sql_execute(connection_id: String, sql: String) -> Result<ExecuteResult, String> {
    let pools = POOLS.lock().await;
    let entry = pools
        .get(&connection_id)
        .ok_or_else(|| format!("No connection found for: {connection_id}"))?;

    let rows_affected = match entry {
        #[cfg(feature = "postgres")]
        PoolEntry::Postgres(pool) => sqlx::query(&sql)
            .execute(pool)
            .await
            .map_err(|err| format!("Execute failed: {err}"))?
            .rows_affected(),
        #[cfg(feature = "mysql")]
        PoolEntry::Mysql(pool) => sqlx::query(&sql)
            .execute(pool)
            .await
            .map_err(|err| format!("Execute failed: {err}"))?
            .rows_affected(),
    };

    Ok(ExecuteResult { rows_affected })
}

#[tauri::command]
pub async fn db_sql_get_tables(connection_id: String) -> Result<Vec<TableInfo>, String> {
    let pools = POOLS.lock().await;
    let entry = pools
        .get(&connection_id)
        .ok_or_else(|| format!("No connection found for: {connection_id}"))?;

    match entry {
        #[cfg(feature = "postgres")]
        PoolEntry::Postgres(pool) => {
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT table_name, table_type \
                 FROM information_schema.tables \
                 WHERE table_schema = 'public' \
                   AND table_type IN ('BASE TABLE', 'VIEW') \
                 ORDER BY table_name",
            )
            .fetch_all(pool)
            .await
            .map_err(|err| format!("Failed to list tables: {err}"))?;

            Ok(rows
                .into_iter()
                .map(|(name, table_type)| TableInfo {
                    name,
                    table_type,
                    row_count: None,
                })
                .collect())
        }
        #[cfg(feature = "mysql")]
        PoolEntry::Mysql(pool) => {
            let rows: Vec<(String, String)> = sqlx::query_as(
                "SELECT TABLE_NAME, TABLE_TYPE \
                 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = DATABASE() \
                   AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
                 ORDER BY TABLE_NAME",
            )
            .fetch_all(pool)
            .await
            .map_err(|err| format!("Failed to list tables: {err}"))?;

            Ok(rows
                .into_iter()
                .map(|(name, table_type)| TableInfo {
                    name,
                    table_type,
                    row_count: None,
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn db_sql_get_table_schema(
    connection_id: String,
    table_name: String,
) -> Result<Vec<ColumnInfo>, String> {
    let pools = POOLS.lock().await;
    let entry = pools
        .get(&connection_id)
        .ok_or_else(|| format!("No connection found for: {connection_id}"))?;

    match entry {
        #[cfg(feature = "postgres")]
        PoolEntry::Postgres(pool) => {
            let rows: Vec<sqlx::postgres::PgRow> = sqlx::query(
                "SELECT \
                   c.column_name, \
                   COALESCE(c.udt_name, c.data_type) as data_type, \
                   c.is_nullable, \
                   c.column_default, \
                   CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk \
                 FROM information_schema.columns c \
                 LEFT JOIN ( \
                   SELECT ku.column_name \
                   FROM information_schema.table_constraints tc \
                   JOIN information_schema.key_column_usage ku \
                     ON tc.constraint_name = ku.constraint_name \
                     AND tc.table_schema = ku.table_schema \
                   WHERE tc.constraint_type = 'PRIMARY KEY' \
                     AND tc.table_schema = 'public' \
                     AND tc.table_name = $1 \
                 ) pk ON c.column_name = pk.column_name \
                 WHERE c.table_schema = 'public' \
                   AND c.table_name = $1 \
                 ORDER BY c.ordinal_position",
            )
            .bind(&table_name)
            .fetch_all(pool)
            .await
            .map_err(|err| format!("Failed to get schema: {err}"))?;

            Ok(rows
                .iter()
                .map(|row| {
                    let col_default: Option<String> = row.try_get("column_default").unwrap_or(None);
                    let is_auto = col_default
                        .as_ref()
                        .map(|d| d.contains("nextval"))
                        .unwrap_or(false);
                    ColumnInfo {
                        name: row.get("column_name"),
                        data_type: row
                            .try_get::<String, _>("data_type")
                            .unwrap_or_default()
                            .to_uppercase(),
                        nullable: row.try_get::<String, _>("is_nullable").unwrap_or_default()
                            == "YES",
                        primary_key: row.try_get::<bool, _>("is_pk").unwrap_or(false),
                        default_value: col_default,
                        auto_increment: is_auto,
                    }
                })
                .collect())
        }
        #[cfg(feature = "mysql")]
        PoolEntry::Mysql(pool) => {
            let rows: Vec<sqlx::mysql::MySqlRow> = sqlx::query(
                "SELECT \
                   COLUMN_NAME, \
                   COLUMN_TYPE, \
                   IS_NULLABLE, \
                   COLUMN_DEFAULT, \
                   COLUMN_KEY, \
                   EXTRA \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = DATABASE() \
                   AND TABLE_NAME = ? \
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(&table_name)
            .fetch_all(pool)
            .await
            .map_err(|err| format!("Failed to get schema: {err}"))?;

            Ok(rows
                .iter()
                .map(|row| ColumnInfo {
                    name: row.try_get("COLUMN_NAME").unwrap_or_default(),
                    data_type: row
                        .try_get::<String, _>("COLUMN_TYPE")
                        .unwrap_or_default()
                        .to_uppercase(),
                    nullable: row.try_get::<String, _>("IS_NULLABLE").unwrap_or_default() == "YES",
                    primary_key: row.try_get::<String, _>("COLUMN_KEY").unwrap_or_default()
                        == "PRI",
                    default_value: row.try_get("COLUMN_DEFAULT").unwrap_or(None),
                    auto_increment: row
                        .try_get::<String, _>("EXTRA")
                        .unwrap_or_default()
                        .contains("auto_increment"),
                })
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command in this module resolves a pooled connection first, so a
    /// test only needs an id that was never connected.
    fn unconnected_id(name: &str) -> String {
        format!("db-clients-test-never-connected-{name}")
    }

    /// The result payloads are plain serde DTOs without `Debug`, so unwrap the
    /// error side by hand rather than widening the production derives.
    fn err_of<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected an error, got Ok"),
            Err(err) => err,
        }
    }

    // ---------- connection lifecycle ----------

    #[tokio::test]
    async fn connect_rejects_an_unknown_engine_without_dialling_out() {
        let err = db_sql_connect(
            unconnected_id("engine"),
            "sqlite".to_string(),
            "sqlite:///tmp/whatever.db".to_string(),
        )
        .await
        .unwrap_err();

        assert_eq!(err, "Unsupported db_type: sqlite");
        // A rejected engine must not leave a half-registered pool entry
        // behind for later commands to find.
        assert!(POOLS.lock().await.get(&unconnected_id("engine")).is_none());
    }

    #[tokio::test]
    async fn connect_engine_name_matching_is_exact_and_case_sensitive() {
        for engine in ["Postgres", "POSTGRES", "postgresql", "MySQL", ""] {
            let err = db_sql_connect(
                unconnected_id("case"),
                engine.to_string(),
                "ignored".to_string(),
            )
            .await
            .unwrap_err();
            assert_eq!(err, format!("Unsupported db_type: {engine}"));
        }
    }

    #[tokio::test]
    async fn disconnect_is_a_no_op_for_an_unknown_connection() {
        // The frontend calls disconnect on teardown paths that may never have
        // connected; that must not surface an error to the user.
        assert_eq!(db_sql_disconnect(unconnected_id("disconnect")).await, Ok(()));
    }

    // ---------- unresolved-connection guards ----------

    #[tokio::test]
    async fn query_requires_an_established_connection() {
        let id = unconnected_id("query");
        let err = err_of(db_sql_query(id.clone(), "SELECT 1".to_string()).await);

        assert_eq!(err, format!("No connection found for: {id}"));
    }

    #[tokio::test]
    async fn execute_requires_an_established_connection() {
        let id = unconnected_id("execute");
        let err = err_of(db_sql_execute(id.clone(), "DELETE FROM t".to_string()).await);

        // The guard runs before the SQL is handed to any driver, so a
        // destructive statement against a dead connection is never sent.
        assert_eq!(err, format!("No connection found for: {id}"));
    }

    #[tokio::test]
    async fn get_tables_requires_an_established_connection() {
        let id = unconnected_id("tables");
        let err = err_of(db_sql_get_tables(id.clone()).await);

        assert_eq!(err, format!("No connection found for: {id}"));
    }

    #[tokio::test]
    async fn get_table_schema_requires_an_established_connection() {
        let id = unconnected_id("schema");
        let err = err_of(db_sql_get_table_schema(id.clone(), "users".to_string()).await);

        assert_eq!(err, format!("No connection found for: {id}"));
    }

    // ---------- wire contract ----------
    //
    // These structs cross the Tauri boundary with **no** `rename_all`, so the
    // JSON keys stay snake_case. `DatabaseCore`'s `PostgresProvider` /
    // `MySQLProvider` read `table_type`, `row_count`, `data_type`,
    // `primary_key`, `default_value` and `auto_increment` verbatim. Adding
    // `#[serde(rename_all = "camelCase")]` here — as the sibling `db_browser`
    // crate does — would silently produce `undefined` in both providers, so
    // the field names are pinned.

    /// Field names in sorted order — JSON object key order is not part of the
    /// contract, the set of names is.
    fn field_names(value: &serde_json::Value) -> Vec<&str> {
        let mut names: Vec<&str> = value
            .as_object()
            .expect("serializes to a JSON object")
            .keys()
            .map(String::as_str)
            .collect();
        names.sort_unstable();
        names
    }

    #[test]
    fn query_result_serializes_with_snake_case_keys() {
        let json = serde_json::to_value(QueryResult {
            columns: vec!["id".to_string()],
            rows: vec![vec![serde_json::json!(1)]],
            row_count: 1,
        })
        .expect("serialize");

        assert_eq!(field_names(&json), vec!["columns", "row_count", "rows"]);
        assert_eq!(json["rows"][0][0], serde_json::json!(1));
    }

    #[test]
    fn execute_result_serializes_with_snake_case_keys() {
        let json = serde_json::to_value(ExecuteResult { rows_affected: 7 }).expect("serialize");

        assert_eq!(field_names(&json), vec!["rows_affected"]);
        assert_eq!(json["rows_affected"], serde_json::json!(7));
    }

    #[test]
    fn table_info_serializes_with_snake_case_keys_and_nullable_row_count() {
        let json = serde_json::to_value(TableInfo {
            name: "users".to_string(),
            table_type: "VIEW".to_string(),
            row_count: None,
        })
        .expect("serialize");

        assert_eq!(field_names(&json), vec!["name", "row_count", "table_type"]);
        // The providers map `row_count ?? undefined`, so `null` must be sent
        // rather than the field being skipped.
        assert_eq!(json["row_count"], serde_json::Value::Null);
    }

    #[test]
    fn column_info_serializes_with_snake_case_keys() {
        let json = serde_json::to_value(ColumnInfo {
            name: "id".to_string(),
            data_type: "INT4".to_string(),
            nullable: false,
            primary_key: true,
            default_value: Some("nextval('users_id_seq')".to_string()),
            auto_increment: true,
        })
        .expect("serialize");

        assert_eq!(
            field_names(&json),
            vec![
                "auto_increment",
                "data_type",
                "default_value",
                "name",
                "nullable",
                "primary_key",
            ]
        );
    }
}
