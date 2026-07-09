//! Key Vault wizard setup methods exposed to GenericSetup.

pub const SETUP_AUTODETECT: &str = "autodetect";
pub const SETUP_ENTER_KEY: &str = "enter_key";
pub const SETUP_EXTRACT: &str = "extract";

const GENERIC_SETUP_METHODS_DEFAULT: &[&str] = &[
    SETUP_AUTODETECT,
    SETUP_ENTER_KEY,
    SETUP_EXTRACT,
];

const GENERIC_SETUP_METHOD_OVERRIDES: &[(&str, &[&str])] =
    &[("opencode", &[SETUP_AUTODETECT, SETUP_ENTER_KEY])];

/// Setup methods available in the Key Vault GenericSetup flow.
/// Complex-setup agents (Cursor, Kiro, etc.) return an empty list.
pub fn supported_setup_methods_for_agent(
    name: &str,
    is_complex_setup: bool,
) -> &'static [&'static str] {
    if is_complex_setup {
        return &[];
    }

    GENERIC_SETUP_METHOD_OVERRIDES
        .iter()
        .find(|(agent_name, _)| *agent_name == name)
        .map(|(_, methods)| *methods)
        .unwrap_or(GENERIC_SETUP_METHODS_DEFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_omits_extract_config() {
        assert_eq!(
            supported_setup_methods_for_agent("opencode", false),
            &["autodetect", "enter_key"]
        );
    }

    #[test]
    fn default_generic_agent_includes_extract() {
        assert_eq!(
            supported_setup_methods_for_agent("kimi_cli", false),
            &["autodetect", "enter_key", "extract"]
        );
    }

    #[test]
    fn complex_setup_agents_have_no_generic_methods() {
        assert!(supported_setup_methods_for_agent("cursor_cli", true).is_empty());
    }
}
