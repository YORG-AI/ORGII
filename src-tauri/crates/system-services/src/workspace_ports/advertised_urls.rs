//! In-memory cache of URLs advertised by workspace terminals.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use url::Url;

use super::types::WorkspacePortProtocol;

const MAX_CACHE_ENTRIES: usize = 256;

#[derive(Debug, Clone)]
pub(crate) struct AdvertisedUrlEntry {
    pub origin: String,
    pub protocol: WorkspacePortProtocol,
    pub last_seen_at: u64,
}

struct AdvertisedUrlCache {
    entries: HashMap<String, AdvertisedUrlEntry>,
}

impl AdvertisedUrlCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn cache_key(folder_id: &str, port: u16) -> String {
        format!("{folder_id}::{port}")
    }

    fn lookup(&self, folder_id: &str, port: u16) -> Option<AdvertisedUrlEntry> {
        self.entries.get(&Self::cache_key(folder_id, port)).cloned()
    }

    /// Store an advertised origin. Returns true when a new/changed entry was written.
    fn ingest(&mut self, folder_id: &str, origin: &str) -> Option<(bool, u16)> {
        let parsed = parse_advertised_origin(origin)?;
        let key = Self::cache_key(folder_id, parsed.port);
        let now = now_ms();
        let changed = match self.entries.get(&key) {
            Some(existing) => existing.origin != parsed.origin,
            None => true,
        };
        self.entries.insert(
            key,
            AdvertisedUrlEntry {
                origin: parsed.origin,
                protocol: parsed.protocol,
                last_seen_at: now,
            },
        );
        if self.entries.len() > MAX_CACHE_ENTRIES {
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_seen_at)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }
        Some((changed, parsed.port))
    }
}

struct ParsedAdvertisedOrigin {
    origin: String,
    protocol: WorkspacePortProtocol,
    port: u16,
}

fn parse_advertised_origin(raw: &str) -> Option<ParsedAdvertisedOrigin> {
    let trimmed = raw.trim().trim_end_matches(['.', ',', ';', ')', ']']);
    let url = Url::parse(trimmed).ok()?;
    let protocol = match url.scheme() {
        "http" => WorkspacePortProtocol::Http,
        "https" => WorkspacePortProtocol::Https,
        _ => return None,
    };
    let port = url.port().unwrap_or(match protocol {
        WorkspacePortProtocol::Http => 80,
        WorkspacePortProtocol::Https => 443,
        WorkspacePortProtocol::Unknown => return None,
    });
    if port == 0 {
        return None;
    }
    Some(ParsedAdvertisedOrigin {
        origin: url.origin().ascii_serialization(),
        protocol,
        port,
    })
}

fn cache() -> &'static Mutex<AdvertisedUrlCache> {
    static CACHE: OnceLock<Mutex<AdvertisedUrlCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(AdvertisedUrlCache::new()))
}

pub(crate) fn lookup_advertised_url(folder_id: &str, port: u16) -> Option<AdvertisedUrlEntry> {
    cache()
        .lock()
        .ok()
        .and_then(|guard| guard.lookup(folder_id, port))
}

/// Ingest an advertised URL. Returns `(accepted, port)` when parsing succeeds.
pub(crate) fn ingest_advertised_url(folder_id: &str, origin: &str) -> Option<(bool, u16)> {
    let mut guard = cache().lock().ok()?;
    guard.ingest(folder_id, origin)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "advertised_urls_tests.rs"]
mod tests;
