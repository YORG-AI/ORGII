//! Firefox cookie reader.
//!
//! Firefox stores cookies in `cookies.sqlite` (`moz_cookies` table) as
//! **plaintext** values on every platform, so no key material or keychain
//! access is required. This makes Firefox the one importable source that works
//! identically on macOS, Windows, and Linux.

use std::path::Path;

use super::{CookieReadError, DecryptedCookie, SameSite};

/// Firefox `moz_cookies.sameSite`: 0 = None, 1 = Lax, 2 = Strict.
fn same_site_from_firefox(raw: i64) -> SameSite {
    match raw {
        1 => SameSite::Lax,
        2 => SameSite::Strict,
        0 => SameSite::None,
        _ => SameSite::Unspecified,
    }
}

/// Read every cookie from a Firefox `cookies.sqlite` file.
///
/// The database is opened through a temporary copy by the caller-agnostic
/// [`super::open_sqlite_readonly`] helper so a running Firefox holding a write
/// lock does not block the import.
pub fn read_cookies(store_path: &Path) -> Result<Vec<DecryptedCookie>, CookieReadError> {
    let connection = super::open_sqlite_readonly(store_path)?;

    let mut statement = connection
        .prepare(
            "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite \
             FROM moz_cookies",
        )
        .map_err(|error| CookieReadError::Query(error.to_string()))?;

    let rows = statement
        .query_map([], |row| {
            let expiry: i64 = row.get(4)?;
            Ok(DecryptedCookie {
                host_key: row.get::<_, String>(0)?,
                name: row.get::<_, String>(1)?,
                value: String::from_utf8_lossy(&super::bytes_column(row, 2)?).into_owned(),
                path: row.get::<_, String>(3)?,
                // Firefox stores expiry as unix seconds; 0 marks a session cookie.
                expires_utc: if expiry > 0 { Some(expiry) } else { None },
                is_secure: row.get::<_, i64>(5)? != 0,
                is_http_only: row.get::<_, i64>(6)? != 0,
                same_site: same_site_from_firefox(row.get::<_, i64>(7)?),
            })
        })
        .map_err(|error| CookieReadError::Query(error.to_string()))?;

    let mut cookies = Vec::new();
    for row in rows {
        match row {
            Ok(cookie) if !cookie.name.is_empty() => cookies.push(cookie),
            Ok(_) => {}
            // One odd row is one lost cookie, not a failed profile.
            Err(error) => {
                tracing::debug!(error = %error, "cookie_import: skipping unreadable Firefox row");
            }
        }
    }
    Ok(cookies)
}
