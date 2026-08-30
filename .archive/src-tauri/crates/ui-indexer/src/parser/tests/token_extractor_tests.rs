use super::*;

#[test]
fn test_extract_token_definitions() {
    let extractor = TokenDefinitionExtractor::new();

    let content = r#"
        :root {
            --color-text-1: #111827;
            --primary-6: 37 99 235;
        }
    "#;

    let result = extractor.extract_from_content(content, "tokens.css");

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].name, "color-text-1");
    assert_eq!(result[0].value, "#111827");
    assert_eq!(result[0].source, "tokens.css");
    assert_eq!(result[1].name, "primary-6");
    assert_eq!(result[1].value, "37 99 235");
}
