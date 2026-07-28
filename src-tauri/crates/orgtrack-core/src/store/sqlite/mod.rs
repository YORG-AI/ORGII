use rusqlite::Connection;

mod provenance;
mod record_store;
mod schema;
mod support;
mod usage;

#[cfg(test)]
mod tests;

pub struct SqliteRecordStore<'conn> {
    conn: &'conn Connection,
}

impl<'conn> SqliteRecordStore<'conn> {
    pub fn new(conn: &'conn Connection) -> Self {
        Self { conn }
    }
}
