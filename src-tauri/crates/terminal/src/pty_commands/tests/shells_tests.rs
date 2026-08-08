use crate::pty_commands::shells::*;

// ============================================
// parse_etc_shells
// ============================================

#[test]
fn test_parse_etc_shells_standard() {
    let content = "\
# List of acceptable shells for chpass(1).
# Ftstrstrsd.

/bin/bash
/bin/csh
/bin/dash
/bin/ksh
/bin/sh
/bin/tcsh
/bin/zsh
";
    let result = parse_etc_shells(content);
    assert_eq!(
        result,
        vec![
            "/bin/bash",
            "/bin/csh",
            "/bin/dash",
            "/bin/ksh",
            "/bin/sh",
            "/bin/tcsh",
            "/bin/zsh",
        ]
    );
}

#[test]
fn test_parse_etc_shells_with_homebrew_paths() {
    let content = "\
/bin/bash
/bin/zsh
/usr/local/bin/bash
/usr/local/bin/fish
/opt/homebrew/bin/fish
/opt/homebrew/bin/nu
";
    let result = parse_etc_shells(content);
    assert_eq!(result.len(), 6);
    assert!(result.contains(&"/opt/homebrew/bin/fish".to_string()));
    assert!(result.contains(&"/opt/homebrew/bin/nu".to_string()));
}

#[test]
fn test_parse_etc_shells_empty() {
    assert!(parse_etc_shells("").is_empty());
}

#[test]
fn test_parse_etc_shells_comments_only() {
    let content = "# comment 1\n# comment 2\n";
    assert!(parse_etc_shells(content).is_empty());
}

#[test]
fn test_parse_etc_shells_skips_relative_paths() {
    let content = "/bin/bash\nbash\n./local/fish\n/bin/zsh\n";
    let result = parse_etc_shells(content);
    assert_eq!(result, vec!["/bin/bash", "/bin/zsh"]);
}

#[test]
fn test_parse_etc_shells_trims_whitespace() {
    let content = "  /bin/bash  \n\t/bin/zsh\t\n";
    let result = parse_etc_shells(content);
    assert_eq!(result, vec!["/bin/bash", "/bin/zsh"]);
}

// ============================================
// classify_shell_name
// ============================================

#[test]
fn test_classify_common_shells() {
    assert_eq!(classify_shell_name("zsh"), ShellKind::Zsh);
    assert_eq!(classify_shell_name("bash"), ShellKind::Bash);
    assert_eq!(classify_shell_name("fish"), ShellKind::Fish);
    assert_eq!(classify_shell_name("sh"), ShellKind::Sh);
    assert_eq!(classify_shell_name("dash"), ShellKind::Sh);
    assert_eq!(classify_shell_name("csh"), ShellKind::Csh);
    assert_eq!(classify_shell_name("tcsh"), ShellKind::Csh);
    assert_eq!(classify_shell_name("ksh"), ShellKind::Ksh);
}

#[test]
fn test_classify_repl_shells() {
    assert_eq!(classify_shell_name("node"), ShellKind::Node);
    assert_eq!(classify_shell_name("nodejs"), ShellKind::Node);
    assert_eq!(classify_shell_name("python3"), ShellKind::Python);
    assert_eq!(classify_shell_name("python3.11"), ShellKind::Python);
    assert_eq!(classify_shell_name("ruby"), ShellKind::Ruby);
}

#[test]
fn test_classify_modern_shells() {
    assert_eq!(classify_shell_name("nu"), ShellKind::Nushell);
    assert_eq!(classify_shell_name("nushell"), ShellKind::Nushell);
    assert_eq!(classify_shell_name("xonsh"), ShellKind::Xonsh);
    assert_eq!(classify_shell_name("pwsh"), ShellKind::Pwsh);
}

#[test]
fn test_classify_case_insensitive() {
    assert_eq!(classify_shell_name("ZSH"), ShellKind::Zsh);
    assert_eq!(classify_shell_name("Bash"), ShellKind::Bash);
    assert_eq!(classify_shell_name("FISH"), ShellKind::Fish);
    assert_eq!(classify_shell_name("Node"), ShellKind::Node);
}

#[test]
fn test_classify_unknown() {
    assert_eq!(classify_shell_name("myshell"), ShellKind::Unknown);
    assert_eq!(classify_shell_name(""), ShellKind::Unknown);
}

// ============================================
// ShellKind::from_shell_path
// ============================================

#[test]
fn test_from_shell_path_strips_directory() {
    assert_eq!(ShellKind::from_shell_path("/bin/zsh"), ShellKind::Zsh);
    assert_eq!(
        ShellKind::from_shell_path("/usr/local/bin/fish"),
        ShellKind::Fish
    );
    assert_eq!(
        ShellKind::from_shell_path("/opt/homebrew/bin/nu"),
        ShellKind::Nushell
    );
    assert_eq!(
        ShellKind::from_shell_path("/usr/bin/python3"),
        ShellKind::Python
    );
}

#[test]
fn test_from_shell_path_bare_name() {
    assert_eq!(ShellKind::from_shell_path("zsh"), ShellKind::Zsh);
    assert_eq!(ShellKind::from_shell_path("node"), ShellKind::Node);
}

// ============================================
// ShellKind::default_args
// ============================================

#[test]
fn test_default_args_interactive() {
    assert_eq!(ShellKind::Zsh.default_args(), vec!["-il"]);
    assert_eq!(ShellKind::Bash.default_args(), vec!["--login"]);
    assert_eq!(ShellKind::Node.default_args(), vec!["--interactive"]);
    assert_eq!(ShellKind::Python.default_args(), vec!["-i"]);
}

// ============================================
// ShellKind::category
// ============================================

#[test]
fn test_shell_categories() {
    assert_eq!(ShellKind::Zsh.category(), ShellCategory::Shell);
    assert_eq!(ShellKind::Bash.category(), ShellCategory::Shell);
    assert_eq!(ShellKind::Fish.category(), ShellCategory::Shell);
    assert_eq!(ShellKind::Pwsh.category(), ShellCategory::Shell);
    assert_eq!(ShellKind::Node.category(), ShellCategory::Repl);
    assert_eq!(ShellKind::Python.category(), ShellCategory::Repl);
    assert_eq!(ShellKind::Ruby.category(), ShellCategory::Repl);
}
