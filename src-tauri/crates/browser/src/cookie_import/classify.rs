//! Site grouping and category classification for cookie import.
//!
//! Pure, cross-platform logic: given a cookie's host key, decide the
//! registrable domain it belongs to (so the import UI can present one row per
//! site rather than per host), and a coarse category used to pick a safe
//! default for whether the site is checked.
//!
//! The default follows the built-in-browser convention: everyday sites are
//! checked, but sites that handle money, email, or single sign-on are left
//! unchecked so the user opts in deliberately.

use serde::{Deserialize, Serialize};

/// Coarse category for a site, used only to choose a default-selected state.
///
/// This is a hint for the import UI, not a security boundary — the user always
/// sees the site and makes the final choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiteCategory {
    /// Everyday site — checked by default.
    General,
    /// Webmail — unchecked by default.
    Email,
    /// Banking / payments / brokerage — unchecked by default.
    Banking,
    /// Single sign-on / identity provider — unchecked by default.
    Sso,
}

impl SiteCategory {
    /// Whether a site in this category should be checked by default.
    pub fn default_selected(self) -> bool {
        matches!(self, SiteCategory::General)
    }
}

/// Multi-label public suffixes we treat as a single TLD so the registrable
/// domain keeps the organisation label (e.g. `bbc.co.uk`, not `co.uk`).
///
/// This is a pragmatic shortlist, not the full Public Suffix List. Grouping is
/// a display convenience for the import checklist; an over-broad group at worst
/// shows two related hosts on one row.
const MULTI_LABEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.jp", "or.jp", "ne.jp",
    "com.au", "net.au", "org.au", "com.br", "com.cn", "com.hk", "com.tw",
    "com.sg", "com.mx", "co.in", "co.nz", "co.za", "co.kr", "com.tr",
];

/// Host substrings that mark a banking / payments / brokerage site.
const BANKING_MARKERS: &[&str] = &[
    "bank", "paypal", "venmo", "stripe", "coinbase", "binance", "kraken",
    "chase", "wellsfargo", "citi", "citibank", "hsbc", "barclays", "santander",
    "americanexpress", "amex", "capitalone", "discover", "usbank", "pnc",
    "schwab", "fidelity", "vanguard", "etrade", "robinhood", "sofi", "ally",
    "tdbank", "bankofamerica", "bofa", "revolut", "wise", "monzo", "nubank",
];

/// Host substrings that mark a webmail site.
const EMAIL_MARKERS: &[&str] = &[
    "mail.google.com", "gmail", "outlook", "hotmail", "live.com", "proton.me",
    "protonmail", "mail.yahoo", "fastmail", "zoho", "icloud.com", "mail.com",
    "gmx", "yandex.mail", "tutanota",
];

/// Host prefixes / substrings that mark a single sign-on / identity endpoint.
const SSO_MARKERS: &[&str] = &[
    "accounts.google.com", "login.microsoftonline.com", "login.live.com",
    "okta.com", "auth0.com", "onelogin.com", "duosecurity.com", "pingidentity",
    "id.me", "login.gov", "authing", "workos.com", "clerk.",
];

/// Extract the registrable domain (eTLD+1) from a cookie host key.
///
/// Leading dots (`.github.com`) are stripped first. Uses a small multi-label
/// suffix list so `bbc.co.uk` is kept intact instead of collapsing to `co.uk`.
pub fn registrable_domain(host_key: &str) -> String {
    let host = host_key.trim().trim_start_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return host;
    }
    // An IP literal or single-label host is its own registrable domain.
    if host.parse::<std::net::IpAddr>().is_ok() {
        return host;
    }

    let labels: Vec<&str> = host.split('.').filter(|part| !part.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }

    let last_two = labels[labels.len() - 2..].join(".");
    if MULTI_LABEL_SUFFIXES.contains(&last_two.as_str()) && labels.len() >= 3 {
        return labels[labels.len() - 3..].join(".");
    }
    last_two
}

/// Classify a site by its registrable domain and a representative host.
///
/// `hosts` are the concrete host keys observed for the site; matching against
/// the full host catches sub-domains such as `mail.google.com` that the
/// registrable domain (`google.com`) alone would miss.
pub fn classify_site<'a>(
    registrable: &str,
    hosts: impl IntoIterator<Item = &'a str>,
) -> SiteCategory {
    let registrable = registrable.to_ascii_lowercase();
    let haystacks: Vec<String> = std::iter::once(registrable.clone())
        .chain(
            hosts
                .into_iter()
                .map(|host| host.trim_start_matches('.').to_ascii_lowercase()),
        )
        .collect();

    let any_contains = |markers: &[&str]| {
        haystacks
            .iter()
            .any(|host| markers.iter().any(|marker| host.contains(marker)))
    };

    // Order matters: an identity endpoint on a bank domain is still SSO-shaped,
    // but banking is the more cautious default, so check it first.
    if any_contains(BANKING_MARKERS) {
        SiteCategory::Banking
    } else if any_contains(SSO_MARKERS) {
        SiteCategory::Sso
    } else if any_contains(EMAIL_MARKERS) {
        SiteCategory::Email
    } else {
        SiteCategory::General
    }
}

#[cfg(test)]
#[path = "tests/classify_tests.rs"]
mod tests;
