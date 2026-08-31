// `@types/react-syntax-highlighter` declares the deep entry points
// (`dist/esm/prism-light`, `dist/esm/languages/prism/*`, `dist/esm/styles/prism/*`)
// as ambient modules inside its index.d.ts. TypeScript only loads that file
// when something imports the package root, which nothing does any more
// (src/util/language/prismLight.ts deliberately avoids the barrel), so pull
// the declarations in explicitly.
/// <reference types="react-syntax-highlighter" />
