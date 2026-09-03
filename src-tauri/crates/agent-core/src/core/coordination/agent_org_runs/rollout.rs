//! Single internal rollout gate for the long-lived Agent Org redesign.
//!
//! This is deliberately not persisted in Team definitions or exposed to
//! model/tool context. Until the final stack PR changes the default, missing
//! or malformed configuration fails closed.

const ENABLED_VALUE: &str = "1";
const ROLLOUT_ENV: &str = "ORGII_AGENT_ORG_REDESIGN";

fn configured_enabled(value: Option<&str>, test_build: bool) -> bool {
    test_build || value.is_some_and(|value| value.trim() == ENABLED_VALUE)
}

pub fn is_enabled() -> bool {
    let configured = std::env::var(ROLLOUT_ENV).ok();
    configured_enabled(configured.as_deref(), cfg!(test))
}

/// Enables the redesign only after the packaged WebDriver harness explicitly
/// asks for it. Ordinary binaries cannot activate this in-process override,
/// even if a production frontend somehow tries to invoke the debug command.
pub fn enable_for_webdriver_test() -> Result<(), String> {
    if !cfg!(feature = "webdriver") {
        return Err(
            "agent_org_webdriver_override_unavailable: binary lacks the webdriver feature"
                .to_string(),
        );
    }
    std::env::set_var(ROLLOUT_ENV, ENABLED_VALUE);
    require_enabled()
}

pub fn require_enabled() -> Result<(), String> {
    is_enabled().then_some(()).ok_or_else(|| {
        "agent_org_redesign_disabled: the long-lived Agent Team lifecycle is not enabled"
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn unit_test_builds_use_the_internal_gate_without_environment_state() {
        assert!(super::is_enabled());
    }

    #[test]
    fn production_gate_defaults_and_malformed_values_fail_closed() {
        assert!(!super::configured_enabled(None, false));
        assert!(!super::configured_enabled(Some("true"), false));
        assert!(!super::configured_enabled(Some("0"), false));
        assert!(super::configured_enabled(Some("1"), false));
    }
}
