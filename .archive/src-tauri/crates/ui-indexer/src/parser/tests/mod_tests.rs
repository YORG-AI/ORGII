use super::*;
use std::path::Path;

// -- get_file_type --

#[test]
fn get_file_type_tsx() {
    assert_eq!(get_file_type(Path::new("foo.tsx")), Some(FileType::Tsx));
}

#[test]
fn get_file_type_jsx() {
    assert_eq!(get_file_type(Path::new("foo.jsx")), Some(FileType::Jsx));
}

#[test]
fn get_file_type_ts() {
    assert_eq!(get_file_type(Path::new("foo.ts")), Some(FileType::Ts));
}

#[test]
fn get_file_type_js() {
    assert_eq!(get_file_type(Path::new("foo.js")), Some(FileType::Js));
}

#[test]
fn get_file_type_vue() {
    assert_eq!(get_file_type(Path::new("foo.vue")), Some(FileType::Vue));
}

#[test]
fn get_file_type_svelte() {
    assert_eq!(
        get_file_type(Path::new("foo.svelte")),
        Some(FileType::Svelte)
    );
}

#[test]
fn get_file_type_rs_returns_none() {
    assert_eq!(get_file_type(Path::new("foo.rs")), None);
}

#[test]
fn get_file_type_py_returns_none() {
    assert_eq!(get_file_type(Path::new("foo.py")), None);
}

#[test]
fn get_file_type_no_extension_returns_none() {
    assert_eq!(get_file_type(Path::new("foo")), None);
}

#[test]
fn get_file_type_nested_path() {
    assert_eq!(
        get_file_type(Path::new("dir/nested/file.tsx")),
        Some(FileType::Tsx)
    );
}

// -- FileType::has_jsx --

#[test]
fn has_jsx_tsx() {
    assert!(FileType::Tsx.has_jsx());
}

#[test]
fn has_jsx_jsx() {
    assert!(FileType::Jsx.has_jsx());
}

#[test]
fn has_jsx_ts() {
    assert!(!FileType::Ts.has_jsx());
}

#[test]
fn has_jsx_js() {
    assert!(!FileType::Js.has_jsx());
}

#[test]
fn has_jsx_vue() {
    assert!(!FileType::Vue.has_jsx());
}

#[test]
fn has_jsx_svelte() {
    assert!(!FileType::Svelte.has_jsx());
}

// -- FileType::is_typescript --

#[test]
fn is_typescript_tsx() {
    assert!(FileType::Tsx.is_typescript());
}

#[test]
fn is_typescript_ts() {
    assert!(FileType::Ts.is_typescript());
}

#[test]
fn is_typescript_jsx() {
    assert!(!FileType::Jsx.is_typescript());
}

#[test]
fn is_typescript_js() {
    assert!(!FileType::Js.is_typescript());
}

#[test]
fn is_typescript_vue() {
    assert!(!FileType::Vue.is_typescript());
}

#[test]
fn is_typescript_svelte() {
    assert!(!FileType::Svelte.is_typescript());
}
