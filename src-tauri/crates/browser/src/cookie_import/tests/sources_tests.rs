//! Firefox `profiles.ini` parsing tests.

use super::parse_firefox_profiles_ini;

#[test]
fn parses_relative_and_absolute_profiles() {
    let ini = "\
[Install2656FF1E]
Default=Profiles/abc.default-release
Locked=1

[Profile1]
Name=default
IsRelative=1
Path=Profiles/knehl59t.default
Default=1

[Profile0]
Name=default-release
IsRelative=0
Path=/custom/abs/path

[General]
StartWithLastProfile=1
Version=2
";
    let profiles = parse_firefox_profiles_ini(ini);
    assert_eq!(
        profiles,
        vec![
            ("Profiles/knehl59t.default".to_string(), true),
            ("/custom/abs/path".to_string(), false),
        ]
    );
}

#[test]
fn ignores_non_profile_sections_and_defaults_relative() {
    let ini = "\
[Profile0]
Path=Profiles/only.default
";
    // No IsRelative line means relative by default.
    assert_eq!(
        parse_firefox_profiles_ini(ini),
        vec![("Profiles/only.default".to_string(), true)]
    );
    // A body with no profile sections yields nothing.
    assert!(parse_firefox_profiles_ini("[General]\nVersion=2\n").is_empty());
}
