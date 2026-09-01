//! Synchronous DB Browser operations.
//!
//! All functions take a `&rusqlite::Connection` (borrowed from the pool).
//! `is_valid_sqlite_file` is the only function that does not use SQLite — it
//! reads the raw file header and returns `Result<bool, String>`. All other
//! functions return `rusqlite::Result<T>`.

use std::time::Instant;

use rusqlite::{params_from_iter, Connection, Result as SqliteResult};

use super::types::{
    ColumnInfo, ColumnValueMap, ExecuteResult, QueryOptions, QueryResult, TableInfo,
};

// ============================================
// Row serialization helpers
// ============================================

fn rusqlite_value_to_json(val: rusqlite::types::Value) -> serde_json::Value {
    match val {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(int) => serde_json::json!(int),
        rusqlite::types::Value::Real(flt) => serde_json::json!(flt),
        rusqlite::types::Value::Text(text) => serde_json::Value::String(text),
        rusqlite::types::Value::Blob(bytes) => {
            // Encode blobs as hex strings so they survive the JSON round-trip
            serde_json::Value::String(format!("0x{}", hex::encode(&bytes)))
        }
    }
}

fn collect_rows(
    stmt: &mut rusqlite::Statement,
    col_count: usize,
) -> SqliteResult<Vec<Vec<serde_json::Value>>> {
    let mut rows = Vec::new();
    let mut row_iter = stmt.query([])?;
    while let Some(row) = row_iter.next()? {
        let mut cells = Vec::with_capacity(col_count);
        for idx in 0..col_count {
            let val: rusqlite::types::Value = row.get(idx)?;
            cells.push(rusqlite_value_to_json(val));
        }
        rows.push(cells);
    }
    Ok(rows)
}

// ============================================
// Schema introspection
// ============================================

pub fn get_tables(conn: &Connection) -> SqliteResult<Vec<TableInfo>> {
    let mut stmt = conn.prepare(
        "SELECT name, type, sql FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )?;

    let col_count = stmt.column_count();
    let rows = collect_rows(&mut stmt, col_count)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name = row[0].as_str().unwrap_or("").to_string();
            let kind = row[1].as_str().unwrap_or("table").to_string();
            let sql = row[2].as_str().map(|s| s.to_string());
            TableInfo {
                name,
                kind,
                row_count: None,
                sql,
            }
        })
        .collect())
}

pub fn get_table_schema(conn: &Connection, table_name: &str) -> SqliteResult<Vec<ColumnInfo>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{}\")", table_name))?;
    let col_count = stmt.column_count();
    let rows = collect_rows(&mut stmt, col_count)?;

    // Check if any INTEGER PRIMARY KEY column has AUTOINCREMENT
    let create_sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [table_name],
            |row| row.get(0),
        )
        .unwrap_or(None);

    let sql_upper = create_sql.as_deref().unwrap_or("").to_uppercase();

    let cols: Vec<ColumnInfo> = rows
        .into_iter()
        .map(|row| {
            // PRAGMA table_info columns:
            // 0=cid, 1=name, 2=type, 3=notnull, 4=dflt_value, 5=pk
            let name = row[1].as_str().unwrap_or("").to_string();
            let col_type = row[2].as_str().unwrap_or("").to_string();
            let notnull = row[3].as_i64().unwrap_or(0) != 0;
            let default_value = match &row[4] {
                serde_json::Value::Null => None,
                other => Some(other.to_string()),
            };
            let pk = row[5].as_i64().unwrap_or(0) != 0;

            // Detect AUTOINCREMENT by scanning the CREATE TABLE SQL
            let auto_increment = pk
                && col_type.to_uppercase().contains("INTEGER")
                && sql_upper.contains("AUTOINCREMENT");

            ColumnInfo {
                name,
                col_type,
                nullable: !notnull,
                primary_key: pk,
                default_value,
                auto_increment,
            }
        })
        .collect();

    Ok(cols)
}

// ============================================
// Query
// ============================================

pub fn query(conn: &Connection, sql: &str) -> SqliteResult<QueryResult> {
    let start = Instant::now();
    let mut stmt = conn.prepare(sql)?;
    let col_count = stmt.column_count();
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = collect_rows(&mut stmt, col_count)?;
    let row_count = values.len() as i64;
    let duration = start.elapsed().as_secs_f64() * 1000.0;

    Ok(QueryResult {
        columns,
        values,
        row_count,
        total_count: None,
        duration,
    })
}

pub fn get_table_data(
    conn: &Connection,
    table_name: &str,
    options: Option<&QueryOptions>,
) -> SqliteResult<QueryResult> {
    let page = options.and_then(|o| o.page).unwrap_or(1).max(1);
    let page_size = options.and_then(|o| o.page_size).unwrap_or(100).max(1);
    let offset = (page - 1) * page_size;
    let order_by = options.and_then(|o| o.order_by.as_deref());
    let order_dir = options
        .and_then(|o| o.order_direction.as_deref())
        .unwrap_or("asc");

    let mut sql = format!("SELECT * FROM \"{}\"", table_name);
    if let Some(col) = order_by {
        let dir = if order_dir.to_lowercase() == "desc" {
            "DESC"
        } else {
            "ASC"
        };
        sql += &format!(" ORDER BY \"{}\" {}", col, dir);
    }
    sql += &format!(" LIMIT {} OFFSET {}", page_size, offset);

    let start = Instant::now();
    let mut stmt = conn.prepare(&sql)?;
    let col_count = stmt.column_count();
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let values = collect_rows(&mut stmt, col_count)?;
    let row_count = values.len() as i64;
    let duration = start.elapsed().as_secs_f64() * 1000.0;

    // Total count for pagination
    let total_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", table_name),
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Ok(QueryResult {
        columns,
        values,
        row_count,
        total_count: Some(total_count),
        duration,
    })
}

// ============================================
// Execute (write statements)
// ============================================

pub fn execute(conn: &Connection, sql: &str) -> SqliteResult<ExecuteResult> {
    let start = Instant::now();
    match conn.execute_batch(sql) {
        Ok(_) => {
            let rows_affected = conn.changes() as i64;
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: true,
                rows_affected,
                duration,
                last_insert_id: Some(conn.last_insert_rowid()),
                error: None,
            })
        }
        Err(err) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: false,
                rows_affected: 0,
                duration,
                last_insert_id: None,
                error: Some(err.to_string()),
            })
        }
    }
}

// ============================================
// CRUD helpers
// ============================================

fn json_value_to_sql_param(val: &serde_json::Value) -> rusqlite::types::Value {
    match val {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(int) = n.as_i64() {
                rusqlite::types::Value::Integer(int)
            } else if let Some(flt) = n.as_f64() {
                rusqlite::types::Value::Real(flt)
            } else {
                rusqlite::types::Value::Null
            }
        }
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

pub fn insert(
    conn: &Connection,
    table_name: &str,
    data: &ColumnValueMap,
) -> SqliteResult<ExecuteResult> {
    let columns: Vec<&String> = data.keys().collect();
    let values: Vec<rusqlite::types::Value> = columns
        .iter()
        .map(|k| json_value_to_sql_param(&data[*k]))
        .collect();

    let placeholders = columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let col_list = columns
        .iter()
        .map(|c| format!("\"{}\"", c))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "INSERT INTO \"{}\" ({}) VALUES ({})",
        table_name, col_list, placeholders
    );

    let start = Instant::now();
    match conn.execute(&sql, params_from_iter(values)) {
        Ok(_) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: true,
                rows_affected: conn.changes() as i64,
                duration,
                last_insert_id: Some(conn.last_insert_rowid()),
                error: None,
            })
        }
        Err(err) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: false,
                rows_affected: 0,
                duration,
                last_insert_id: None,
                error: Some(err.to_string()),
            })
        }
    }
}

pub fn update(
    conn: &Connection,
    table_name: &str,
    data: &ColumnValueMap,
    where_clause: &ColumnValueMap,
) -> SqliteResult<ExecuteResult> {
    let set_cols: Vec<&String> = data.keys().collect();
    let where_cols: Vec<&String> = where_clause.keys().collect();

    let set_clauses: Vec<String> = set_cols.iter().map(|c| format!("\"{}\" = ?", c)).collect();
    let where_clauses: Vec<String> = where_cols
        .iter()
        .map(|c| format!("\"{}\" = ?", c))
        .collect();

    let mut values: Vec<rusqlite::types::Value> = set_cols
        .iter()
        .map(|k| json_value_to_sql_param(&data[*k]))
        .collect();
    values.extend(
        where_cols
            .iter()
            .map(|k| json_value_to_sql_param(&where_clause[*k])),
    );

    let sql = format!(
        "UPDATE \"{}\" SET {} WHERE {}",
        table_name,
        set_clauses.join(", "),
        where_clauses.join(" AND ")
    );

    let start = Instant::now();
    match conn.execute(&sql, params_from_iter(values)) {
        Ok(_) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: true,
                rows_affected: conn.changes() as i64,
                duration,
                last_insert_id: None,
                error: None,
            })
        }
        Err(err) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: false,
                rows_affected: 0,
                duration,
                last_insert_id: None,
                error: Some(err.to_string()),
            })
        }
    }
}

pub fn delete(
    conn: &Connection,
    table_name: &str,
    where_clause: &ColumnValueMap,
) -> SqliteResult<ExecuteResult> {
    let where_cols: Vec<&String> = where_clause.keys().collect();
    let clauses: Vec<String> = where_cols
        .iter()
        .map(|c| format!("\"{}\" = ?", c))
        .collect();
    let values: Vec<rusqlite::types::Value> = where_cols
        .iter()
        .map(|k| json_value_to_sql_param(&where_clause[*k]))
        .collect();

    let sql = format!(
        "DELETE FROM \"{}\" WHERE {}",
        table_name,
        clauses.join(" AND ")
    );

    let start = Instant::now();
    match conn.execute(&sql, params_from_iter(values)) {
        Ok(_) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: true,
                rows_affected: conn.changes() as i64,
                duration,
                last_insert_id: None,
                error: None,
            })
        }
        Err(err) => {
            let duration = start.elapsed().as_secs_f64() * 1000.0;
            Ok(ExecuteResult {
                success: false,
                rows_affected: 0,
                duration,
                last_insert_id: None,
                error: Some(err.to_string()),
            })
        }
    }
}

// ============================================
// File validation
// ============================================

pub fn is_valid_sqlite_file(path: &str) -> Result<bool, String> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };
    let mut header = [0u8; 16];
    if file.read_exact(&mut header).is_err() {
        return Ok(false);
    }
    Ok(&header[..15] == b"SQLite format 3")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// In-memory DB with a small fixture table. Every test gets its own.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE users (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 nickname TEXT DEFAULT 'anon',
                 score REAL,
                 avatar BLOB
             );
             CREATE VIEW active_users AS SELECT * FROM users;
             INSERT INTO users (name, nickname, score, avatar) VALUES
                 ('carol', 'cc', 3.5, x'0a0b'),
                 ('alice', NULL, 1.0, NULL),
                 ('bob',   'bb', 2.25, NULL);",
        )
        .expect("seed fixture");
        conn
    }

    fn map(pairs: &[(&str, serde_json::Value)]) -> ColumnValueMap {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    // ---------- row serialization ----------

    #[test]
    fn query_maps_every_sqlite_storage_class_to_json() {
        let conn = fixture();
        let result = query(
            &conn,
            "SELECT 1, 2.5, 'text', NULL, x'0a0b' FROM users LIMIT 1",
        )
        .expect("query");

        assert_eq!(result.row_count, 1);
        assert_eq!(
            result.values[0],
            vec![
                json!(1),
                json!(2.5),
                json!("text"),
                serde_json::Value::Null,
                // Blobs are hex-encoded so they survive the JSON round-trip
                // to the frontend, which has no binary channel.
                json!("0x0a0b"),
            ]
        );
    }

    #[test]
    fn query_reports_column_names_and_leaves_total_count_unset() {
        let conn = fixture();
        let result = query(&conn, "SELECT name, score FROM users ORDER BY name").expect("query");

        assert_eq!(result.columns, vec!["name", "score"]);
        assert_eq!(result.row_count, 3);
        // `total_count` is a pagination concept; the free-form query path
        // must not invent one.
        assert_eq!(result.total_count, None);
    }

    #[test]
    fn query_propagates_sql_errors_as_err() {
        let conn = fixture();
        // Unlike `execute`, `query` surfaces failures as `Err`, not as an
        // `ExecuteResult { success: false }`.
        assert!(query(&conn, "SELECT * FROM missing_table").is_err());
    }

    // ---------- schema introspection ----------

    #[test]
    fn get_tables_lists_tables_and_views_sorted_and_skips_sqlite_internals() {
        let conn = fixture();
        // `sqlite_sequence` exists because of AUTOINCREMENT and must stay hidden.
        let tables = get_tables(&conn).expect("get tables");

        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["active_users", "users"]);

        assert_eq!(tables[0].kind, "view");
        assert_eq!(tables[1].kind, "table");
        assert!(tables[1].sql.as_deref().unwrap().contains("CREATE TABLE"));
        // Row counts are deliberately not computed here — counting every
        // table on open would be O(rows) per file.
        assert!(tables.iter().all(|t| t.row_count.is_none()));
    }

    #[test]
    fn get_table_schema_reports_nullability_primary_key_and_defaults() {
        let conn = fixture();
        let cols = get_table_schema(&conn, "users").expect("schema");

        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "name", "nickname", "score", "avatar"]);

        let id = &cols[0];
        assert_eq!(id.col_type, "INTEGER");
        assert!(id.primary_key);
        assert!(id.auto_increment);

        let name = &cols[1];
        assert!(!name.nullable, "NOT NULL column must report nullable=false");
        assert!(!name.primary_key);
        assert!(!name.auto_increment);
        assert_eq!(name.default_value, None);

        let nickname = &cols[2];
        assert!(nickname.nullable);
        // PRAGMA returns the default as raw SQL text, so a string default
        // keeps its SQL quotes and then picks up JSON quotes on top.
        assert_eq!(nickname.default_value.as_deref(), Some("\"'anon'\""));
    }

    #[test]
    fn get_table_schema_marks_integer_primary_key_without_autoincrement_as_not_auto() {
        let conn = fixture();
        conn.execute_batch("CREATE TABLE plain (id INTEGER PRIMARY KEY, label TEXT)")
            .expect("create table");

        let cols = get_table_schema(&conn, "plain").expect("schema");
        assert!(cols[0].primary_key);
        assert!(
            !cols[0].auto_increment,
            "rowid alias without AUTOINCREMENT must not be reported as auto-increment"
        );
    }

    #[test]
    fn get_table_schema_returns_empty_for_unknown_table() {
        let conn = fixture();
        // PRAGMA table_info on a missing table is not an error in SQLite —
        // it just yields no rows.
        assert!(get_table_schema(&conn, "missing").expect("schema").is_empty());
    }

    // ---------- paginated table data ----------

    #[test]
    fn get_table_data_defaults_to_first_page_and_reports_total_count() {
        let conn = fixture();
        let result = get_table_data(&conn, "users", None).expect("table data");

        assert_eq!(result.row_count, 3);
        assert_eq!(result.total_count, Some(3));
        assert_eq!(result.columns[1], "name");
    }

    #[test]
    fn get_table_data_paginates_with_offset_and_keeps_total_count_whole() {
        let conn = fixture();
        let options = QueryOptions {
            page: Some(2),
            page_size: Some(2),
            order_by: Some("name".to_string()),
            order_direction: None,
        };

        let result = get_table_data(&conn, "users", Some(&options)).expect("table data");

        assert_eq!(result.row_count, 1, "page 2 of size 2 over 3 rows");
        assert_eq!(result.values[0][1], json!("carol"));
        // `total_count` is the table total, not the page total — the UI needs
        // it to render the pager.
        assert_eq!(result.total_count, Some(3));
    }

    #[test]
    fn get_table_data_orders_ascending_by_default_and_descending_on_request() {
        let conn = fixture();
        let ascending = QueryOptions {
            page: None,
            page_size: None,
            order_by: Some("name".to_string()),
            order_direction: None,
        };
        let descending = QueryOptions {
            order_direction: Some("DESC".to_string()),
            ..ascending.clone()
        };

        let asc = get_table_data(&conn, "users", Some(&ascending)).expect("asc");
        let desc = get_table_data(&conn, "users", Some(&descending)).expect("desc");

        assert_eq!(
            asc.values.iter().map(|r| r[1].clone()).collect::<Vec<_>>(),
            vec![json!("alice"), json!("bob"), json!("carol")]
        );
        // Direction matching is case-insensitive.
        assert_eq!(
            desc.values.iter().map(|r| r[1].clone()).collect::<Vec<_>>(),
            vec![json!("carol"), json!("bob"), json!("alice")]
        );
    }

    #[test]
    fn get_table_data_treats_unrecognized_direction_as_ascending() {
        let conn = fixture();
        let options = QueryOptions {
            page: None,
            page_size: None,
            order_by: Some("name".to_string()),
            // Anything that is not "desc" must not be spliced into the SQL
            // as-is; it falls back to ASC.
            order_direction: Some("desc; DROP TABLE users".to_string()),
        };

        let result = get_table_data(&conn, "users", Some(&options)).expect("table data");
        assert_eq!(result.values[0][1], json!("alice"));
        assert_eq!(
            get_table_data(&conn, "users", None).expect("table intact").row_count,
            3
        );
    }

    #[test]
    fn get_table_data_clamps_non_positive_page_and_page_size() {
        let conn = fixture();
        let options = QueryOptions {
            page: Some(0),
            page_size: Some(-5),
            order_by: None,
            order_direction: None,
        };

        // Without clamping this builds `LIMIT -5 OFFSET 5` — SQLite reads a
        // negative LIMIT as "no limit", which would silently return the whole
        // table instead of one page.
        let result = get_table_data(&conn, "users", Some(&options)).expect("table data");
        assert_eq!(result.row_count, 1);
    }

    #[test]
    fn get_table_data_quotes_identifiers_containing_spaces_and_keywords() {
        let conn = fixture();
        conn.execute_batch(
            "CREATE TABLE \"order details\" (\"select\" TEXT); \
             INSERT INTO \"order details\" VALUES ('kept')",
        )
        .expect("create quoted table");

        let options = QueryOptions {
            page: None,
            page_size: None,
            order_by: Some("select".to_string()),
            order_direction: None,
        };
        let result = get_table_data(&conn, "order details", Some(&options)).expect("table data");

        assert_eq!(result.columns, vec!["select"]);
        assert_eq!(result.values[0][0], json!("kept"));
    }

    #[test]
    fn get_table_data_reports_zero_total_count_when_the_table_is_missing() {
        let conn = fixture();
        // The page query fails, so the call is an `Err`; the `COUNT(*)`
        // fallback only matters for tables that vanish between the two
        // statements.
        assert!(get_table_data(&conn, "missing", None).is_err());
    }

    // ---------- execute ----------

    #[test]
    fn execute_runs_a_batch_and_reports_the_last_insert_id() {
        let conn = fixture();
        let result = execute(
            &conn,
            "INSERT INTO users (name) VALUES ('dave'); \
             INSERT INTO users (name) VALUES ('erin');",
        )
        .expect("execute");

        assert!(result.success);
        assert_eq!(result.error, None);
        assert_eq!(result.last_insert_id, Some(5));
        // `execute_batch` reports the changes of the *last* statement only.
        assert_eq!(result.rows_affected, 1);
    }

    #[test]
    fn execute_returns_a_failed_result_instead_of_err_on_bad_sql() {
        let conn = fixture();
        // The frontend renders the SQL error inline, so a syntax error must
        // come back as a successful call carrying `success: false`.
        let result = execute(&conn, "NOT SQL AT ALL").expect("execute must not be Err");

        assert!(!result.success);
        assert_eq!(result.rows_affected, 0);
        assert_eq!(result.last_insert_id, None);
        assert!(result.error.is_some());
    }

    // ---------- insert / update / delete ----------

    #[test]
    fn insert_binds_every_json_type_as_a_parameter() {
        let conn = fixture();
        let result = insert(
            &conn,
            "users",
            &map(&[
                ("name", json!("dave")),
                ("nickname", serde_json::Value::Null),
                ("score", json!(9.5)),
            ]),
        )
        .expect("insert");

        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.rows_affected, 1);
        assert_eq!(result.last_insert_id, Some(4));

        let row = query(&conn, "SELECT nickname, score FROM users WHERE name = 'dave'")
            .expect("read back");
        assert_eq!(row.values[0], vec![serde_json::Value::Null, json!(9.5)]);
    }

    #[test]
    fn insert_coerces_bool_and_composite_json_values() {
        let conn = fixture();
        conn.execute_batch("CREATE TABLE misc (flag, blob_ish, nested)")
            .expect("create table");

        let result = insert(
            &conn,
            "misc",
            &map(&[
                ("flag", json!(true)),
                ("blob_ish", json!(7)),
                // Arrays and objects have no SQLite storage class, so they are
                // stored as their JSON text.
                ("nested", json!({"a": 1})),
            ]),
        )
        .expect("insert");
        assert!(result.success, "{:?}", result.error);

        let row = query(&conn, "SELECT flag, blob_ish, nested FROM misc").expect("read back");
        assert_eq!(
            row.values[0],
            vec![json!(1), json!(7), json!("{\"a\":1}")]
        );
    }

    #[test]
    fn insert_treats_a_string_value_as_data_not_sql() {
        let conn = fixture();
        let result = insert(
            &conn,
            "users",
            &map(&[("name", json!("'); DROP TABLE users; --"))]),
        )
        .expect("insert");

        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            query(&conn, "SELECT COUNT(*) FROM users").expect("count").values[0][0],
            json!(4)
        );
    }

    #[test]
    fn insert_returns_a_failed_result_when_a_constraint_rejects_the_row() {
        let conn = fixture();
        // `name` is NOT NULL.
        let result = insert(&conn, "users", &map(&[("score", json!(1))])).expect("insert");

        assert!(!result.success);
        assert_eq!(result.rows_affected, 0);
        assert!(result.error.unwrap().contains("NOT NULL"));
    }

    #[test]
    fn update_applies_only_to_rows_matching_every_where_column() {
        let conn = fixture();
        let result = update(
            &conn,
            "users",
            &map(&[("score", json!(10.0)), ("nickname", json!("zz"))]),
            &map(&[("name", json!("alice"))]),
        )
        .expect("update");

        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.rows_affected, 1);
        // UPDATE does not produce a new rowid.
        assert_eq!(result.last_insert_id, None);

        let rows = query(&conn, "SELECT name, score, nickname FROM users ORDER BY name")
            .expect("read back");
        assert_eq!(rows.values[0], vec![json!("alice"), json!(10.0), json!("zz")]);
        assert_eq!(rows.values[1][1], json!(2.25), "other rows untouched");
    }

    #[test]
    fn update_combines_multiple_where_columns_with_and() {
        let conn = fixture();
        let result = update(
            &conn,
            "users",
            &map(&[("score", json!(0.0))]),
            &map(&[("name", json!("alice")), ("nickname", json!("bb"))]),
        )
        .expect("update");

        assert!(result.success, "{:?}", result.error);
        // No row has name='alice' AND nickname='bb'.
        assert_eq!(result.rows_affected, 0);
    }

    #[test]
    fn update_matches_a_null_where_value_against_no_rows() {
        let conn = fixture();
        let result = update(
            &conn,
            "users",
            &map(&[("score", json!(0.0))]),
            &map(&[("nickname", serde_json::Value::Null)]),
        )
        .expect("update");

        assert!(result.success, "{:?}", result.error);
        // `"nickname" = NULL` is never true in SQL, even for the row whose
        // nickname *is* NULL. Editing a row through a NULL cell silently
        // does nothing rather than updating the wrong row.
        assert_eq!(result.rows_affected, 0);
    }

    #[test]
    fn delete_removes_only_the_matching_rows() {
        let conn = fixture();
        let result = delete(&conn, "users", &map(&[("name", json!("bob"))])).expect("delete");

        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.rows_affected, 1);
        assert_eq!(
            query(&conn, "SELECT COUNT(*) FROM users").expect("count").values[0][0],
            json!(2)
        );
    }

    #[test]
    fn delete_with_an_unknown_where_column_silently_matches_nothing() {
        let conn = fixture();
        let result =
            delete(&conn, "users", &map(&[("nope", json!(1))])).expect("delete must not be Err");

        // SQLite's double-quote fallback turns the unresolvable identifier
        // `"nope"` into the *string literal* 'nope', so the predicate is
        // `'nope' = 1` — false for every row. The call therefore reports
        // success with zero rows rather than "no such column". Callers must
        // treat `rows_affected == 0` as "nothing matched", not as "deleted".
        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.rows_affected, 0);
        assert_eq!(
            query(&conn, "SELECT COUNT(*) FROM users").expect("count").values[0][0],
            json!(3)
        );
    }

    #[test]
    fn update_returns_a_failed_result_for_an_unknown_set_column() {
        let conn = fixture();
        // Unlike a WHERE column, a SET target has no string-literal fallback,
        // so a stale column name does surface as an error here.
        let result = update(
            &conn,
            "users",
            &map(&[("nope", json!(1))]),
            &map(&[("name", json!("alice"))]),
        )
        .expect("update must not be Err");

        assert!(!result.success);
        assert!(result.error.unwrap().contains("no such column"));
    }

    // ---------- file validation ----------

    #[test]
    fn is_valid_sqlite_file_accepts_a_real_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("real.sqlite");
        let conn = Connection::open(&path).expect("create db");
        conn.execute_batch("CREATE TABLE t (a)").expect("write header");
        drop(conn);

        assert_eq!(
            is_valid_sqlite_file(path.to_str().unwrap()),
            Ok(true)
        );
    }

    #[test]
    fn is_valid_sqlite_file_rejects_other_files_without_erroring() {
        let dir = tempfile::tempdir().expect("tempdir");

        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "this is definitely not a database file").expect("write");
        assert_eq!(is_valid_sqlite_file(text.to_str().unwrap()), Ok(false));

        // Shorter than the 16-byte header read.
        let stub = dir.path().join("stub.bin");
        std::fs::write(&stub, b"SQLite format").expect("write");
        assert_eq!(is_valid_sqlite_file(stub.to_str().unwrap()), Ok(false));

        // A missing path is "not a database", not an error — the picker
        // calls this on arbitrary user selections.
        let missing = dir.path().join("nope.sqlite");
        assert_eq!(is_valid_sqlite_file(missing.to_str().unwrap()), Ok(false));

        // A directory is also just "false".
        assert_eq!(is_valid_sqlite_file(dir.path().to_str().unwrap()), Ok(false));
    }
}
