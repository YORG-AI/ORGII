//! A2A originator identity: who caused this run to exist. Injected into
//! agent shells as `ORGII_ORIGINATOR` and carried on agent-authored
//! Discussion posts so downstream consumers can see the chain.

pub fn originator_identity(org_member_id: Option<&str>, parent_session_id: Option<&str>) -> String {
    if let Some(member) = org_member_id.map(str::trim).filter(|id| !id.is_empty()) {
        return format!("member:{member}");
    }
    if let Some(parent) = parent_session_id.map(str::trim).filter(|id| !id.is_empty()) {
        return format!("session:{parent}");
    }
    "user".to_string()
}

#[cfg(test)]
mod tests {
    use super::originator_identity;

    #[test]
    fn member_wins_then_parent_then_user() {
        assert_eq!(originator_identity(Some("m-1"), Some("s-1")), "member:m-1");
        assert_eq!(originator_identity(None, Some("s-1")), "session:s-1");
        assert_eq!(originator_identity(Some("  "), None), "user");
        assert_eq!(originator_identity(None, None), "user");
    }
}
