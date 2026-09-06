//! Safari cookie reader (`Cookies.binarycookies`).
//!
//! Safari keeps its persistent cookies in a small binary container:
//!
//! ```text
//! file   := "cook" · page_count:u32be · page_size:u32be × page_count · page × page_count · trailer
//! page   := 00 00 01 00 · cookie_count:u32le · cookie_offset:u32le × cookie_count · 00 00 00 00 · cookie…
//! cookie := size:u32le · _:u32 · flags:u32le · _:u32
//!         · domain_off:u32le · name_off:u32le · path_off:u32le · value_off:u32le
//!         · _:u64 · expires:f64le · created:f64le · strings…
//! ```
//!
//! Cookie offsets are relative to the page; string offsets are relative to the
//! cookie's first byte, and strings are NUL-terminated. Dates are seconds
//! since 2001-01-01 (Mac absolute time). Values are not encrypted — the only
//! obstacle is that the file lives in Safari's sandbox container, which macOS
//! gates behind Full Disk Access.
//!
//! The parser is deliberately tolerant: a malformed cookie or page is skipped
//! rather than failing the whole import, since one bad record should not hide
//! every other saved login.

use std::path::Path;

use super::{CookieReadError, DecryptedCookie, SameSite};

const MAGIC: &[u8; 4] = b"cook";
const PAGE_HEADER: [u8; 4] = [0x00, 0x00, 0x01, 0x00];
const FLAG_SECURE: u32 = 0x1;
const FLAG_HTTP_ONLY: u32 = 0x4;
/// Bytes a cookie record occupies before its string table begins.
const COOKIE_HEADER_LEN: usize = 56;
/// Seconds between the Mac absolute epoch (2001-01-01) and the Unix epoch.
const MAC_EPOCH_OFFSET_SECONDS: i64 = 978_307_200;

/// Read every cookie from a Safari `Cookies.binarycookies` file.
///
/// A permission failure is reported as [`CookieReadError::FullDiskAccess`]
/// because on macOS that is what it means for this path.
pub fn read_cookies(store_path: &Path) -> Result<Vec<DecryptedCookie>, CookieReadError> {
    let bytes = std::fs::read(store_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            CookieReadError::FullDiskAccess
        } else {
            CookieReadError::Open(format!("{}: {error}", store_path.display()))
        }
    })?;
    parse_binarycookies(&bytes)
}

/// Parse the bytes of a `Cookies.binarycookies` file.
pub fn parse_binarycookies(bytes: &[u8]) -> Result<Vec<DecryptedCookie>, CookieReadError> {
    if bytes.len() < 8 || &bytes[..4] != MAGIC {
        return Err(CookieReadError::Query(
            "not a Safari cookie file (bad magic)".to_string(),
        ));
    }
    let page_count = u32_be(bytes, 4).ok_or_else(truncated)? as usize;
    let sizes_end = 8usize
        .checked_add(page_count.checked_mul(4).ok_or_else(truncated)?)
        .ok_or_else(truncated)?;
    if bytes.len() < sizes_end {
        return Err(truncated());
    }

    let mut cookies = Vec::new();
    let mut cursor = sizes_end;
    for index in 0..page_count {
        let size = u32_be(bytes, 8 + index * 4).ok_or_else(truncated)? as usize;
        let end = cursor
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(truncated)?;
        parse_page(&bytes[cursor..end], &mut cookies);
        cursor = end;
    }
    Ok(cookies)
}

fn truncated() -> CookieReadError {
    CookieReadError::Query("Safari cookie file is truncated".to_string())
}

fn parse_page(page: &[u8], out: &mut Vec<DecryptedCookie>) {
    if page.len() < 8 || page[..4] != PAGE_HEADER {
        return;
    }
    let Some(count) = u32_le(page, 4) else {
        return;
    };
    for index in 0..count as usize {
        let Some(offset) = u32_le(page, 8 + index * 4) else {
            return;
        };
        if let Some(cookie) = parse_cookie(page, offset as usize) {
            out.push(cookie);
        }
    }
}

fn parse_cookie(page: &[u8], start: usize) -> Option<DecryptedCookie> {
    let record_len = u32_le(page, start)? as usize;
    let end = start.checked_add(record_len)?;
    if end > page.len() || record_len < COOKIE_HEADER_LEN {
        return None;
    }
    let record = &page[start..end];

    let flags = u32_le(record, 8)?;
    let domain = c_string(record, u32_le(record, 16)? as usize)?;
    let name = c_string(record, u32_le(record, 20)? as usize)?;
    let path = c_string(record, u32_le(record, 24)? as usize)?;
    let value = c_string(record, u32_le(record, 28)? as usize).unwrap_or_default();
    let expires = f64::from_le_bytes(record.get(40..48)?.try_into().ok()?);

    if name.is_empty() || domain.is_empty() {
        return None;
    }
    Some(DecryptedCookie {
        host_key: domain,
        name,
        value,
        path: if path.is_empty() { "/".to_string() } else { path },
        expires_utc: mac_absolute_to_unix(expires),
        is_secure: flags & FLAG_SECURE != 0,
        is_http_only: flags & FLAG_HTTP_ONLY != 0,
        same_site: SameSite::Unspecified,
    })
}

/// Mac absolute time (seconds since 2001) → Unix seconds; non-positive or
/// non-finite values mean "no expiry".
fn mac_absolute_to_unix(seconds: f64) -> Option<i64> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some(seconds as i64 + MAC_EPOCH_OFFSET_SECONDS)
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_le_bytes)
}

fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_be_bytes)
}

/// NUL-terminated string at `offset` within a cookie record; `0` means absent.
fn c_string(record: &[u8], offset: usize) -> Option<String> {
    if offset == 0 || offset >= record.len() {
        return None;
    }
    let rest = &record[offset..];
    let len = rest.iter().position(|&byte| byte == 0)?;
    String::from_utf8(rest[..len].to_vec()).ok()
}

#[cfg(test)]
#[path = "tests/safari_tests.rs"]
mod tests;
