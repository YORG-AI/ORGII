use super::*;

#[test]
fn test_add_and_lookup() {
    let mut index = UiIndex::new();

    index.add(
        "Button".to_string(),
        ComponentLocation {
            file: PathBuf::from("/src/Button.tsx"),
            line: 5,
            column: 0,
            kind: ComponentKind::FunctionDef,
            end_line: Some(20),
        },
    );

    index.add(
        "Button".to_string(),
        ComponentLocation {
            file: PathBuf::from("/src/App.tsx"),
            line: 42,
            column: 10,
            kind: ComponentKind::JsxUsage,
            end_line: None,
        },
    );

    // Case-insensitive lookup
    let results = index.lookup("button");
    assert_eq!(results.len(), 2);

    // Prioritized lookup should return definition first
    let prioritized = index.lookup_prioritized("Button");
    assert_eq!(prioritized.len(), 2);
    assert!(prioritized[0].kind.is_definition());
}

#[test]
fn test_remove_file() {
    let mut index = UiIndex::new();

    index.add(
        "Button".to_string(),
        ComponentLocation {
            file: PathBuf::from("/src/Button.tsx"),
            line: 5,
            column: 0,
            kind: ComponentKind::FunctionDef,
            end_line: None,
        },
    );

    index.add(
        "Button".to_string(),
        ComponentLocation {
            file: PathBuf::from("/src/App.tsx"),
            line: 42,
            column: 10,
            kind: ComponentKind::JsxUsage,
            end_line: None,
        },
    );

    // Remove one file
    index.remove_file(&PathBuf::from("/src/Button.tsx"));

    let results = index.lookup("button");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].file, PathBuf::from("/src/App.tsx"));
}
