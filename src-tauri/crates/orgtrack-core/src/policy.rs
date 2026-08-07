use serde::{Deserialize, Serialize};

use crate::canonical::{SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS};
use crate::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_OPENCODE, SOURCE_WARP, SOURCE_WINDSURF,
};

pub const SOURCE_CURSOR_IDE: &str = "cursor_ide";
pub const SOURCE_IMPORTED_HISTORY: &str = "imported_history";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TierSupport {
    Default,
    OptIn,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTierPolicy {
    pub tier1: TierSupport,
    pub tier2: TierSupport,
    pub tier3: TierSupport,
}

impl SourceTierPolicy {
    pub const fn orgii_owned() -> Self {
        Self {
            tier1: TierSupport::Default,
            tier2: TierSupport::Default,
            tier3: TierSupport::Default,
        }
    }

    pub const fn external_default() -> Self {
        Self {
            tier1: TierSupport::Default,
            tier2: TierSupport::Default,
            tier3: TierSupport::OptIn,
        }
    }
}

pub fn source_tier_policy(source: &str) -> SourceTierPolicy {
    match source {
        SOURCE_ORGII_CLI_SESSIONS | SOURCE_ORGII_RUST_AGENTS => SourceTierPolicy::orgii_owned(),
        SOURCE_CURSOR_IDE
        | SOURCE_CLAUDE_CODE
        | SOURCE_CODEX_APP
        | SOURCE_OPENCODE
        | SOURCE_WARP
        | SOURCE_WINDSURF
        | SOURCE_IMPORTED_HISTORY => SourceTierPolicy::external_default(),
        _ => SourceTierPolicy {
            tier1: TierSupport::Default,
            tier2: TierSupport::Default,
            tier3: TierSupport::OptIn,
        },
    }
}

pub fn should_capture_tier3_by_default(source: &str) -> bool {
    source_tier_policy(source).tier3 == TierSupport::Default
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orgii_owned_sources_default_to_tier3() {
        assert!(should_capture_tier3_by_default(SOURCE_ORGII_RUST_AGENTS));
        assert!(should_capture_tier3_by_default(SOURCE_ORGII_CLI_SESSIONS));
    }

    #[test]
    fn external_sources_default_to_tier2_but_not_tier3() {
        let policy = source_tier_policy(SOURCE_CURSOR_IDE);
        assert_eq!(policy.tier1, TierSupport::Default);
        assert_eq!(policy.tier2, TierSupport::Default);
        assert_eq!(policy.tier3, TierSupport::OptIn);
    }
}
