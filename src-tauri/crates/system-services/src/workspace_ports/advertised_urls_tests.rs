use super::*;

#[test]
fn ingests_http_origin_and_reports_change() {
    let first = ingest_advertised_url("folder-1", "http://localhost:5173/").expect("parse ok");
    assert!(first.0);
    assert_eq!(first.1, 5173);

    let second = ingest_advertised_url("folder-1", "http://localhost:5173").expect("parse ok");
    assert!(!second.0);

    let lookup = lookup_advertised_url("folder-1", 5173).expect("cached");
    assert_eq!(lookup.origin, "http://localhost:5173");
}

#[test]
fn rejects_non_http_schemes() {
    assert!(ingest_advertised_url("folder-1", "ftp://localhost:21").is_none());
}

#[test]
fn strips_trailing_punctuation() {
    let result = ingest_advertised_url("folder-1", "https://127.0.0.1:3000/.").expect("parse ok");
    assert_eq!(result.1, 3000);
    let lookup = lookup_advertised_url("folder-1", 3000).expect("cached");
    assert_eq!(lookup.origin, "https://127.0.0.1:3000");
}
