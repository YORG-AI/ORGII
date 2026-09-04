use super::*;
use std::path::PathBuf;

#[test]
fn test_component_name_from_filename() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <div>Hello</div>
</template>

<script>
export default {}
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("MyButton.vue"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::VueDef)
        .collect();
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0].0, "MyButton");
}

#[test]
fn test_options_api_name() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <div>Hello</div>
</template>

<script>
export default {
  name: 'ExplicitName',
  data() {
    return {}
  }
}
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("MyButton.vue"), code);

    let defs: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::VueDef)
        .collect();
    // Should have both filename-based and explicit name
    assert_eq!(defs.len(), 2);
    assert!(defs.iter().any(|(name, _)| name == "MyButton"));
    assert!(defs.iter().any(|(name, _)| name == "ExplicitName"));
}

#[test]
fn test_component_usages_pascal() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <div>
    <MyHeader />
    <MainContent>
      <SideBar />
    </MainContent>
  </div>
</template>

<script>
export default {}
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("App.vue"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"MyHeader"));
    assert!(usages.contains(&"MainContent"));
    assert!(usages.contains(&"SideBar"));
}

#[test]
fn test_component_usages_kebab() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <div>
    <my-header />
    <main-content />
  </div>
</template>

<script>
export default {}
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("App.vue"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    // Should be converted to PascalCase
    assert!(usages.contains(&"MyHeader"));
    assert!(usages.contains(&"MainContent"));
}

#[test]
fn test_vue_imports() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <ChildComponent />
</template>

<script setup>
import ChildComponent from './ChildComponent.vue'
import AnotherOne from '@/components/AnotherOne.vue'
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("Parent.vue"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    assert!(usages.contains(&"ChildComponent"));
    assert!(usages.contains(&"AnotherOne"));
}

#[test]
fn test_skip_vue_builtins() {
    let parser = VueParser::new();
    let code = r#"
<template>
  <Transition>
    <KeepAlive>
      <MyComponent />
    </KeepAlive>
  </Transition>
</template>

<script>
export default {}
</script>
"#;
    let results = parser.parse_file(&PathBuf::from("App.vue"), code);

    let usages: Vec<_> = results
        .iter()
        .filter(|(_, loc)| loc.kind == ComponentKind::JsxUsage)
        .map(|(name, _)| name.as_str())
        .collect();

    // Should only have MyComponent, not Transition or KeepAlive
    assert_eq!(usages.len(), 1);
    assert!(usages.contains(&"MyComponent"));
}
