//! Global user-profile state — process-wide snapshot for backend-initiated turns.
//!
//! Frontend-launched turns still carry `IdeContext.user_profile` as the freshest
//! per-message snapshot. This module provides the same current profile to
//! backend-only/background entry points that cannot collect frontend IDE context.

use std::sync::RwLock;

use tracing::info;

use crate::session::UserProfile;

static GLOBAL_PROFILE: RwLock<Option<UserProfile>> = RwLock::new(None);

pub fn set_global_profile(profile: Option<UserProfile>) {
    if let Some(profile) = profile.as_ref() {
        info!(
            "[profile] global profile set: roles={} stacks={} has_description={}",
            profile.job_roles.len(),
            profile.familiar_tech_stacks.len(),
            profile
                .description
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        );
    } else {
        info!("[profile] global profile cleared");
    }
    if let Ok(mut guard) = GLOBAL_PROFILE.write() {
        *guard = profile;
    }
}

pub fn global_profile() -> Option<UserProfile> {
    GLOBAL_PROFILE.read().ok().and_then(|guard| guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_and_clear_profile_round_trip() {
        set_global_profile(Some(UserProfile {
            tech_savvy: Some("advanced".to_string()),
            job_roles: vec!["Frontend Engineer".to_string()],
            familiar_tech_stacks: vec!["React".to_string()],
            description: Some("Prefers direct answers.".to_string()),
        }));

        let snapshot = global_profile().expect("profile snapshot");
        assert_eq!(snapshot.tech_savvy.as_deref(), Some("advanced"));
        assert_eq!(snapshot.job_roles, vec!["Frontend Engineer"]);

        set_global_profile(None);
        assert!(global_profile().is_none());
    }
}
