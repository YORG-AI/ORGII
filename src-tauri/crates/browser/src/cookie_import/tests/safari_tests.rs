//! Safari `Cookies.binarycookies` parser tests, against a synthetic file built
//! with the same layout Safari writes (magic, big-endian page table, little-
//! endian pages, NUL-terminated strings, Mac-absolute dates).

use super::{parse_binarycookies, MAC_EPOCH_OFFSET_SECONDS};

/// Build one cookie record: 56-byte header followed by the string table.
fn cookie(domain: &str, name: &str, path: &str, value: &str, flags: u32, expires: f64) -> Vec<u8> {
    let strings = [domain, name, path, value];
    let mut offsets = [0u32; 4];
    let mut table = Vec::new();
    for (index, text) in strings.iter().enumerate() {
        offsets[index] = (56 + table.len()) as u32;
        table.extend_from_slice(text.as_bytes());
        table.push(0);
    }
    let size = (56 + table.len()) as u32;

    let mut record = Vec::with_capacity(size as usize);
    record.extend_from_slice(&size.to_le_bytes());
    record.extend_from_slice(&0u32.to_le_bytes());
    record.extend_from_slice(&flags.to_le_bytes());
    record.extend_from_slice(&0u32.to_le_bytes());
    for offset in offsets {
        record.extend_from_slice(&offset.to_le_bytes());
    }
    record.extend_from_slice(&0u64.to_le_bytes());
    record.extend_from_slice(&expires.to_le_bytes());
    record.extend_from_slice(&(expires - 86_400.0).to_le_bytes());
    record.extend_from_slice(&table);
    record
}

/// Build one page: header, count, offsets, footer, then the records.
fn page(cookies: &[Vec<u8>]) -> Vec<u8> {
    let header_len = 4 + 4 + 4 * cookies.len() + 4;
    let mut out = vec![0x00, 0x00, 0x01, 0x00];
    out.extend_from_slice(&(cookies.len() as u32).to_le_bytes());
    let mut offset = header_len;
    for record in cookies {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += record.len();
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    for record in cookies {
        out.extend_from_slice(record);
    }
    out
}

/// Build the file: magic, page count and sizes (big-endian), pages, trailer.
fn file(pages: &[Vec<u8>]) -> Vec<u8> {
    let mut out = b"cook".to_vec();
    out.extend_from_slice(&(pages.len() as u32).to_be_bytes());
    for body in pages {
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    }
    for body in pages {
        out.extend_from_slice(body);
    }
    out.extend_from_slice(&[0x07, 0x17, 0x20, 0x05, 0x00, 0x00, 0x00, 0x4b]);
    out
}

#[test]
fn parses_cookies_across_pages_with_flags_and_dates() {
    let expires_mac = 700_000_000.0;
    let bytes = file(&[
        page(&[
            cookie(".github.com", "user_session", "/", "abc123", 0x5, expires_mac),
            cookie("docs.example.com", "theme", "/docs", "dark", 0x0, 0.0),
        ]),
        page(&[cookie(".apple.com", "s_vi", "/", "", 0x1, expires_mac)]),
    ]);

    let cookies = parse_binarycookies(&bytes).expect("parses");
    assert_eq!(cookies.len(), 3);

    let session = &cookies[0];
    assert_eq!(session.host_key, ".github.com");
    assert_eq!(session.name, "user_session");
    assert_eq!(session.value, "abc123");
    assert_eq!(session.path, "/");
    assert!(session.is_secure);
    assert!(session.is_http_only);
    assert_eq!(
        session.expires_utc,
        Some(expires_mac as i64 + MAC_EPOCH_OFFSET_SECONDS)
    );

    let theme = &cookies[1];
    assert_eq!(theme.path, "/docs");
    assert!(!theme.is_secure);
    assert!(!theme.is_http_only);
    assert_eq!(theme.expires_utc, None, "zero date means no expiry");

    let empty_value = &cookies[2];
    assert_eq!(empty_value.value, "");
    assert!(empty_value.is_secure);
}

#[test]
fn rejects_bad_magic_and_truncated_files() {
    assert!(parse_binarycookies(b"nope0000").is_err());
    let mut bytes = file(&[page(&[cookie("a.com", "n", "/", "v", 0, 1.0)])]);
    bytes.truncate(bytes.len() - 40);
    assert!(parse_binarycookies(&bytes).is_err());
}

/// Parse a real NSHTTPCookieStorage file — the same format Safari writes —
/// when `ORGII_BINARYCOOKIES_PATH` points at one. Readable examples live in
/// `~/Library/HTTPStorages/*.binarycookies`. Run with
/// `cargo test -p browser safari -- --ignored --nocapture`.
#[test]
#[ignore]
fn parses_real_file_from_env() {
    let Ok(path) = std::env::var("ORGII_BINARYCOOKIES_PATH") else {
        return;
    };
    let bytes = std::fs::read(&path).expect("read the file");
    let cookies = parse_binarycookies(&bytes).expect("parse the file");
    assert!(!cookies.is_empty(), "no cookies parsed from {path}");
    eprintln!("{} cookies in {path}", cookies.len());
    for cookie in cookies.iter().take(8) {
        eprintln!(
            "  {} {} path={} secure={} httponly={} expires={:?} value_len={}",
            cookie.host_key,
            cookie.name,
            cookie.path,
            cookie.is_secure,
            cookie.is_http_only,
            cookie.expires_utc,
            cookie.value.len()
        );
    }
}

#[test]
fn skips_a_corrupt_record_but_keeps_the_rest() {
    let good = cookie("good.com", "ok", "/", "1", 0, 1.0);
    let mut bad = cookie("bad.com", "broken", "/", "2", 0, 1.0);
    // Point the name at an offset past the record's end.
    bad[20..24].copy_from_slice(&9_999u32.to_le_bytes());
    let bytes = file(&[page(&[bad, good])]);

    let cookies = parse_binarycookies(&bytes).expect("parses");
    assert_eq!(cookies.len(), 1);
    assert_eq!(cookies[0].host_key, "good.com");
}
