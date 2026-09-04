# Linting conventions

ESLint configuration lives in the `eslintConfig` field of the root
`package.json`. ESLint 8 and its editor integrations discover it automatically;
no custom config path is needed. Prettier settings are in the same manifest.

The config sets `root: true`, uses the TypeScript parser, and extends ESLint,
TypeScript, React, React Hooks, and Prettier recommendations in that order.
Prettier comes last to disable conflicting formatting rules. Linting is limited
to `src/`; CSS and SCSS are excluded. Git hooks run ESLint and Prettier through
lint-staged before committing.

## Rule decisions

- JSX does not require a React import because the project uses the automatic
  JSX runtime. TypeScript replaces runtime prop-type checking.
- `unused-imports` owns unused import and variable checks. Underscore-prefixed
  variables and arguments are deliberately allowed.
- Direct console use is discouraged; use `@src/hooks/logger`. Warnings and
  errors remain allowed.
- Import icons by name from `@src/icons`. Namespace imports force the entire
  barrel into a chunk. Webpack marks the barrel as side-effect-free so named
  imports can link directly to individual glyph modules.
- Deep Hugeicons imports belong only in `src/icons.ts`, the canonical barrel.
  Add a re-export there when introducing a glyph. The removed `lucide-react`
  package must not be reintroduced.
- Do not cast values to `IconSvgElement` or `IconSvgObject`. Components are not
  glyph arrays, and such casts can cause runtime failures. Use `RenderableIcon`
  from `@src/components/AnyIcon` for mixed icon values.
- Restricted import patterns point callers away from dissolved hook groups
  and toward their current owners. The diagnostic messages name those paths.
- Keep all restricted imports in one `no-restricted-imports` rule. Duplicate
  object keys silently replace earlier rules.
- Tests must not commit `.only` or `.only.each`: they can skip the rest of a
  suite while still returning success. `.skip` and `.todo` remain allowed
  because reporters make those skipped cases visible.
- The test override replaces the top-level `no-restricted-syntax` list, so it
  repeats the glyph-cast guards to retain them for test files.

Changes to `package.json` trigger full-tree linting in CI because they can
change rules or formatter behavior for otherwise untouched files.
