use super::*;
use std::path::PathBuf;

#[test]
fn test_component_name_from_filename() {
    let parser = SvelteParser::new();
    let code = r#"
<script>
  let count = 0;
</script>

<button on:click={() => count++}>
  Clicked {count} times
</button>
"#;
    let results = parser.parse_file(&PathBuf::from("Counter.svelte"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::SvelteDef)
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "Counter");
}

#[test]
fn test_component_usages() {
    let parser = SvelteParser::new();
    let code = r#"
<script>
  import Header from './Header.svelte';
  import Footer from './Footer.svelte';
</script>

<Header />

<main>
  <NestedComponent prop={value} />
</main>

<Footer />
"#;
    let results = parser.parse_file(&PathBuf::from("App.svelte"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"Header"));
    assert!(usages.contains(&"Footer"));
    assert!(usages.contains(&"NestedComponent"));
}

#[test]
fn test_svelte_imports() {
    let parser = SvelteParser::new();
    let code = r#"
<script>
  import Button from '$lib/components/Button.svelte';
  import Card from '../Card.svelte';
</script>

<Button />
<Card />
"#;
    let results = parser.parse_file(&PathBuf::from("Page.svelte"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    // Imports + usages in markup
    assert!(usages.contains(&"Button"));
    assert!(usages.contains(&"Card"));
}

#[test]
fn test_skip_html_elements() {
    let parser = SvelteParser::new();
    let code = r#"
<script>
  let name = 'world';
</script>

<div>
  <h1>Hello {name}!</h1>
  <MyComponent />
  <p>Some text</p>
</div>
"#;
    let results = parser.parse_file(&PathBuf::from("App.svelte"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    // Should only have MyComponent (PascalCase), not div, h1, p
    assert_eq!(usages.len(), 1);
    assert!(usages.contains(&"MyComponent"));
}

#[test]
fn test_multiple_script_tags() {
    let parser = SvelteParser::new();
    let code = r#"
<script context="module">
  export function preload() {}
</script>

<script>
  import Widget from './Widget.svelte';
  let data;
</script>

<Widget />
"#;
    let results = parser.parse_file(&PathBuf::from("Page.svelte"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"Widget"));
}
