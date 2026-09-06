//! Site-grouping tests for the preview builder.

use super::{group_sites, DecryptedCookie, SameSite, SiteCategory};

fn cookie(host: &str, name: &str) -> DecryptedCookie {
    DecryptedCookie {
        host_key: host.to_string(),
        name: name.to_string(),
        value: "v".to_string(),
        path: "/".to_string(),
        expires_utc: None,
        is_secure: true,
        is_http_only: false,
        same_site: SameSite::Unspecified,
    }
}

#[test]
fn groups_by_registrable_domain_and_counts() {
    let cookies = vec![
        cookie(".github.com", "a"),
        cookie("github.com", "b"),
        cookie("api.github.com", "c"),
        cookie(".example.com", "d"),
    ];
    let sites = group_sites(&cookies);
    assert_eq!(sites.len(), 2);
    // Most cookies first.
    assert_eq!(sites[0].domain, "github.com");
    assert_eq!(sites[0].cookie_count, 3);
    assert_eq!(sites[1].domain, "example.com");
    assert_eq!(sites[1].cookie_count, 1);
}

#[test]
fn banking_site_defaults_to_unselected() {
    let sites = group_sites(&[cookie(".chase.com", "sid")]);
    assert_eq!(sites.len(), 1);
    assert_eq!(sites[0].category, SiteCategory::Banking);
    assert!(!sites[0].default_selected);
}

#[test]
fn sample_hosts_are_capped_and_deduped() {
    let cookies = vec![
        cookie("a.example.com", "1"),
        cookie("a.example.com", "2"),
        cookie("b.example.com", "3"),
        cookie("c.example.com", "4"),
        cookie("d.example.com", "5"),
        cookie("e.example.com", "6"),
    ];
    let sites = group_sites(&cookies);
    assert_eq!(sites.len(), 1);
    // De-duplicated (a.example.com once) and capped at MAX_SAMPLE_HOSTS (4).
    assert!(sites[0].sample_hosts.len() <= 4);
    assert!(sites[0].sample_hosts.iter().all(|host| !host.starts_with('.')));
}
