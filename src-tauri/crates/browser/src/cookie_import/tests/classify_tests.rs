//! Domain-grouping and category-classification tests.

use super::{classify_site, registrable_domain, SiteCategory};

#[test]
fn registrable_domain_strips_leading_dot_and_subdomains() {
    assert_eq!(registrable_domain(".github.com"), "github.com");
    assert_eq!(registrable_domain("mail.google.com"), "google.com");
    assert_eq!(registrable_domain("GITHUB.COM"), "github.com");
    assert_eq!(registrable_domain("example.com"), "example.com");
}

#[test]
fn registrable_domain_keeps_org_label_for_multi_part_suffix() {
    assert_eq!(registrable_domain("www.bbc.co.uk"), "bbc.co.uk");
    assert_eq!(registrable_domain("shop.company.com.au"), "company.com.au");
}

#[test]
fn registrable_domain_handles_ip_and_single_label() {
    assert_eq!(registrable_domain("127.0.0.1"), "127.0.0.1");
    assert_eq!(registrable_domain("localhost"), "localhost");
}

#[test]
fn everyday_sites_are_general_and_checked_by_default() {
    let category = classify_site("github.com", ["github.com"]);
    assert_eq!(category, SiteCategory::General);
    assert!(category.default_selected());
}

#[test]
fn money_mail_and_sso_are_unchecked_by_default() {
    let banking = classify_site("chase.com", ["chase.com"]);
    assert_eq!(banking, SiteCategory::Banking);
    assert!(!banking.default_selected());

    // Sub-domain match: registrable google.com is general, but the concrete
    // host mail.google.com is webmail.
    let email = classify_site("google.com", ["mail.google.com"]);
    assert_eq!(email, SiteCategory::Email);
    assert!(!email.default_selected());

    let sso = classify_site("google.com", ["accounts.google.com"]);
    assert_eq!(sso, SiteCategory::Sso);
    assert!(!sso.default_selected());
}
