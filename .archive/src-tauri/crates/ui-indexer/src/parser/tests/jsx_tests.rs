use super::*;
use std::path::PathBuf;

#[test]
fn test_function_component() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
function Button() {
    return <button>Click</button>;
}
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    // Should find Button definition and button usage (lowercase, skipped)
    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind.is_definition())
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "Button");
}

#[test]
fn test_arrow_component() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
const Card = () => {
    return <div>Card</div>;
};
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind.is_definition())
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "Card");
}

#[test]
fn test_memo_component() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
const MemoButton = memo(() => {
    return <button>Memo</button>;
});
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind.is_definition())
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "MemoButton");
}

#[test]
fn test_jsx_usage() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
function App() {
    return (
        <div>
            <Button onClick={() => {}} />
            <Card title="test">
                <Header />
            </Card>
        </div>
    );
}
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"Button"));
    assert!(usages.contains(&"Card"));
    assert!(usages.contains(&"Header"));
}

#[test]
fn test_member_expression_jsx() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
function App() {
    return <motion.div animate={{ x: 100 }} />;
}
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"motion.div"));
}

#[test]
fn test_class_component() {
    let mut parser = JsxParser::new().unwrap();
    let code = r#"
class MyComponent extends React.Component {
    render() {
        return <div>Hello</div>;
    }
}
"#;
    let results = parser.parse_file(&PathBuf::from("test.tsx"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::ClassDef)
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "MyComponent");
}
