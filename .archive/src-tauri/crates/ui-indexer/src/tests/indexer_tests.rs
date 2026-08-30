use super::*;
use app_utils::testing::temp_dir_with_files;

#[test]
fn test_index_directory() {
    let (_dir, root) = temp_dir_with_files(&[(
        "Button.tsx",
        r#"
export function Button() {
    return <button>Click</button>;
}

const Card = () => {
    return <div><Button /></div>;
};
"#,
    )]);

    let indexer = UiIndexer::new();
    let index = indexer.index_directory(&root).unwrap();

    let button_locs = index.lookup("button");
    assert!(!button_locs.is_empty());

    let card_locs = index.lookup("card");
    assert!(!card_locs.is_empty());
}

#[test]
fn test_incremental_index() {
    let (_dir, root) = temp_dir_with_files(&[(
        "Component.tsx",
        r#"
function OldComponent() {
    return <div>Old</div>;
}
"#,
    )]);

    let indexer = UiIndexer::new();
    let mut index = indexer.index_directory(&root).unwrap();

    assert!(!index.lookup("oldcomponent").is_empty());

    std::fs::write(
        root.join("Component.tsx"),
        r#"
function NewComponent() {
    return <div>New</div>;
}
"#,
    )
    .unwrap();

    indexer
        .index_file(&mut index, &root.join("Component.tsx"))
        .unwrap();

    assert!(index.lookup("oldcomponent").is_empty());
    assert!(!index.lookup("newcomponent").is_empty());
}
