//! Runtime identity derived from Tauri's configured application identifier.
//!
//! Build scripts still create the per-instance Tauri config, but the binary
//! must remain isolated when it is launched directly (Explorer, a shortcut,
//! or a test runner). Runtime services and the local data root therefore
//! derive their defaults from the identifier embedded in that config instead
//! of depending on launcher environment variables.

use std::path::{Path, PathBuf};

const PRIMARY_IDE_SERVER_PORT: u16 = 13_847;
const PRIMARY_CLI_PROXY_PORT: u16 = 17_888;
const INSTANCE_IDENTIFIER_PREFIX: &str = "yorg.orgii.instance";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeInstanceProfile {
    pub(crate) instance_id: u16,
    pub(crate) ide_server_port: u16,
    pub(crate) cli_proxy_port: u16,
}

impl RuntimeInstanceProfile {
    pub(crate) fn from_identifier(identifier: &str) -> Self {
        let instance_id = parse_instance_id(identifier).unwrap_or(1);
        Self {
            instance_id,
            ide_server_port: PRIMARY_IDE_SERVER_PORT + instance_id - 1,
            cli_proxy_port: PRIMARY_CLI_PROXY_PORT + instance_id - 1,
        }
    }

    /// Secondary identities own a sibling data root even when their binary is
    /// launched directly. The primary identity keeps the production default
    /// (`~/.orgii`) by returning `None`.
    pub(crate) fn default_orgii_home(self, user_home: &Path) -> Option<PathBuf> {
        (self.instance_id > 1)
            .then(|| user_home.join(format!(".orgii-instance{}", self.instance_id)))
    }
}

fn parse_instance_id(identifier: &str) -> Option<u16> {
    identifier
        .strip_prefix(INSTANCE_IDENTIFIER_PREFIX)?
        .parse::<u16>()
        .ok()
        .filter(|id| (2..=99).contains(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_identifier_uses_primary_ports() {
        assert_eq!(
            RuntimeInstanceProfile::from_identifier("yorg.orgii"),
            RuntimeInstanceProfile {
                instance_id: 1,
                ide_server_port: 13_847,
                cli_proxy_port: 17_888,
            }
        );
    }

    #[test]
    fn isolated_identifier_offsets_both_runtime_ports() {
        let profile = RuntimeInstanceProfile::from_identifier("yorg.orgii.instance2");
        assert_eq!(
            profile,
            RuntimeInstanceProfile {
                instance_id: 2,
                ide_server_port: 13_848,
                cli_proxy_port: 17_889,
            }
        );
        assert_eq!(
            profile.default_orgii_home(Path::new("C:/Users/Test")),
            Some(PathBuf::from("C:/Users/Test/.orgii-instance2"))
        );
    }

    #[test]
    fn primary_identifier_keeps_the_production_data_root() {
        let profile = RuntimeInstanceProfile::from_identifier("yorg.orgii");
        assert_eq!(profile.default_orgii_home(Path::new("/home/test")), None);
    }

    #[test]
    fn malformed_or_unbounded_identifiers_fall_back_to_primary() {
        for identifier in [
            "yorg.orgii.instance1",
            "yorg.orgii.instance0",
            "yorg.orgii.instance100",
            "yorg.orgii.instance2.extra",
            "other.orgii.instance2",
        ] {
            assert_eq!(
                RuntimeInstanceProfile::from_identifier(identifier).instance_id,
                1,
                "{identifier}"
            );
        }
    }
}
