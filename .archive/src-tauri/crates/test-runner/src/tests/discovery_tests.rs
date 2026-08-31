use crate::discovery::matches_glob_pattern;

#[test]
fn test_glob_matching() {
    // JavaScript/TypeScript patterns
    assert!(matches_glob_pattern("src/utils.test.ts", "*.test.ts"));
    assert!(matches_glob_pattern("src/utils.spec.tsx", "*.spec.tsx"));
    assert!(matches_glob_pattern(
        "src/__tests__/utils.ts",
        "__tests__/**/*.ts"
    ));
    assert!(!matches_glob_pattern("src/utils.ts", "*.test.ts"));

    // Python test patterns
    assert!(matches_glob_pattern("test_main.py", "**/test_*.py"));
    assert!(matches_glob_pattern("tests/test_utils.py", "**/test_*.py"));
    assert!(matches_glob_pattern(
        "src/tests/test_api.py",
        "**/test_*.py"
    ));
    assert!(matches_glob_pattern("utils_test.py", "**/*_test.py"));
    assert!(matches_glob_pattern("tests/module_test.py", "**/*_test.py"));
    assert!(!matches_glob_pattern("main.py", "**/test_*.py"));
    assert!(!matches_glob_pattern("utils.py", "**/*_test.py"));
}
